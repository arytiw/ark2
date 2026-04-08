export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type ClientToServer =
  | {
      type: "generate";
      requestId: string;
      prompt: string;
      maxTokens?: number;
      stop?: string[];
    }
  | {
      type: "cancel";
      requestId: string;
    }
  | {
      type: "ping";
      requestId: string;
    };

export type ServerToClient =
  | { type: "ready"; version: string }
  | { type: "pong"; requestId: string; t: number }
  | { type: "token"; requestId: string; token: string }
  | { type: "done"; requestId: string; reason: "eos" | "stop" | "cancel" | "error" }
  | { type: "error"; requestId?: string; code: string; message: string };

export type Config = {
  runtime: {
    host: string;
    port: number;
    auditLogDir: string;
  };
  llm: {
    backend: "llamacpp" | "mock" | "ollama";
    modelPath: string;
    llamaBinPath: string;
    // Ollama config (used only when llm.backend === "ollama")
    ollamaBaseUrl?: string;
    ollamaModel?: string;
    contextTokens: number;
    temperature: number;
    topP: number;
    seed: number;
    threads: number;
    gpuLayers: number;
  };
};

export type GenerateParams = {
  requestId: string;
  prompt: string;
  maxTokens: number;
  stop: string[];
};

export type TokenSink = (token: string) => void;

export interface LlmBackend {
  generate(params: GenerateParams, onToken: TokenSink, signal: AbortSignal): Promise<"eos" | "stop">;
}
