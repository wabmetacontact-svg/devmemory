import type { SqliteDatabase } from "@samirthakur024/storage";
import { joinCanonical, scanEndpoints, type EndpointRole } from "./endpoint-scanner.js";

export interface EndpointRecord {
  id: number;
  fileId: number;
  path: string;
  role: EndpointRole;
  method: string | null;
  rawPath: string;
  /** Canonical path with any mount prefix already applied. */
  canonical: string;
  line: number;
  source: string;
  /** True when the call targets a third-party service rather than this codebase. */
  external: boolean;
}

/**
 * Persistence for HTTP endpoints, plus the one piece of resolution that cannot
 * happen at scan time: an Express route file writes `router.get("/profile")` and
 * has no idea it is mounted at `/api/admin`. The prefix lives in another file, so
 * it is applied on read, by following the same import edge the graph already has.
 */
export class EndpointStore {
  constructor(private readonly db: SqliteDatabase) {}

  replaceFile(projectId: string, fileId: number, relativePath: string, content: string): number {
    this.db.prepare("DELETE FROM http_endpoints WHERE file_id = ?").run(fileId);

    const endpoints = scanEndpoints(content, relativePath);
    if (endpoints.length === 0) return 0;

    const insert = this.db.prepare(
      `INSERT INTO http_endpoints (project_id, file_id, role, method, raw_path, canonical_path, line, mounted_name, source, is_external)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const endpoint of endpoints) {
      insert.run(
        projectId,
        fileId,
        endpoint.role,
        endpoint.method,
        endpoint.rawPath,
        endpoint.canonical,
        endpoint.line,
        endpoint.mountedName,
        endpoint.source,
        endpoint.external ? 1 : 0,
      );
    }
    return endpoints.length;
  }

  clearFile(fileId: number): void {
    this.db.prepare("DELETE FROM http_endpoints WHERE file_id = ?").run(fileId);
  }

  /**
   * Every route the project serves, with mount prefixes resolved.
   *
   * `app.use("/api/admin", adminRoutes)` names an identifier, and the imports
   * table already knows which file that identifier came from - so the prefix is
   * carried to that file's routes without re-parsing anything.
   */
  provides(projectId: string): EndpointRecord[] {
    const prefixes = this.mountPrefixes(projectId);
    return this.rows(projectId, "provides").map((record) => {
      const prefix = prefixes.get(record.fileId);
      return prefix ? { ...record, canonical: joinCanonical(prefix, record.canonical) } : record;
    });
  }

  consumes(projectId: string): EndpointRecord[] {
    return this.rows(projectId, "consumes");
  }

  counts(projectId: string): { provides: number; consumes: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(role = 'provides') AS provides, SUM(role = 'consumes') AS consumes
           FROM http_endpoints WHERE project_id = ?`,
      )
      .get<{ provides: number | null; consumes: number | null }>(projectId);
    return { provides: Number(row?.provides ?? 0), consumes: Number(row?.consumes ?? 0) };
  }

  /** file_id of a mounted router -> the prefix it was mounted under. */
  private mountPrefixes(projectId: string): Map<number, string> {
    const rows = this.db
      .prepare(
        `SELECT e.canonical_path AS prefix, e.mounted_name AS name, i.resolved_file_id AS target
           FROM http_endpoints e
           JOIN imports i ON i.file_id = e.file_id AND i.resolved_file_id IS NOT NULL
          WHERE e.project_id = ? AND e.role = 'mounts' AND e.mounted_name IS NOT NULL
            AND (i.names LIKE '%"' || e.mounted_name || '"%' OR i.names = '[]')`,
      )
      .all<{ prefix: string; name: string; target: number }>(projectId);

    const prefixes = new Map<number, string>();
    for (const row of rows) {
      // A router mounted twice keeps the first prefix; picking one beats inventing
      // a second set of routes that the second mount would imply.
      if (!prefixes.has(Number(row.target))) prefixes.set(Number(row.target), String(row.prefix));
    }
    return prefixes;
  }

  private rows(projectId: string, role: EndpointRole): EndpointRecord[] {
    return this.db
      .prepare(
        `SELECT e.id, e.file_id, e.role, e.method, e.raw_path, e.canonical_path, e.line, e.source, e.is_external,
                f.relative_path AS path
           FROM http_endpoints e
           JOIN files f ON f.id = e.file_id
          WHERE e.project_id = ? AND e.role = ? AND f.status = 'active'
          ORDER BY e.canonical_path`,
      )
      .all<Record<string, unknown>>(projectId, role)
      .map((row) => ({
        id: Number(row.id),
        fileId: Number(row.file_id),
        path: String(row.path),
        role: String(row.role) as EndpointRole,
        method: (row.method as string | null) ?? null,
        rawPath: String(row.raw_path),
        canonical: String(row.canonical_path),
        line: Number(row.line),
        source: String(row.source),
        external: Number(row.is_external) === 1,
      }));
  }
}
