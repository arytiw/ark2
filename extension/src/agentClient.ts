import { WebSocket } from "ws";
import crypto from "node:crypto";

export type AgentEvent =
  | { kind: "step_start"; step: number }
  | { kind: "model_action"; step: number; action: unknown }
  | { kind: "tool_call"; step: number; requestId: string; tool: string; params: unknown }
  | { kind: "tool_result"; step: number; requestId: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
  | { kind: "step_end"; step: number };

export type AgentToClient =
  | { type: "ready"; version: string }
  | { type: "pong"; requestId: string; t: number }
  | { type: "event"; taskId: string; event: AgentEvent }
  | { type: "final"; taskId: string; ok: boolean; result?: string; error?: { code: string; message: string } }
  | { type: "error"; taskId?: string; code: string; message: string };

export type ClientToAgent =
  | { type: "task"; taskId: string; instruction: string; mode?: "chat" | "agent" | "plan" }
  | { type: "cancel"; taskId: string }
  | { type: "ping"; requestId: string };

export interface TaskCallbacks {
  onEvent: (event: AgentEvent) => void;
  onFinal: (result: { ok: boolean; result?: string; error?: { code: string; message: string } }) => void;
  onError: (error: { code: string; message: string }) => void;
}

export class AgentClient {
  private ws: WebSocket | null = null;
  private readonly activeTasks = new Map<string, TaskCallbacks>();
  private readonly stateListeners = new Set<(state: "disconnected" | "connecting" | "connected") => void>();

  constructor(private readonly url: string) {}

  onState(cb: (state: "disconnected" | "connecting" | "connected") => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private emitState(s: "disconnected" | "connecting" | "connected") {
    for (const cb of this.stateListeners) cb(s);
  }

  async connect(timeoutMs = 2000): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.emitState("connecting");
    const ws = new WebSocket(this.url, { handshakeTimeout: timeoutMs });
    this.ws = ws;

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        ws.close();
        reject(new Error("Agent connection timeout"));
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(t);
        this.emitState("connected");
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(t);
        this.emitState("disconnected");
        reject(err);
      });

      ws.on("close", () => {
        this.emitState("disconnected");
        this.activeTasks.clear();
      });

      ws.on("message", (data) => {
        const raw = data.toString("utf8");
        try {
          const msg = JSON.parse(raw) as AgentToClient;
          this.handleMessage(msg);
        } catch (e) {
          console.error("[AgentClient] Failed to parse message", e);
        }
      });
    });
  }

  private handleMessage(msg: AgentToClient) {
    if (msg.type === "event") {
      const cb = this.activeTasks.get(msg.taskId);
      if (cb) cb.onEvent(msg.event);
    } else if (msg.type === "final") {
      const cb = this.activeTasks.get(msg.taskId);
      if (cb) {
        cb.onFinal({ ok: msg.ok, result: msg.result, error: msg.error });
        this.activeTasks.delete(msg.taskId);
      }
    } else if (msg.type === "error") {
      if (msg.taskId) {
        const cb = this.activeTasks.get(msg.taskId);
        if (cb) {
          cb.onError({ code: msg.code, message: msg.message });
          this.activeTasks.delete(msg.taskId);
        }
      } else {
        console.error("[AgentClient] Global error", msg.code, msg.message);
      }
    }
  }

  runTask(instruction: string, callbacks: TaskCallbacks, mode: "chat" | "agent" | "plan" = "chat"): string {
    const taskId = crypto.randomBytes(8).toString("hex");
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agent not connected");
    }

    this.activeTasks.set(taskId, callbacks);
    const msg: ClientToAgent = { type: "task", taskId, instruction, mode };
    this.ws.send(JSON.stringify(msg));
    return taskId;
  }

  cancel(taskId: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: ClientToAgent = { type: "cancel", taskId };
    this.ws.send(JSON.stringify(msg));
    this.activeTasks.delete(taskId);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
