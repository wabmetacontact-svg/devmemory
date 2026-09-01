import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DevMemory } from "@devmemory/core";
import { defaultConfig, normalizePath } from "@devmemory/shared";
import type { DevMemoryConfig } from "@devmemory/shared";

const created: string[] = [];

/** Fresh, isolated DEVMEMORY_HOME for a test. */
export function makeHome(label = "home"): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `devmemory-${label}-`));
  created.push(home);
  return normalizePath(home);
}

export function makeDevMemory(home = makeHome(), config?: Partial<DevMemoryConfig>): DevMemory {
  const merged = { ...defaultConfig(), ...(config ?? {}) } as DevMemoryConfig;
  return new DevMemory({ home, config: merged });
}

export interface TempProjectOptions {
  files?: Record<string, string>;
  git?: boolean;
  remote?: string;
  commit?: boolean;
  name?: string;
}

/** Creates a throwaway project directory, optionally as a git repository. */
export function makeProject(options: TempProjectOptions = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `devmemory-project-${options.name ?? "p"}-`));
  created.push(root);

  const files = options.files ?? {
    "package.json": JSON.stringify({ name: options.name ?? "temp-project", dependencies: {} }, null, 2),
    "src/index.ts": "export const value = 1;\n",
  };

  for (const [relative, content] of Object.entries(files)) writeFile(root, relative, content);

  if (options.git !== false) {
    git(root, ["init", "-q", "."]);
    git(root, ["config", "user.email", "test@devmemory.local"]);
    git(root, ["config", "user.name", "DevMemory Test"]);
    if (options.remote) git(root, ["remote", "add", "origin", options.remote]);
    if (options.commit !== false) {
      git(root, ["add", "-A"]);
      git(root, ["commit", "-qm", "initial"]);
    }
  }

  return normalizePath(root);
}

export function writeFile(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return normalizePath(target);
}

export function removeFile(root: string, relative: string): void {
  fs.rmSync(path.join(root, relative), { force: true });
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Moves a project directory, simulating a developer relocating it (PRD 9). */
export function moveProject(from: string, label = "moved"): string {
  const to = path.join(path.dirname(from), `${path.basename(from)}-${label}`);
  fs.renameSync(from, to);
  created.push(to);
  return normalizePath(to);
}

export function cleanupAll(): void {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows can hold a handle briefly; a leftover temp dir is harmless. */
    }
  }
}

/**
 * Credentials for the security tests. They are assembled at runtime so the literal
 * never appears in the source: secret scanners (GitHub push protection, for one)
 * block a push that contains something shaped like a live token, even a fake one.
 * The runtime value is what the detectors see, so behaviour is unchanged.
 */
export const FAKE_SECRETS = {
  githubToken: ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_"),
  stripeKey: ["sk", "live", "51H8xExampleKeyValue123456"].join("_"),
  stripeKeyAlt: ["sk", "live", "0123456789abcdefghij"].join("_"),
  stripeKeyShort: ["sk", "live", "0123456789abcdef"].join("_"),
} as const;
