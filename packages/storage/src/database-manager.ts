import fs from "node:fs";
import { DevMemoryError, ensureHome, ensureProjectDirs, homeLayout, projectLayout, resolveHome } from "@devmemory/shared";
import type { SqliteDatabase, SqliteDriver } from "./driver.js";
import { nodeSqliteDriver } from "./node-sqlite-driver.js";
import { migrate } from "./migrator.js";
import { REGISTRY_MIGRATIONS } from "./migrations/registry.js";
import { INDEX_MIGRATIONS } from "./migrations/index-db.js";
import { MEMORY_MIGRATIONS } from "./migrations/memory-db.js";

export interface DatabaseManagerOptions {
  home?: string;
  driver?: SqliteDriver;
}

/**
 * Owns every SQLite handle in the process. Per-project databases are opened lazily
 * and cached, which is what keeps project data physically isolated (PRD 11): a
 * project's records live in its own file under projects/<project_id>/.
 */
export class DatabaseManager {
  readonly home: string;
  readonly driver: SqliteDriver;
  private registry?: SqliteDatabase;
  private readonly projectDbs = new Map<string, SqliteDatabase>();
  private readonly memoryDbs = new Map<string, SqliteDatabase>();

  constructor(options: DatabaseManagerOptions = {}) {
    this.home = options.home ?? resolveHome();
    this.driver = options.driver ?? nodeSqliteDriver;
  }

  get layout() {
    return homeLayout(this.home);
  }

  openRegistry(): SqliteDatabase {
    if (this.registry?.isOpen) return this.registry;
    ensureHome(this.home);
    const db = this.driver.open(this.layout.registryDb);
    migrate(db, REGISTRY_MIGRATIONS);
    this.registry = db;
    return db;
  }

  openProjectIndex(projectId: string): SqliteDatabase {
    assertProjectId(projectId);
    const cached = this.projectDbs.get(projectId);
    if (cached?.isOpen) return cached;

    ensureProjectDirs(projectId, this.home);
    const db = this.driver.open(projectLayout(projectId, this.home).indexDb);

    // Anything that fails after the handle exists must close it, or a corrupt file
    // stays locked and cannot be repaired - on Windows, not even deleted.
    try {
      migrate(db, INDEX_MIGRATIONS);

      // Stamp ownership so a database file can never be silently used for another project.
      const owner = db.prepare("SELECT value FROM meta WHERE key = 'project_id'").get<{ value: string }>();
      if (!owner) {
        db.prepare("INSERT INTO meta (key, value) VALUES ('project_id', ?)").run(projectId);
      } else if (owner.value !== projectId) {
        throw new DevMemoryError("STORAGE_ERROR", "index database belongs to a different project", {
          expected: projectId,
          found: owner.value,
        });
      }
    } catch (error) {
      db.close();
      throw error;
    }

    this.projectDbs.set(projectId, db);
    return db;
  }

  /**
   * Project memory lives in its own database file, separate from the code index
   * (PRD 7): it survives a full re-index, and losing an index never loses knowledge.
   */
  openProjectMemory(projectId: string): SqliteDatabase {
    assertProjectId(projectId);
    const cached = this.memoryDbs.get(projectId);
    if (cached?.isOpen) return cached;

    ensureProjectDirs(projectId, this.home);
    const db = this.driver.open(projectLayout(projectId, this.home).memoryDb);

    try {
      migrate(db, MEMORY_MIGRATIONS);

      const owner = db.prepare("SELECT value FROM meta WHERE key = 'project_id'").get<{ value: string }>();
      if (!owner) {
        db.prepare("INSERT INTO meta (key, value) VALUES ('project_id', ?)").run(projectId);
      } else if (owner.value !== projectId) {
        throw new DevMemoryError("STORAGE_ERROR", "memory database belongs to a different project", {
          expected: projectId,
          found: owner.value,
        });
      }
    } catch (error) {
      db.close();
      throw error;
    }

    this.memoryDbs.set(projectId, db);
    return db;
  }

  closeProject(projectId: string): void {
    this.projectDbs.get(projectId)?.close();
    this.projectDbs.delete(projectId);
    this.memoryDbs.get(projectId)?.close();
    this.memoryDbs.delete(projectId);
  }

  /** Deletes a project's entire storage directory (PRD 10 project_remove). */
  destroyProjectStorage(projectId: string): void {
    assertProjectId(projectId);
    this.closeProject(projectId);
    const dir = projectLayout(projectId, this.home).root;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  closeAll(): void {
    for (const [id, db] of this.projectDbs) {
      db.close();
      this.projectDbs.delete(id);
    }
    for (const [id, db] of this.memoryDbs) {
      db.close();
      this.memoryDbs.delete(id);
    }
    this.registry?.close();
    this.registry = undefined;
  }
}

function assertProjectId(projectId: string): void {
  if (!/^proj_[a-f0-9]{6,32}$/.test(projectId)) {
    throw new DevMemoryError("INVALID_INPUT", `invalid project id: ${projectId}`);
  }
}
