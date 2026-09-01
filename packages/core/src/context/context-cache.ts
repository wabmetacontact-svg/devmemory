import { nowIso, sha256, shortId } from "@samirthakur024/shared";
import type { SqliteDatabase } from "@samirthakur024/storage";
import type { ContextResult } from "./context-engine.js";

export interface CachedFile {
  path: string;
  hash: string;
}

export interface CacheEntry {
  id: string;
  key: string;
  task: string;
  gitHead: string | null;
  budget: number;
  tokenEstimate: number;
  files: CachedFile[];
  memoryIds: string[];
  payload: ContextResult;
  createdAt: string;
  lastUsedAt: string;
  hits: number;
}

export type CacheOutcome = "hit" | "incremental" | "miss";

export interface CacheValidation {
  entry: CacheEntry;
  /** Files whose content hash moved since the entry was stored. */
  staleFiles: string[];
  /** Files in the entry that no longer exist in the index. */
  missingFiles: string[];
  gitMoved: boolean;
}

export interface ContextAnalytics {
  requests: number;
  hits: number;
  incremental: number;
  misses: number;
  hitRate: number;
  averageTokens: number;
  totalTokens: number;
  filesRetrieved: number;
  filesAvoided: number;
  estimatedTokensSaved: number;
  cachedEntries: number;
}

const MAX_ENTRIES_PER_PROJECT = 200;

/**
 * Cache of assembled context (PRD 25, 26). An entry is keyed by the request, and
 * kept honest by the content hashes of the files it contains: if nothing those
 * files depend on has moved, the answer is still true and costs nothing to return.
 */
export class ContextCache {
  constructor(
    private readonly projectId: string,
    private readonly db: SqliteDatabase,
  ) {}

  /** Stable key for a request: the same words and options must produce the same key. */
  static keyFor(task: string, options: Record<string, unknown>): string {
    const normalisedTask = task.toLowerCase().replace(/\s+/g, " ").trim();
    const normalisedOptions = Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("&");
    return sha256(`${normalisedTask}|${normalisedOptions}`).slice(0, 32);
  }

  lookup(key: string): CacheValidation | null {
    const row = this.db
      .prepare("SELECT * FROM context_cache WHERE project_id = ? AND key = ?")
      .get<Record<string, unknown>>(this.projectId, key);
    if (!row) return null;

    const entry = hydrate(row);
    const current = new Map(
      this.db
        .prepare("SELECT relative_path, hash FROM files WHERE project_id = ? AND status = 'active'")
        .all<{ relative_path: string; hash: string }>(this.projectId)
        .map((file) => [file.relative_path, file.hash]),
    );

    const staleFiles: string[] = [];
    const missingFiles: string[] = [];
    for (const file of entry.files) {
      const hash = current.get(file.path);
      if (hash === undefined) missingFiles.push(file.path);
      else if (hash !== file.hash) staleFiles.push(file.path);
    }

    return { entry, staleFiles, missingFiles, gitMoved: false };
  }

  /** Records that an entry was served, so hot context stays hot. */
  touch(id: string): void {
    this.db
      .prepare("UPDATE context_cache SET hits = hits + 1, last_used_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  store(key: string, result: ContextResult, files: CachedFile[], gitHead: string | null): string {
    const id = result.contextId ?? shortId("ctx", 5);
    const timestamp = nowIso();

    this.db
      .prepare(
        `INSERT INTO context_cache (
           id, project_id, key, task, intent, git_head, budget, token_estimate,
           files, memory_ids, payload, created_at, last_used_at, hits
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(project_id, key) DO UPDATE SET
           id = excluded.id,
           task = excluded.task,
           intent = excluded.intent,
           git_head = excluded.git_head,
           budget = excluded.budget,
           token_estimate = excluded.token_estimate,
           files = excluded.files,
           memory_ids = excluded.memory_ids,
           payload = excluded.payload,
           last_used_at = excluded.last_used_at,
           hits = 0`,
      )
      .run(
        id,
        this.projectId,
        key,
        result.task,
        result.intent,
        gitHead,
        result.budget,
        result.tokenEstimate,
        JSON.stringify(files),
        JSON.stringify(result.memories.map((memory) => memory.id)),
        JSON.stringify(result),
        timestamp,
        timestamp,
      );

    this.evict();
    return id;
  }

  /** Drops every entry that contains one of the given files. */
  invalidatePaths(paths: string[]): number {
    if (paths.length === 0) return 0;
    const wanted = new Set(paths.map((entry) => entry.replace(/\\/g, "/")));

    const rows = this.db
      .prepare("SELECT id, files FROM context_cache WHERE project_id = ?")
      .all<{ id: string; files: string }>(this.projectId);

    let removed = 0;
    for (const row of rows) {
      const files = parseFiles(row.files);
      if (!files.some((file) => wanted.has(file.path))) continue;
      this.db.prepare("DELETE FROM context_cache WHERE id = ?").run(row.id);
      removed++;
    }
    return removed;
  }

  clear(): number {
    const removed = this.db.prepare("DELETE FROM context_cache WHERE project_id = ?").run(this.projectId);
    return Number(removed.changes);
  }

  record(outcome: CacheOutcome, result: ContextResult, durationMs: number): void {
    this.db
      .prepare(
        `INSERT INTO context_events (project_id, at, cache, tokens, files_selected, files_avoided, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.projectId,
        nowIso(),
        outcome,
        result.tokenEstimate,
        result.filesSelected,
        result.filesAvoided,
        Math.round(durationMs),
      );
  }

  /** Token analytics (PRD 51, 65) - measured, not asserted. */
  analytics(): ContextAnalytics {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END) AS hits,
                SUM(CASE WHEN cache = 'incremental' THEN 1 ELSE 0 END) AS incremental,
                SUM(CASE WHEN cache = 'miss' THEN 1 ELSE 0 END) AS misses,
                COALESCE(SUM(tokens), 0) AS total_tokens,
                COALESCE(SUM(files_selected), 0) AS files_retrieved,
                COALESCE(SUM(files_avoided), 0) AS files_avoided,
                COALESCE(SUM(CASE WHEN cache IN ('hit', 'incremental') THEN tokens ELSE 0 END), 0) AS saved
           FROM context_events WHERE project_id = ?`,
      )
      .get<Record<string, number | null>>(this.projectId);

    const cached = this.db
      .prepare("SELECT COUNT(*) AS n FROM context_cache WHERE project_id = ?")
      .get<{ n: number }>(this.projectId)?.n ?? 0;

    const requests = Number(totals?.requests ?? 0);
    const hits = Number(totals?.hits ?? 0);
    const incremental = Number(totals?.incremental ?? 0);
    const totalTokens = Number(totals?.total_tokens ?? 0);

    return {
      requests,
      hits,
      incremental,
      misses: Number(totals?.misses ?? 0),
      hitRate: requests === 0 ? 0 : Number(((hits + incremental) / requests).toFixed(3)),
      averageTokens: requests === 0 ? 0 : Math.round(totalTokens / requests),
      totalTokens,
      filesRetrieved: Number(totals?.files_retrieved ?? 0),
      filesAvoided: Number(totals?.files_avoided ?? 0),
      // Tokens that would have been re-assembled had the cache not answered.
      estimatedTokensSaved: Number(totals?.saved ?? 0),
      cachedEntries: cached,
    };
  }

  /** Keeps the cache bounded; the least recently used entries go first. */
  private evict(): void {
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM context_cache WHERE project_id = ?")
      .get<{ n: number }>(this.projectId)?.n ?? 0;
    if (count <= MAX_ENTRIES_PER_PROJECT) return;

    this.db
      .prepare(
        `DELETE FROM context_cache
          WHERE id IN (
            SELECT id FROM context_cache WHERE project_id = ?
             ORDER BY last_used_at ASC
             LIMIT ?
          )`,
      )
      .run(this.projectId, count - MAX_ENTRIES_PER_PROJECT);
  }
}

function hydrate(row: Record<string, unknown>): CacheEntry {
  return {
    id: String(row.id),
    key: String(row.key),
    task: String(row.task),
    gitHead: (row.git_head as string | null) ?? null,
    budget: Number(row.budget),
    tokenEstimate: Number(row.token_estimate),
    files: parseFiles(String(row.files)),
    memoryIds: parseStrings(String(row.memory_ids)),
    payload: JSON.parse(String(row.payload)) as ContextResult,
    createdAt: String(row.created_at),
    lastUsedAt: String(row.last_used_at),
    hits: Number(row.hits),
  };
}

function parseFiles(value: string): CachedFile[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is CachedFile =>
        typeof entry === "object" && entry !== null && typeof (entry as CachedFile).path === "string",
    );
  } catch {
    return [];
  }
}

function parseStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
