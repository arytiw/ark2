type HunkLine =
  | { kind: "context"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string };

type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
};

function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  // @@ -l,s +l,s @@
  const m = /^@@\s+-([0-9]+)(?:,([0-9]+))?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/.exec(line);
  if (!m) return null;
  const oldStart = Number(m[1]);
  const oldCount = m[2] ? Number(m[2]) : 1;
  const newStart = Number(m[3]);
  const newCount = m[4] ? Number(m[4]) : 1;
  if (!Number.isInteger(oldStart) || !Number.isInteger(oldCount) || !Number.isInteger(newStart) || !Number.isInteger(newCount)) return null;
  return { oldStart, oldCount, newStart, newCount };
}

export function applyUnifiedDiff(original: string, diffText: string): { ok: true; content: string } | { ok: false; message: string } {
  const origLines = original.split(/\r?\n/);
  const diffLines = diffText.split(/\r?\n/);

  const hunks: Hunk[] = [];
  let i = 0;

  while (i < diffLines.length) {
    const line = diffLines[i];
    if (line.startsWith("@@")) {
      const hdr = parseHunkHeader(line);
      if (!hdr) return { ok: false, message: "Invalid hunk header." };
      i++;
      const lines: HunkLine[] = [];
      while (i < diffLines.length) {
        const l = diffLines[i];
        if (l.startsWith("@@")) break;
        if (l.startsWith("--- ") || l.startsWith("+++ ")) {
          i++;
          continue;
        }
        if (l.startsWith("\\ No newline")) {
          i++;
          continue;
        }
        const tag = l.slice(0, 1);
        const text = l.slice(1);
        if (tag === " ") lines.push({ kind: "context", text });
        else if (tag === "+") lines.push({ kind: "add", text });
        else if (tag === "-") lines.push({ kind: "del", text });
        else if (l.length === 0) {
          // Empty line is valid; must have tag in unified diff though.
          return { ok: false, message: "Invalid diff line (missing prefix)." };
        } else {
          // Ignore metadata lines outside hunks.
          return { ok: false, message: `Invalid diff line prefix: ${tag}` };
        }
        i++;
      }
      hunks.push({ ...hdr, lines });
      continue;
    }
    i++;
  }

  if (hunks.length === 0) return { ok: false, message: "No hunks found." };

  // Apply hunks in order against a working array.
  const out: string[] = [];
  let srcIdx = 0; // 0-based in origLines

  for (const h of hunks) {
    const targetIdx = Math.max(0, h.oldStart - 1);
    if (targetIdx < srcIdx) return { ok: false, message: "Overlapping hunks are not supported." };

    // Copy unchanged lines before hunk
    while (srcIdx < targetIdx && srcIdx < origLines.length) {
      out.push(origLines[srcIdx]);
      srcIdx++;
    }

    // Apply hunk lines
    for (const hl of h.lines) {
      if (hl.kind === "context") {
        const cur = origLines[srcIdx];
        if (cur !== hl.text) return { ok: false, message: "Context mismatch while applying diff." };
        out.push(cur);
        srcIdx++;
      } else if (hl.kind === "del") {
        const cur = origLines[srcIdx];
        if (cur !== hl.text) return { ok: false, message: "Delete mismatch while applying diff." };
        srcIdx++;
      } else {
        // add
        out.push(hl.text);
      }
    }
  }

  // Copy remaining
  while (srcIdx < origLines.length) {
    out.push(origLines[srcIdx]);
    srcIdx++;
  }

  return { ok: true, content: out.join("\n") };
}

