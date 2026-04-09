import type { AgentConfig, AgentEvent, ModelAction, RootConfig, ToolResult } from "./types";
import { AuditLogger } from "./audit";
import { ToolsClient } from "./toolClient";
import { MockModel, RuntimeModel } from "./model";
import { RagClient } from "./ragClient";
import { PromptBuilder } from "../../shared/promptBuilder";
import { Planner } from "./planner";
import { Executor } from "./executor";
import { Verifier } from "./verifier";
import { ActionBudget } from "./actionBudget";
import { Logger } from "./logger";

type Emit = (ev: AgentEvent) => void;

function truncateForHistory(v: unknown, maxChars: number): string {
  const s = JSON.stringify(v);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "...(truncated)";
}

function summarizeToolResult(res: ToolResult): string {
  if (res.ok) return truncateForHistory({ ok: true, result: res.result }, 4000);
  return truncateForHistory({ ok: false, error: res.error }, 4000);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractJsonAnswer(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (isRecord(obj) && typeof obj.answer === "string") return obj.answer;
  } catch {}
  return null;
}

export class AgentLoop {
  private readonly toolsUrl: string;
  private readonly runtimeUrl: string;
  private readonly embeddingsUrl: string;

  constructor(
    private readonly projectCfg: RootConfig,
    private readonly audit: AuditLogger,
    private readonly logger: Logger
  ) {
    this.toolsUrl = `ws://${projectCfg.tools.host}:${projectCfg.tools.port}`;
    this.runtimeUrl = `ws://${projectCfg.runtime.host}:${projectCfg.runtime.port}`;
    this.embeddingsUrl = `ws://${projectCfg.embeddings.host}:${projectCfg.embeddings.port}`;
  }

  async runTask(taskId: string, instruction: string, emit: Emit, signal: AbortSignal, mode: "chat" | "agent" | "plan" = "agent"): Promise<string> {
    const cfg: AgentConfig = this.projectCfg.agent;
    const tools = new ToolsClient(this.toolsUrl);
    const rag = new RagClient(this.embeddingsUrl);
    const runtimeModel = cfg.modelSource === "runtime" ? new RuntimeModel(this.runtimeUrl) : null;
    const mockModel = cfg.modelSource === "mock" ? new MockModel() : null;

    await tools.connect();
    await rag.connect();
    if (runtimeModel) await runtimeModel.connect();

    let history = "";
    const startedAt = Date.now();
    this.logger.info("Agent task started", { taskId });

    try {
      // Preserve Phase 5 behavior in mock mode (no planning/verifying).
      if (mockModel) {
        for (let step = 1; step <= cfg.maxSteps; step++) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          if (Date.now() - startedAt > cfg.timeoutMs) throw new Error("Agent timeout.");

          emit({ kind: "step_start", step });
          const action = mockModel.proposeAction(instruction, mode);
          this.logger.info("Agent step", { step, action });
          this.logger.debug("Agent action", { action });
          emit({ kind: "model_action", step, action });

          if (action.action === "final") {
            emit({ kind: "step_end", step });
            return action.answer;
          }

          const toolReqId = `${taskId}:${step}`;
          emit({ kind: "tool_call", step, requestId: toolReqId, tool: action.tool, params: action.params });
          const res = await tools.call(action.tool, action.params, signal);
          if (res.ok) emit({ kind: "tool_result", step, requestId: toolReqId, ok: true, result: res.result });
          else emit({ kind: "tool_result", step, requestId: toolReqId, ok: false, error: res.error });
          emit({ kind: "step_end", step });

          // In mock mode, finish after the first tool call (keeps Phase 5 runnable without an LLM).
          if (!res.ok) return `Tool error: ${res.error.code}: ${res.error.message}`;
          return JSON.stringify(res.result, null, 2);
        }
        return "Max steps reached without a final answer.";
      }

      if (!runtimeModel) throw new Error("No model configured.");

      const promptBuilder = new PromptBuilder();
      const planner = new Planner({ promptBuilder, rag, model: runtimeModel, cfg: { llmMaxTokens: cfg.llmMaxTokens } });
      const executor = new Executor({ tools });
      const verifier = new Verifier({ promptBuilder, rag, model: runtimeModel });

      const budget = new ActionBudget({
        maxSteps: cfg.maxSteps,
        timeoutMs: cfg.timeoutMs,
        // Conservative defaults; Phase 7 adds enforcement without changing tools service.
        maxToolCalls: cfg.maxSteps * 2,
        maxFilesTouched: 80,
        maxBytesWritten: 2_000_000
      });

      // Handle CHAT mode (Direct response, no tools)
      if (mode === "chat") {
        emit({ kind: "step_start", step: 1 });
        this.logger.info("Agent step", { step: 1, mode: "chat" });
        const built = promptBuilder.build({
          systemConstraints: [
            "You are a coding assistant. Do not call tools.",
            "Provide helpful, concise explanations or code snippets.",
            "You MUST output STRICT JSON only: {\"answer\":\"...\"}"
          ],
          goal: "Respond to the user request directly.",
          instruction,
          ragSnippets: [], // Could add RAG here if needed
          historyText: "",
          maxChars: 28000
        });
        const text = await runtimeModel.generate(built.prompt, cfg.llmMaxTokens, signal);
        const answer = extractJsonAnswer(text) ?? "Model did not return a valid final JSON answer.";
        emit({ kind: "model_action", step: 1, action: { kind: "final_json", raw: truncateForHistory(text, 1200) } });
        emit({ kind: "step_end", step: 1 });
        return answer;
      }

      // PLAN (Step 1 for both Agent and Plan modes)
      emit({ kind: "step_start", step: 1 });
      this.logger.info("Agent step", { step: 1, mode: "planning" });
      const plan = await planner.plan(instruction, history, signal);
      this.logger.debug("Agent action", { plan });
      emit({ kind: "model_action", step: 1, action: { kind: "plan", plan } });
      emit({ kind: "step_end", step: 1 });

      // Handle PLAN mode (Stop after planning)
      if (mode === "plan") {
        return `Plan created successfully:\n\nGoal: ${plan.goal}\n\n` + 
               plan.steps.map(s => `- ${s.id}: ${s.description}${s.tool ? ` (Tool: ${s.tool})` : ""}`).join("\n");
      }

      // EXECUTE + VERIFY (Agent mode only)
      let planStepIndex = 0;
      for (let orchestrationStep = 2; orchestrationStep <= cfg.maxSteps + 1; orchestrationStep++) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (planStepIndex >= plan.steps.length) return "Plan completed without a final answer.";

        const check = budget.canStartNextStep();
        if (!check.ok) return `Budget halt: ${check.message}`;

        const step = plan.steps[planStepIndex];
        budget.noteStepExecuted();
        emit({ kind: "step_start", step: orchestrationStep });

        // Handle planner-produced final step deterministically.
        if (step.action === "final") {
          const built = promptBuilder.build({
            systemConstraints: [
              "You are an offline agent producing the final answer.",
              "You MUST output STRICT JSON only: {\"answer\":\"...\"}",
              "No tool calls."
            ],
            goal: plan.goal,
            instruction,
            ragSnippets: [],
            historyText: history,
            extraSections: [{ title: "Plan step", content: `${step.id}: ${step.description}` }],
            maxChars: 28000
          });
          const text = await runtimeModel.generate(built.prompt, cfg.llmMaxTokens, signal);
          const answer = extractJsonAnswer(text) ?? "Model did not return a valid final JSON answer.";
          emit({ kind: "model_action", step: orchestrationStep, action: { kind: "final_json", raw: truncateForHistory(text, 1200) } });
          emit({ kind: "step_end", step: orchestrationStep });
          return answer;
        }

        // Reasoning steps are recorded into history but do not execute tools here.
        if (step.action === "reasoning") {
          const entry = { planStep: step.id, kind: "reasoning", description: step.description };
          history += (history ? "\n" : "") + truncateForHistory(entry, 2000);
          if (history.length > 30000) history = history.slice(history.length - 30000);
          emit({ kind: "model_action", step: orchestrationStep, action: { kind: "reasoning_noop", stepId: step.id } });
          emit({ kind: "step_end", step: orchestrationStep });
          planStepIndex += 1;
          continue;
        }

        // tool_call
        budget.noteToolCall();
        const toolReqId = `${taskId}:plan:${step.id}`;
        emit({ kind: "tool_call", step: orchestrationStep, requestId: toolReqId, tool: step.tool ?? "", params: step.params });
        const execRes = await executor.executeOneStep(step, signal);

        if (execRes.kind !== "tool_result") {
          emit({ kind: "tool_result", step: orchestrationStep, requestId: toolReqId, ok: false, error: { code: "E_EXEC", message: execRes.reason } });
          emit({ kind: "step_end", step: orchestrationStep });
          return `Execution halted: ${execRes.reason}`;
        }

        const res = execRes.result;
        budget.noteToolResult(execRes.tool, res);
        if (res.ok) emit({ kind: "tool_result", step: orchestrationStep, requestId: toolReqId, ok: true, result: res.result });
        else emit({ kind: "tool_result", step: orchestrationStep, requestId: toolReqId, ok: false, error: res.error });

        const toolResultSummary = summarizeToolResult(res);
        const entry = { planStep: step.id, tool: execRes.tool, ok: res.ok, result: res.ok ? res.result : res.error };
        history += (history ? "\n" : "") + truncateForHistory(entry, 6000);
        if (history.length > 30000) history = history.slice(history.length - 30000);

        // Workspace summary: best-effort and bounded; use RAG query as a proxy for state summary.
        const workspaceSummary = "Workspace state is summarized via RAG snippets and tool results; no direct filesystem scanning here.";

        const verdict = await verifier.verify(
          {
            instruction,
            stepDescription: `${step.id}: ${step.description}`,
            toolResultSummary,
            workspaceSummary,
            historyText: history
          },
          signal
        );
        emit({ kind: "model_action", step: orchestrationStep, action: { kind: "verdict", verdict } });
        emit({ kind: "step_end", step: orchestrationStep });

        if (verdict.status === "success") {
          planStepIndex += 1;
          continue;
        }
        if (verdict.status === "retry") {
          // Retry same step once by not advancing index; budget will enforce bounds.
          continue;
        }
        if (verdict.status === "revise_plan") {
          // Controlled re-plan using updated history.
          const revised = await planner.plan(instruction, history, signal);
          emit({ kind: "model_action", step: orchestrationStep, action: { kind: "replan", plan: revised, reason: verdict.reason } });
          // Replace plan and restart from first step deterministically.
          (plan as any).goal = revised.goal;
          (plan as any).steps = revised.steps;
          planStepIndex = 0;
          continue;
        }
        return `Verifier failed: ${verdict.reason}`;
      }

      this.logger.info("Agent completed", { taskId });
      return "Max steps reached without a final answer.";
    } catch (e) {
      if (signal.aborted) {
        this.logger.warn("Agent aborted", { taskId, reason: "Signal aborted" });
      } else if (Date.now() - startedAt > cfg.timeoutMs) {
        this.logger.warn("Agent aborted", { taskId, reason: "Timeout" });
      }
      throw e;
    } finally {
      runtimeModel?.close();
      rag.close();
      tools.close();
    }
  }
}

