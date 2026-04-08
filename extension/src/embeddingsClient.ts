import { WebSocket } from "ws";
import type { RawData } from "ws";

type QueryReq = { type: "query"; requestId: string; text: string; topK: number };
type QueryResult =
  | { type: "result"; requestId: string; ok: true; result: { matches: Array<{ id: string; score: number; meta: Record<string, unknown> }> } }
  | { type: "result"; requestId: string; ok: false; error: { code: string; message: string } };

function rid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class EmbeddingsClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(m: QueryResult | { type: "ready"; version: string }) => void>();
  constructor(private readonly url: string) {}

  async connect(timeoutMs = 1200): Promise<void> {
    if (this.ws && (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING)) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: timeoutMs, perMessageDeflate: false });
    this.ws = ws;
    ws.on("message", (data: RawData) => {
      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const parsed = JSON.parse(raw) as QueryResult | { type: "ready"; version: string };
        for (const cb of this.listeners) cb(parsed);
      } catch {}
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("Embeddings connect timeout"));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", () => {
        clearTimeout(t);
        reject(new Error("Embeddings connect failed"));
      });
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  private send(msg: QueryReq): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) throw new Error("Embeddings socket not connected");
    this.ws.send(JSON.stringify(msg));
  }

  async query(text: string, topK: number, timeoutMs: number): Promise<Array<{ path: string; preview: string; score: number }>> {
    await this.connect();
    const requestId = rid();
    const p = new Promise<QueryResult>((resolve, reject) => {
      const off = this.onMessage((m) => {
        if (m.type === "result" && m.requestId === requestId) {
          clearTimeout(t);
          off();
          resolve(m);
        }
      });
      const t = setTimeout(() => {
        off();
        reject(new Error("Embeddings query timeout"));
      }, timeoutMs);
    });
    this.send({ type: "query", requestId, text, topK });
    const res = await p;
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
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

  onMessage(cb: (m: QueryResult | { type: "ready"; version: string }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

