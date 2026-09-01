import { DevMemoryError, nowIso, shortId } from "@samirthakur024/shared";
import type { SqliteDatabase } from "@samirthakur024/storage";
import type { GitEngine } from "../git/git-engine.js";
import type { TaskEngine } from "../tasks/task-engine.js";

export interface Session {
  id: string;
  projectId: string;
  taskId: string | null;
  agent: string;
  branch: string | null;
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
  startCommit: string | null;
  endCommit: string | null;
  summary: string | null;
  completed: string[];
  remaining: string[];
  nextStep: string | null;
  filesChanged: string[];
  tests: string | null;
}

export interface StartSessionInput {
  agent: string;
  taskId?: string;
}

export interface EndSessionInput {
  summary: string;
  completed?: string[];
  remaining?: string[];
  nextStep?: string;
  tests?: string;
  /** Files the agent knows it touched; git fills in the rest. */
  filesChanged?: string[];
}

interface SessionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  agent: string;
  branch: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  start_commit: string | null;
  end_commit: string | null;
  summary: string | null;
  completed: string;
  remaining: string;
  next_step: string | null;
  files_changed: string;
  tests: string | null;
}

export interface SessionEngineDeps {
  projectId: string;
  db: SqliteDatabase;
  git: GitEngine | null;
  root: string;
  isGitRepo: boolean;
}

/**
 * Compact session records (PRD 31). What is stored is the outcome of a session -
 * what got done, what is left, what to do next - never the conversation itself
 * (PRD 77: an AI conversation is never the source of truth).
 */
export class SessionEngine {
  constructor(private readonly deps: SessionEngineDeps) {}

  start(input: StartSessionInput): Session {
    const agent = input.agent.trim() || "unknown-agent";
    const id = shortId("ses", 6);
    const branch = this.branch();
    const head = this.head();

    // Only one session can be open at a time per project; an abandoned one is closed.
    const stale = this.active();
    if (stale) this.abandon(stale.id);

    this.deps.db
      .prepare(
        `INSERT INTO sessions (id, project_id, task_id, agent, branch, status, started_at, start_commit)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, this.deps.projectId, input.taskId ?? null, agent, branch, nowIso(), head);

    return this.require(id);
  }

  end(id: string, input: EndSessionInput): Session {
    const session = this.require(id);
    if (session.status === "ended") {
      throw new DevMemoryError("INVALID_INPUT", `session ${id} has already ended`);
    }

    const filesChanged = [
      ...new Set([...(input.filesChanged ?? []), ...this.changedSince(session.startCommit)]),
    ];

    this.deps.db
      .prepare(
        `UPDATE sessions
            SET status = 'ended', ended_at = ?, end_commit = ?, summary = ?, completed = ?,
                remaining = ?, next_step = ?, files_changed = ?, tests = ?
          WHERE id = ?`,
      )
      .run(
        nowIso(),
        this.head(),
        input.summary.trim(),
        JSON.stringify(input.completed ?? []),
        JSON.stringify(input.remaining ?? []),
        input.nextStep ?? null,
        JSON.stringify(filesChanged),
        input.tests ?? null,
        id,
      );

    return this.require(id);
  }

  get(id: string): Session | null {
    const row = this.deps.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND id = ?")
      .get<SessionRow>(this.deps.projectId, id);
    return row ? hydrate(row) : null;
  }

  require(id: string): Session {
    const session = this.get(id);
    if (!session) throw new DevMemoryError("INVALID_INPUT", `unknown session: ${id}`);
    return session;
  }

  active(): Session | null {
    const row = this.deps.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1")
      .get<SessionRow>(this.deps.projectId);
    return row ? hydrate(row) : null;
  }

  /** The most recent finished session - the one a new agent picks up from. */
  lastEnded(): Session | null {
    const row = this.deps.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND status = 'ended' ORDER BY ended_at DESC LIMIT 1")
      .get<SessionRow>(this.deps.projectId);
    return row ? hydrate(row) : null;
  }

  list(limit = 20): Session[] {
    return this.deps.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT ?")
      .all<SessionRow>(this.deps.projectId, limit)
      .map(hydrate);
  }

  forTask(taskId: string, limit = 10): Session[] {
    return this.deps.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND task_id = ? ORDER BY started_at DESC LIMIT ?")
      .all<SessionRow>(this.deps.projectId, taskId, limit)
      .map(hydrate);
  }

  stats(): { total: number; byAgent: Array<{ agent: string; sessions: number }> } {
    const total = this.deps.db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?")
      .get<{ n: number }>(this.deps.projectId)?.n ?? 0;

    const byAgent = this.deps.db
      .prepare("SELECT agent, COUNT(*) AS sessions FROM sessions WHERE project_id = ? GROUP BY agent ORDER BY sessions DESC")
      .all<{ agent: string; sessions: number }>(this.deps.projectId);

    return { total, byAgent };
  }

  /** Closes a session that was never ended, so state never looks live when it is not. */
  private abandon(id: string): void {
    this.deps.db
      .prepare("UPDATE sessions SET status = 'ended', ended_at = ?, summary = COALESCE(summary, ?) WHERE id = ?")
      .run(nowIso(), "session ended without a summary", id);
  }

  private changedSince(commit: string | null): string[] {
    if (!this.deps.git || !this.deps.isGitRepo) return [];
    try {
      return commit
        ? this.deps.git.changedFilesSince(this.deps.root, commit)
        : this.deps.git.status(this.deps.root).files.map((file) => file.path);
    } catch {
      return [];
    }
  }

  private branch(): string | null {
    if (!this.deps.git || !this.deps.isGitRepo) return null;
    return this.deps.git.currentBranch(this.deps.root);
  }

  private head(): string | null {
    if (!this.deps.git || !this.deps.isGitRepo) return null;
    return this.deps.git.headCommit(this.deps.root);
  }
}

function hydrate(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agent: row.agent,
    branch: row.branch,
    status: row.status === "active" ? "active" : "ended",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startCommit: row.start_commit,
    endCommit: row.end_commit,
    summary: row.summary,
    completed: parseArray(row.completed),
    remaining: parseArray(row.remaining),
    nextStep: row.next_step,
    filesChanged: parseArray(row.files_changed),
    tests: row.tests,
  };
}

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export type { TaskEngine };
