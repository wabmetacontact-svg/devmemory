import { DevMemoryError, normalizePath, nowIso } from "@devmemory/shared";
import type { IdentitySource, IndexStatus, ProjectDetection, ProjectIdentity, ProjectRecord, ProjectStatus } from "@devmemory/shared";
import type { DatabaseManager, SqliteDatabase } from "@devmemory/storage";

interface ProjectRow {
  project_id: string;
  name: string;
  root_path: string;
  repository_url: string | null;
  repository_type: string | null;
  identity_source: string;
  identity_key: string;
  framework: string | null;
  languages: string;
  package_manager: string | null;
  created_at: string;
  last_seen_at: string;
  last_indexed_at: string | null;
  status: string;
  index_status: string;
}

export interface ListProjectsOptions {
  status?: ProjectStatus;
  limit?: number;
}

/**
 * The global project registry (PRD 10). One row per project; every other engine
 * addresses data by project_id, which is what enforces isolation (PRD 11).
 */
export class ProjectRegistry {
  constructor(private readonly databases: DatabaseManager) {}

  private get db(): SqliteDatabase {
    return this.databases.openRegistry();
  }

  /**
   * Registers or refreshes a project. A project that moved on disk keeps its
   * project_id and simply gets a new root_path (PRD 9).
   */
  connect(identity: ProjectIdentity, detection?: ProjectDetection): ProjectRecord {
    const timestamp = nowIso();
    const rootPath = normalizePath(identity.rootPath);
    const existing = this.getByIdentityKey(identity.identityKey);

    this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE projects
                SET name = ?, root_path = ?, repository_url = ?, repository_type = ?,
                    identity_source = ?, framework = COALESCE(?, framework),
                    languages = COALESCE(?, languages), package_manager = COALESCE(?, package_manager),
                    last_seen_at = ?, status = 'active'
              WHERE project_id = ?`,
          )
          .run(
            existing.name === existing.projectId ? identity.name : existing.name,
            rootPath,
            identity.repositoryUrl,
            identity.repositoryType,
            identity.identitySource,
            detection?.framework ?? null,
            detection ? JSON.stringify(detection.languages) : null,
            detection?.packageManager ?? null,
            timestamp,
            existing.projectId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO projects (
               project_id, name, root_path, repository_url, repository_type, identity_source, identity_key,
               framework, languages, package_manager, created_at, last_seen_at, last_indexed_at, status, index_status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', 'never')`,
          )
          .run(
            identity.projectId,
            identity.name,
            rootPath,
            identity.repositoryUrl,
            identity.repositoryType,
            identity.identitySource,
            identity.identityKey,
            detection?.framework ?? null,
            JSON.stringify(detection?.languages ?? []),
            detection?.packageManager ?? null,
            timestamp,
            timestamp,
          );
      }

      const projectId = existing?.projectId ?? identity.projectId;
      this.db
        .prepare(
          `INSERT INTO project_paths (project_id, path, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        )
        .run(projectId, rootPath, timestamp, timestamp);
    });

    const record = this.get(existing?.projectId ?? identity.projectId);
    if (!record) throw new DevMemoryError("INTERNAL", "project registration did not persist");
    return record;
  }

  get(projectId: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get<ProjectRow>(projectId);
    return row ? toRecord(row) : null;
  }

  getByIdentityKey(identityKey: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE identity_key = ?").get<ProjectRow>(identityKey);
    return row ? toRecord(row) : null;
  }

  /** Looks up a project by a path it currently or previously occupied. */
  findByPath(candidatePath: string): ProjectRecord | null {
    const normalized = normalizePath(candidatePath);
    const direct = this.db.prepare("SELECT * FROM projects WHERE root_path = ?").get<ProjectRow>(normalized);
    if (direct) return toRecord(direct);

    const viaHistory = this.db
      .prepare(
        `SELECT p.* FROM projects p
           JOIN project_paths pp ON pp.project_id = p.project_id
          WHERE pp.path = ?
          ORDER BY pp.last_seen_at DESC
          LIMIT 1`,
      )
      .get<ProjectRow>(normalized);
    return viaHistory ? toRecord(viaHistory) : null;
  }

  findByName(name: string): ProjectRecord[] {
    return this.db
      .prepare("SELECT * FROM projects WHERE name = ? COLLATE NOCASE ORDER BY last_seen_at DESC")
      .all<ProjectRow>(name)
      .map(toRecord);
  }

  list(options: ListProjectsOptions = {}): ProjectRecord[] {
    const limit = options.limit ?? 200;
    const rows = options.status
      ? this.db
          .prepare("SELECT * FROM projects WHERE status = ? ORDER BY last_seen_at DESC LIMIT ?")
          .all<ProjectRow>(options.status, limit)
      : this.db.prepare("SELECT * FROM projects ORDER BY last_seen_at DESC LIMIT ?").all<ProjectRow>(limit);
    return rows.map(toRecord);
  }

  touch(projectId: string): void {
    this.db.prepare("UPDATE projects SET last_seen_at = ? WHERE project_id = ?").run(nowIso(), projectId);
  }

  setIndexState(projectId: string, indexStatus: IndexStatus, indexedAt?: string | null): void {
    if (indexedAt === undefined) {
      this.db.prepare("UPDATE projects SET index_status = ? WHERE project_id = ?").run(indexStatus, projectId);
      return;
    }
    this.db
      .prepare("UPDATE projects SET index_status = ?, last_indexed_at = ? WHERE project_id = ?")
      .run(indexStatus, indexedAt, projectId);
  }

  updateDetection(projectId: string, detection: ProjectDetection): void {
    this.db
      .prepare("UPDATE projects SET framework = ?, languages = ?, package_manager = ? WHERE project_id = ?")
      .run(detection.framework, JSON.stringify(detection.languages), detection.packageManager, projectId);
  }

  rename(projectId: string, name: string): ProjectRecord {
    const trimmed = name.trim();
    if (!trimmed) throw new DevMemoryError("INVALID_INPUT", "project name cannot be empty");
    const result = this.db.prepare("UPDATE projects SET name = ? WHERE project_id = ?").run(trimmed, projectId);
    if (Number(result.changes) === 0) {
      throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);
    }
    return this.get(projectId) as ProjectRecord;
  }

  setStatus(projectId: string, status: ProjectStatus): ProjectRecord {
    const result = this.db.prepare("UPDATE projects SET status = ? WHERE project_id = ?").run(status, projectId);
    if (Number(result.changes) === 0) {
      throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);
    }
    return this.get(projectId) as ProjectRecord;
  }

  /** Removes the registry row; per-project storage is deleted by ProjectService. */
  remove(projectId: string): void {
    const result = this.db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId);
    if (Number(result.changes) === 0) {
      throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);
    }
  }

  count(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM projects").get<{ n: number }>()?.n ?? 0;
  }
}

function toRecord(row: ProjectRow): ProjectRecord {
  let languages: string[] = [];
  try {
    const parsed = JSON.parse(row.languages) as unknown;
    if (Array.isArray(parsed)) languages = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    languages = [];
  }

  return {
    projectId: row.project_id,
    name: row.name,
    rootPath: row.root_path,
    repositoryUrl: row.repository_url,
    repositoryType: row.repository_type,
    identitySource: row.identity_source as IdentitySource,
    identityKey: row.identity_key,
    framework: row.framework,
    languages,
    packageManager: row.package_manager,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastIndexedAt: row.last_indexed_at,
    status: row.status as ProjectStatus,
    indexStatus: row.index_status as IndexStatus,
  };
}
