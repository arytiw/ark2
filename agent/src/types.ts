export type AgentConfig = {
  host: string;
  port: number;
  auditLogDir: string;
  maxSteps: number;
  timeoutMs: number;
  modelSource: "runtime" | "mock";
  llmMaxTokens: number;
};

export type RootConfig = {
  runtime: { host: string; port: number };
  tools: { host: string; port: number };
  embeddings: { host: string; port: number };
  agent: AgentConfig;
};

export type ClientToAgent =
  | { type: "task"; taskId: string; instruction: string; mode?: "chat" | "agent" | "plan" }
  | { type: "cancel"; taskId: string }
  | { type: "ping"; requestId: string };

export type AgentToClient =
  | { type: "ready"; version: string }
  | { type: "pong"; requestId: string; t: number }
  | { type: "event"; taskId: string; event: AgentEvent }
  | { type: "final"; taskId: string; ok: boolean; result?: string; error?: { code: string; message: string } };

export type AgentEvent =
  | { kind: "step_start"; step: number }
  | { kind: "model_action"; step: number; action: unknown }
  | { kind: "tool_call"; step: number; requestId: string; tool: string; params: unknown }
  | { kind: "tool_result"; step: number; requestId: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }
  | { kind: "step_end"; step: number };

export type RuntimeGenerate = { type: "generate"; requestId: string; prompt: string; maxTokens?: number; stop?: string[] };
export type RuntimeCancel = { type: "cancel"; requestId: string };

export type RuntimeServerMsg =
  | { type: "ready"; version: string }
  | { type: "token"; requestId: string; token: string }
  | { type: "done"; requestId: string; reason: "eos" | "stop" | "cancel" | "error" }
  | { type: "error"; requestId?: string; code: string; message: string };

export type ToolCall = { type: "tool_call"; requestId: string; tool: string; params: Record<string, unknown> };
export type ToolResult =
  | { type: "tool_result"; requestId: string; ok: true; result: unknown }
  | { type: "tool_result"; requestId: string; ok: false; error: { code: string; message: string } };

export type ModelAction =
  | { action: "tool"; tool: "read_file" | "write_file" | "apply_diff" | "list_files" | "search_code"; params: Record<string, unknown> }
  | { action: "final"; answer: string };

