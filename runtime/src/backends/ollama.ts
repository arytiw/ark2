import type { GenerateParams, LlmBackend, TokenSink } from "../types";

type OllamaConfig = {
  baseUrl: string; // e.g. http://127.0.0.1:11434
  model: string; // e.g. gpt-oss:20b
  contextTokens: number;
  temperature: number;
  topP: number;
  seed: number;
  threads: number;
};

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export class OllamaBackend implements LlmBackend {
  private readonly baseUrl: string;

  constructor(private readonly cfg: OllamaConfig) {
    this.baseUrl = normalizeBaseUrl(cfg.baseUrl);
  }

  async generate(params: GenerateParams, onToken: TokenSink, signal: AbortSignal): Promise<"eos" | "stop"> {
    const stopSeqs = params.stop;
    let buffer = "";

    const body = {
      model: this.cfg.model,
      prompt: params.prompt,
      stream: true,
      // Ask Ollama to apply stop as well; we still enforce stop client-side deterministically.
      stop: stopSeqs,
      options: {
        num_ctx: this.cfg.contextTokens,
        num_predict: params.maxTokens,
        temperature: this.cfg.temperature,
        top_p: this.cfg.topP,
        seed: this.cfg.seed,
        num_thread: this.cfg.threads
      }
    };

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 400)}`);
    }
    if (!res.body) throw new Error("Ollama response has no body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");

    const maybeEmit = (text: string) => {
      if (text.length === 0) return;
      onToken(text);
    };

    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      const split = splitLines(buffer);
      buffer = split.rest;

      for (const line of split.lines) {
        const trimmed = line.trim();
        if (!trimmed.length) continue;

        let obj: unknown;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          // Ignore malformed lines; keep deterministic behavior.
          continue;
        }

        if (typeof obj !== "object" || obj === null) continue;
        const rec = obj as Record<string, unknown>;
        const responsePart = typeof rec.response === "string" ? rec.response : "";
        const doneFlag = rec.done === true;

        if (responsePart.length) {
          buffer = buffer; // no-op (keeps logic obvious)

          // Client-side stop enforcement: scan accumulated output to avoid split stop sequences.
          // Keep a rolling tail in `outBuf`.
          let outBuf = responsePart;
          for (const stop of stopSeqs) {
            const idx = outBuf.indexOf(stop);
            if (idx !== -1) {
              maybeEmit(outBuf.slice(0, idx));
              return "stop";
            }
          }

          maybeEmit(outBuf);
        }

        if (doneFlag) {
          // Ollama finished normally.
          return "eos";
        }
      }
    }

    // If the stream ended without a done=true line, treat as eos.
    return "eos";
  }
}

