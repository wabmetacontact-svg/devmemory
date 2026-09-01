import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import "./suppress-experimental-warning.js";
import { DevMemoryError } from "@devmemory/shared";
import type { OpenOptions, SqliteDatabase, SqliteDriver, SqliteStatement, SqlValue } from "./driver.js";

type DatabaseSyncConstructor = new (location: string, options?: { readOnly?: boolean }) => DatabaseSyncType;

const require = createRequire(import.meta.url);
let DatabaseSyncClass: DatabaseSyncConstructor | undefined;

/**
 * node:sqlite is loaded lazily rather than with a static import. An ESM graph links
 * every module - builtins included - before any of it runs, so a static import would
 * emit the ExperimentalWarning before the filter in ./suppress-experimental-warning
 * had a chance to install itself.
 */
function loadDatabaseSync(): DatabaseSyncConstructor {
  if (!DatabaseSyncClass) {
    const sqlite = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
    DatabaseSyncClass = sqlite.DatabaseSync;
  }
  return DatabaseSyncClass;
}

class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly stmt: ReturnType<DatabaseSyncType["prepare"]>) {}

  all<T>(...params: SqlValue[]): T[] {
    return this.stmt.all(...(params as never[])) as T[];
  }

  get<T>(...params: SqlValue[]): T | undefined {
    return this.stmt.get(...(params as never[])) as T | undefined;
  }

  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const result = this.stmt.run(...(params as never[]));
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }
}

class NodeSqliteDatabase implements SqliteDatabase {
  private db: DatabaseSyncType;
  private open = true;
  private depth = 0;

  constructor(
    readonly file: string,
    options: OpenOptions = {},
  ) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    try {
      this.db = new DatabaseSync(file, { readOnly: options.readOnly ?? false });
    } catch (error) {
      throw new DevMemoryError("STORAGE_ERROR", `cannot open database ${file}: ${(error as Error).message}`);
    }

    if (!options.readOnly) {
      try {
        // WAL lets the CLI, MCP server, daemon and dashboard read concurrently (PRD 41, 56).
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = NORMAL");
        this.db.exec("PRAGMA busy_timeout = 5000");
        this.db.exec("PRAGMA foreign_keys = ON");
      } catch (error) {
        // A corrupt file opens but rejects the first statement. Close the handle, or
        // it stays locked and the file cannot be repaired - on Windows, not even deleted.
        this.open = false;
        this.db.close();
        throw new DevMemoryError("STORAGE_ERROR", `cannot use database ${file}: ${(error as Error).message}`);
      }
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn(); // nested calls join the outer transaction
    this.depth++;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* rolling back an already-aborted transaction is not worth surfacing */
      }
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}

export const nodeSqliteDriver: SqliteDriver = {
  name: "node:sqlite",
  open(file, options) {
    return new NodeSqliteDatabase(file, options ?? {});
  },
};
