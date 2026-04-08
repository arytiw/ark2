import fs from "node:fs";
import path from "node:path";

type AuditEvent =
  | { t: number; kind: "server_start"; host: string; port: number }
  | { t: number; kind: "client_connect"; clientId: string; remote?: string }
  | { t: number; kind: "client_disconnect"; clientId: string }
  | { t: number; kind: "request_start"; clientId: string; requestId: string; promptBytes: number }
  | { t: number; kind: "request_token"; clientId: string; requestId: string; tokenBytes: number }
  | { t: number; kind: "request_end"; clientId: string; requestId: string; reason: string; elapsedMs: number }
  | { t: number; kind: "request_cancel"; clientId: string; requestId: string }
  | { t: number; kind: "protocol_error"; clientId?: string; code: string; message: string };

export class AuditLogger {
  private readonly filePath: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(dir, `audit-${stamp}.jsonl`);
  }

  log(ev: AuditEvent): void {
    const line = JSON.stringify(ev);
    // Append is synchronous but not on user-facing token path in practice; token path uses small writes.
    // If needed later: swap to a buffered async writer behind the same interface.
    fs.appendFileSync(this.filePath, line + "\n", { encoding: "utf8" });
  }
}

