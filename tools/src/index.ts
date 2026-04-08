import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import type { IncomingMessage } from "node:http";
import { loadToolsConfig } from "./config";
import { AuditLogger } from "./audit";
import { parseToolCall } from "./validate";
import { ToolExecutor } from "./tools";
import type { ServerMsg } from "./types";

const VERSION = "0.1.0";

function nowMs(): number {
  return Date.now();
}

function getProjectRoot(): string {
  // tools/dist/index.js -> tools -> project root
  return path.resolve(__dirname, "..", "..");
}

function newClientId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function safeSend(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

async function main() {
  const projectRoot = getProjectRoot();
  const workspaceRoot = projectRoot; // Phase 4: sandbox is the repo workspace root.

  const cfg = loadToolsConfig(projectRoot);
  const audit = new AuditLogger(cfg.auditLogDir);
  const exec = new ToolExecutor(workspaceRoot, cfg);

  const wss = new WebSocketServer({
    host: cfg.host,
    port: cfg.port,
    maxPayload: 4 * 1024 * 1024 // 4 MiB (bounded); tool calls must be structured and small.
  });

  audit.log({ t: nowMs(), kind: "server_start", host: cfg.host, port: cfg.port, workspaceRoot });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const clientId = newClientId();
    const remote = req.socket.remoteAddress;
    audit.log({ t: nowMs(), kind: "client_connect", clientId, remote });
    safeSend(ws, { type: "ready", version: VERSION });

    ws.on("message", async (data: RawData) => {
      const started = nowMs();
      let parsed: unknown;
      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        parsed = JSON.parse(raw);
      } catch {
        audit.log({ t: nowMs(), kind: "security_violation", clientId, message: "Invalid JSON." });
        safeSend(ws, { type: "tool_result", requestId: "?", ok: false, error: { code: "E_BAD_JSON", message: "Invalid JSON." } });
        return;
      }

      const callRes = parseToolCall(parsed);
      if (!callRes.ok) {
        audit.log({ t: nowMs(), kind: "security_violation", clientId, message: `${callRes.code}: ${callRes.message}` });
        safeSend(ws, {
          type: "tool_result",
          requestId: (parsed as any)?.requestId ?? "?",
          ok: false,
          error: { code: callRes.code, message: callRes.message }
        });
        return;
      }

      const call = callRes.call;
      audit.log({ t: nowMs(), kind: "tool_call", clientId, requestId: call.requestId, tool: call.tool, params: call.params });

      const res = await exec.call(call.tool, call.params);
      const elapsedMs = nowMs() - started;
      if (res.ok) {
        audit.log({ t: nowMs(), kind: "tool_result", clientId, requestId: call.requestId, ok: true, elapsedMs });
        safeSend(ws, { type: "tool_result", requestId: call.requestId, ok: true, result: res.result });
      } else {
        audit.log({ t: nowMs(), kind: "tool_result", clientId, requestId: call.requestId, ok: false, code: res.code, elapsedMs });
        safeSend(ws, { type: "tool_result", requestId: call.requestId, ok: false, error: { code: res.code, message: res.message } });
      }
    });

    ws.on("close", () => {
      audit.log({ t: nowMs(), kind: "client_disconnect", clientId });
    });
  });
}

main().catch((e) => {
  process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + "\n");
  process.exitCode = 1;
});

