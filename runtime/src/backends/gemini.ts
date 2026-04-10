import type { GenerateParams, LlmBackend, TokenSink } from "../types";
import { Logger } from "../logger";

const logger = new Logger("gemini");

export type GeminiConfig = {
  apiKey: string;
  model: string;
};

export class GeminiApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GeminiApiError";
  }
}

export class GeminiBackend implements LlmBackend {
  constructor(private readonly cfg: GeminiConfig) {
    if (!cfg.apiKey) {
      throw new Error("Gemini API key missing");
    }
  }

  async generate(params: GenerateParams, onToken: TokenSink, signal: AbortSignal): Promise<"eos" | "stop"> {
    logger.info("Gemini request", { model: this.cfg.model });

    const modelResource = this.cfg.model.startsWith("models/") 
      ? this.cfg.model 
      : `models/${this.cfg.model}`;

    // Validate model before calling generateContent
    const modelUrl = `https://generativelanguage.googleapis.com/v1beta/${modelResource}?key=${this.cfg.apiKey}`;
    try {
      const modelRes = await fetch(modelUrl, { signal });
      if (!modelRes.ok) {
        throw new GeminiApiError("E_CONFIG", "Unsupported Gemini model");
      }
      const modelData = await modelRes.json();
      if (!modelData.supportedGenerationMethods?.includes("generateContent")) {
        throw new GeminiApiError("E_CONFIG", "Unsupported Gemini model");
      }
    } catch (err: any) {
      if (err instanceof GeminiApiError) throw err;
      throw new GeminiApiError("E_CONFIG", "Unsupported Gemini model");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/${modelResource}:generateContent?key=${this.cfg.apiKey}`;

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

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
    } catch (err: any) {
      logger.error("Gemini API failure", { status: "network_error", message: err.message });
      throw new GeminiApiError("E_BACKEND", "Gemini API error: " + err.message);
    }

    if (!res.ok) {
      let msg = "Unknown error";
      let code = "E_BACKEND";
      let status = res.status;
      try {
        const errorText = await res.text();
        msg = errorText;
        try {
          const errData = JSON.parse(errorText);
          if (errData.error) {
            msg = errData.error.message || msg;
            code = errData.error.code || code;
          }
        } catch { }
      } catch { }
      
      logger.error("Gemini API failure", { status, message: msg });
      throw new GeminiApiError("E_BACKEND", "Gemini API error: " + msg);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (typeof text !== "string") {
      throw new Error("E_PARSE: Invalid Gemini response format");
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
