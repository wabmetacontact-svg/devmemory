import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { DevMemoryError, normalizePath } from "@devmemory/shared";

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body?: string;
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileStatus[];
}

export interface GitEngineOptions {
  binary?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Thin, deterministic wrapper over the native git CLI (PRD 5.7, 12). No libgit2
 * binding and no network access - only local repository facts.
 */
export class GitEngine {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private available?: boolean;

  constructor(options: GitEngineOptions = {}) {
    this.binary = options.binary ?? "git";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBuffer = options.maxBufferBytes ?? 32 * 1024 * 1024;
  }

  private run(cwd: string, args: string[]): RunResult {
    const result = spawnSync(this.binary, args, {
      cwd,
      encoding: "utf8",
      timeout: this.timeoutMs,
      maxBuffer: this.maxBuffer,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.error) return { ok: false, stdout: "", stderr: result.error.message, code: null };
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status,
    };
  }

  private must(cwd: string, args: string[]): string {
    const result = this.run(cwd, args);
    if (!result.ok) {
      throw new DevMemoryError("GIT_ERROR", `git ${args[0]} failed: ${result.stderr.trim() || "unknown error"}`, {
        args,
        cwd,
      });
    }
    return result.stdout;
  }

  isAvailable(): boolean {
    if (this.available !== undefined) return this.available;
    this.available = this.run(process.cwd(), ["--version"]).ok;
    return this.available;
  }

  version(): string | null {
    const result = this.run(process.cwd(), ["--version"]);
    return result.ok ? result.stdout.trim() : null;
  }

  /** Absolute repository root for any path inside a work tree, or null. */
  repoRoot(cwd: string): string | null {
    if (!fs.existsSync(cwd)) return null;
    const result = this.run(cwd, ["rev-parse", "--show-toplevel"]);
    if (!result.ok) return null;
    const root = result.stdout.trim();
    return root ? normalizePath(root) : null;
  }

  isRepo(cwd: string): boolean {
    return this.repoRoot(cwd) !== null;
  }

  remoteUrl(root: string, remote = "origin"): string | null {
    const primary = this.run(root, ["config", "--get", `remote.${remote}.url`]);
    if (primary.ok && primary.stdout.trim()) return primary.stdout.trim();

    const remotes = this.run(root, ["remote"]);
    if (!remotes.ok) return null;
    const first = remotes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (!first || first === remote) return null;
    const fallback = this.run(root, ["config", "--get", `remote.${first}.url`]);
    return fallback.ok && fallback.stdout.trim() ? fallback.stdout.trim() : null;
  }

  /**
   * Hash of the repository's first commit. Stable across clones, moves and renames,
   * which makes it a sound identity for a repo that has no remote yet (PRD 9).
   */
  rootCommit(root: string): string | null {
    const result = this.run(root, ["rev-list", "--max-parents=0", "HEAD"]);
    if (!result.ok) return null;
    const lines = result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.length ? (lines[lines.length - 1] ?? null) : null;
  }

  headCommit(root: string): string | null {
    const result = this.run(root, ["rev-parse", "HEAD"]);
    return result.ok ? result.stdout.trim() || null : null;
  }

  currentBranch(root: string): string | null {
    const result = this.run(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!result.ok) return null;
    const branch = result.stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  }

  branches(root: string): string[] {
    const result = this.run(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (!result.ok) return [];
    return result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  status(root: string): GitStatus {
    const raw = this.must(root, ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"]);
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, clean: true, files: [] };

    for (const line of lines) {
      if (line.startsWith("##")) {
        const header = line.slice(2).trim();
        const [branchPart, trackingPart] = header.split(/\s+\[/, 2);
        const [local, upstream] = (branchPart ?? "").split("...");
        status.branch = !local || local.startsWith("HEAD (") ? null : local;
        status.upstream = upstream ?? null;
        if (trackingPart) {
          status.ahead = Number(/ahead (\d+)/.exec(trackingPart)?.[1] ?? 0);
          status.behind = Number(/behind (\d+)/.exec(trackingPart)?.[1] ?? 0);
        }
        continue;
      }

      const index = line[0] ?? " ";
      const worktree = line[1] ?? " ";
      let file = line.slice(3);
      const arrow = file.indexOf(" -> ");
      if (arrow !== -1) file = file.slice(arrow + 4);
      file = file.replace(/^"|"$/g, "");

      status.files.push({
        path: file,
        index,
        worktree,
        staged: index !== " " && index !== "?",
        untracked: index === "?",
      });
    }

    status.clean = status.files.length === 0;
    return status;
  }

  log(root: string, options: { limit?: number; since?: string; file?: string; branch?: string } = {}): GitCommit[] {
    const unit = "\u001f";
    const record = "\u001e";
    const args = ["log", `--pretty=format:%H${unit}%h${unit}%an${unit}%ae${unit}%aI${unit}%s${unit}%b${record}`];
    args.push(`--max-count=${options.limit ?? 20}`);
    if (options.since) args.push(`--since=${options.since}`);
    if (options.branch) args.push(options.branch);
    if (options.file) args.push("--", options.file);

    const result = this.run(root, args);
    if (!result.ok) return [];

    return result.stdout
      .split(record)
      .map((chunk) => chunk.replace(/^\r?\n/, ""))
      .filter((chunk) => chunk.trim().length > 0)
      .map((chunk) => {
        const parts = chunk.split(unit);
        const commit: GitCommit = {
          hash: parts[0] ?? "",
          shortHash: parts[1] ?? "",
          author: parts[2] ?? "",
          email: parts[3] ?? "",
          date: parts[4] ?? "",
          subject: parts[5] ?? "",
        };
        const body = (parts[6] ?? "").trim();
        if (body) commit.body = body;
        return commit;
      });
  }

  diff(root: string, options: { staged?: boolean; ref?: string; file?: string; nameOnly?: boolean } = {}): string {
    const args = ["diff"];
    if (options.staged) args.push("--cached");
    if (options.nameOnly) args.push("--name-only");
    if (options.ref) args.push(options.ref);
    if (options.file) args.push("--", options.file);
    const result = this.run(root, args);
    return result.ok ? result.stdout : "";
  }

  /** Every file touched since a ref, including staged, unstaged and untracked work. */
  changedFilesSince(root: string, ref: string): string[] {
    const committed = this.run(root, ["diff", "--name-only", `${ref}..HEAD`]);
    const working = this.run(root, ["diff", "--name-only", "HEAD"]);
    const untracked = this.run(root, ["ls-files", "--others", "--exclude-standard"]);
    const all = [committed, working, untracked]
      .filter((result) => result.ok)
      .flatMap((result) => result.stdout.split(/\r?\n/))
      .map((line) => line.trim())
      .filter(Boolean);
    return [...new Set(all)];
  }

  /**
   * Files git itself considers part of the project: tracked plus untracked-but-not-
   * ignored. Using git as the enumerator gives exact .gitignore semantics for free.
   */
  listFiles(root: string): string[] | null {
    const result = this.run(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    if (!result.ok) return null;
    return result.stdout.split("\u0000").map((line) => line.trim()).filter(Boolean);
  }

  show(root: string, ref: string): string {
    return this.must(root, ["show", "--stat", "--patch", ref]);
  }

  blame(root: string, file: string, options: { start?: number; end?: number } = {}): string {
    const args = ["blame", "--line-porcelain"];
    if (options.start && options.end) args.push("-L", `${options.start},${options.end}`);
    args.push("--", file);
    const result = this.run(root, args);
    return result.ok ? result.stdout : "";
  }
}

/**
 * Canonical form of a remote URL so that ssh and https clones of one repository
 * resolve to a single identity: git@github.com:u/r.git and https://github.com/u/r
 * both become "github.com/u/r".
 */
export function normalizeRemoteUrl(url: string): string {
  let value = url.trim();
  value = value.replace(/^[a-z+]+:\/\//i, "");
  value = value.replace(/^[^@/]+@/, "");
  value = value.replace(/:(\d+)\//, "/");
  value = value.replace(/:(?!\/)/, "/");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/\/+$/, "");
  return value.toLowerCase();
}
