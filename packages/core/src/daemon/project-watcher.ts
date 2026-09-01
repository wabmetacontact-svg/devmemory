import fs from "node:fs";
import path from "node:path";
import { relativePath } from "@devmemory/shared";
import type { IndexRunStats, ProjectRecord } from "@devmemory/shared";
import { IgnoreMatcher, isSensitiveFile } from "@devmemory/indexer";
import type { DevMemory } from "../project/project-service.js";

export interface WatchEvent {
  projectId: string;
  changed: string[];
  removed: string[];
  branchChanged: string | null;
  stats: IndexRunStats | null;
  invalidatedContexts: number;
  at: string;
}

export interface ProjectWatcherOptions {
  /** How long to wait for a burst of edits to settle before re-indexing. */
  debounceMs?: number;
  onEvent?: (event: WatchEvent) => void;
  onError?: (error: Error) => void;
}

/**
 * Watches one project and keeps its index current (PRD 56). A single edited file
 * costs a single-file re-index; nothing here ever rebuilds a project wholesale.
 */
export class ProjectWatcher {
  private readonly debounceMs: number;
  private watchers: fs.FSWatcher[] = [];
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private flushing: Promise<WatchEvent | null> = Promise.resolve(null);
  private matcher: IgnoreMatcher;
  private branch: string | null;

  constructor(
    private readonly devmemory: DevMemory,
    private readonly project: ProjectRecord,
    private readonly options: ProjectWatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    this.matcher = this.devmemory.indexerFor(project.projectId).buildMatcher(project.rootPath);
    this.branch = null;
  }

  get isWatching(): boolean {
    return this.running;
  }

  get projectId(): string {
    return this.project.projectId;
  }

  get root(): string {
    return this.project.rootPath;
  }

  start(): void {
    if (this.running) return;
    if (!fs.existsSync(this.project.rootPath)) {
      throw new Error(`project root does not exist: ${this.project.rootPath}`);
    }

    this.running = true;
    this.branch = this.currentBranch();

    // fs.watch with recursive:true is supported on every platform DevMemory targets
    // (Node >= 20), which keeps the daemon dependency-free.
    this.watchers.push(
      fs.watch(this.project.rootPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        this.queue(filename.toString());
      }),
    );

    // A branch switch changes many files at once; git tells us directly.
    const headFile = path.join(this.project.rootPath, ".git", "HEAD");
    if (fs.existsSync(headFile)) {
      this.watchers.push(
        fs.watch(headFile, () => {
          this.queue(".git/HEAD");
        }),
      );
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        /* closing an already-closed watcher is not an error */
      }
    }
    this.watchers = [];
    this.pending.clear();
  }

  /** Processes anything pending immediately - the hook tests and shutdown use. */
  async flush(): Promise<WatchEvent | null> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.run();
  }

  private queue(filename: string): void {
    const relative = filename.replace(/\\/g, "/");

    if (relative === ".git/HEAD") {
      this.pending.add(relative);
      this.schedule();
      return;
    }

    // Ignored and sensitive paths must not even wake the indexer (PRD 20, 37).
    // A watcher also sees bare directory events, so every segment is checked.
    if (
      relative.startsWith(".git/") ||
      isSensitiveFile(relative) ||
      this.matcher.isIgnoredAnySegment(relative) ||
      this.matcher.isIgnoredPath(relative)
    ) {
      return;
    }

    this.pending.add(relative);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Serialised so overlapping bursts cannot start two index runs at once. */
  private run(): Promise<WatchEvent | null> {
    this.flushing = this.flushing.then(() => this.process()).catch((error: unknown) => {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return null;
    });
    return this.flushing;
  }

  private async process(): Promise<WatchEvent | null> {
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length === 0) return null;

    const headTouched = paths.includes(".git/HEAD");
    const files = paths.filter((entry) => entry !== ".git/HEAD");

    const changed: string[] = [];
    const removed: string[] = [];
    for (const relative of files) {
      if (fs.existsSync(path.join(this.project.rootPath, relative))) changed.push(relative);
      else removed.push(relative);
    }

    const branchNow = headTouched ? this.currentBranch() : this.branch;
    const branchChanged = headTouched && branchNow !== this.branch ? branchNow : null;
    this.branch = branchNow;

    let stats: IndexRunStats | null = null;
    // A deletion or a branch switch needs a full scan to be seen at all; a plain
    // edit only needs the files that actually changed (PRD 56).
    const needsFullScan = removed.length > 0 || branchChanged !== null;

    if (needsFullScan) {
      stats = await this.devmemory.index(this.project.projectId);
    } else if (changed.length > 0) {
      stats = await this.devmemory.index(this.project.projectId, { only: changed });
    }

    const cache = this.devmemory.contextCacheFor(this.project.projectId);
    const invalidatedContexts = branchChanged !== null ? cache.clear() : cache.invalidatePaths([...changed, ...removed]);

    const event: WatchEvent = {
      projectId: this.project.projectId,
      changed,
      removed,
      branchChanged,
      stats,
      invalidatedContexts,
      at: new Date().toISOString(),
    };

    this.options.onEvent?.(event);
    return event;
  }

  private currentBranch(): string | null {
    if (this.project.repositoryType !== "git") return null;
    try {
      return this.devmemory.git.currentBranch(this.project.rootPath);
    } catch {
      return null;
    }
  }
}

/** Project-relative, forward-slashed path for a watcher event. */
export function toRelative(root: string, absolute: string): string {
  return relativePath(root, absolute);
}
