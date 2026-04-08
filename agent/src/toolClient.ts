import crypto from "node:crypto";
import type { ToolCall, ToolResult } from "./types";
import { JsonWsClient } from "./wsClient";

function newRequestId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export class ToolsClient {
  private client: JsonWsClient<ToolResult | { type: "ready"; version: string }, ToolCall>;

  constructor(url: string) {
    this.client = new JsonWsClient(url);
  }

  async connect(): Promise<void> {
    await this.client.connect(1500);
  }

  close(): void {
    this.client.close();
  }

  async call(tool: string, params: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const requestId = newRequestId();
    const msg: ToolCall = { type: "tool_call", requestId, tool, params };
    // No explicit cancel protocol for tools (deterministic + bounded ops). We honor abort by ignoring late results.
    this.client.send(msg);
    return await new Promise<ToolResult>((resolve, reject) => {
      const off = this.client.onMessage((m) => {
        if (signal.aborted) {
          off();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (m.type === "tool_result" && m.requestId === requestId) {
          off();
          resolve(m);
        }
      });
      signal.addEventListener(
        "abort",
        () => {
          off();
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    });
  }
}

