import fs from "node:fs";
import path from "node:path";
import type { Config } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`${name} must be a non-empty string`);
  return v;
}

function reqInt(v: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`${name} must be an int in [${min}, ${max}]`);
  return v as number;
}

function reqNum(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) throw new Error(`${name} must be a number in [${min}, ${max}]`);
  return v;
}

function normalizeRelToRoot(rootDir: string, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(rootDir, p);
}

export function loadConfig(projectRoot: string): Config {
  const configPath = path.join(projectRoot, "config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("config.json must be an object");

  const runtime = raw.runtime;
  const llm = raw.llm;
  if (!isRecord(runtime)) throw new Error("config.runtime must be an object");
  if (!isRecord(llm)) throw new Error("config.llm must be an object");

  const host = reqString(runtime.host, "runtime.host");
  const port = reqInt(runtime.port, "runtime.port", 1, 65535);
  const auditLogDir = reqString(runtime.auditLogDir, "runtime.auditLogDir");

  const backend = reqString(llm.backend, "llm.backend");
  if (backend !== "llamacpp" && backend !== "mock" && backend !== "ollama") {
    throw new Error("llm.backend must be 'llamacpp', 'ollama', or 'mock'");
  }

  const modelPath = reqString(llm.modelPath, "llm.modelPath");
  const llamaBinPath = reqString(llm.llamaBinPath, "llm.llamaBinPath");
  const ollamaBaseUrl = typeof llm.ollamaBaseUrl === "string" && llm.ollamaBaseUrl.length ? llm.ollamaBaseUrl : "http://127.0.0.1:11434";
  const ollamaModel = typeof llm.ollamaModel === "string" && llm.ollamaModel.length ? llm.ollamaModel : "";
  const contextTokens = reqInt(llm.contextTokens, "llm.contextTokens", 128, 32768);
  const temperature = reqNum(llm.temperature, "llm.temperature", 0, 2);
  const topP = reqNum(llm.topP, "llm.topP", 0, 1);
  const seed = reqInt(llm.seed, "llm.seed", 0, 2147483647);
  const threads = reqInt(llm.threads, "llm.threads", 1, 128);
  const gpuLayers = reqInt(llm.gpuLayers, "llm.gpuLayers", 0, 200);

  if (backend === "ollama") {
    if (!ollamaModel) throw new Error("llm.ollamaModel must be a non-empty string when llm.backend='ollama'");
    // Basic safety: avoid accidental remote URLs; allow only localhost/loopback by default.
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(ollamaBaseUrl)) {
      throw new Error("llm.ollamaBaseUrl must point to localhost/127.0.0.1 for offline mode.");
    }
  }

  const cfg: Config = {
    runtime: {
      host,
      port,
      auditLogDir: normalizeRelToRoot(projectRoot, auditLogDir)
    },
    llm: {
      backend,
      modelPath: normalizeRelToRoot(projectRoot, modelPath),
      llamaBinPath: normalizeRelToRoot(projectRoot, llamaBinPath),
      ollamaBaseUrl,
      ollamaModel: ollamaModel || undefined,
      contextTokens,
      temperature,
      topP,
      seed,
      threads,
      gpuLayers
    }
  };

  return cfg;
}

