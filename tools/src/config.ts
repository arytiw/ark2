import fs from "node:fs";
import path from "node:path";
import type { RootConfig, ToolsConfig } from "./types";

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

function normalizeRelToRoot(rootDir: string, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(rootDir, p);
}

export function loadToolsConfig(projectRoot: string): ToolsConfig {
  const configPath = path.join(projectRoot, "config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("config.json must be an object");
  const tools = raw.tools;
  if (!isRecord(tools)) throw new Error("config.tools must be an object");

  const host = reqString(tools.host, "tools.host");
  const port = reqInt(tools.port, "tools.port", 1, 65535);
  const auditLogDir = reqString(tools.auditLogDir, "tools.auditLogDir");
  const backupDir = reqString(tools.backupDir, "tools.backupDir");
  const maxFileBytes = reqInt(tools.maxFileBytes, "tools.maxFileBytes", 1, 104857600);
  const maxListEntries = reqInt(tools.maxListEntries, "tools.maxListEntries", 1, 200000);
  const maxSearchMatches = reqInt(tools.maxSearchMatches, "tools.maxSearchMatches", 1, 200000);

  return {
    host,
    port,
    auditLogDir: normalizeRelToRoot(projectRoot, auditLogDir),
    backupDir: normalizeRelToRoot(projectRoot, backupDir),
    maxFileBytes,
    maxListEntries,
    maxSearchMatches
  };
}

export function loadRootConfig(projectRoot: string): RootConfig {
  return { tools: loadToolsConfig(projectRoot) };
}

