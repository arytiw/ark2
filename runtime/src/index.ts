import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import type { IncomingMessage } from "node:http";
import { loadConfig } from "./config";
import { AuditLogger } from "./audit";
import { Logger } from "./logger";
import { parseClientMessage } from "./validate";
import type { LlmBackend, ServerToClient } from "./types";
import { MockBackend } from "./backends/mock";
import { LlamaCppCliBackend } from "./backends/llamacpp";
import { OllamaBackend } from "./backends/ollama";
import { GeminiBackend } from "./backends/gemini";

const logger = new Logger("runtime");

const VERSION = "0.1.0";

function safeSend(ws: WebSocket, msg: ServerToClient): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function nowMs(): number {
  return Date.now();
}

function getProjectRoot(): string {
  // runtime/dist/index.js -> runtime -> project root
  return path.resolve(__dirname, "..", "..");
}

function newClientId(): string {
  return crypto.randomBytes(12).toString("hex");
}

type ActiveRequest = {
  abort: AbortController;
  startedAt: number;
};

async function main() {
  const projectRoot = getProjectRoot();
  const cfg = loadConfig(projectRoot);
  const audit = new AuditLogger(cfg.runtime.auditLogDir);

  let backend: LlmBackend;
  if (cfg.llm.backend === "mock") {
    backend = new MockBackend();
  } else if (cfg.llm.backend === "ollama") {
    backend = new OllamaBackend({
      baseUrl: cfg.llm.ollamaBaseUrl ?? "http://127.0.0.1:11434",
      model: cfg.llm.ollamaModel ?? "",
      contextTokens: cfg.llm.contextTokens,
      temperature: cfg.llm.temperature,
      topP: cfg.llm.topP,
      seed: cfg.llm.seed,
      threads: cfg.llm.threads
    });
  } else if (cfg.llm.backend === "gemini") {
    backend = new GeminiBackend({
      apiKey: cfg.llm.geminiApiKey ?? "",
      model: cfg.llm.geminiModel ?? "gemini-1.5-flash"
    });
  } else {
    backend = new LlamaCppCliBackend(cfg.llm);
  }

  const wss = new WebSocketServer({
    host: cfg.runtime.host,
    port: cfg.runtime.port,
    maxPayload: 1024 * 1024 // 1 MiB: prompts must be bounded
  });

  audit.log({ t: nowMs(), kind: "server_start", host: cfg.runtime.host, port: cfg.runtime.port });
  logger.info("Runtime server started", { host: cfg.runtime.host, port: cfg.runtime.port });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    logger.info("Client connected");
    const clientId = newClientId();
    const remote = req.socket.remoteAddress;
    audit.log({ t: nowMs(), kind: "client_connect", clientId, remote });

    const active = new Map<string, ActiveRequest>();

    safeSend(ws, { type: "ready", version: VERSION });

    ws.on("message", async (data: RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
      } catch {
        audit.log({ t: nowMs(), kind: "protocol_error", clientId, code: "E_BAD_JSON", message: "Invalid JSON" });
        safeSend(ws, { type: "error", code: "E_BAD_JSON", message: "Invalid JSON." });
        return;
      }

      const res = parseClientMessage(parsed);
      if (!res.ok) {
        audit.log({ t: nowMs(), kind: "protocol_error", clientId, code: res.code, message: res.message });
        safeSend(ws, { type: "error", code: res.code, message: res.message });
        return;
      }

      const msg = res.msg;
      if (msg.type === "ping") {
        safeSend(ws, { type: "pong", requestId: msg.requestId, t: nowMs() });
        return;
      }

      if (msg.type === "cancel") {
        const r = active.get(msg.requestId);
        if (r) {
          audit.log({ t: nowMs(), kind: "request_cancel", clientId, requestId: msg.requestId });
          r.abort.abort();
        }
        safeSend(ws, { type: "done", requestId: msg.requestId, reason: "cancel" });
        return;
      }

      // generate
      const requestId = msg.requestId;
      if (active.has(requestId)) {
        safeSend(ws, { type: "error", requestId, code: "E_INFLIGHT", message: "requestId already in use." });
        return;
      }

      const ac = new AbortController();
      active.set(requestId, { abort: ac, startedAt: nowMs() });

      const prompt = msg.prompt;
      const maxTokens = msg.maxTokens ?? 512;
      const stop = msg.stop ?? [];

      audit.log({ t: nowMs(), kind: "request_start", clientId, requestId, promptBytes: Buffer.byteLength(prompt, "utf8") });
      logger.info("Generate request received", { requestId });

      try {
        const reason = await backend.generate(
          { requestId, prompt, maxTokens, stop },
          (token) => {
            // Non-blocking on WS send: ws buffers internally; if backpressure becomes a problem, we’ll add a bounded queue.
            audit.log({ t: nowMs(), kind: "request_token", clientId, requestId, tokenBytes: Buffer.byteLength(token, "utf8") });
            logger.debug("Streaming token", { requestId, token });
            safeSend(ws, { type: "token", requestId, token });
          },
          ac.signal
        );

        const startedAt = active.get(requestId)?.startedAt ?? nowMs();
        active.delete(requestId);
        safeSend(ws, { type: "done", requestId, reason: reason === "stop" ? "stop" : "eos" });
        audit.log({ t: nowMs(), kind: "request_end", clientId, requestId, reason, elapsedMs: nowMs() - startedAt });
        logger.info("Generation completed", { requestId, reason });
      } catch (e) {
        const startedAt = active.get(requestId)?.startedAt ?? nowMs();
        active.delete(requestId);
        const aborted = ac.signal.aborted;
        safeSend(ws, { type: "done", requestId, reason: aborted ? "cancel" : "error" });
        safeSend(ws, {
          type: "error",
          requestId,
          code: aborted ? "E_CANCELLED" : "E_BACKEND",
          message: aborted ? "Cancelled." : (e instanceof Error ? e.message : "Backend error.")
        });
        logger.error("Runtime error", { error: e instanceof Error ? e.message : String(e) });
        audit.log({
          t: nowMs(),
          kind: "request_end",
          clientId,
          requestId,
          reason: aborted ? "cancel" : "error",
          elapsedMs: nowMs() - startedAt
        });
      }
    });

    ws.on("close", () => {
      for (const r of active.values()) r.abort.abort();
      active.clear();
      audit.log({ t: nowMs(), kind: "client_disconnect", clientId });
    });
  });
}

main().catch((e) => {
  // Last-resort crash output; no telemetry.
  process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + "\n");
  process.exitCode = 1;
});

