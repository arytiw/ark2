import type { RagClient } from "./ragClient";
import { RuntimeModel } from "./model";
import { PromptBuilder, type RagSnippet } from "../../shared/promptBuilder";

export type VerifyStatus = "success" | "retry" | "revise_plan" | "fail";

export type VerifyResult = {
  status: VerifyStatus;
  reason: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

export function validateVerifyResult(v: unknown): VerifyResult | null {
  if (!isRecord(v)) return null;
  const status = v.status;
  const reason = v.reason;
  if (status !== "success" && status !== "retry" && status !== "revise_plan" && status !== "fail") return null;
  if (typeof reason !== "string" || reason.length === 0) return null;
  return { status, reason };
}

export type VerifierDeps = {
  promptBuilder: PromptBuilder;
  rag: RagClient | null;
  model: RuntimeModel | null;
};

export type VerifyInputs = {
  stepDescription: string;
  toolResultSummary: string;
  workspaceSummary: string;
  historyText: string;
  instruction: string;
};

export class Verifier {
  constructor(private readonly deps: VerifierDeps) {}

  async verify(input: VerifyInputs, signal: AbortSignal): Promise<VerifyResult> {
    // If no model configured, be conservative and accept tool results (keeps offline deterministic pipeline runnable).
    if (!this.deps.model) return { status: "success", reason: "No verifier model configured; accepting outcome." };

    let ragSnippets: RagSnippet[] = [];
    if (this.deps.rag) {
      try {
        const q = (input.instruction + "\n" + input.stepDescription + "\n" + input.toolResultSummary).slice(-2500);
        ragSnippets = (await this.deps.rag.query(q, 4, 120)).slice(0, 4);
      } catch {
        ragSnippets = [];
      }
    }

    const systemConstraints = [
      "You are the verifier in an offline, deterministic, auditable coding assistant.",
      "You MUST output STRICT JSON only.",
      'Output format: {"status":"success|retry|revise_plan|fail","reason":"..."}',
      "Rules:",
      "- Choose success only if the outcome matches the step intent.",
      "- Choose retry if the tool likely failed transiently or params were slightly off.",
      "- Choose revise_plan if the outcome diverged and continuing would be unsafe or ineffective.",
      "- Choose fail only if unsafe, impossible, or constraints violated."
    ];

    const built = this.deps.promptBuilder.build({
      systemConstraints,
      goal: "Verify whether the step outcome matches the intent safely.",
      instruction: input.instruction,
      ragSnippets,
      historyText: input.historyText,
      maxChars: 28000,
      extraSections: [
        { title: "Step description", content: input.stepDescription },
        { title: "Tool result summary", content: input.toolResultSummary || "(none)" },
        { title: "Workspace state summary", content: input.workspaceSummary || "(none)" }
      ]
    });

    const text = await this.deps.model.generate(built.prompt, 256, signal);
    const parsed = extractFirstJsonObject(text);
    const verdict = validateVerifyResult(parsed);
    return verdict ?? { status: "revise_plan", reason: "Verifier produced invalid JSON; requesting re-plan." };
  }
}

