import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ToolsConfig, ToolName } from "./types";
import { WorkspaceSandbox } from "./sandbox";
import { applyUnifiedDiff } from "./diff";
import { Logger } from "./logger";

type Ok<T> = { ok: true; result: T };
type Err = { ok: false; code: string; message: string };

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function statIfExists(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

function toRel(workspaceRoot: string, abs: string): string {
  const rel = path.relative(workspaceRoot, abs);
  return rel.length === 0 ? "." : rel;
}

export class ToolExecutor {
  private readonly sandbox: WorkspaceSandbox;

  constructor(
    private readonly workspaceRoot: string,
    private readonly cfg: ToolsConfig,
    private readonly logger: Logger
  ) {
    this.sandbox = new WorkspaceSandbox(workspaceRoot);
  }

  async call(tool: ToolName, params: Record<string, unknown>, requestId: string): Promise<Ok<unknown> | Err> {
    switch (tool) {
      case "read_file":
        return this.readFile(params, requestId);
      case "write_file":
        return this.writeFile(params, requestId);
      case "apply_diff":
        return this.applyDiff(params, requestId);
      case "list_files":
        return this.listFiles(params, requestId);
      case "search_code":
        return this.searchCode(params, requestId);
      default:
        return { ok: false, code: "E_TOOL", message: "Unknown tool." };
    }
  }

  private resolvePathParam(params: Record<string, unknown>): { ok: true; abs: string } | Err {
    const p = params.path;
    if (typeof p !== "string") return { ok: false, code: "E_PARAMS", message: "path must be a string" };
    const r = this.sandbox.resolvePath(p);
    if (!r.ok) return { ok: false, code: "E_SANDBOX", message: r.message };
    return { ok: true, abs: r.abs };
  }

  private async readFile(params: Record<string, unknown>, requestId: string): Promise<Ok<unknown> | Err> {
    const r = this.resolvePathParam(params);
    if (!r.ok) return r;
    this.logger.debug("File read/write", { path: r.abs, requestId });
    const st = await statIfExists(r.abs);
    if (!st || !st.isFile()) return { ok: false, code: "E_NOT_FOUND", message: "File not found." };
    if (st.size > this.cfg.maxFileBytes) return { ok: false, code: "E_TOO_LARGE", message: "File exceeds maxFileBytes." };
    const data = await fs.readFile(r.abs);
    const content = data.toString("utf8");
    return {
      ok: true,
      result: {
        path: toRel(this.workspaceRoot, r.abs),
        bytes: data.byteLength,
        sha256: sha256(data),
        content
      }
    };
  }

  private async writeFile(params: Record<string, unknown>, requestId: string): Promise<Ok<unknown> | Err> {
    const r = this.resolvePathParam(params);
    if (!r.ok) return r;
    this.logger.debug("File read/write", { path: r.abs, requestId });
    const content = params.content;
    if (typeof content !== "string") return { ok: false, code: "E_PARAMS", message: "content must be a string" };
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.cfg.maxFileBytes) return { ok: false, code: "E_TOO_LARGE", message: "content exceeds maxFileBytes." };

    // Backup old content if exists.
    const st = await statIfExists(r.abs);
    let backupPath: string | null = null;
    let oldSha: string | null = null;
    if (st && st.isFile()) {
      const old = await fs.readFile(r.abs);
      oldSha = sha256(old);
      backupPath = await this.backupFile(r.abs, old);
    } else {
      // Ensure parent exists
      await ensureDir(path.dirname(r.abs));
    }

    await fs.writeFile(r.abs, content, { encoding: "utf8" });
    return {
      ok: true,
      result: {
        path: toRel(this.workspaceRoot, r.abs),
        backupPath: backupPath ? toRel(this.workspaceRoot, backupPath) : null,
        oldSha256: oldSha,
        newSha256: sha256(content),
        bytes
      }
    };
  }

  private async applyDiff(params: Record<string, unknown>, requestId: string): Promise<Ok<unknown> | Err> {
    const r = this.resolvePathParam(params);
    if (!r.ok) return r;
    this.logger.debug("File read/write", { path: r.abs, requestId });
    const diff = params.diff;
    if (typeof diff !== "string" || diff.length === 0) return { ok: false, code: "E_PARAMS", message: "diff must be a non-empty string" };

    const st = await statIfExists(r.abs);
    if (!st || !st.isFile()) return { ok: false, code: "E_NOT_FOUND", message: "File not found." };
    if (st.size > this.cfg.maxFileBytes) return { ok: false, code: "E_TOO_LARGE", message: "File exceeds maxFileBytes." };
    const old = await fs.readFile(r.abs, "utf8");

    const applied = applyUnifiedDiff(old, diff);
    if (!applied.ok) return { ok: false, code: "E_DIFF", message: applied.message };

    const newBytes = Buffer.byteLength(applied.content, "utf8");
    if (newBytes > this.cfg.maxFileBytes) return { ok: false, code: "E_TOO_LARGE", message: "Patched file exceeds maxFileBytes." };

    const backupPath = await this.backupFile(r.abs, Buffer.from(old, "utf8"));
    await fs.writeFile(r.abs, applied.content, { encoding: "utf8" });

    return {
      ok: true,
      result: {
        path: toRel(this.workspaceRoot, r.abs),
        backupPath: toRel(this.workspaceRoot, backupPath),
        oldSha256: sha256(old),
        newSha256: sha256(applied.content),
        bytes: newBytes
      }
    };
  }

  private async listFiles(params: Record<string, unknown>, requestId: string): Promise<Ok<unknown> | Err> {
    const dirParam = params.directory;
    if (typeof dirParam !== "string") return { ok: false, code: "E_PARAMS", message: "directory must be a string" };
    const resolved = this.sandbox.resolvePath(dirParam);
    if (!resolved.ok) return { ok: false, code: "E_SANDBOX", message: resolved.message };
    const abs = resolved.abs;

    const maxDepth = typeof params.maxDepth === "number" && Number.isInteger(params.maxDepth) && params.maxDepth >= 0 ? (params.maxDepth as number) : 20;

    const st = await statIfExists(abs);
    if (!st || !st.isDirectory()) return { ok: false, code: "E_NOT_FOUND", message: "Directory not found." };

    const results: { path: string; kind: "file" | "dir"; bytes?: number }[] = [];
    const root = abs;

    const walk = async (cur: string, depth: number): Promise<void> => {
      if (results.length >= this.cfg.maxListEntries) return;
      const entries = await fs.readdir(cur, { withFileTypes: true });
      for (const ent of entries) {
        if (results.length >= this.cfg.maxListEntries) return;
        const p = path.join(cur, ent.name);
        const rel = toRel(this.workspaceRoot, p);
        if (ent.isDirectory()) {
          results.push({ path: rel, kind: "dir" });
          if (depth < maxDepth) await walk(p, depth + 1);
        } else if (ent.isFile()) {
          const s = await fs.stat(p);
          results.push({ path: rel, kind: "file", bytes: s.size });
        }
      }
    };

    await walk(root, 0);
    return { ok: true, result: { directory: toRel(this.workspaceRoot, abs), entries: results, truncated: results.length >= this.cfg.maxListEntries } };
  }

  private async searchCode(params: Record<string, unknown>, requestId: string): Promise<Ok<unknown> | Err> {
    const query = params.query;
    if (typeof query !== "string" || query.length === 0) return { ok: false, code: "E_PARAMS", message: "query must be a non-empty string" };

    const dirParam = params.directory;
    const dir = typeof dirParam === "string" ? dirParam : ".";
    const resolved = this.sandbox.resolvePath(dir);
    if (!resolved.ok) return { ok: false, code: "E_SANDBOX", message: resolved.message };
    const abs = resolved.abs;
    const st = await statIfExists(abs);
    if (!st || !st.isDirectory()) return { ok: false, code: "E_NOT_FOUND", message: "Directory not found." };

    const maxDepth = typeof params.maxDepth === "number" && Number.isInteger(params.maxDepth) && params.maxDepth >= 0 ? (params.maxDepth as number) : 25;
    const maxFileBytes = typeof params.maxFileBytes === "number" && Number.isInteger(params.maxFileBytes) && params.maxFileBytes > 0
      ? Math.min(params.maxFileBytes as number, this.cfg.maxFileBytes)
      : this.cfg.maxFileBytes;

    const matches: { path: string; line: number; preview: string }[] = [];

    const walk = async (cur: string, depth: number): Promise<void> => {
      if (matches.length >= this.cfg.maxSearchMatches) return;
      const entries = await fs.readdir(cur, { withFileTypes: true });
      for (const ent of entries) {
        if (matches.length >= this.cfg.maxSearchMatches) return;
        const p = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          if (depth < maxDepth) await walk(p, depth + 1);
        } else if (ent.isFile()) {
          const s = await fs.stat(p);
          if (s.size > maxFileBytes) continue;
          // Heuristic: treat as text; binary may contain NUL.
          const buf = await fs.readFile(p);
          if (buf.includes(0)) continue;
          const text = buf.toString("utf8");
          let idx = 0;
          while (matches.length < this.cfg.maxSearchMatches) {
            const hit = text.indexOf(query, idx);
            if (hit === -1) break;
            const before = text.lastIndexOf("\n", hit);
            const after = text.indexOf("\n", hit);
            const lineStart = before === -1 ? 0 : before + 1;
            const lineEnd = after === -1 ? text.length : after;
            const lineText = text.slice(lineStart, lineEnd);
            const lineNo = text.slice(0, hit).split("\n").length; // 1-based
            matches.push({ path: toRel(this.workspaceRoot, p), line: lineNo, preview: lineText.slice(0, 400) });
            idx = hit + Math.max(1, query.length);
          }
        }
      }
    };

    await walk(abs, 0);
    return { ok: true, result: { query, directory: toRel(this.workspaceRoot, abs), matches, truncated: matches.length >= this.cfg.maxSearchMatches } };
  }

  private async backupFile(absPath: string, content: Buffer): Promise<string> {
    const rel = path.relative(this.workspaceRoot, absPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(this.cfg.backupDir, stamp, rel);
    await ensureDir(path.dirname(dest));
    await fs.writeFile(dest, content);

    // Best-effort: make backup read-only.
    try {
      fssync.chmodSync(dest, 0o444);
    } catch {}
    return dest;
  }
}

