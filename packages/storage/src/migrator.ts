import { DevMemoryError } from "@samirthakur024/shared";
import type { SqliteDatabase } from "./driver.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);`;

export function currentVersion(db: SqliteDatabase): number {
  db.exec(MIGRATION_TABLE);
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get<{ v: number }>();
  return row?.v ?? 0;
}

/** Migrations are applied in order, each in its own transaction, and are idempotent. */
export function migrate(db: SqliteDatabase, migrations: Migration[]): number {
  db.exec(MIGRATION_TABLE);
  const applied = currentVersion(db);
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version > applied);

  for (const migration of pending) {
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
          migration.version,
          migration.name,
          new Date().toISOString(),
        );
      });
    } catch (e) {
      throw new DevMemoryError(
        "STORAGE_ERROR",
        `migration ${migration.version} (${migration.name}) failed: ${(e as Error).message}`,
        { file: db.file, version: migration.version },
      );
    }
  }

  return currentVersion(db);
}
