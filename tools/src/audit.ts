import fs from "node:fs";
import path from "node:path";

export type AuditEvent =
  | { t: number; kind: "server_start"; host: string; port: number; workspaceRoot: string }
  | { t: number; kind: "client_connect"; clientId: string; remote?: string }
  | { t: number; kind: "client_disconnect"; clientId: string }
  | { t: number; kind: "tool_call"; clientId: string; requestId: string; tool: string; params: unknown }
  | { t: number; kind: "tool_result"; clientId: string; requestId: string; ok: boolean; code?: string; elapsedMs: number }
  | { t: number; kind: "security_violation"; clientId: string; requestId?: string; message: string };

export class AuditLogger {
  private readonly filePath: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(dir, `tools-audit-${stamp}.jsonl`);
  }

  log(ev: AuditEvent): void {
    fs.appendFileSync(this.filePath, JSON.stringify(ev) + "\n", { encoding: "utf8" });
  }
}

