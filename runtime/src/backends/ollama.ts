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

export class OllamaBackend implements LlmBackend {
  constructor(private readonly cfg: OllamaConfig) {
    // Localhost-only enforcement: prevent SSRF to external domains.
    try {
      const url = new URL(this.cfg.baseUrl);
      const host = url.hostname;
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
        throw new Error(`Security violation: Ollama backend must use localhost. Received: ${host}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("Security violation")) throw e;
      throw new Error(`Invalid Ollama baseUrl: ${this.cfg.baseUrl}`);
    }
  }

  async generate(params: GenerateParams, onToken: TokenSink, signal: AbortSignal): Promise<"eos" | "stop"> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/api/generate`;

    const body = {
      model: this.cfg.model,
      prompt: params.prompt,
      stream: true,
      options: {
        num_predict: params.maxTokens,
        stop: params.stop,
        temperature: this.cfg.temperature,
        top_p: this.cfg.topP,
        seed: this.cfg.seed,
        num_thread: this.cfg.threads,
        num_ctx: this.cfg.contextTokens
      }
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "Unknown error");
      throw new Error(`Ollama error (${res.status}): ${errorText}`);
    }

    if (!res.body) throw new Error("Ollama response body is empty");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reason: "eos" | "stop" = "eos";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.response) {
              onToken(parsed.response);
            }
            if (parsed.done) {
              if (parsed.done_reason === "stop") reason = "stop";
            }
          } catch (e) {
            console.error("[OllamaBackend] JSON parse error", e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return reason;
  }
}
