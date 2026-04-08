import path from "node:path";
import fs from "node:fs";

export class WorkspaceSandbox {
  private readonly rootReal: string;

  constructor(private readonly workspaceRoot: string) {
    // Resolve real path once; later we ensure every request resolves under it.
    this.rootReal = fs.realpathSync.native(workspaceRoot);
  }

  resolvePath(userPath: string): { ok: true; abs: string } | { ok: false; message: string } {
    if (typeof userPath !== "string" || userPath.length === 0) return { ok: false, message: "path must be a non-empty string" };

    // Force relative-to-root unless absolute path is still within root.
    const abs = path.isAbsolute(userPath) ? userPath : path.resolve(this.workspaceRoot, userPath);

    // Normalize to remove .. and such. Then realpath (if exists) to mitigate symlink escape.
    const norm = path.normalize(abs);

    // For non-existent paths, realpath will throw. We validate the parent directory instead.
    try {
      const real = fs.realpathSync.native(norm);
      if (!this.isUnderRoot(real)) return { ok: false, message: "path escapes workspace root" };
      return { ok: true, abs: real };
    } catch {
      const parent = path.dirname(norm);
      try {
        const parentReal = fs.realpathSync.native(parent);
        if (!this.isUnderRoot(parentReal)) return { ok: false, message: "path escapes workspace root" };
        // Use normalized absolute path (not realpath) for the target.
        return { ok: true, abs: norm };
      } catch {
        return { ok: false, message: "invalid path or parent directory does not exist" };
      }
    }
  }

  private isUnderRoot(p: string): boolean {
    const root = this.rootReal.endsWith(path.sep) ? this.rootReal : this.rootReal + path.sep;
    const cand = p.endsWith(path.sep) ? p : p + path.sep;
    // Case-insensitive compare on Windows is safest; normalize to lower.
    return cand.toLowerCase().startsWith(root.toLowerCase());
  }
}

