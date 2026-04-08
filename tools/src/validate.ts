import type { ToolCall, ToolName } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isToolName(v: unknown): v is ToolName {
  return v === "read_file" || v === "write_file" || v === "apply_diff" || v === "list_files" || v === "search_code";
}

export function parseToolCall(raw: unknown): { ok: true; call: ToolCall } | { ok: false; code: string; message: string } {
  if (!isRecord(raw)) return { ok: false, code: "E_BAD_JSON", message: "Message must be a JSON object." };
  if (raw.type !== "tool_call") return { ok: false, code: "E_BAD_REQUEST", message: "Expected type=tool_call." };
  if (!isNonEmptyString(raw.requestId)) return { ok: false, code: "E_BAD_REQUEST", message: "requestId must be a non-empty string." };
  if (!isToolName(raw.tool)) return { ok: false, code: "E_BAD_REQUEST", message: "Invalid tool name." };
  const params = raw.params;
  if (!isRecord(params)) return { ok: false, code: "E_BAD_REQUEST", message: "params must be an object." };
  return { ok: true, call: { type: "tool_call", requestId: raw.requestId, tool: raw.tool, params } };
}

