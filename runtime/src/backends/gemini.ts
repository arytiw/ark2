import type { GenerateParams, LlmBackend, TokenSink } from "../types";

export type GeminiConfig = {
  apiKey: string;
  model: string;
};

export class GeminiBackend implements LlmBackend {
  constructor(private readonly cfg: GeminiConfig) {}

  async generate(params: GenerateParams, onToken: TokenSink, signal: AbortSignal): Promise<"eos" | "stop"> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.cfg.model}:generateContent?key=${this.cfg.apiKey}`;

    const body = {
      contents: [
        {
          parts: [{ text: params.prompt }]
        }
      ],
      generationConfig: {
        maxOutputTokens: params.maxTokens,
        stopSequences: params.stop
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
      throw new Error(`Gemini API error (${res.status}): ${errorText}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (typeof text !== "string") {
      throw new Error("Gemini API did not return valid text content.");
    }

    // Simulate streaming by splitting into tokens and emitting with a delay
    const tokens = text.split(" ");
    for (let i = 0; i < tokens.length; i++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      
      const token = tokens[i] + (i === tokens.length - 1 ? "" : " ");
      onToken(token);
      
      // Artificial delay (5-20ms)
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
    }

    return "eos";
  }
}
