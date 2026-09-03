import type { SqliteDatabase } from "@samirthakur024/storage";
import { nowIso } from "@samirthakur024/shared";
import { redactSecrets } from "@samirthakur024/indexer";

export type ActivitySource = "tool" | "file" | "index";
export type ActivityOutcome = "ok" | "error" | "denied";

export interface ActivityEntry {
  source: ActivitySource;
  summary: string;
  outcome?: ActivityOutcome;
  agent?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  tool?: string | null;
  detail?: string | null;
  durationMs?: number | null;
  sessionId?: string | null;
}

export interface ActivityRecord extends ActivityEntry {
  id: number;
  at: string;
  outcome: ActivityOutcome;
}

/** Long enough to be useful in a feed, short enough that no payload hides inside. */
const MAX_SUMMARY = 200;
const MAX_DETAIL = 400;

/**
 * A shared, append-only record of what agents did (PRD 41).
 *
 * Every MCP tool call already passes one wrapper, and the daemon already sees
 * every file change; both write here so the dashboard can show the work behind
 * an instruction without either process talking to the other. WAL means the
 * writer and the reader never block each other.
 *
 * This is a feed, not an audit log: rows are trimmed, and a failure to write one
 * must never fail the tool call it describes.
 */
export class ActivityLog {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly retain = 2000,
  ) {}

  record(entry: ActivityEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO activity (at, source, agent, project_id, project_name, tool, summary, detail, outcome, duration_ms, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nowIso(),
          entry.source,
          entry.agent ?? null,
          entry.projectId ?? null,
          entry.projectName ?? null,
          entry.tool ?? null,
          clean(entry.summary, MAX_SUMMARY),
          entry.detail ? clean(entry.detail, MAX_DETAIL) : null,
          entry.outcome ?? "ok",
          entry.durationMs ?? null,
          entry.sessionId ?? null,
        );

      // Amortised trim: the feed is bounded without a scan on every write.
      if (Math.random() < 0.02) this.prune();
    } catch {
      // A feed is never worth failing a tool call for.
    }
  }

  recent(options: { limit?: number; projectId?: string; since?: number } = {}): ActivityRecord[] {
    const limit = Math.min(options.limit ?? 100, 500);
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (options.projectId) {
      clauses.push("project_id = ?");
      params.push(options.projectId);
    }
    if (typeof options.since === "number") {
      clauses.push("id > ?");
      params.push(options.since);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);

    return this.db
      .prepare(`SELECT * FROM activity ${where} ORDER BY id DESC LIMIT ?`)
      .all<Record<string, unknown>>(...params)
      .map(toRecord)
      .reverse();
  }

  /** Counts by tool over the most recent rows, for a "what has it been doing" panel. */
  summary(limit = 500): Array<{ tool: string; count: number }> {
    return this.db
      .prepare(
        `SELECT tool, COUNT(*) AS count
           FROM (SELECT tool FROM activity WHERE tool IS NOT NULL ORDER BY id DESC LIMIT ?)
          GROUP BY tool ORDER BY count DESC`,
      )
      .all<{ tool: string; count: number }>(limit)
      .map((row) => ({ tool: String(row.tool), count: Number(row.count) }));
  }

  prune(): void {
    this.db
      .prepare("DELETE FROM activity WHERE id <= (SELECT MAX(id) FROM activity) - ?")
      .run(this.retain);
  }

  clear(): void {
    this.db.exec("DELETE FROM activity");
  }
}

/**
 * Anything reaching this table has been near a tool argument, so it is redacted
 * and flattened before it is stored - a feed row is not worth leaking a token
 * that the indexer would have stripped anywhere else.
 */
function clean(value: string, max: number): string {
  const flat = redactSecrets(value).text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toRecord(row: Record<string, unknown>): ActivityRecord {
  return {
    id: Number(row.id),
    at: String(row.at),
    source: String(row.source) as ActivitySource,
    agent: (row.agent as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    projectName: (row.project_name as string | null) ?? null,
    tool: (row.tool as string | null) ?? null,
    summary: String(row.summary),
    detail: (row.detail as string | null) ?? null,
    outcome: String(row.outcome) as ActivityOutcome,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    sessionId: (row.session_id as string | null) ?? null,
  };
}
