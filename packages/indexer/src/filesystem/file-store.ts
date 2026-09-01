import { nowIso } from "@samirthakur024/shared";
import type { IndexedFile, IndexRunStats } from "@samirthakur024/shared";
import type { SqliteDatabase } from "@samirthakur024/storage";

export interface ExistingFileRow {
  id: number;
  relative_path: string;
  hash: string;
  size: number;
  last_modified: number;
  status: string;
}

export interface FileUpsert {
  projectId: string;
  path: string;
  relativePath: string;
  language: string | null;
  extension: string | null;
  size: number;
  hash: string;
  lastModified: number;
}

export interface FileStats {
  files: number;
  bytes: number;
  byLanguage: Array<{ language: string; files: number }>;
  lastIndexedAt: string | null;
}

/**
 * All reads and writes are scoped by project_id even though each project already
 * has its own database file - defence in depth for isolation (PRD 11, AC-06).
 */
export class FileStore {
  constructor(private readonly db: SqliteDatabase) {}

  existingByPath(projectId: string): Map<string, ExistingFileRow> {
    const rows = this.db
      .prepare("SELECT id, relative_path, hash, size, last_modified, status FROM files WHERE project_id = ?")
      .all<ExistingFileRow>(projectId);
    return new Map(rows.map((row) => [row.relative_path, row]));
  }

  upsert(file: FileUpsert): void {
    this.db
      .prepare(
        `INSERT INTO files (project_id, path, relative_path, language, extension, size, hash, last_modified, indexed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
         ON CONFLICT(project_id, relative_path) DO UPDATE SET
           path = excluded.path,
           language = excluded.language,
           extension = excluded.extension,
           size = excluded.size,
           hash = excluded.hash,
           last_modified = excluded.last_modified,
           indexed_at = excluded.indexed_at,
           status = 'active'`,
      )
      .run(
        file.projectId,
        file.path,
        file.relativePath,
        file.language,
        file.extension,
        file.size,
        file.hash,
        file.lastModified,
        nowIso(),
      );
  }

  markDeleted(projectId: string, relativePaths: string[]): number {
    if (relativePaths.length === 0) return 0;
    const statement = this.db.prepare(
      "UPDATE files SET status = 'deleted', indexed_at = ? WHERE project_id = ? AND relative_path = ?",
    );
    const timestamp = nowIso();
    let changed = 0;
    for (const relativePath of relativePaths) {
      changed += Number(statement.run(timestamp, projectId, relativePath).changes);
    }
    return changed;
  }

  purgeDeleted(projectId: string): number {
    return Number(this.db.prepare("DELETE FROM files WHERE project_id = ? AND status = 'deleted'").run(projectId).changes);
  }

  clear(projectId: string): void {
    this.db.prepare("DELETE FROM files WHERE project_id = ?").run(projectId);
  }

  get(projectId: string, relativePath: string): IndexedFile | null {
    const row = this.db
      .prepare("SELECT * FROM files WHERE project_id = ? AND relative_path = ?")
      .get<Record<string, never>>(projectId, relativePath);
    return row ? toIndexedFile(row) : null;
  }

  list(projectId: string, options: { limit?: number; language?: string } = {}): IndexedFile[] {
    const limit = options.limit ?? 500;
    const rows = options.language
      ? this.db
          .prepare(
            "SELECT * FROM files WHERE project_id = ? AND status = 'active' AND language = ? ORDER BY relative_path LIMIT ?",
          )
          .all<Record<string, never>>(projectId, options.language, limit)
      : this.db
          .prepare("SELECT * FROM files WHERE project_id = ? AND status = 'active' ORDER BY relative_path LIMIT ?")
          .all<Record<string, never>>(projectId, limit);
    return rows.map(toIndexedFile);
  }

  /** Substring path search. Full-text content search arrives with the context engine. */
  searchPaths(projectId: string, query: string, limit = 50): IndexedFile[] {
    const like = `%${query.replace(/[%_]/g, (match) => `\\${match}`)}%`;
    return this.db
      .prepare(
        `SELECT * FROM files
          WHERE project_id = ? AND status = 'active' AND relative_path LIKE ? ESCAPE '\\'
          ORDER BY LENGTH(relative_path) ASC
          LIMIT ?`,
      )
      .all<Record<string, never>>(projectId, like, limit)
      .map(toIndexedFile);
  }

  /** Project-relative paths of every active file - the input to import resolution. */
  allPaths(projectId: string): string[] {
    return this.db
      .prepare("SELECT relative_path FROM files WHERE project_id = ? AND status = 'active'")
      .all<{ relative_path: string }>(projectId)
      .map((row) => row.relative_path);
  }

  /** Active files in parseable languages that carry no parse result yet. */
  unparsed(projectId: string, languages: string[], limit = 5000): Array<{ id: number; relativePath: string; path: string; language: string }> {
    if (languages.length === 0) return [];
    const placeholders = languages.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT id, relative_path, path, language
           FROM files
          WHERE project_id = ? AND status = 'active' AND parse_status IS NULL
            AND language IN (${placeholders})
          LIMIT ?`,
      )
      .all<Record<string, unknown>>(projectId, ...(languages as never[]), limit)
      .map((row) => ({
        id: Number(row.id),
        relativePath: String(row.relative_path),
        path: String(row.path),
        language: String(row.language),
      }));
  }

  recentlyModified(projectId: string, limit = 20): IndexedFile[] {
    return this.db
      .prepare(
        "SELECT * FROM files WHERE project_id = ? AND status = 'active' ORDER BY last_modified DESC LIMIT ?",
      )
      .all<Record<string, never>>(projectId, limit)
      .map(toIndexedFile);
  }

  stats(projectId: string): FileStats {
    const totals = this.db
      .prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files WHERE project_id = ? AND status = 'active'")
      .get<{ files: number; bytes: number }>(projectId);

    const byLanguage = this.db
      .prepare(
        `SELECT COALESCE(language, 'other') AS language, COUNT(*) AS files
           FROM files WHERE project_id = ? AND status = 'active'
          GROUP BY COALESCE(language, 'other')
          ORDER BY files DESC`,
      )
      .all<{ language: string; files: number }>(projectId);

    const lastRun = this.db
      .prepare("SELECT finished_at FROM index_runs WHERE project_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1")
      .get<{ finished_at: string | null }>(projectId);

    return {
      files: totals?.files ?? 0,
      bytes: totals?.bytes ?? 0,
      byLanguage,
      lastIndexedAt: lastRun?.finished_at ?? null,
    };
  }

  /** Files where a credential pattern was detected during indexing (PRD 37). */
  securityFindings(projectId: string, limit = 50): {
    files: number;
    findings: Array<{ path: string; detectors: string[] }>;
  } {
    const rows = this.db
      .prepare(
        `SELECT f.relative_path AS path, GROUP_CONCAT(DISTINCT s.detector) AS detectors
           FROM security_findings s
           JOIN files f ON f.id = s.file_id
          WHERE s.project_id = ? AND f.status = 'active'
          GROUP BY f.relative_path
          ORDER BY f.relative_path
          LIMIT ?`,
      )
      .all<{ path: string; detectors: string | null }>(projectId, limit);

    return {
      files: rows.length,
      findings: rows.map((row) => ({
        path: row.path,
        detectors: (row.detectors ?? "").split(",").filter(Boolean),
      })),
    };
  }

  startRun(projectId: string, fullRebuild: boolean): number {
    const result = this.db
      .prepare("INSERT INTO index_runs (project_id, started_at, full_rebuild, status) VALUES (?, ?, ?, 'running')")
      .run(projectId, nowIso(), fullRebuild ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  finishRun(runId: number, stats: IndexRunStats, error?: string): void {
    this.db
      .prepare(
        `UPDATE index_runs
            SET finished_at = ?, scanned = ?, added = ?, updated = ?, unchanged = ?, deleted = ?,
                skipped = ?, bytes_indexed = ?, duration_ms = ?, parsed = ?, parse_errors = ?, symbols = ?,
                status = ?, error = ?
          WHERE id = ?`,
      )
      .run(
        nowIso(),
        stats.scanned,
        stats.added,
        stats.updated,
        stats.unchanged,
        stats.deleted,
        stats.skipped,
        stats.bytesIndexed,
        stats.durationMs,
        stats.parsed,
        stats.parseErrors,
        stats.symbols,
        error ? "error" : "ok",
        error ?? null,
        runId,
      );
  }

  /** An interrupted run leaves a 'running' row behind; that is how a partial index is detected (PRD 60). */
  hasUnfinishedRun(projectId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM index_runs WHERE project_id = ? AND status = 'running'")
      .get<{ n: number }>(projectId);
    return (row?.n ?? 0) > 0;
  }

  abandonUnfinishedRuns(projectId: string): void {
    this.db
      .prepare("UPDATE index_runs SET status = 'error', error = 'interrupted', finished_at = ? WHERE project_id = ? AND status = 'running'")
      .run(nowIso(), projectId);
  }
}

function toIndexedFile(row: Record<string, unknown>): IndexedFile {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    path: String(row.path),
    relativePath: String(row.relative_path),
    language: (row.language as string | null) ?? null,
    extension: (row.extension as string | null) ?? null,
    size: Number(row.size),
    hash: String(row.hash),
    lastModified: Number(row.last_modified),
    indexedAt: String(row.indexed_at),
    status: row.status === "deleted" ? "deleted" : "active",
  };
}
