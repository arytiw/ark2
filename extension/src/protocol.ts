export type ClientToServer =
  | { type: "generate"; requestId: string; prompt: string; maxTokens?: number; stop?: string[] }
  | { type: "cancel"; requestId: string }
  | { type: "ping"; requestId: string };

export type ServerToClient =
  | { type: "ready"; version: string }
  | { type: "pong"; requestId: string; t: number }
  | { type: "token"; requestId: string; token: string }
  | { type: "done"; requestId: string; reason: "eos" | "stop" | "cancel" | "error" }
  | { type: "error"; requestId?: string; code: string; message: string };

export function safeJsonParse(raw: string): unknown {
  return JSON.parse(raw);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseServerMessage(raw: unknown): ServerToClient | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (type === "ready" && typeof raw.version === "string") return { type: "ready", version: raw.version };
  if (type === "pong" && typeof raw.requestId === "string" && typeof raw.t === "number") return { type: "pong", requestId: raw.requestId, t: raw.t };
  if (type === "token" && typeof raw.requestId === "string" && typeof raw.token === "string") return { type: "token", requestId: raw.requestId, token: raw.token };
  if (type === "done" && typeof raw.requestId === "string" && typeof raw.reason === "string") {
    const r = raw.reason;
    if (r === "eos" || r === "stop" || r === "cancel" || r === "error") return { type: "done", requestId: raw.requestId, reason: r };
    return null;
  }
  if (type === "error" && typeof raw.code === "string" && typeof raw.message === "string") {
    return typeof raw.requestId === "string"
      ? { type: "error", requestId: raw.requestId, code: raw.code, message: raw.message }
      : { type: "error", code: raw.code, message: raw.message };
  }
  return null;
}

