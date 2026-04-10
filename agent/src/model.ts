import crypto from "node:crypto";
import type { ModelAction, RuntimeCancel, RuntimeGenerate, RuntimeServerMsg } from "./types";
import { JsonWsClient } from "./wsClient";

function newRequestId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function extractFirstJsonObject(text: string): unknown | null {
  // Minimal deterministic extractor: finds first {...} region and tries JSON.parse.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateModelAction(v: unknown): ModelAction | null {
  if (!isRecord(v)) return null;
  const a = v.action;
  if (a === "final" && typeof v.answer === "string") return { action: "final", answer: v.answer };
  if (a === "tool" && typeof v.tool === "string" && isRecord(v.params)) {
    const tool = v.tool;
    if (tool === "read_file" || tool === "write_file" || tool === "apply_diff" || tool === "list_files" || tool === "search_code") {
      return { action: "tool", tool, params: v.params };
    }
  }
  return null;
}

export class RuntimeModel {
  private client: JsonWsClient<RuntimeServerMsg, RuntimeGenerate | RuntimeCancel>;

  constructor(url: string) {
    this.client = new JsonWsClient(url);
  }

  async connect(): Promise<void> {
    await this.client.connect(1500);
  }

  close(): void {
    this.client.close();
  }

  async generate(prompt: string, maxTokens: number, signal: AbortSignal, onToken?: (t: string) => void): Promise<string> {
    const requestId = newRequestId();
    let text = "";
    const unsub = this.client.onMessage((m) => {
      if (m.type === "token" && m.requestId === requestId) {
        console.log(`[AgentModel] Token received from runtime: ${m.token.length} bytes`);
        if (onToken) {
          console.log(`[AgentModel] Forwarding token to extension`);
          onToken(m.token);
        }
        text += m.token;
      }
    });

    const abortHandler = () => {
      try {
        this.client.send({ type: "cancel", requestId });
      } catch {}
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    try {
      this.client.send({ type: "generate", requestId, prompt, maxTokens, stop: [] });
      await new Promise<void>((resolve, reject) => {
        const off = this.client.onMessage((m) => {
          if (m.type === "done" && m.requestId === requestId) {
            off();
            resolve();
          } else if (m.type === "error" && m.requestId === requestId) {
            off();
            const err = new Error(m.message) as any;
            err.code = m.code;
            reject(err);
          }
        });
      });
    } finally {
      unsub();
      signal.removeEventListener("abort", abortHandler);
    }

    return text;
  }

  async proposeAction(prompt: string, maxTokens: number, signal: AbortSignal): Promise<ModelAction> {
    let currentPrompt = prompt;
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      const text = await this.generate(currentPrompt, maxTokens, signal);
      const parsed = extractFirstJsonObject(text);
      const action = validateModelAction(parsed);

      if (action) {
        return action;
      }

      console.warn(`[RuntimeModel] Attempt ${attempts} failed to produce valid JSON action.`, {
        text: text.slice(0, 100) + (text.length > 100 ? "..." : "")
      });

      if (attempts < maxAttempts) {
        currentPrompt = prompt + "\n\nERROR: Your previous response was not valid JSON or was missing required fields. " +
          "You MUST output exactly ONE valid JSON object following the schema precisely. " +
          "Do not include any conversational text or markdown blocks.";
      }
    }

    throw new Error(`Model failed to return a valid JSON action after ${maxAttempts} attempts.`);
  }
}

export class MockModel {
  proposeAction(instruction: string, mode: "chat" | "agent" | "plan" = "agent"): ModelAction {
    if (mode === "chat") {
      return { action: "final", answer: `Mock Chat: I'm a coding assistant. You asked: "${instruction}". I don't use tools in chat mode.` };
    }
    if (mode === "plan") {
      return { action: "final", answer: `Mock Plan: 1. Research ${instruction}. 2. Draft implementation. 3. Review logic.` };
    }

    // Deterministic minimal policy for runnable Phase 5 (agent mode).
    // Supports: "read <path>" and "search <query>"
    const trimmed = instruction.trim();
    const mRead = /^read\s+(.+)$/i.exec(trimmed);
    if (mRead) return { action: "tool", tool: "read_file", params: { path: mRead[1].trim() } };
    const mSearch = /^search\s+(.+)$/i.exec(trimmed);
    if (mSearch) return { action: "tool", tool: "search_code", params: { query: mSearch[1].trim(), directory: "." } };
    return { action: "final", answer: "Mock agent: supported commands are `read <path>` and `search <query>`." };
  }
}

