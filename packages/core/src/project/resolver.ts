import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DevMemoryError, normalizePath, projectIdFromIdentity, sha256 } from "@devmemory/shared";
import type { IdentitySource, ProjectIdentity } from "@devmemory/shared";
import { GitEngine, normalizeRemoteUrl } from "../git/git-engine.js";

/** Files that mark the root of a project when there is no git repository. */
const PROJECT_MARKERS = [
  "package.json",
  "pnpm-workspace.yaml",
  "deno.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "pubspec.yaml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "Makefile",
];

export interface ResolveOptions {
  /** Explicit root from project_connect - highest priority (PRD 8, fallback 2). */
  explicitRoot?: string;
  /** Workspace roots advertised by the MCP client (PRD 8, fallback 1). */
  clientRoots?: string[];
  /** Process working directory - the last positional fallback. */
  cwd?: string;
}

export interface ResolvedWorkspace {
  /** Directory the resolution started from. */
  startDir: string;
  /** Detected project root. */
  root: string;
  /** Which input produced startDir. */
  origin: "explicit" | "client_root" | "cwd";
  gitRoot: string | null;
}

export interface ProjectResolverOptions {
  git?: GitEngine;
}

/**
 * Turns "wherever the agent happens to be" into a stable project identity,
 * without writing anything into the project itself (PRD 5.2, 8, 9).
 */
export class ProjectResolver {
  private readonly git: GitEngine;

  constructor(options: ProjectResolverOptions = {}) {
    this.git = options.git ?? new GitEngine();
  }

  /** Picks the workspace directory and its project root. */
  resolveWorkspace(options: ResolveOptions = {}): ResolvedWorkspace {
    const candidates: Array<{ dir: string; origin: ResolvedWorkspace["origin"] }> = [];
    if (options.explicitRoot) candidates.push({ dir: options.explicitRoot, origin: "explicit" });
    for (const root of options.clientRoots ?? []) candidates.push({ dir: root, origin: "client_root" });
    candidates.push({ dir: options.cwd ?? process.cwd(), origin: "cwd" });

    for (const candidate of candidates) {
      const dir = safeDirectory(candidate.dir);
      if (!dir) continue;
      const gitRoot = this.git.isAvailable() ? this.git.repoRoot(dir) : null;
      const root = normalizePath(gitRoot ?? findMarkerRoot(dir) ?? dir);

      // An inferred root that landed on the home directory means the agent was
      // simply started outside any project; say so rather than indexing everything.
      if (candidate.origin !== "explicit" && isUnsafeProjectRoot(root)) {
        throw new DevMemoryError(
          "NOT_A_DIRECTORY",
          `refusing to treat ${root} as a project root - start the agent inside a project, or pass an explicit root`,
          { root },
        );
      }

      return { startDir: dir, root, origin: candidate.origin, gitRoot };
    }

    throw new DevMemoryError("NOT_A_DIRECTORY", "no readable workspace directory could be resolved", {
      tried: candidates.map((candidate) => candidate.dir),
    });
  }

  /** Full identity for a workspace, following the PRD 9 priority order. */
  resolveIdentity(options: ResolveOptions = {}): ProjectIdentity {
    const workspace = this.resolveWorkspace(options);
    return this.identityForRoot(workspace.root, workspace.gitRoot);
  }

  identityForRoot(root: string, gitRootHint?: string | null): ProjectIdentity {
    const normalizedRoot = normalizePath(root);
    const gitRoot =
      gitRootHint === undefined ? (this.git.isAvailable() ? this.git.repoRoot(normalizedRoot) : null) : gitRootHint;

    let identitySource: IdentitySource = "path";
    let identityKey = `path:${normalizedRoot.toLowerCase()}`;
    let repositoryUrl: string | null = null;

    if (gitRoot) {
      const remote = this.git.remoteUrl(gitRoot);
      if (remote) {
        repositoryUrl = remote;
        identitySource = "git_remote";
        identityKey = `git:remote:${normalizeRemoteUrl(remote)}`;
      } else {
        const rootCommit = this.git.rootCommit(gitRoot);
        if (rootCommit) {
          identitySource = "git_root_commit";
          identityKey = `git:root-commit:${rootCommit}`;
        }
      }
    }

    if (identitySource === "path") {
      const fingerprint = computeFingerprint(normalizedRoot);
      if (fingerprint) {
        identitySource = "fingerprint";
        identityKey = `fingerprint:${fingerprint}`;
      }
    }

    return {
      projectId: projectIdFromIdentity(identityKey),
      name: deriveName(normalizedRoot, repositoryUrl),
      rootPath: gitRoot ?? normalizedRoot,
      identitySource,
      identityKey,
      repositoryUrl,
      repositoryType: gitRoot ? "git" : null,
      isGitRepo: Boolean(gitRoot),
    };
  }
}

function safeDirectory(input: string): string | null {
  try {
    const resolved = path.resolve(input);
    return fs.statSync(resolved).isDirectory() ? normalizePath(resolved) : null;
  } catch {
    return null;
  }
}

/** Files that identify a monorepo root sitting above a package's own manifest. */
const WORKSPACE_MARKERS = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "rush.json", "go.work"];

function hasMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

function isWorkspaceRoot(dir: string): boolean {
  if (WORKSPACE_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) return true;
  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { workspaces?: unknown };
    return parsed.workspaces !== undefined;
  } catch {
    return false;
  }
}

/**
 * The user's home directory and filesystem roots are never projects. Treating one
 * as a project root would index everything the user owns - slow, and a privacy
 * problem (PRD 61).
 */
export function isUnsafeProjectRoot(candidate: string): boolean {
  const normalized = normalizePath(candidate);
  if (normalized === normalizePath(os.homedir())) return true;
  return normalized === normalizePath(path.parse(path.resolve(candidate)).root);
}

/**
 * Walks up from dir to the *nearest* project manifest, then promotes to a monorepo
 * root if one sits a few levels above it. Nearest-wins matters: an unrelated
 * manifest high in the tree (a stray build.gradle.kts in the home directory, say)
 * must never capture a project below it.
 */
function findMarkerRoot(dir: string): string | null {
  let current = path.resolve(dir);
  let nearest: string | null = null;

  for (let depth = 0; depth < 64; depth++) {
    if (isUnsafeProjectRoot(current)) break;
    if (hasMarker(current)) {
      nearest = normalizePath(current);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (!nearest) return null;

  let best = nearest;
  let cursor = path.resolve(nearest);
  for (let depth = 0; depth < 6; depth++) {
    const parent = path.dirname(cursor);
    if (parent === cursor || isUnsafeProjectRoot(parent)) break;
    if (isWorkspaceRoot(parent)) best = normalizePath(parent);
    cursor = parent;
  }

  return best;
}

/**
 * Content fingerprint for projects with no git identity. Combines the declared
 * package name, the directory name and the set of manifests present, so a project
 * that is moved (but not renamed and re-tooled) keeps its identity (PRD 9).
 */
function computeFingerprint(root: string): string | null {
  const markers = PROJECT_MARKERS.filter((marker) => fs.existsSync(path.join(root, marker)));
  if (markers.length === 0) return null;

  let declaredName = "";
  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
      declaredName = parsed.name ?? "";
    } catch {
      declaredName = "";
    }
  }

  const basename = path.basename(root).toLowerCase();
  return sha256([declaredName.toLowerCase(), basename, markers.sort().join(",")].join("|")).slice(0, 24);
}

function deriveName(root: string, repositoryUrl: string | null): string {
  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
      if (parsed.name) {
        const scoped = parsed.name.startsWith("@") ? parsed.name.split("/").pop() : parsed.name;
        if (scoped) return scoped;
      }
    } catch {
      /* fall through to directory name */
    }
  }

  if (repositoryUrl) {
    const normalized = normalizeRemoteUrl(repositoryUrl);
    const last = normalized.split("/").pop();
    if (last) return last;
  }

  return path.basename(root) || root;
}
