import fs from "node:fs";
import path from "node:path";
import {
  DevMemoryError,
  loadConfig,
  normalizePath,
  nowIso,
  resolveHome,
  writeJsonAtomic,
  projectLayout,
} from "@devmemory/shared";
import type { DevMemoryConfig, IndexRunStats, ProjectDetection, ProjectRecord } from "@devmemory/shared";
import { DatabaseManager, type SqliteDriver } from "@devmemory/storage";
import { FilesystemIndexer, FileStore, SearchStore, SymbolStore, type CodeStats, type FileStats } from "@devmemory/indexer";
import { GitEngine, type GitStatus } from "../git/git-engine.js";
import { CodeIntelligence } from "../code/code-intelligence.js";
import { ContextEngine } from "../context/context-engine.js";
import { ContextCache, type ContextAnalytics } from "../context/context-cache.js";
import { PermissionEngine } from "../security/permissions.js";
import { RecoveryEngine } from "../recovery/recovery-engine.js";
import { MemoryEngine } from "../memory/memory-engine.js";
import { MemoryStore, type MemoryStats } from "../memory/memory-store.js";
import { TaskEngine } from "../tasks/task-engine.js";
import { SessionEngine } from "../sessions/session-engine.js";
import { buildHandoff, type HandoffReport } from "../sessions/handoff.js";
import { ProjectRegistry } from "./registry.js";
import { ProjectResolver, type ResolveOptions } from "./resolver.js";
import { detectProject } from "./detection.js";

export interface DevMemoryOptions {
  home?: string;
  config?: DevMemoryConfig;
  driver?: SqliteDriver;
  git?: GitEngine;
}

export interface ConnectOptions extends ResolveOptions {
  /** Index immediately after registering. Defaults to true. */
  index?: boolean;
  /** Force a full rebuild rather than an incremental pass. */
  full?: boolean;
}

export interface ConnectResult {
  project: ProjectRecord;
  detection: ProjectDetection;
  index: IndexRunStats | null;
  git: GitSummary | null;
  reconnected: boolean;
  movedFrom: string | null;
}

export interface GitSummary {
  branch: string | null;
  head: string | null;
  clean: boolean;
  changedFiles: number;
  ahead: number;
  behind: number;
}

export interface ProjectStatusReport {
  project: ProjectRecord;
  files: FileStats;
  code: CodeStats;
  memory: MemoryStats;
  tasks: ReturnType<TaskEngine["stats"]>;
  sessions: ReturnType<SessionEngine["stats"]>;
  context: ContextAnalytics;
  security: ReturnType<FileStore["securityFindings"]>;
  git: GitSummary | null;
  index: {
    status: string;
    lastIndexedAt: string | null;
    incomplete: boolean;
  };
  storagePath: string;
}

export interface ProjectMapEntry {
  path: string;
  files: number;
  languages: string[];
}

export interface ProjectMap {
  projectId: string;
  name: string;
  root: string;
  framework: string | null;
  languages: string[];
  files: number;
  directories: ProjectMapEntry[];
  entryPoints: string[];
  truncated: boolean;
}

/**
 * Facade that wires the resolver, registry, git engine and indexer together.
 * Every surface - MCP server, CLI and later the dashboard - drives this one object,
 * which is what keeps them consistent (PRD 41).
 */
export class DevMemory {
  readonly home: string;
  readonly config: DevMemoryConfig;
  readonly databases: DatabaseManager;
  readonly registry: ProjectRegistry;
  readonly resolver: ProjectResolver;
  readonly git: GitEngine;
  /** Operation policy for every surface that calls in (PRD 38). */
  readonly permissions: PermissionEngine;

  constructor(options: DevMemoryOptions = {}) {
    this.home = options.home ?? resolveHome();
    this.config = options.config ?? loadConfig(this.home);
    this.databases = new DatabaseManager({ home: this.home, ...(options.driver ? { driver: options.driver } : {}) });
    this.registry = new ProjectRegistry(this.databases);
    this.git = options.git ?? new GitEngine({ binary: this.config.git.binary });
    this.resolver = new ProjectResolver({ git: this.git });
    this.permissions = new PermissionEngine(this.config.security.permissions);
  }

  /** Resolves, registers and (by default) indexes the project for a workspace (PRD 8). */
  async connect(options: ConnectOptions = {}): Promise<ConnectResult> {
    const identity = this.resolver.resolveIdentity(options);
    const existing = this.registry.getByIdentityKey(identity.identityKey);
    const movedFrom = existing && existing.rootPath !== normalizePath(identity.rootPath) ? existing.rootPath : null;

    const detection = detectProject(identity.rootPath);
    const project = this.registry.connect(identity, detection);
    this.writeProjectMetadata(project, detection);

    const shouldIndex = options.index ?? true;
    const index = shouldIndex ? await this.index(project.projectId, { full: options.full ?? false }) : null;

    return {
      project: this.registry.get(project.projectId) ?? project,
      detection,
      index,
      git: this.gitSummary(project),
      reconnected: Boolean(existing),
      movedFrom,
    };
  }

  /** Finds the project for a workspace without registering anything. */
  resolveProject(options: ResolveOptions = {}): ProjectRecord | null {
    const workspace = this.resolver.resolveWorkspace(options);
    const identity = this.resolver.identityForRoot(workspace.root, workspace.gitRoot);
    return this.registry.getByIdentityKey(identity.identityKey) ?? this.registry.findByPath(workspace.root);
  }

  /**
   * Resolves the project a tool call refers to: an explicit project_id wins, then
   * the workspace, and an unregistered workspace is connected on the spot so agents
   * never have to bootstrap by hand (PRD 8).
   */
  async requireProject(options: ResolveOptions & { projectId?: string; autoConnect?: boolean } = {}): Promise<ProjectRecord> {
    if (options.projectId) {
      const byId = this.registry.get(options.projectId);
      if (!byId) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${options.projectId}`);
      this.registry.touch(byId.projectId);
      return byId;
    }

    const existing = this.resolveProject(options);
    if (existing) {
      this.registry.touch(existing.projectId);
      return existing;
    }

    if (options.autoConnect === false) {
      throw new DevMemoryError("PROJECT_NOT_CONNECTED", "no DevMemory project is connected for this workspace", {
        cwd: options.cwd ?? process.cwd(),
      });
    }

    return (await this.connect({ ...options, index: true })).project;
  }

  indexerFor(projectId: string): FilesystemIndexer {
    return new FilesystemIndexer(this.databases.openProjectIndex(projectId), this.config);
  }

  filesFor(projectId: string): FileStore {
    return new FileStore(this.databases.openProjectIndex(projectId));
  }

  /** Symbol, import and reference store for a project (PRD 16, 17). */
  codeFor(projectId: string): SymbolStore {
    return new SymbolStore(this.databases.openProjectIndex(projectId));
  }

  /** Long-lived project knowledge: facts, decisions, discoveries, bugs (PRD 27). */
  memoryFor(projectId: string): MemoryEngine {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);

    return new MemoryEngine(projectId, new MemoryStore(this.databases.openProjectMemory(projectId)), this.branchOf(project));
  }

  /** Structured development work for a project (PRD 30). */
  tasksFor(projectId: string): TaskEngine {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);
    return new TaskEngine(projectId, this.databases.openProjectMemory(projectId), this.branchOf(project));
  }

  /** Session records for a project (PRD 31). */
  sessionsFor(projectId: string): SessionEngine {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);

    return new SessionEngine({
      projectId,
      db: this.databases.openProjectMemory(projectId),
      git: this.config.git.enabled && this.git.isAvailable() ? this.git : null,
      root: project.rootPath,
      isGitRepo: project.repositoryType === "git",
    });
  }

  /**
   * Everything a different agent needs to continue this project's work (PRD 32).
   * Built from durable state alone - no previous conversation required.
   */
  handoff(projectId: string): HandoffReport {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);

    return buildHandoff({
      project,
      tasks: this.tasksFor(projectId),
      sessions: this.sessionsFor(projectId),
      memory: this.memoryFor(projectId),
      git: this.config.git.enabled && this.git.isAvailable() ? this.git : null,
    });
  }

  /** Current git branch for a project, or null when git is unavailable. */
  private branchOf(project: ProjectRecord): string | null {
    if (!this.config.git.enabled || project.repositoryType !== "git" || !this.git.isAvailable()) return null;
    return this.git.currentBranch(project.rootPath);
  }

  /** Health checks and self-repair for this installation (PRD 60, 64). */
  recovery(): RecoveryEngine {
    return new RecoveryEngine(this);
  }

  /** Cached context results and token analytics for a project (PRD 25, 65). */
  contextCacheFor(projectId: string): ContextCache {
    return new ContextCache(projectId, this.databases.openProjectIndex(projectId));
  }

  /** Full-text search index for a project (PRD 21, 53). */
  searchFor(projectId: string): SearchStore {
    return new SearchStore(this.databases.openProjectIndex(projectId));
  }

  /** Context assembly for one project: seed, expand, rank, fit to a token budget. */
  contextEngine(projectId: string): ContextEngine {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);

    return new ContextEngine({
      project,
      files: this.filesFor(projectId),
      symbols: this.codeFor(projectId),
      search: this.searchFor(projectId),
      code: this.codeIntelligence(projectId),
      memory: this.memoryFor(projectId),
      cache: this.contextCacheFor(projectId),
      git: this.config.git.enabled && this.git.isAvailable() ? this.git : null,
      redactSecrets: this.config.security.redactSecrets,
    });
  }

  /** Query layer over the code graph, bound to one project. */
  codeIntelligence(projectId: string): CodeIntelligence {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);
    return new CodeIntelligence(projectId, project.rootPath, this.codeFor(projectId), this.filesFor(projectId), {
      redactSecrets: this.config.security.redactSecrets,
    });
  }

  /** Incremental index pass; git enumerates candidates when the project is a repo. */
  async index(projectId: string, options: { full?: boolean; only?: string[] } = {}): Promise<IndexRunStats> {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);
    if (!fs.existsSync(project.rootPath)) {
      throw new DevMemoryError("NOT_A_DIRECTORY", `project root no longer exists: ${project.rootPath}`, { projectId });
    }

    this.registry.setIndexState(projectId, "indexing");
    try {
      const candidates =
        project.repositoryType === "git" && this.config.git.enabled ? this.git.listFiles(project.rootPath) : null;

      const stats = await this.indexerFor(projectId).run({
        projectId,
        root: project.rootPath,
        full: options.full ?? false,
        ...(candidates ? { candidates } : {}),
        ...(options.only ? { only: options.only } : {}),
      });

      // Hash checks catch modified files at lookup time, but a file appearing or
      // disappearing can change which files *should* have been selected, and no
      // hash can detect that - so structural change clears the cache (PRD 25).
      if (stats.added > 0 || stats.deleted > 0) this.contextCacheFor(projectId).clear();

      this.registry.setIndexState(projectId, "healthy", nowIso());
      return stats;
    } catch (error) {
      this.registry.setIndexState(projectId, "error");
      throw error;
    }
  }

  status(projectId: string): ProjectStatusReport {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);
    const store = this.filesFor(projectId);

    return {
      project,
      files: store.stats(projectId),
      code: this.codeFor(projectId).stats(projectId),
      memory: this.memoryFor(projectId).stats(),
      tasks: this.tasksFor(projectId).stats(),
      sessions: this.sessionsFor(projectId).stats(),
      context: this.contextCacheFor(projectId).analytics(),
      security: store.securityFindings(projectId, 20),
      git: this.gitSummary(project),
      index: {
        status: project.indexStatus,
        lastIndexedAt: project.lastIndexedAt,
        incomplete: store.hasUnfinishedRun(projectId),
      },
      storagePath: projectLayout(projectId, this.home).root,
    };
  }

  /**
   * Compact structural overview - directory rollups rather than a file list, so the
   * response stays small enough to be worth sending to an agent (PRD 22 L0/L1, 24).
   */
  map(projectId: string, options: { limit?: number } = {}): ProjectMap {
    const project = this.registry.get(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);

    const limit = options.limit ?? 40;
    const files = this.filesFor(projectId).list(projectId, { limit: 20_000 });
    const buckets = new Map<string, { files: number; languages: Set<string> }>();

    for (const file of files) {
      const segments = file.relativePath.split("/");
      const key = segments.length > 1 ? segments.slice(0, Math.min(2, segments.length - 1)).join("/") : ".";
      const bucket = buckets.get(key) ?? { files: 0, languages: new Set<string>() };
      bucket.files++;
      if (file.language) bucket.languages.add(file.language);
      buckets.set(key, bucket);
    }

    const directories = [...buckets.entries()]
      .map(([dirPath, bucket]) => ({ path: dirPath, files: bucket.files, languages: [...bucket.languages].sort() }))
      .sort((a, b) => b.files - a.files);

    const entryPoints = files
      .filter((file) => /^(src\/)?(index|main|app|server|cli)\.(ts|tsx|js|jsx|mjs|py)$/.test(file.relativePath))
      .map((file) => file.relativePath)
      .slice(0, 10);

    return {
      projectId,
      name: project.name,
      root: project.rootPath,
      framework: project.framework,
      languages: project.languages,
      files: files.length,
      directories: directories.slice(0, limit),
      entryPoints,
      truncated: directories.length > limit,
    };
  }

  listProjects(): ProjectRecord[] {
    return this.registry.list();
  }

  disconnect(projectId: string): ProjectRecord {
    const project = this.registry.setStatus(projectId, "disconnected");
    this.databases.closeProject(projectId);
    return project;
  }

  rename(projectId: string, name: string): ProjectRecord {
    return this.registry.rename(projectId, name);
  }

  /** Removes a project from the registry and deletes its local intelligence. */
  remove(projectId: string, options: { deleteData?: boolean } = {}): void {
    this.registry.remove(projectId);
    if (options.deleteData ?? true) this.databases.destroyProjectStorage(projectId);
  }

  gitSummary(project: ProjectRecord): GitSummary | null {
    if (!this.config.git.enabled || project.repositoryType !== "git") return null;
    if (!this.git.isAvailable() || !fs.existsSync(project.rootPath)) return null;

    try {
      const status: GitStatus = this.git.status(project.rootPath);
      return {
        branch: status.branch,
        head: this.git.headCommit(project.rootPath),
        clean: status.clean,
        changedFiles: status.files.length,
        ahead: status.ahead,
        behind: status.behind,
      };
    } catch {
      return null;
    }
  }

  /**
   * Human-readable copy of a project's identity, kept beside its databases. Purely
   * informational - the registry remains the source of truth (PRD 7).
   */
  private writeProjectMetadata(project: ProjectRecord, detection: ProjectDetection): void {
    const layout = projectLayout(project.projectId, this.home);
    writeJsonAtomic(layout.metadataFile, {
      project_id: project.projectId,
      name: project.name,
      root: project.rootPath,
      repository: project.repositoryUrl,
      identity_source: project.identitySource,
      framework: detection.framework,
      frameworks: detection.frameworks,
      languages: detection.languages,
      package_manager: detection.packageManager,
      updated_at: nowIso(),
    });
  }

  close(): void {
    this.databases.closeAll();
  }
}

/** Absolute path of a project-relative file, refusing anything outside the root. */
export function safeProjectPath(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(resolved);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    throw new DevMemoryError("PERMISSION_DENIED", "path escapes the project root", { relative });
  }
  return normalizedTarget;
}
