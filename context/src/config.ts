import fs from "node:fs";
import path from "node:path";

type RootConfig = {
  tools: { host: string; port: number };
  embeddings: { host: string; port: number };
  context: { auditLogDir: string; chunkChars: number; chunkOverlap: number; maxFiles: number };
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function reqString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`${name} must be non-empty string`);
  return v;
}
function reqInt(v: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`${name} must be int in [${min},${max}]`);
  return v as number;
}

export function loadRootConfig(projectRoot: string): RootConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, "config.json"), "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("config.json must be object");
  const tools = raw.tools;
  const embeddings = raw.embeddings;
  const context = raw.context;
  if (!isRecord(tools) || !isRecord(embeddings) || !isRecord(context)) throw new Error("config.tools/embeddings/context must be objects");
  const cfg: RootConfig = {
    tools: { host: reqString(tools.host, "tools.host"), port: reqInt(tools.port, "tools.port", 1, 65535) },
    embeddings: { host: reqString(embeddings.host, "embeddings.host"), port: reqInt(embeddings.port, "embeddings.port", 1, 65535) },
    context: {
      auditLogDir: path.resolve(projectRoot, reqString(context.auditLogDir, "context.auditLogDir")),
      chunkChars: reqInt(context.chunkChars, "context.chunkChars", 200, 20000),
      chunkOverlap: reqInt(context.chunkOverlap, "context.chunkOverlap", 0, 5000),
      maxFiles: reqInt(context.maxFiles, "context.maxFiles", 1, 200000)
    }
  };
  return cfg;
}

