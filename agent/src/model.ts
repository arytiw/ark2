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

  async generate(prompt: string, maxTokens: number, signal: AbortSignal): Promise<string> {
    const requestId = newRequestId();
    let text = "";
    const unsub = this.client.onMessage((m) => {
      if (m.type === "token" && m.requestId === requestId) text += m.token;
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
            reject(new Error(m.message));
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
    const text = await this.generate(prompt, maxTokens, signal);
    const parsed = extractFirstJsonObject(text);
    const action = validateModelAction(parsed);
    if (!action) throw new Error("Model did not return a valid JSON action.");
    return action;
  }
}

export class MockModel {
  proposeAction(instruction: string): ModelAction {
    // Deterministic minimal policy for runnable Phase 5.
    // Supports: "read <path>" and "search <query>"
    const trimmed = instruction.trim();
    const mRead = /^read\s+(.+)$/i.exec(trimmed);
    if (mRead) return { action: "tool", tool: "read_file", params: { path: mRead[1].trim() } };
    const mSearch = /^search\s+(.+)$/i.exec(trimmed);
    if (mSearch) return { action: "tool", tool: "search_code", params: { query: mSearch[1].trim(), directory: "." } };
    return { action: "final", answer: "Mock agent: supported commands are `read <path>` and `search <query>`." };
  }
}

