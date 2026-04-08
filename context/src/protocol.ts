export type ToolsReady = { type: "ready"; version: string };
export type ToolCall = { type: "tool_call"; requestId: string; tool: string; params: Record<string, unknown> };
export type ToolResult =
  | { type: "tool_result"; requestId: string; ok: true; result: any }
  | { type: "tool_result"; requestId: string; ok: false; error: { code: string; message: string } };

export type EmbReady = { type: "ready"; version: string };
export type EmbRequest =
  | { type: "upsert"; requestId: string; items: { id: string; text: string; meta: Record<string, unknown> }[] }
  | { type: "query"; requestId: string; text: string; topK: number };
export type EmbResult =
  | { type: "result"; requestId: string; ok: true; result: any }
  | { type: "result"; requestId: string; ok: false; error: { code: string; message: string } };

