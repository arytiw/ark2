import type { GenerateParams, LlmBackend, TokenSink } from "../types";

export class MockBackend implements LlmBackend {
  async generate(params: GenerateParams, onToken: TokenSink, signal: AbortSignal): Promise<"eos" | "stop"> {
    const text =
      "Mock backend active. Configure config.json llm.backend=llamacpp and set modelPath to use llama.cpp.\n\n" +
      "Prompt received:\n" +
      params.prompt +
      "\n";

    // Stream small chunks to exercise UI + cancellation.
    const chunks = text.match(/.{1,12}/gs) ?? [text];
    for (const ch of chunks) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      onToken(ch);
      await new Promise((r) => setTimeout(r, 10));
    }
    return "eos";
  }
}

