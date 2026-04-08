import fs from "node:fs";
import path from "node:path";
import type { RootConfig } from "./types";

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

export function loadRootConfig(projectRoot: string): RootConfig {
  const configPath = path.join(projectRoot, "config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("config.json must be an object");
  const runtime = raw.runtime;
  const tools = raw.tools;
  const embeddings = raw.embeddings;
  const agent = raw.agent;
  if (!isRecord(runtime) || !isRecord(tools) || !isRecord(embeddings) || !isRecord(agent)) {
    throw new Error("config.runtime/tools/embeddings/agent must be objects");
  }

  const runtimeHost = reqString(runtime.host, "runtime.host");
  const runtimePort = reqInt(runtime.port, "runtime.port", 1, 65535);
  const toolsHost = reqString(tools.host, "tools.host");
  const toolsPort = reqInt(tools.port, "tools.port", 1, 65535);
  const embHost = reqString(embeddings.host, "embeddings.host");
  const embPort = reqInt(embeddings.port, "embeddings.port", 1, 65535);

  const host = reqString(agent.host, "agent.host");
  const port = reqInt(agent.port, "agent.port", 1, 65535);
  const auditLogDir = reqString(agent.auditLogDir, "agent.auditLogDir");
  const maxSteps = reqInt(agent.maxSteps, "agent.maxSteps", 1, 100);
  const timeoutMs = reqInt(agent.timeoutMs, "agent.timeoutMs", 100, 600000);
  const modelSource = reqString(agent.modelSource, "agent.modelSource");
  if (modelSource !== "runtime" && modelSource !== "mock") throw new Error("agent.modelSource must be runtime|mock");
  const llmMaxTokens = reqInt(agent.llmMaxTokens, "agent.llmMaxTokens", 16, 2048);

  return {
    runtime: { host: runtimeHost, port: runtimePort },
    tools: { host: toolsHost, port: toolsPort },
    embeddings: { host: embHost, port: embPort },
    agent: { host, port, auditLogDir: path.resolve(projectRoot, auditLogDir), maxSteps, timeoutMs, modelSource, llmMaxTokens }
  };
}

