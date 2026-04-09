import fs from "node:fs";
import path from "node:path";

export type AuditEvent =
  | { t: number; kind: "server_start"; host: string; port: number }
  | { t: number; kind: "client_connect"; clientId: string; remote?: string }
  | { t: number; kind: "client_disconnect"; clientId: string }
  | { t: number; kind: "task_start"; clientId: string; taskId: string; mode?: string; instructionBytes: number }
  | { t: number; kind: "task_end"; clientId: string; taskId: string; ok: boolean; elapsedMs: number }
  | { t: number; kind: "step"; clientId: string; taskId: string; step: number; detail: unknown }
  | { t: number; kind: "security_violation"; clientId: string; taskId?: string; message: string };

export class AuditLogger {
  private readonly filePath: string;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(dir, `agent-audit-${stamp}.jsonl`);
  }
  log(ev: AuditEvent): void {
    fs.appendFileSync(this.filePath, JSON.stringify(ev) + "\n", { encoding: "utf8" });
  }
}

