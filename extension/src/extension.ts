import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { RuntimeClient } from "./runtimeClient";
import type { ServerToClient } from "./protocol";
import { InlineCompletionPipeline } from "./completionProvider";
import { EmbeddingsClient } from "./embeddingsClient";

type RootConfig = {
  runtime: { host: string; port: number };
  embeddings: { host: string; port: number };
};

function tryReadRootConfig(workspaceRoot: string): RootConfig | null {
  try {
    const p = path.join(workspaceRoot, "config.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const r = (raw as any).runtime;
    const e = (raw as any).embeddings;
    if (!r || typeof r.host !== "string" || typeof r.port !== "number") return null;
    if (!e || typeof e.host !== "string" || typeof e.port !== "number") return null;
    return { runtime: { host: r.host, port: r.port }, embeddings: { host: e.host, port: e.port } };
  } catch {
    return null;
  }
}

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

function newRequestId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Offline Assistant", { log: true });
  output.appendLine("Extension activated.");

  let client: RuntimeClient | null = null;
  let embClient: EmbeddingsClient | null = null;
  let inflightRequestId: string | null = null;
  let inlinePipeline: InlineCompletionPipeline | null = null;

  const ensureClient = async (): Promise<RuntimeClient> => {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("Open a workspace folder first.");
    const cfg = tryReadRootConfig(root);
    if (!cfg) throw new Error("Missing/invalid config.json at workspace root.");

    const url = `ws://${cfg.runtime.host}:${cfg.runtime.port}`;
    if (!client) {
      client = new RuntimeClient({ url });
      client.onState((s) => output.appendLine(`runtime: ${s}`));
      client.onMessage((m) => onRuntimeMessage(m));
    }
    await client.connect();
    output.appendLine(`Connected to ${url}`);
    return client;
  };

  const ensureEmbClient = async (): Promise<EmbeddingsClient> => {
    const root = getWorkspaceRoot();
    if (!root) throw new Error("Open a workspace folder first.");
    const cfg = tryReadRootConfig(root);
    if (!cfg) throw new Error("Missing/invalid config.json at workspace root.");
    const url = `ws://${cfg.embeddings.host}:${cfg.embeddings.port}`;
    if (!embClient) embClient = new EmbeddingsClient(url);
    await embClient.connect();
    return embClient;
  };

  const retrieveRagSnippets = async (query: string, topK: number, timeoutMs: number) => {
    const c = await ensureEmbClient();
    return c.query(query, topK, timeoutMs);
  };

  const onRuntimeMessage = (m: ServerToClient) => {
    if (m.type === "ready") {
      output.appendLine(`runtime ready: v${m.version}`);
      return;
    }
    if (m.type === "token") {
      output.append(m.token);
      return;
    }
    if (m.type === "done") {
      output.appendLine(`\n[done ${m.requestId}] reason=${m.reason}`);
      if (inflightRequestId === m.requestId) inflightRequestId = null;
      return;
    }
    if (m.type === "error") {
      output.appendLine(`[error] code=${m.code} requestId=${m.requestId ?? "-"} msg=${m.message}`);
      return;
    }
  };

  // Phase 3: completion pipeline
  const initInlineCompletion = () => {
    if (inlinePipeline) return;
    const cfg = vscode.workspace.getConfiguration("offlineAssistant");
    inlinePipeline = new InlineCompletionPipeline(
      output,
      ensureClient,
      retrieveRagSnippets,
      {
        maxTokens: cfg.get<number>("completionMaxTokens", 256),
        stop: [],
        maxPrefixChars: cfg.get<number>("maxPrefixChars", 8000),
        maxSuffixChars: cfg.get<number>("maxSuffixChars", 2000),
        ragTopK: cfg.get<number>("ragTopK", 6),
        ragTimeoutMs: cfg.get<number>("ragTimeoutMs", 80)
      }
    );
    inlinePipeline.register(context);
    output.appendLine("Inline completion provider registered.");
  };
  initInlineCompletion();

  context.subscriptions.push(
    vscode.commands.registerCommand("offlineAssistant.connect", async () => {
      output.show(true);
      try {
        await ensureClient();
      } catch (e) {
        vscode.window.showErrorMessage(e instanceof Error ? e.message : "Connect failed.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("offlineAssistant.generate", async () => {
      output.show(true);
      try {
        const c = await ensureClient();
        const prompt = await vscode.window.showInputBox({
          title: "Offline Assistant Prompt",
          prompt: "Enter a prompt to stream from the local runtime",
          ignoreFocusOut: true
        });
        if (!prompt) return;

        if (inflightRequestId) {
          vscode.window.showWarningMessage("A request is already running. Cancel it first.");
          return;
        }

        const requestId = newRequestId();
        inflightRequestId = requestId;
        output.appendLine(`\n[generate ${requestId}]`);
        c.send({ type: "generate", requestId, prompt, maxTokens: 512, stop: [] });
      } catch (e) {
        inflightRequestId = null;
        vscode.window.showErrorMessage(e instanceof Error ? e.message : "Generate failed.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("offlineAssistant.cancel", async () => {
      output.show(true);
      try {
        const c = await ensureClient();
        if (!inflightRequestId) {
          vscode.window.showInformationMessage("No in-flight request to cancel.");
          return;
        }
        const rid = inflightRequestId;
        inflightRequestId = null;
        c.send({ type: "cancel", requestId: rid });
        output.appendLine(`[cancel ${rid}] sent`);
      } catch (e) {
        vscode.window.showErrorMessage(e instanceof Error ? e.message : "Cancel failed.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("offlineAssistant.toggleInlineCompletion", async () => {
      const cfg = vscode.workspace.getConfiguration("offlineAssistant");
      const cur = cfg.get<boolean>("inlineCompletionEnabled", true);
      await cfg.update("inlineCompletionEnabled", !cur, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Offline Assistant inline completion: ${!cur ? "enabled" : "disabled"}`);
    })
  );
}

export function deactivate() {
  // No-op: VS Code disposes subscriptions.
}

