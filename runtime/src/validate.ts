import type { ClientToServer } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function parseClientMessage(raw: unknown): { ok: true; msg: ClientToServer } | { ok: false; code: string; message: string } {
  if (!isRecord(raw)) return { ok: false, code: "E_BAD_JSON", message: "Message must be a JSON object." };
  const type = raw.type;
  if (type === "generate") {
    if (!isNonEmptyString(raw.requestId)) return { ok: false, code: "E_BAD_REQUEST", message: "requestId must be a non-empty string." };
    if (!isNonEmptyString(raw.prompt)) return { ok: false, code: "E_BAD_REQUEST", message: "prompt must be a non-empty string." };
    const maxTokens = raw.maxTokens;
    if (maxTokens !== undefined && !(typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 8192)) {
      return { ok: false, code: "E_BAD_REQUEST", message: "maxTokens must be an integer in (0, 8192]." };
    }
    const stop = raw.stop;
    if (stop !== undefined && !isStringArray(stop)) return { ok: false, code: "E_BAD_REQUEST", message: "stop must be a string array." };
    return {
      ok: true,
      msg: {
        type: "generate",
        requestId: raw.requestId,
        prompt: raw.prompt,
        maxTokens: maxTokens as number | undefined,
        stop: stop as string[] | undefined
      }
    };
  }
  if (type === "cancel") {
    if (!isNonEmptyString(raw.requestId)) return { ok: false, code: "E_BAD_REQUEST", message: "requestId must be a non-empty string." };
    return { ok: true, msg: { type: "cancel", requestId: raw.requestId } };
  }
  if (type === "ping") {
    if (!isNonEmptyString(raw.requestId)) return { ok: false, code: "E_BAD_REQUEST", message: "requestId must be a non-empty string." };
    return { ok: true, msg: { type: "ping", requestId: raw.requestId } };
  }
  return { ok: false, code: "E_BAD_REQUEST", message: "Unknown message type." };
}

