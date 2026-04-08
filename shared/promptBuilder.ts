export type RagSnippet = { path: string; preview: string; score: number };

export type PromptSection = {
  title: string;
  content: string;
};

export type PromptBuildInput = {
  systemConstraints: string[];
  goal: string;
  instruction: string;
  ragSnippets?: RagSnippet[];
  toolSchemasText?: string;
  historyText?: string;
  extraSections?: PromptSection[];
  maxChars?: number;
};

export type BuiltPrompt = {
  prompt: string;
  truncated: boolean;
  approxChars: number;
};

function stableJoin(sections: PromptSection[]): string {
  return sections
    .map((s) => {
      const header = s.title.length ? `## ${s.title}\n` : "";
      return header + (s.content || "");
    })
    .join("\n\n")
    .trimEnd();
}

function clampTail(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: "", truncated: true };
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(text.length - maxChars), truncated: true };
}

function formatRag(snips: RagSnippet[] | undefined): string {
  if (!snips || snips.length === 0) return "(none)";
  return snips
    .map((s, i) => `#${i + 1} path=${s.path} score=${s.score.toFixed(4)}\n${s.preview}`)
    .join("\n\n");
}

export class PromptBuilder {
  // Char budgeting is deterministic and avoids tokenizers/deps.
  build(input: PromptBuildInput): BuiltPrompt {
    const maxChars = typeof input.maxChars === "number" && Number.isFinite(input.maxChars) ? Math.max(2000, Math.floor(input.maxChars)) : 32000;

    const base: PromptSection[] = [
      {
        title: "System",
        content: [
          ...input.systemConstraints,
          "",
          "You MUST respond with exactly one JSON object and nothing else."
        ].join("\n")
      },
      { title: "Goal", content: input.goal },
      { title: "Task instruction", content: input.instruction }
    ];

    const ragSec: PromptSection = { title: "Retrieved code context", content: formatRag(input.ragSnippets) };
    const toolSec: PromptSection | null = input.toolSchemasText ? { title: "Tool schemas", content: input.toolSchemasText } : null;
    const histSec: PromptSection | null = typeof input.historyText === "string" ? { title: "History", content: input.historyText.length ? input.historyText : "(none)" } : null;

    const extra = input.extraSections ?? [];
    const ordered = [...base, ragSec, ...(toolSec ? [toolSec] : []), ...(histSec ? [histSec] : []), ...extra];
    const assembled = stableJoin(ordered);

    const clamped = clampTail(assembled, maxChars);
    return { prompt: clamped.text, truncated: clamped.truncated, approxChars: clamped.text.length };
  }
}

