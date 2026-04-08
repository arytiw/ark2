import type { ToolResult } from "./types";

export type ActionBudgetLimits = {
  maxSteps: number;
  maxFilesTouched: number;
  maxBytesWritten: number;
  maxToolCalls: number;
  timeoutMs: number;
};

export type ActionBudgetUsage = {
  stepsExecuted: number;
  toolCalls: number;
  filesTouched: number;
  bytesWritten: number;
  elapsedMs: number;
};

export type BudgetCheck =
  | { ok: true }
  | { ok: false; code: "E_BUDGET"; message: string; usage: ActionBudgetUsage; limits: ActionBudgetLimits };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractTouchedPath(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const p = result.path;
  return typeof p === "string" && p.length ? p : null;
}

function extractBytesWritten(result: unknown): number {
  if (!isRecord(result)) return 0;
  const bytes = result.bytes;
  if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) return Math.floor(bytes);
  return 0;
}

export class ActionBudget {
  private readonly startedAt = Date.now();
  private stepsExecuted = 0;
  private toolCalls = 0;
  private bytesWritten = 0;
  private readonly touched = new Set<string>();

  constructor(private readonly limits: ActionBudgetLimits) {}

  usage(nowMs: number = Date.now()): ActionBudgetUsage {
    return {
      stepsExecuted: this.stepsExecuted,
      toolCalls: this.toolCalls,
      filesTouched: this.touched.size,
      bytesWritten: this.bytesWritten,
      elapsedMs: nowMs - this.startedAt
    };
  }

  canStartNextStep(): BudgetCheck {
    const u = this.usage();
    if (u.elapsedMs > this.limits.timeoutMs) return this.fail(`Timeout exceeded (${u.elapsedMs}ms > ${this.limits.timeoutMs}ms).`);
    if (u.stepsExecuted >= this.limits.maxSteps) return this.fail(`Max steps exceeded (${u.stepsExecuted} >= ${this.limits.maxSteps}).`);
    if (u.toolCalls > this.limits.maxToolCalls) return this.fail(`Max tool calls exceeded (${u.toolCalls} > ${this.limits.maxToolCalls}).`);
    if (u.filesTouched > this.limits.maxFilesTouched) return this.fail(`Max files touched exceeded (${u.filesTouched} > ${this.limits.maxFilesTouched}).`);
    if (u.bytesWritten > this.limits.maxBytesWritten) return this.fail(`Max bytes written exceeded (${u.bytesWritten} > ${this.limits.maxBytesWritten}).`);
    return { ok: true };
  }

  noteStepExecuted(): void {
    this.stepsExecuted += 1;
  }

  noteToolCall(): void {
    this.toolCalls += 1;
  }

  noteToolResult(tool: string, res: ToolResult): void {
    if (!res.ok) return;
    const touchedPath = extractTouchedPath(res.result);
    if (touchedPath) this.touched.add(`${tool}:${touchedPath}`);
    // Only count bytesWritten for mutating tools.
    if (tool === "write_file" || tool === "apply_diff") {
      this.bytesWritten += extractBytesWritten(res.result);
    }
  }

  private fail(message: string): BudgetCheck {
    return { ok: false, code: "E_BUDGET", message, usage: this.usage(), limits: this.limits };
  }
}

