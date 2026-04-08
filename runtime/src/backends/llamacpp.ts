import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GenerateParams, LlmBackend, TokenSink } from "../types";

type LlamaCppConfig = {
  modelPath: string;
  llamaBinPath: string;
  contextTokens: number;
  temperature: number;
  topP: number;
  seed: number;
  threads: number;
  gpuLayers: number;
};

function resolvePathFromCwd(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export class LlamaCppCliBackend implements LlmBackend {
  constructor(private readonly cfg: LlamaCppConfig) {}

  async generate(params: GenerateParams, onToken: TokenSink, signal: AbortSignal): Promise<"eos" | "stop"> {
    const bin = resolvePathFromCwd(this.cfg.llamaBinPath);
    const model = resolvePathFromCwd(this.cfg.modelPath);
    if (!fs.existsSync(bin)) throw new Error(`llama.cpp binary not found at ${bin}`);
    if (!fs.existsSync(model)) throw new Error(`Model not found at ${model}`);

    // NOTE: We intentionally do NOT pass arbitrary flags from the client.
    // Determinism: seed is fixed in config; prompt is the only client-controlled input.
    const args: string[] = [
      "-m",
      model,
      "-n",
      String(params.maxTokens),
      "--ctx-size",
      String(this.cfg.contextTokens),
      "--temp",
      String(this.cfg.temperature),
      "--top-p",
      String(this.cfg.topP),
      "--seed",
      String(this.cfg.seed),
      "-t",
      String(this.cfg.threads),
      "-ngl",
      String(this.cfg.gpuLayers),
      // Prompt as a single argument; avoid shell.
      "-p",
      params.prompt,
      // Emit tokens as they are produced.
      "--log-disable"
    ];

    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let resolved = false;
    const stopSeqs = params.stop;

    let buffer = "";
    const abortHandler = () => {
      if (!child.killed) child.kill();
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    return await new Promise<"eos" | "stop">((resolve, reject) => {
      const finish = (v: "eos" | "stop", err?: Error) => {
        if (resolved) return;
        resolved = true;
        signal.removeEventListener("abort", abortHandler);
        if (err) reject(err);
        else resolve(v);
      };

      const maybeEmit = (text: string) => {
        if (text.length === 0) return;
        onToken(text);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        buffer += s;

        // Stop sequences (simple scan). For higher performance later: streaming KMP/Aho-Corasick.
        for (const stop of stopSeqs) {
          const idx = buffer.indexOf(stop);
          if (idx !== -1) {
            const before = buffer.slice(0, idx);
            maybeEmit(before);
            buffer = "";
            if (!child.killed) child.kill();
            finish("stop");
            return;
          }
        }

        // Emit incrementally. Keep a small tail to avoid splitting stop sequences across chunks.
        const tailKeep = Math.min(64, buffer.length);
        const emitLen = buffer.length - tailKeep;
        if (emitLen > 0) {
          const out = buffer.slice(0, emitLen);
          buffer = buffer.slice(emitLen);
          maybeEmit(out);
        }
      });

      child.stderr.on("data", () => {
        // Intentionally ignored; stderr is not streamed to clients.
      });

      child.on("error", (e: unknown) => finish("eos", e instanceof Error ? e : new Error("llama.cpp spawn failed")));
      child.on("close", (code: number | null) => {
        if (resolved) return;
        if (signal.aborted) return finish("eos", new DOMException("Aborted", "AbortError") as unknown as Error);
        // Flush remaining buffer
        if (buffer.length) {
          maybeEmit(buffer);
          buffer = "";
        }
        if (code === 0) finish("eos");
        else finish("eos", new Error(`llama.cpp exited with code ${code ?? "null"}`));
      });
    });
  }
}

