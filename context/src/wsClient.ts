import { WebSocket } from "ws";
import type { RawData } from "ws";

export class JsonWsClient<TIn, TOut> {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(msg: TIn) => void>();
  constructor(private readonly url: string) {}

  onMessage(cb: (msg: TIn) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  connect(timeoutMs = 1500): Promise<void> {
    if (this.ws && (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING)) return Promise.resolve();
    const ws = new WebSocket(this.url, { handshakeTimeout: timeoutMs, perMessageDeflate: false });
    this.ws = ws;
    ws.on("message", (data: RawData) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      try {
        const parsed = JSON.parse(raw) as TIn;
        for (const cb of this.listeners) cb(parsed);
      } catch {
        // ignore
      }
    });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("WS connect timeout"));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", () => {
        clearTimeout(t);
        reject(new Error("WS connect error"));
      });
    });
  }

  send(msg: TOut): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) throw new Error("WS not connected");
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }
}

