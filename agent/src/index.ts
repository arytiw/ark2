import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { RawData } from "ws";
import { loadRootConfig } from "./config";
import { AuditLogger } from "./audit";
import { parseClientMsg } from "./validate";
import { AgentLoop } from "./agentLoop";
import type { AgentToClient, AgentEvent } from "./types";

const VERSION = "0.1.0";

function nowMs(): number {
  return Date.now();
}

function getProjectRoot(): string {
  // agent/dist/index.js -> agent -> project root
  return path.resolve(__dirname, "..", "..");
}

function newClientId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function safeSend(ws: WebSocket, msg: AgentToClient): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

async function main() {
  const projectRoot = getProjectRoot();
  const cfg = loadRootConfig(projectRoot);
  const audit = new AuditLogger(cfg.agent.auditLogDir);
  const loop = new AgentLoop(cfg, audit);

  const wss = new WebSocketServer({
    host: cfg.agent.host,
    port: cfg.agent.port,
    maxPayload: 1024 * 1024
  });

  audit.log({ t: nowMs(), kind: "server_start", host: cfg.agent.host, port: cfg.agent.port });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const clientId = newClientId();
    const remote = req.socket.remoteAddress;
    audit.log({ t: nowMs(), kind: "client_connect", clientId, remote });
    safeSend(ws, { type: "ready", version: VERSION });

    const tasks = new Map<string, AbortController>();

    const emit = (taskId: string, ev: AgentEvent) => {
      safeSend(ws, { type: "event", taskId, event: ev });
      audit.log({ t: nowMs(), kind: "step", clientId, taskId, step: (ev as any).step ?? 0, detail: ev });
    };

    ws.on("message", async (data: RawData) => {
      let parsed: unknown;
      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        parsed = JSON.parse(raw);
      } catch {
        audit.log({ t: nowMs(), kind: "security_violation", clientId, message: "Invalid JSON" });
        return;
      }

      const m = parseClientMsg(parsed);
      if (!m.ok) {
        audit.log({ t: nowMs(), kind: "security_violation", clientId, message: `${m.code}: ${m.message}` });
        return;
      }

      if (m.msg.type === "ping") {
        safeSend(ws, { type: "pong", requestId: m.msg.requestId, t: nowMs() });
        return;
      }

      if (m.msg.type === "cancel") {
        const ac = tasks.get(m.msg.taskId);
        if (ac) ac.abort();
        return;
      }

      // task
      const { taskId, instruction } = m.msg;
      if (tasks.has(taskId)) {
        safeSend(ws, { type: "final", taskId, ok: false, error: { code: "E_INFLIGHT", message: "taskId already running" } });
        return;
      }

      const ac = new AbortController();
      tasks.set(taskId, ac);
      audit.log({ t: nowMs(), kind: "task_start", clientId, taskId, instructionBytes: Buffer.byteLength(instruction, "utf8") });
      const startedAt = nowMs();

      (async () => {
        try {
          const result = await loop.runTask(taskId, instruction, (ev) => emit(taskId, ev), ac.signal);
          safeSend(ws, { type: "final", taskId, ok: true, result });
          audit.log({ t: nowMs(), kind: "task_end", clientId, taskId, ok: true, elapsedMs: nowMs() - startedAt });
        } catch (e) {
          const aborted = ac.signal.aborted;
          safeSend(ws, {
            type: "final",
            taskId,
            ok: false,
            error: { code: aborted ? "E_CANCELLED" : "E_AGENT", message: aborted ? "Cancelled." : (e instanceof Error ? e.message : "Agent error.") }
          });
          audit.log({ t: nowMs(), kind: "task_end", clientId, taskId, ok: false, elapsedMs: nowMs() - startedAt });
        } finally {
          tasks.delete(taskId);
        }
      })().catch(() => {});
    });

    ws.on("close", () => {
      for (const ac of tasks.values()) ac.abort();
      tasks.clear();
      audit.log({ t: nowMs(), kind: "client_disconnect", clientId });
    });
  });
}

main().catch((e) => {
  process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + "\n");
  process.exitCode = 1;
});

