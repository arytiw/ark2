import * as vscode from "vscode";
import crypto from "node:crypto";
import type { RuntimeClient } from "./runtimeClient";
import { buildCompletionPrompt } from "./promptBuilder";
import type { ServerToClient } from "./protocol";

export type CompletionPipelineConfig = {
  maxTokens: number;
  stop: string[];
  maxPrefixChars: number;
  maxSuffixChars: number;
  ragTopK: number;
  ragTimeoutMs: number;
};

function newRequestId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export class InlineCompletionPipeline {
  private inflight: { requestId: string } | null = null;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly ensureClient: () => Promise<RuntimeClient>,
    private readonly retrieveRagSnippets: (query: string, topK: number, timeoutMs: number) => Promise<Array<{ path: string; preview: string; score: number }>>,
    private readonly cfg: CompletionPipelineConfig
  ) {}

  register(context: vscode.ExtensionContext): void {
    const provider: vscode.InlineCompletionItemProvider = {
      provideInlineCompletionItems: async (document, position, _ctx, token) => {
        const enabled = vscode.workspace.getConfiguration("offlineAssistant").get<boolean>("inlineCompletionEnabled", true);
        if (!enabled) return { items: [] };

        // One at a time to keep deterministic and easy to audit.
        if (this.inflight) return { items: [] };

        const querySeed = document.getText(new vscode.Range(new vscode.Position(Math.max(0, position.line - 20), 0), position)).slice(-1200);
        let ragSnippets: Array<{ path: string; preview: string; score: number }> = [];
        try {
          ragSnippets = await this.retrieveRagSnippets(querySeed, this.cfg.ragTopK, this.cfg.ragTimeoutMs);
        } catch {
          ragSnippets = [];
        }
        const prompt = buildCompletionPrompt(document, position, {
          maxPrefixChars: this.cfg.maxPrefixChars,
          maxSuffixChars: this.cfg.maxSuffixChars,
          ragSnippets
        });

        const requestId = newRequestId();
        this.inflight = { requestId };

        const c = await this.ensureClient();

        let text = "";
        const startedAt = Date.now();

        const unsub = c.onMessage((m: ServerToClient) => {
          if (m.type === "token" && m.requestId === requestId) {
            text += m.token;
          }
        });

        const cancel = () => {
          try {
            c.send({ type: "cancel", requestId });
          } catch {}
        };
        token.onCancellationRequested(cancel);

        try {
          this.output.appendLine(`\n[inline-generate ${requestId}]`);
          c.send({ type: "generate", requestId, prompt, maxTokens: this.cfg.maxTokens, stop: this.cfg.stop });

          // Wait for done/error for this request.
          await new Promise<void>((resolve, reject) => {
            const off = c.onMessage((m) => {
              if (m.type === "done" && m.requestId === requestId) {
                off();
                resolve();
              } else if (m.type === "error" && m.requestId === requestId) {
                off();
                reject(new Error(m.message));
              }
            });
          });
        } finally {
          unsub();
          this.inflight = null;
          const elapsed = Date.now() - startedAt;
          this.output.appendLine(`[inline-done ${requestId}] bytes=${Buffer.byteLength(text, "utf8")} elapsedMs=${elapsed}`);
        }

        // Basic guard: avoid returning gigantic edits.
        const maxReturnChars = 20_000;
        if (text.length > maxReturnChars) text = text.slice(0, maxReturnChars);

        // Insert at cursor (range is empty).
        const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
        return { items: [item] };
      }
    };

    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: "**/*" }, provider));
  }
}

