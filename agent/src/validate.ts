import type { ClientToAgent } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function parseClientMsg(raw: unknown): { ok: true; msg: ClientToAgent } | { ok: false; code: string; message: string } {
  if (!isRecord(raw)) return { ok: false, code: "E_BAD_JSON", message: "Message must be an object." };
  const type = raw.type;
  if (type === "task") {
    if (!isNonEmptyString(raw.taskId)) return { ok: false, code: "E_BAD_REQUEST", message: "taskId must be non-empty string." };
    if (!isNonEmptyString(raw.instruction)) return { ok: false, code: "E_BAD_REQUEST", message: "instruction must be non-empty string." };
    const mode = (raw.mode === "chat" || raw.mode === "agent" || raw.mode === "plan") ? raw.mode : undefined;
    return { ok: true, msg: { type: "task", taskId: raw.taskId, instruction: raw.instruction, mode } };
  }
  if (type === "cancel") {
    if (!isNonEmptyString(raw.taskId)) return { ok: false, code: "E_BAD_REQUEST", message: "taskId must be non-empty string." };
    return { ok: true, msg: { type: "cancel", taskId: raw.taskId } };
  }
  if (type === "ping") {
    if (!isNonEmptyString(raw.requestId)) return { ok: false, code: "E_BAD_REQUEST", message: "requestId must be non-empty string." };
    return { ok: true, msg: { type: "ping", requestId: raw.requestId } };
  }
  return { ok: false, code: "E_BAD_REQUEST", message: "Unknown message type." };
}

