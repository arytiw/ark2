import fs from "node:fs";
import path from "node:path";

export class AuditLogger {
  private readonly filePath: string;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(dir, `context-audit-${stamp}.jsonl`);
  }
  log(ev: unknown): void {
    fs.appendFileSync(this.filePath, JSON.stringify({ t: Date.now(), ...((ev as any) ?? {}) }) + "\n", { encoding: "utf8" });
  }
}

