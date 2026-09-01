import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeLayout, projectLayout } from "@samirthakur024/shared";
import type { ProjectRecord } from "@samirthakur024/shared";
import type { DevMemory } from "../project/project-service.js";

export type IssueSeverity = "error" | "warning";

export interface HealthIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  projectId?: string;
  /** True when repair() can fix this without the developer doing anything. */
  repairable: boolean;
}

export interface HealthReport {
  healthy: boolean;
  home: string;
  platform: { os: string; release: string; node: string; driver: string };
  projects: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  issues: HealthIssue[];
}

export interface RepairOptions {
  /**
   * Rebuild a project's index database from scratch. Safe by construction: the
   * index is derived from the filesystem, so nothing unique is lost.
   */
  rebuildIndex?: boolean;
  /** Remove storage directories belonging to no registered project. */
  removeOrphans?: boolean;
}

export interface RepairAction {
  code: string;
  projectId?: string;
  detail: string;
}

export interface RepairResult {
  actions: RepairAction[];
  remaining: HealthIssue[];
}

/**
 * Health checking and self-repair (PRD 60, 64). The rule that shapes every repair:
 * the index is derived data and may be rebuilt at will, while memory, tasks and
 * sessions are the only irreplaceable things DevMemory holds and are never touched.
 */
export class RecoveryEngine {
  constructor(private readonly devmemory: DevMemory) {}

  check(): HealthReport {
    const layout = homeLayout(this.devmemory.home);
    const issues: HealthIssue[] = [];
    const checks: HealthReport["checks"] = [];

    checks.push({
      name: "storage",
      ok: fs.existsSync(layout.root),
      detail: layout.root,
    });

    let projects: ProjectRecord[] = [];
    try {
      projects = this.devmemory.listProjects();
      checks.push({ name: "registry", ok: true, detail: `${projects.length} projects` });
    } catch (error) {
      checks.push({ name: "registry", ok: false, detail: message(error) });
      issues.push({
        code: "registry_unreadable",
        severity: "error",
        message: `the project registry could not be read: ${message(error)}`,
        repairable: false,
      });
      return this.report(layout.root, projects.length, checks, issues);
    }

    const registryIntegrity = this.integrityOf(() => this.devmemory.databases.openRegistry());
    checks.push({ name: "registry integrity", ok: registryIntegrity === "ok", detail: registryIntegrity });
    if (registryIntegrity !== "ok") {
      issues.push({
        code: "registry_corrupt",
        severity: "error",
        message: `registry database reports: ${registryIntegrity}`,
        repairable: false,
      });
    }

    let missingRoots = 0;
    let incompleteRuns = 0;
    let corruptIndexes = 0;

    for (const project of projects) {
      if (!fs.existsSync(project.rootPath)) {
        missingRoots++;
        issues.push({
          code: "missing_root",
          severity: "warning",
          projectId: project.projectId,
          message: `${project.name} no longer exists at ${project.rootPath}`,
          repairable: false,
        });
        continue;
      }

      const indexIntegrity = this.integrityOf(() => this.devmemory.databases.openProjectIndex(project.projectId));
      if (indexIntegrity !== "ok") {
        corruptIndexes++;
        issues.push({
          code: "index_corrupt",
          severity: "error",
          projectId: project.projectId,
          message: `${project.name}: index database reports ${indexIntegrity}`,
          // The index is derived from the filesystem, so it can simply be rebuilt.
          repairable: true,
        });
        continue;
      }

      const memoryIntegrity = this.integrityOf(() => this.devmemory.databases.openProjectMemory(project.projectId));
      if (memoryIntegrity !== "ok") {
        issues.push({
          code: "memory_corrupt",
          severity: "error",
          projectId: project.projectId,
          message: `${project.name}: memory database reports ${memoryIntegrity} - restore it from a backup, it cannot be regenerated`,
          repairable: false,
        });
      }

      if (this.devmemory.filesFor(project.projectId).hasUnfinishedRun(project.projectId)) {
        incompleteRuns++;
        issues.push({
          code: "incomplete_index",
          severity: "warning",
          projectId: project.projectId,
          message: `${project.name}: an index run did not finish`,
          repairable: true,
        });
      }
    }

    checks.push({ name: "project roots", ok: missingRoots === 0, detail: `${missingRoots} missing` });
    checks.push({ name: "index integrity", ok: corruptIndexes === 0, detail: `${corruptIndexes} corrupt` });
    checks.push({ name: "index runs", ok: incompleteRuns === 0, detail: `${incompleteRuns} interrupted` });

    const orphans = this.orphanDirectories(projects);
    checks.push({ name: "orphan storage", ok: orphans.length === 0, detail: `${orphans.length} directories` });
    for (const orphan of orphans) {
      issues.push({
        code: "orphan_storage",
        severity: "warning",
        message: `storage directory belongs to no registered project: ${orphan}`,
        repairable: true,
      });
    }

    const git = this.devmemory.git.version();
    checks.push({ name: "git", ok: git !== null, detail: git ?? "git binary not found" });
    if (git === null) {
      issues.push({
        code: "git_missing",
        severity: "warning",
        message: "git is not on PATH; repository identity and change tracking are degraded",
        repairable: false,
      });
    }

    return this.report(layout.root, projects.length, checks, issues);
  }

  /**
   * Fixes what can be fixed automatically. Repairs are deliberately conservative:
   * anything that would lose knowledge is reported rather than performed.
   */
  repair(options: RepairOptions = {}): RepairResult {
    const actions: RepairAction[] = [];
    const before = this.check();

    for (const issue of before.issues) {
      if (!issue.repairable) continue;

      if (issue.code === "incomplete_index" && issue.projectId) {
        this.devmemory.filesFor(issue.projectId).abandonUnfinishedRuns(issue.projectId);
        actions.push({
          code: "abandoned_stale_run",
          projectId: issue.projectId,
          detail: "marked the interrupted run as failed; the next index pass will complete it",
        });
      }

      if (issue.code === "index_corrupt" && issue.projectId && options.rebuildIndex !== false) {
        this.rebuildIndexDatabase(issue.projectId);
        actions.push({
          code: "rebuilt_index",
          projectId: issue.projectId,
          detail: "index database rebuilt from the filesystem; memory was not touched",
        });
      }

      if (issue.code === "orphan_storage" && options.removeOrphans === true) {
        const directory = issue.message.split(": ").pop() as string;
        fs.rmSync(directory, { recursive: true, force: true });
        actions.push({ code: "removed_orphan", detail: `deleted ${directory}` });
      }
    }

    return { actions, remaining: this.check().issues };
  }

  /** Compacts databases and checkpoints the write-ahead log (PRD 56 maintenance). */
  compact(projectId: string): { purgedFiles: number } {
    const purgedFiles = this.devmemory.filesFor(projectId).purgeDeleted(projectId);
    const index = this.devmemory.databases.openProjectIndex(projectId);

    index.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    index.exec("VACUUM");

    const memory = this.devmemory.databases.openProjectMemory(projectId);
    memory.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    return { purgedFiles };
  }

  /**
   * Deletes and recreates a project's index database. Only ever called for the
   * index - `memory.db` holds decisions and tasks that exist nowhere else.
   */
  private rebuildIndexDatabase(projectId: string): void {
    const layout = projectLayout(projectId, this.devmemory.home);
    this.devmemory.databases.closeProject(projectId);

    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${layout.indexDb}${suffix}`, { force: true });
    }

    // Reopening runs the migrations, leaving an empty but valid index.
    this.devmemory.databases.openProjectIndex(projectId);
    this.devmemory.registry.setIndexState(projectId, "stale", null);
  }

  private orphanDirectories(projects: ProjectRecord[]): string[] {
    const layout = homeLayout(this.devmemory.home);
    if (!fs.existsSync(layout.projectsDir)) return [];

    const known = new Set(projects.map((project) => project.projectId));
    try {
      return fs
        .readdirSync(layout.projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("proj_") && !known.has(entry.name))
        .map((entry) => path.join(layout.projectsDir, entry.name));
    } catch {
      return [];
    }
  }

  /** SQLite's own opinion of a database file, or the error that stopped us asking. */
  private integrityOf(open: () => { prepare: (sql: string) => { get: <T>() => T | undefined } }): string {
    try {
      const db = open();
      const row = db.prepare("PRAGMA quick_check").get<{ quick_check: string }>();
      return row?.quick_check ?? "unknown";
    } catch (error) {
      return message(error);
    }
  }

  private report(
    home: string,
    projects: number,
    checks: HealthReport["checks"],
    issues: HealthIssue[],
  ): HealthReport {
    return {
      healthy: issues.every((issue) => issue.severity !== "error"),
      home,
      platform: {
        os: `${process.platform} ${os.arch()}`,
        release: os.release(),
        node: process.version,
        driver: this.devmemory.databases.driver.name,
      },
      projects,
      checks,
      issues,
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
