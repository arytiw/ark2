export type ToolName = "read_file" | "write_file" | "apply_diff" | "list_files" | "search_code";

export type ToolCall = {
  type: "tool_call";
  requestId: string;
  tool: ToolName;
  params: Record<string, unknown>;
};

export type ToolResultOk = {
  type: "tool_result";
  requestId: string;
  ok: true;
  result: unknown;
};

export type ToolResultErr = {
  type: "tool_result";
  requestId: string;
  ok: false;
  error: { code: string; message: string };
};

export type ServerMsg = ToolResultOk | ToolResultErr | { type: "ready"; version: string };

export type ToolsConfig = {
  host: string;
  port: number;
  auditLogDir: string;
  backupDir: string;
  maxFileBytes: number;
  maxListEntries: number;
  maxSearchMatches: number;
};

export type RootConfig = {
  tools: ToolsConfig;
};

