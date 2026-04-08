import type { RagClient } from "./ragClient";
import type { AgentConfig } from "./types";
import { RuntimeModel } from "./model";
import { PromptBuilder, type RagSnippet } from "../../shared/promptBuilder";

export type PlanStepAction = "tool_call" | "reasoning" | "final";

export type PlanStep = {
  id: string;
  action: PlanStepAction;
  description: string;
  tool?: string;
  params: Record<string, unknown>;
};

export type Plan = {
  goal: string;
  steps: PlanStep[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function validatePlanStep(v: unknown): PlanStep | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const action = asString(v.action);
  const description = asString(v.description);
  const tool = v.tool === undefined ? undefined : asString(v.tool);
  const params = v.params;
  if (!id || !action || !description) return null;
  if (action !== "tool_call" && action !== "reasoning" && action !== "final") return null;
  if (tool !== undefined && tool === null) return null;
  if (!isRecord(params)) return null;
  return { id, action, description, tool, params };
}

export function validatePlan(v: unknown): Plan | null {
  if (!isRecord(v)) return null;
  const goal = asString(v.goal);
  const stepsRaw = v.steps;
  if (!goal || !Array.isArray(stepsRaw)) return null;
  const steps: PlanStep[] = [];
  for (const s of stepsRaw) {
    const st = validatePlanStep(s);
    if (!st) return null;
    steps.push(st);
  }
  return { goal, steps };
}

function extractFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function deterministicFallbackPlan(instruction: string): Plan {
  const goal = instruction.trim().slice(0, 240) || "Respond to the user request.";
  return {
    goal,
    steps: [
      {
        id: "step1",
        action: "final",
        description: "Provide a safe response without tools (planning fallback).",
        params: {}
      }
    ]
  };
}

export type PlannerDeps = {
  promptBuilder: PromptBuilder;
  rag: RagClient | null;
  model: RuntimeModel | null;
  cfg: Pick<AgentConfig, "llmMaxTokens">;
};

export class Planner {
  constructor(private readonly deps: PlannerDeps) {}

  async plan(instruction: string, historyText: string, signal: AbortSignal): Promise<Plan> {
    // Deterministic, bounded RAG for planning context (best-effort).
    let ragSnippets: RagSnippet[] = [];
    if (this.deps.rag) {
      try {
        const q = (instruction + "\n" + historyText).slice(-3000);
        ragSnippets = (await this.deps.rag.query(q, 6, 120)).slice(0, 6);
      } catch {
        ragSnippets = [];
      }
    }

    if (!this.deps.model) return deterministicFallbackPlan(instruction);

    const systemConstraints = [
      "You are a planning module in an offline, deterministic, auditable coding assistant.",
      "You MUST NOT execute tools.",
      "You MUST output STRICT JSON only.",
      "Plan format:",
      '{"goal":"...","steps":[{"id":"step1","action":"tool_call|reasoning|final","description":"...","tool":"optional","params":{}}]}',
      "Constraints:",
      "- Maximum 8 steps.",
      "- Deterministic ordering: step ids must be step1..stepN.",
      "- For tool_call steps, tool must be one of: read_file, write_file, apply_diff, list_files, search_code.",
      "- For reasoning steps, omit tool; params must be {}.",
      "- For final steps, omit tool; params must be {}."
    ];

    const built = this.deps.promptBuilder.build({
      systemConstraints,
      goal: "Create a structured plan for the user instruction.",
      instruction,
      ragSnippets,
      historyText,
      maxChars: 32000,
      extraSections: [
        {
          title: "Output requirements",
          content: [
            "Return ONLY the JSON object.",
            "Do not wrap in markdown.",
            "Do not include trailing commas."
          ].join("\n")
        }
      ]
    });

    const text = await this.deps.model.generate(built.prompt, this.deps.cfg.llmMaxTokens, signal);
    const parsed = extractFirstJsonObject(text);
    const plan = validatePlan(parsed);
    if (!plan) return deterministicFallbackPlan(instruction);

    // Enforce hard constraints deterministically (no throwing).
    const steps = plan.steps.slice(0, 8).map((s, i) => ({
      ...s,
      id: `step${i + 1}`,
      params: isRecord(s.params) ? s.params : {}
    }));

    return { goal: plan.goal, steps };
  }
}

