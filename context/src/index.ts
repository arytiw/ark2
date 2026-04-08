import path from "node:path";
import crypto from "node:crypto";
import { loadRootConfig } from "./config";
import { AuditLogger } from "./audit";
import { JsonWsClient } from "./wsClient";
import type { EmbRequest, EmbResult, ToolCall, ToolResult } from "./protocol";
import { chunkText } from "./chunk";

function getProjectRoot(): string {
  // context/dist/index.js -> context -> project root
  return path.resolve(__dirname, "..", "..");
}

function rid(): string {
  return crypto.randomBytes(8).toString("hex");
}

async function toolsCall(tools: JsonWsClient<any, ToolCall>, tool: string, params: Record<string, unknown>): Promise<ToolResult> {
  const requestId = rid();
  const p = new Promise<ToolResult>((resolve) => {
    const off = tools.onMessage((m: any) => {
      if (m && m.type === "tool_result" && m.requestId === requestId) {
        off();
        resolve(m as ToolResult);
      }
    });
  });
  tools.send({ type: "tool_call", requestId, tool, params });
  return p;
}

async function embCall(emb: JsonWsClient<any, EmbRequest>, msg: EmbRequest): Promise<EmbResult> {
  const requestId = msg.requestId;
  const p = new Promise<EmbResult>((resolve) => {
    const off = emb.onMessage((m: any) => {
      if (m && m.type === "result" && m.requestId === requestId) {
        off();
        resolve(m as EmbResult);
      }
    });
  });
  emb.send(msg);
  return p;
}

async function buildIndex() {
  const projectRoot = getProjectRoot();
  const cfg = loadRootConfig(projectRoot);
  const audit = new AuditLogger(cfg.context.auditLogDir);

  const toolsUrl = `ws://${cfg.tools.host}:${cfg.tools.port}`;
  const embUrl = `ws://${cfg.embeddings.host}:${cfg.embeddings.port}`;
  const tools = new JsonWsClient<any, ToolCall>(toolsUrl);
  const emb = new JsonWsClient<any, EmbRequest>(embUrl);

  await tools.connect(1500);
  await emb.connect(1500);

  audit.log({ kind: "build_start", toolsUrl, embUrl });

  const list = await toolsCall(tools, "list_files", { directory: ".", maxDepth: 50 });
  if (!list.ok) throw new Error(`list_files failed: ${list.error.code}: ${list.error.message}`);

  const entries = (list.result?.entries as any[]) ?? [];
  const files = entries.filter((e) => e.kind === "file").slice(0, cfg.context.maxFiles);

  let totalChunks = 0;
  let totalFiles = 0;

  for (const f of files) {
    const relPath = f.path as string;
    // Skip obvious noise deterministically.
    if (relPath.includes("node_modules/") || relPath.includes("\\node_modules\\")) continue;
    if (relPath.includes(".git/") || relPath.includes("\\.git\\")) continue;
    if (relPath.includes("dist/") || relPath.includes("\\dist\\")) continue;
    if (relPath.includes("\\.venv\\") || relPath.includes("/.venv/")) continue;
    if (relPath.includes("\\.offline-assistant\\") || relPath.includes("/.offline-assistant/")) continue;
    if (relPath.endsWith(".png") || relPath.endsWith(".jpg") || relPath.endsWith(".exe") || relPath.endsWith(".dll")) continue;

    const rf = await toolsCall(tools, "read_file", { path: relPath });
    if (!rf.ok) continue;
    const content = String((rf.result as any).content ?? "");
    if (!content) continue;

    const chunks = chunkText({
      path: relPath,
      content,
      chunkChars: cfg.context.chunkChars,
      overlap: cfg.context.chunkOverlap
    });
    if (chunks.length === 0) continue;

    // Upsert in bounded batches.
    const batchSize = 128;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const reqId = rid();
      const res = await embCall(emb, {
        type: "upsert",
        requestId: reqId,
        items: batch.map((c) => ({ id: c.id, text: c.text, meta: c.meta }))
      });
      if (!res.ok) throw new Error(`embeddings upsert failed: ${res.error.code}: ${res.error.message}`);
      totalChunks += batch.length;
    }

    totalFiles++;
    if (totalFiles % 25 === 0) audit.log({ kind: "build_progress", totalFiles, totalChunks });
  }

  audit.log({ kind: "build_done", totalFiles, totalChunks });
  tools.close();
  emb.close();
  process.stdout.write(`Indexed files=${totalFiles} chunks=${totalChunks}\n`);
}

async function queryIndex() {
  const projectRoot = getProjectRoot();
  const cfg = loadRootConfig(projectRoot);
  const q = process.argv.slice(3).join(" ").trim();
  if (!q) throw new Error("Usage: npm run query -- <text query>");

  const embUrl = `ws://${cfg.embeddings.host}:${cfg.embeddings.port}`;
  const emb = new JsonWsClient<any, EmbRequest>(embUrl);
  await emb.connect(1500);

  const reqId = rid();
  const res = await embCall(emb, { type: "query", requestId: reqId, text: q, topK: 8 });
  emb.close();
  if (!res.ok) throw new Error(`query failed: ${res.error.code}: ${res.error.message}`);
  process.stdout.write(JSON.stringify(res.result, null, 2) + "\n");
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "build") return buildIndex();
  if (cmd === "query") return queryIndex();
  throw new Error("Usage: node dist/index.js build|query -- <query text>");
}

main().catch((e) => {
  process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + "\n");
  process.exitCode = 1;
});

