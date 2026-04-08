import crypto from "node:crypto";
import { JsonWsClient } from "./wsClient";

type EmbMsgIn =
  | { type: "ready"; version: string }
  | { type: "result"; requestId: string; ok: true; result: { matches?: Array<{ id: string; score: number; meta: Record<string, unknown> }> } }
  | { type: "result"; requestId: string; ok: false; error: { code: string; message: string } };

type EmbMsgOut = { type: "query"; requestId: string; text: string; topK: number };

function rid(): string {
  return crypto.randomBytes(8).toString("hex");
}

export class RagClient {
  private readonly c: JsonWsClient<EmbMsgIn, EmbMsgOut>;
  constructor(url: string) {
    this.c = new JsonWsClient(url);
  }
  async connect(): Promise<void> {
    await this.c.connect(1200);
  }
  close(): void {
    this.c.close();
  }

  async query(query: string, topK: number, timeoutMs: number): Promise<Array<{ path: string; preview: string; score: number }>> {
    const requestId = rid();
    const p = new Promise<EmbMsgIn>((resolve, reject) => {
      const off = this.c.onMessage((m) => {
        if (m.type === "result" && m.requestId === requestId) {
          clearTimeout(t);
          off();
          resolve(m);
        }
      });
      const t = setTimeout(() => {
        off();
        reject(new Error("RAG query timeout"));
      }, timeoutMs);
    });
    this.c.send({ type: "query", requestId, text: query, topK });
    const res = await p;
    if (res.type !== "result") return [];
    if (!res.ok) return [];
    const out: Array<{ path: string; preview: string; score: number }> = [];
    for (const m of res.result.matches ?? []) {
      const meta = m.meta ?? {};
      const path = typeof meta.path === "string" ? meta.path : "";
      const preview = typeof meta.preview === "string" ? meta.preview : "";
      if (!path || !preview) continue;
      out.push({ path, preview, score: m.score });
    }
    return out;
  }
}

