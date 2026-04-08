import { WebSocket } from "ws";
import type { ClientToServer, ServerToClient } from "./protocol";
import { parseServerMessage, safeJsonParse } from "./protocol";

export type RuntimeClientConfig = {
  url: string; // ws://127.0.0.1:8765
};

export class RuntimeClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(msg: ServerToClient) => void>();
  private readonly stateListeners = new Set<(state: "disconnected" | "connecting" | "connected") => void>();

  constructor(private readonly cfg: RuntimeClientConfig) {}

  onMessage(cb: (msg: ServerToClient) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onState(cb: (state: "disconnected" | "connecting" | "connected") => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private emitState(s: "disconnected" | "connecting" | "connected") {
    for (const cb of this.stateListeners) cb(s);
  }

  private emit(msg: ServerToClient) {
    for (const cb of this.listeners) cb(msg);
  }

  connect(timeoutMs = 1500): Promise<void> {
    if (this.ws && (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING)) return Promise.resolve();
    this.emitState("connecting");
    const ws = new WebSocket(this.cfg.url, {
      handshakeTimeout: timeoutMs,
      perMessageDeflate: false
    });
    this.ws = ws;

    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      let parsed: unknown;
      try {
        parsed = safeJsonParse(raw);
      } catch {
        return;
      }
      const msg = parseServerMessage(parsed);
      if (msg) this.emit(msg);
    });

    ws.on("close", () => {
      this.emitState("disconnected");
    });
    ws.on("error", () => {
      // handled by connect() rejection if during connect; otherwise just transitions via close.
    });

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("Runtime connection timeout."));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(t);
        this.emitState("connected");
        resolve();
      });
      ws.once("error", () => {
        clearTimeout(t);
        reject(new Error("Failed to connect to runtime."));
      });
    });
  }

  disconnect(): void {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {}
    this.ws = null;
    this.emitState("disconnected");
  }

  send(msg: ClientToServer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) throw new Error("Not connected.");
    ws.send(JSON.stringify(msg));
  }
}

