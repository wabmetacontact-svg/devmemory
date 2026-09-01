import { DevMemoryError, nowIso, sha256, shortId } from "@devmemory/shared";
import type { SqliteDatabase } from "@devmemory/storage";

/** Memory kinds from PRD 27. */
export const MEMORY_TYPES = ["FACT", "DECISION", "DISCOVERY", "BUG", "PATTERN", "CONSTRAINT", "HISTORY"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemoryStatus = "active" | "archived" | "superseded";

export interface DecisionDetail {
  reason: string | null;
  alternatives: string[];
  affected: string[];
  decidedAt: string | null;
}

export interface MemoryRecord {
  id: string;
  projectId: string;
  type: MemoryType;
  title: string;
  content: string;
  importance: number;
  confidence: number;
  status: MemoryStatus;
  /** null = holds for the whole project; otherwise scoped to that branch (PRD 57). */
  branch: string | null;
  source: string | null;
  tags: string[];
  paths: string[];
  symbols: string[];
  createdAt: string;
  updatedAt: string;
  accessedAt: string | null;
  accessCount: number;
  expiresAt: string | null;
  supersedes: string | null;
  decision?: DecisionDetail;
}

export interface MemoryWrite {
  projectId: string;
  type: MemoryType;
  title: string;
  content: string;
  importance: number;
  confidence: number;
  branch: string | null;
  source: string | null;
  tags: string[];
  paths: string[];
  symbols: string[];
  expiresAt: string | null;
  supersedes: string | null;
  decision?: { reason?: string | null; alternatives?: string[]; affected?: string[] };
}

export interface MemoryQuery {
  type?: MemoryType;
  status?: MemoryStatus;
  branch?: string | null;
  /** Include branch-scoped memories for this branch alongside the global ones. */
  branchScope?: string | null;
  tag?: string;
  path?: string;
  minImportance?: number;
  limit?: number;
}

export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  byType: Array<{ type: string; count: number }>;
  averageImportance: number;
  expired: number;
}

interface MemoryRow {
  rowid: number;
  id: string;
  project_id: string;
  type: string;
  title: string;
  content: string;
  importance: number;
  confidence: number;
  status: string;
  branch: string | null;
  source: string | null;
  tags: string;
  paths: string;
  symbols: string;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
  expires_at: string | null;
  supersedes: string | null;
  content_hash: string;
}

/**
 * Persistence for project memory (PRD 27-29). Kept deliberately thin: policy about
 * what is worth remembering lives in MemoryEngine, storage mechanics live here.
 */
export class MemoryStore {
  constructor(private readonly db: SqliteDatabase) {}

  insert(write: MemoryWrite): MemoryRecord {
    const id = shortId("mem", 6);
    const timestamp = nowIso();
    const hash = contentHash(write.type, write.title, write.content);

    const result = this.db
      .prepare(
        `INSERT INTO memories (
           id, project_id, type, title, content, importance, confidence, status, branch, source,
           tags, paths, symbols, created_at, updated_at, accessed_at, access_count, expires_at,
           supersedes, content_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`,
      )
      .run(
        id,
        write.projectId,
        write.type,
        write.title,
        write.content,
        write.importance,
        write.confidence,
        write.branch,
        write.source,
        JSON.stringify(write.tags),
        JSON.stringify(write.paths),
        JSON.stringify(write.symbols),
        timestamp,
        timestamp,
        write.expiresAt,
        write.supersedes,
        hash,
      );

    const rowid = Number(result.lastInsertRowid);
    this.indexForSearch(rowid, write.title, write.content, write.tags);

    if (write.decision) {
      this.db
        .prepare("INSERT INTO decisions (memory_id, reason, alternatives, affected, decided_at) VALUES (?, ?, ?, ?, ?)")
        .run(
          id,
          write.decision.reason ?? null,
          JSON.stringify(write.decision.alternatives ?? []),
          JSON.stringify(write.decision.affected ?? []),
          timestamp,
        );
    }

    if (write.supersedes) {
      this.db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(timestamp, write.supersedes);
      this.recordEvent(write.supersedes, "superseded", `replaced by ${id}`);
    }

    this.recordEvent(id, "created", write.type);
    return this.get(id) as MemoryRecord;
  }

  update(id: string, patch: Partial<MemoryWrite> & { status?: MemoryStatus }): MemoryRecord {
    const existing = this.get(id);
    if (!existing) throw new DevMemoryError("INVALID_INPUT", `unknown memory: ${id}`);

    const merged = {
      title: patch.title ?? existing.title,
      content: patch.content ?? existing.content,
      importance: patch.importance ?? existing.importance,
      confidence: patch.confidence ?? existing.confidence,
      status: patch.status ?? existing.status,
      branch: patch.branch === undefined ? existing.branch : patch.branch,
      tags: patch.tags ?? existing.tags,
      paths: patch.paths ?? existing.paths,
      symbols: patch.symbols ?? existing.symbols,
      expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
    };

    this.db
      .prepare(
        `UPDATE memories
            SET title = ?, content = ?, importance = ?, confidence = ?, status = ?, branch = ?,
                tags = ?, paths = ?, symbols = ?, expires_at = ?, updated_at = ?, content_hash = ?
          WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.content,
        merged.importance,
        merged.confidence,
        merged.status,
        merged.branch,
        JSON.stringify(merged.tags),
        JSON.stringify(merged.paths),
        JSON.stringify(merged.symbols),
        merged.expiresAt,
        nowIso(),
        contentHash(existing.type, merged.title, merged.content),
        id,
      );

    const rowid = this.rowidOf(id);
    if (rowid !== null) this.indexForSearch(rowid, merged.title, merged.content, merged.tags);
    this.recordEvent(id, "updated");
    return this.get(id) as MemoryRecord;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.prepare("SELECT rowid, * FROM memories WHERE id = ?").get<MemoryRow>(id);
    return row ? this.hydrate(row) : null;
  }

  findByHash(projectId: string, type: MemoryType, title: string, content: string): MemoryRecord | null {
    const row = this.db
      .prepare("SELECT rowid, * FROM memories WHERE project_id = ? AND content_hash = ?")
      .get<MemoryRow>(projectId, contentHash(type, title, content));
    return row ? this.hydrate(row) : null;
  }

  list(projectId: string, query: MemoryQuery = {}): MemoryRecord[] {
    const clauses = ["project_id = ?"];
    const params: Array<string | number> = [projectId];

    clauses.push("status = ?");
    params.push(query.status ?? "active");

    if (query.type) {
      clauses.push("type = ?");
      params.push(query.type);
    }
    if (query.branch !== undefined && query.branch !== null) {
      clauses.push("branch = ?");
      params.push(query.branch);
    } else if (query.branchScope !== undefined) {
      // Global memories always apply; branch memories only on their own branch.
      if (query.branchScope === null) {
        clauses.push("branch IS NULL");
      } else {
        clauses.push("(branch IS NULL OR branch = ?)");
        params.push(query.branchScope);
      }
    }
    if (query.minImportance !== undefined) {
      clauses.push("importance >= ?");
      params.push(query.minImportance);
    }
    if (query.tag) {
      clauses.push("tags LIKE ?");
      params.push(`%"${query.tag}"%`);
    }
    if (query.path) {
      clauses.push("paths LIKE ?");
      params.push(`%"${query.path}"%`);
    }

    params.push(query.limit ?? 50);

    return this.db
      .prepare(
        `SELECT rowid, * FROM memories
          WHERE ${clauses.join(" AND ")}
          ORDER BY importance DESC, updated_at DESC
          LIMIT ?`,
      )
      .all<MemoryRow>(...(params as never[]))
      .map((row) => this.hydrate(row));
  }

  /** Full-text recall; returns rows with a normalised relevance score. */
  search(projectId: string, match: string, limit: number): Array<MemoryRecord & { relevance: number }> {
    const rows = this.db
      .prepare(
        `SELECT m.rowid, m.*, bm25(memory_search, 6.0, 2.0, 3.0) AS score
           FROM memory_search
           JOIN memories m ON m.rowid = memory_search.rowid
          WHERE memory_search MATCH ? AND m.project_id = ? AND m.status = 'active'
          ORDER BY score
          LIMIT ?`,
      )
      .all<MemoryRow & { score: number }>(match, projectId, limit);

    if (rows.length === 0) return [];
    const scores = rows.map((row) => row.score);
    const best = Math.min(...scores);
    const worst = Math.max(...scores);
    const span = worst - best;

    return rows.map((row) => ({
      ...this.hydrate(row),
      relevance: span === 0 ? 1 : Number((1 - (row.score - best) / span).toFixed(4)),
    }));
  }

  markAccessed(ids: string[]): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare(
      "UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
    );
    const timestamp = nowIso();
    for (const id of ids) statement.run(timestamp, id);
  }

  setStatus(id: string, status: MemoryStatus): MemoryRecord {
    const result = this.db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
    if (Number(result.changes) === 0) throw new DevMemoryError("INVALID_INPUT", `unknown memory: ${id}`);
    this.recordEvent(id, status === "archived" ? "archived" : "updated");
    return this.get(id) as MemoryRecord;
  }

  delete(id: string): void {
    const rowid = this.rowidOf(id);
    if (rowid === null) throw new DevMemoryError("INVALID_INPUT", `unknown memory: ${id}`);
    this.db.prepare("DELETE FROM memory_search WHERE rowid = ?").run(rowid);
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM memory_events WHERE memory_id = ?").run(id);
  }

  /** Archives memories whose expiry has passed (PRD 28). */
  archiveExpired(projectId: string, now = nowIso()): number {
    const expired = this.db
      .prepare("SELECT id FROM memories WHERE project_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all<{ id: string }>(projectId, now);

    for (const row of expired) this.setStatus(row.id, "archived");
    return expired.length;
  }

  events(id: string, limit = 20): Array<{ event: string; at: string; detail: string | null }> {
    return this.db
      .prepare("SELECT event, at, detail FROM memory_events WHERE memory_id = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all<{ event: string; at: string; detail: string | null }>(id, limit);
  }

  stats(projectId: string): MemoryStats {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
                AVG(CASE WHEN status = 'active' THEN importance END) AS avg_importance,
                SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? AND status = 'active' THEN 1 ELSE 0 END) AS expired
           FROM memories WHERE project_id = ?`,
      )
      .get<{ total: number; active: number | null; archived: number | null; avg_importance: number | null; expired: number | null }>(
        nowIso(),
        projectId,
      );

    const byType = this.db
      .prepare(
        "SELECT type, COUNT(*) AS count FROM memories WHERE project_id = ? AND status = 'active' GROUP BY type ORDER BY count DESC",
      )
      .all<{ type: string; count: number }>(projectId);

    return {
      total: totals?.total ?? 0,
      active: totals?.active ?? 0,
      archived: totals?.archived ?? 0,
      byType,
      averageImportance: Number((totals?.avg_importance ?? 0).toFixed(3)),
      expired: totals?.expired ?? 0,
    };
  }

  recordEvent(memoryId: string, event: string, detail?: string): void {
    this.db
      .prepare("INSERT INTO memory_events (memory_id, event, at, detail) VALUES (?, ?, ?, ?)")
      .run(memoryId, event, nowIso(), detail ?? null);
  }

  private rowidOf(id: string): number | null {
    const row = this.db.prepare("SELECT rowid FROM memories WHERE id = ?").get<{ rowid: number }>(id);
    return row ? Number(row.rowid) : null;
  }

  private indexForSearch(rowid: number, title: string, content: string, tags: string[]): void {
    this.db.prepare("DELETE FROM memory_search WHERE rowid = ?").run(rowid);
    this.db
      .prepare("INSERT INTO memory_search (rowid, title, content, tags) VALUES (?, ?, ?, ?)")
      .run(rowid, title, content, tags.join(" "));
  }

  private hydrate(row: MemoryRow): MemoryRecord {
    const record: MemoryRecord = {
      id: row.id,
      projectId: row.project_id,
      type: row.type as MemoryType,
      title: row.title,
      content: row.content,
      importance: row.importance,
      confidence: row.confidence,
      status: row.status as MemoryStatus,
      branch: row.branch,
      source: row.source,
      tags: parseArray(row.tags),
      paths: parseArray(row.paths),
      symbols: parseArray(row.symbols),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessedAt: row.accessed_at,
      accessCount: row.access_count,
      expiresAt: row.expires_at,
      supersedes: row.supersedes,
    };

    if (row.type === "DECISION") {
      const detail = this.db
        .prepare("SELECT reason, alternatives, affected, decided_at FROM decisions WHERE memory_id = ?")
        .get<{ reason: string | null; alternatives: string; affected: string; decided_at: string | null }>(row.id);
      if (detail) {
        record.decision = {
          reason: detail.reason,
          alternatives: parseArray(detail.alternatives),
          affected: parseArray(detail.affected),
          decidedAt: detail.decided_at,
        };
      }
    }

    return record;
  }
}

/** Identity of a memory's content, so the same knowledge is never stored twice. */
export function contentHash(type: MemoryType, title: string, content: string): string {
  const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();
  return sha256(`${type}|${normalise(title)}|${normalise(content)}`).slice(0, 32);
}

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
