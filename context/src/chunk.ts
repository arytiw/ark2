export type Chunk = { id: string; text: string; meta: Record<string, unknown> };

export function chunkText(opts: {
  path: string;
  content: string;
  chunkChars: number;
  overlap: number;
}): Chunk[] {
  const { path, content, chunkChars, overlap } = opts;
  const chunks: Chunk[] = [];
  const step = Math.max(1, chunkChars - overlap);
  let idx = 0;
  let n = 0;
  while (idx < content.length) {
    const slice = content.slice(idx, idx + chunkChars);
    const id = `${path}::${n}`;
    const preview = slice.slice(0, 400);
    chunks.push({
      id,
      text: slice,
      meta: { path, chunk: n, start: idx, end: idx + slice.length, preview }
    });
    n++;
    idx += step;
    if (chunks.length > 200000) break; // hard cap safety
  }
  return chunks;
}

