import fs from "node:fs";
import path from "node:path";
import { homeLayout, nowIso } from "@samirthakur024/shared";
import type { Logger } from "@samirthakur024/shared";
import type { DevMemory } from "../project/project-service.js";
import { ProjectWatcher, type WatchEvent } from "./project-watcher.js";

export interface DaemonOptions {
  /** Only watch these projects; defaults to every active project. */
  projectIds?: string[];
  debounceMs?: number;
  /** How often to look for newly connected projects. Default 60s. */
  refreshMs?: number;
  /** How often to run housekeeping. Default 30 minutes. */
  maintenanceMs?: number;
  logger?: Logger;
  onEvent?: (event: WatchEvent) => void;
}

export interface DaemonStatus {
  running: boolean;
  startedAt: string | null;
  watching: Array<{ projectId: string; name: string; root: string }>;
  events: number;
  lastEventAt: string | null;
  maintenanceRuns: number;
}

export interface DaemonRecord {
  pid: number;
  startedAt: string;
  home: string;
}

/**
 * The local background daemon (PRD 56): filesystem watching, incremental indexing,
 * git monitoring and periodic housekeeping, for every connected project at once.
 */
export class DevMemoryDaemon {
  private readonly watchers = new Map<string, ProjectWatcher>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private startedAt: string | null = null;
  private events = 0;
  private lastEventAt: string | null = null;
  private maintenanceRuns = 0;

  constructor(
    private readonly devmemory: DevMemory,
    private readonly options: DaemonOptions = {},
  ) {}

  start(): DaemonStatus {
    if (this.startedAt) return this.status();
    this.startedAt = nowIso();

    this.syncWatchers();

    this.refreshTimer = setInterval(() => this.syncWatchers(), this.options.refreshMs ?? 60_000);
    this.refreshTimer.unref?.();

    this.maintenanceTimer = setInterval(() => this.maintain(), this.options.maintenanceMs ?? 30 * 60_000);
    this.maintenanceTimer.unref?.();

    this.options.logger?.info({ projects: this.watchers.size }, "daemon started");
    return this.status();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.refreshTimer = undefined;
    this.maintenanceTimer = undefined;

    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    this.startedAt = null;
    this.options.logger?.info("daemon stopped");
  }

  /** Brings the watcher set in line with the registry, adding and dropping projects. */
  syncWatchers(): void {
    const wanted = this.devmemory
      .listProjects()
      .filter((project) => project.status === "active")
      .filter((project) => !this.options.projectIds || this.options.projectIds.includes(project.projectId))
      .filter((project) => fs.existsSync(project.rootPath));

    const wantedIds = new Set(wanted.map((project) => project.projectId));

    for (const [projectId, watcher] of this.watchers) {
      if (wantedIds.has(projectId)) continue;
      watcher.stop();
      this.watchers.delete(projectId);
    }

    for (const project of wanted) {
      if (this.watchers.has(project.projectId)) continue;
      try {
        const watcher = new ProjectWatcher(this.devmemory, project, {
          ...(this.options.debounceMs !== undefined ? { debounceMs: this.options.debounceMs } : {}),
          onEvent: (event) => {
            this.events++;
            this.lastEventAt = event.at;
            this.options.logger?.debug(
              { project: event.projectId, changed: event.changed.length, removed: event.removed.length },
              "reindexed after change",
            );
            this.options.onEvent?.(event);
          },
          onError: (error) => this.options.logger?.warn({ err: error.message }, "watcher error"),
        });
        watcher.start();
        this.watchers.set(project.projectId, watcher);
      } catch (error) {
        this.options.logger?.warn(
          { project: project.projectId, err: error instanceof Error ? error.message : String(error) },
          "could not watch project",
        );
      }
    }
  }

  /** Housekeeping: expire stale memories and keep cached context from growing forever. */
  maintain(): { projects: number; archivedMemories: number } {
    let archivedMemories = 0;
    const projects = [...this.watchers.keys()];

    for (const projectId of projects) {
      try {
        archivedMemories += this.devmemory.memoryFor(projectId).archiveExpired();
      } catch (error) {
        this.options.logger?.warn(
          { project: projectId, err: error instanceof Error ? error.message : String(error) },
          "maintenance failed",
        );
      }
    }

    this.maintenanceRuns++;
    return { projects: projects.length, archivedMemories };
  }

  /** Processes every watcher's pending changes now - used on shutdown and in tests. */
  async flush(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.flush()));
  }

  status(): DaemonStatus {
    return {
      running: this.startedAt !== null,
      startedAt: this.startedAt,
      watching: [...this.watchers.values()].map((watcher) => {
        const project = this.devmemory.registry.get(watcher.projectId);
        return {
          projectId: watcher.projectId,
          name: project?.name ?? watcher.projectId,
          root: watcher.root,
        };
      }),
      events: this.events,
      lastEventAt: this.lastEventAt,
      maintenanceRuns: this.maintenanceRuns,
    };
  }
}

/** Where the daemon records that it is running, so the CLI can find and stop it. */
export function daemonPidFile(home?: string): string {
  return path.join(homeLayout(home).runtimeDir, "daemon.json");
}

export function readDaemonRecord(home?: string): DaemonRecord | null {
  const file = daemonPidFile(home);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as DaemonRecord;
  } catch {
    return null;
  }
}

export function writeDaemonRecord(record: DaemonRecord, home?: string): void {
  const file = daemonPidFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
}

export function clearDaemonRecord(home?: string): void {
  try {
    fs.rmSync(daemonPidFile(home), { force: true });
  } catch {
    /* a missing pid file is the state we wanted anyway */
  }
}

/** True when the recorded process is still alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
