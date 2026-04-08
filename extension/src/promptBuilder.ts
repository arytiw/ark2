import type * as vscode from "vscode";

export type PromptBuildConfig = {
  maxPrefixChars: number;
  maxSuffixChars: number;
  ragSnippets: Array<{ path: string; preview: string; score: number }>;
};

function clampText(s: string, maxChars: number, fromEnd: boolean): string {
  if (s.length <= maxChars) return s;
  return fromEnd ? s.slice(s.length - maxChars) : s.slice(0, maxChars);
}

export function buildCompletionPrompt(doc: vscode.TextDocument, pos: vscode.Position, cfg: PromptBuildConfig): string {
  const full = doc.getText();
  const offset = doc.offsetAt(pos);
  const prefix = clampText(full.slice(0, offset), cfg.maxPrefixChars, true);
  const suffix = clampText(full.slice(offset), cfg.maxSuffixChars, false);
  const ragSection = cfg.ragSnippets
    .map((s, i) => `#${i + 1} path=${s.path} score=${s.score.toFixed(4)}\n${s.preview}`)
    .join("\n\n");

  // Minimal deterministic format. Phase 6 will replace this with RAG context.
  return [
    "You are an offline coding assistant.",
    "Complete the code at the cursor position.",
    "Return only the code to insert at the cursor. No markdown.",
    "",
    `File: ${doc.uri.fsPath}`,
    `Language: ${doc.languageId}`,
    "",
    "Retrieved code context:",
    ragSection || "(none)",
    "",
    "Prefix (immediately before cursor):",
    prefix,
    "",
    "Suffix (immediately after cursor):",
    suffix,
    "",
    "Insertion:"
  ].join("\n");
}

