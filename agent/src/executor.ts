import type { ToolsClient } from "./toolClient";
import type { ToolResult } from "./types";
import type { PlanStep } from "./planner";

export type AllowedToolName = "read_file" | "write_file" | "apply_diff" | "list_files" | "search_code";

export type ExecutorDeps = {
  tools: ToolsClient;
  // Keeping allowlist explicit and deterministic.
  allowedTools?: ReadonlySet<AllowedToolName>;
};

export type StepExecutionResult =
  | { kind: "tool_result"; tool: AllowedToolName; result: ToolResult }
  | { kind: "no_op"; reason: string };

function isAllowedToolName(v: string): v is AllowedToolName {
  return v === "read_file" || v === "write_file" || v === "apply_diff" || v === "list_files" || v === "search_code";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Executor {
  private readonly allowed: ReadonlySet<AllowedToolName>;

  constructor(private readonly deps: ExecutorDeps) {
    this.allowed = deps.allowedTools ?? new Set<AllowedToolName>(["read_file", "write_file", "apply_diff", "list_files", "search_code"]);
  }

  async executeOneStep(step: PlanStep, signal: AbortSignal): Promise<StepExecutionResult> {
    if (step.action !== "tool_call") {
      // Planner supports these actions, but model calls / response rendering are orchestrator responsibilities.
      return { kind: "no_op", reason: `Executor does not execute '${step.action}' steps.` };
    }

    if (typeof step.tool !== "string" || !isAllowedToolName(step.tool) || !this.allowed.has(step.tool)) {
      const denied: ToolResult = { type: "tool_result", requestId: "invalid", ok: false, error: { code: "E_TOOL", message: "Tool not allowed." } };
      return { kind: "tool_result", tool: "read_file", result: denied };
    }

    const params = isRecord(step.params) ? step.params : {};
    const res = await this.deps.tools.call(step.tool, params, signal);
    return { kind: "tool_result", tool: step.tool, result: res };
  }
}

