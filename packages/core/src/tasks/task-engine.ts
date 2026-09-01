import { DevMemoryError, nowIso, shortId } from "@devmemory/shared";
import type { SqliteDatabase } from "@devmemory/storage";
import { toMatchQuery } from "@devmemory/indexer";

/** Task lifecycle states from PRD 30. */
export const TASK_STATUSES = [
  "IDEA",
  "PLANNING",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "TESTING",
  "COMPLETED",
  "ARCHIVED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * Which moves are legal. Everything can be archived; a completed task can be
 * reopened, because work being "done" is a claim that sometimes turns out false.
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  IDEA: ["PLANNING", "READY", "IN_PROGRESS"],
  PLANNING: ["IDEA", "READY", "IN_PROGRESS"],
  READY: ["PLANNING", "IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["BLOCKED", "TESTING", "COMPLETED", "READY"],
  BLOCKED: ["IN_PROGRESS", "READY", "COMPLETED"],
  TESTING: ["IN_PROGRESS", "BLOCKED", "COMPLETED"],
  COMPLETED: ["IN_PROGRESS", "TESTING"],
  ARCHIVED: ["READY", "IDEA"],
};

/** Statuses that mean the task is still live work. */
const OPEN_STATUSES: TaskStatus[] = ["PLANNING", "READY", "IN_PROGRESS", "BLOCKED", "TESTING"];

/** Statuses that mean someone has actually started - a READY task is not underway. */
const ACTIVE_STATUSES: TaskStatus[] = ["IN_PROGRESS", "BLOCKED", "TESTING"];

export interface Requirement {
  id: number;
  text: string;
  done: boolean;
  completedAt: string | null;
}

export interface Task {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  branch: string | null;
  areas: string[];
  paths: string[];
  symbols: string[];
  tags: string[];
  blockedReason: string | null;
  requirements: Requirement[];
  progress: { done: number; total: number; percent: number };
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  requirements?: string[];
  areas?: string[];
  paths?: string[];
  symbols?: string[];
  tags?: string[];
  branch?: string | null;
  agent?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  blockedReason?: string | null;
  addRequirements?: string[];
  /** Requirement texts (or ids) to tick off. */
  completeRequirements?: Array<string | number>;
  reopenRequirements?: Array<string | number>;
  addPaths?: string[];
  addSymbols?: string[];
  addAreas?: string[];
  addTags?: string[];
  note?: string;
  agent?: string;
}

interface TaskRow {
  rowid: number;
  id: string;
  project_id: string;
  key: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  branch: string | null;
  areas: string;
  paths: string;
  symbols: string;
  tags: string;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * Structured development work (PRD 30). Tasks are what make progress survive a
 * session ending: requirements, status, affected areas and a timeline of events.
 */
export class TaskEngine {
  constructor(
    private readonly projectId: string,
    private readonly db: SqliteDatabase,
    private readonly currentBranch: string | null = null,
  ) {}

  create(input: CreateTaskInput): Task {
    const title = input.title.trim();
    if (title.length < 3) throw new DevMemoryError("INVALID_INPUT", "task title is too short");

    const status = input.status ?? "READY";
    assertStatus(status);

    const id = shortId("task", 6);
    const key = this.nextKey();
    const timestamp = nowIso();

    const result = this.db
      .prepare(
        `INSERT INTO tasks (
           id, project_id, key, title, description, status, priority, branch,
           areas, paths, symbols, tags, blocked_reason, created_at, updated_at, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        this.projectId,
        key,
        title,
        input.description ?? null,
        status,
        input.priority ?? "normal",
        input.branch === undefined ? this.currentBranch : input.branch,
        JSON.stringify(input.areas ?? []),
        JSON.stringify(input.paths ?? []),
        JSON.stringify(input.symbols ?? []),
        JSON.stringify(input.tags ?? []),
        timestamp,
        timestamp,
        status === "IN_PROGRESS" ? timestamp : null,
      );

    for (const [index, text] of (input.requirements ?? []).entries()) {
      this.db
        .prepare("INSERT INTO task_requirements (task_id, text, done, position) VALUES (?, ?, 0, ?)")
        .run(id, text.trim(), index);
    }

    this.reindex(Number(result.lastInsertRowid), id);
    this.event(id, "created", input.agent, `${key} ${status}`);
    return this.require(id);
  }

  update(idOrKey: string, patch: UpdateTaskInput): Task {
    const task = this.require(idOrKey);
    const timestamp = nowIso();

    if (patch.status && patch.status !== task.status) {
      assertTransition(task.status, patch.status);
    }

    const status = patch.status ?? task.status;
    const startedAt = task.startedAt ?? (status === "IN_PROGRESS" ? timestamp : null);
    const completedAt = status === "COMPLETED" ? (task.completedAt ?? timestamp) : status === "ARCHIVED" ? task.completedAt : null;

    this.db
      .prepare(
        `UPDATE tasks
            SET title = ?, description = ?, status = ?, priority = ?, blocked_reason = ?,
                areas = ?, paths = ?, symbols = ?, tags = ?, updated_at = ?, started_at = ?, completed_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.title?.trim() ?? task.title,
        patch.description ?? task.description,
        status,
        patch.priority ?? task.priority,
        patch.blockedReason === undefined ? (status === "BLOCKED" ? task.blockedReason : null) : patch.blockedReason,
        JSON.stringify(mergeUnique(task.areas, patch.addAreas ?? [])),
        JSON.stringify(mergeUnique(task.paths, patch.addPaths ?? [])),
        JSON.stringify(mergeUnique(task.symbols, patch.addSymbols ?? [])),
        JSON.stringify(mergeUnique(task.tags, patch.addTags ?? [])),
        timestamp,
        startedAt,
        completedAt,
        task.id,
      );

    for (const text of patch.addRequirements ?? []) {
      const position = this.db
        .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM task_requirements WHERE task_id = ?")
        .get<{ next: number }>(task.id);
      this.db
        .prepare("INSERT INTO task_requirements (task_id, text, done, position) VALUES (?, ?, 0, ?)")
        .run(task.id, text.trim(), position?.next ?? 0);
    }

    for (const reference of patch.completeRequirements ?? []) this.setRequirement(task.id, reference, true);
    for (const reference of patch.reopenRequirements ?? []) this.setRequirement(task.id, reference, false);

    if (patch.status && patch.status !== task.status) {
      this.event(task.id, "status", patch.agent, `${task.status} -> ${patch.status}`);
    }
    if (patch.note) this.event(task.id, "note", patch.agent, patch.note);
    if ((patch.completeRequirements ?? []).length > 0) {
      this.event(task.id, "progress", patch.agent, `${patch.completeRequirements?.length} requirement(s) completed`);
    }

    const rowid = this.rowidOf(task.id);
    if (rowid !== null) this.reindex(rowid, task.id);
    return this.require(task.id);
  }

  get(idOrKey: string): Task | null {
    const row =
      this.db.prepare("SELECT rowid, * FROM tasks WHERE project_id = ? AND id = ?").get<TaskRow>(this.projectId, idOrKey) ??
      this.db
        .prepare("SELECT rowid, * FROM tasks WHERE project_id = ? AND key = ? COLLATE NOCASE")
        .get<TaskRow>(this.projectId, idOrKey);
    return row ? this.hydrate(row) : null;
  }

  require(idOrKey: string): Task {
    const task = this.get(idOrKey);
    if (!task) throw new DevMemoryError("INVALID_INPUT", `unknown task: ${idOrKey}`);
    return task;
  }

  list(options: { status?: TaskStatus; open?: boolean; branch?: string | null; limit?: number } = {}): Task[] {
    const clauses = ["project_id = ?"];
    const params: Array<string | number> = [this.projectId];

    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (options.open) {
      clauses.push(`status IN (${OPEN_STATUSES.map(() => "?").join(", ")})`);
      params.push(...OPEN_STATUSES);
    }
    if (options.branch !== undefined && options.branch !== null) {
      clauses.push("(branch IS NULL OR branch = ?)");
      params.push(options.branch);
    }

    params.push(options.limit ?? 50);

    return this.db
      .prepare(
        `SELECT rowid, * FROM tasks
          WHERE ${clauses.join(" AND ")}
          ORDER BY CASE status
                     WHEN 'IN_PROGRESS' THEN 0 WHEN 'BLOCKED' THEN 1 WHEN 'TESTING' THEN 2
                     WHEN 'READY' THEN 3 WHEN 'PLANNING' THEN 4 WHEN 'IDEA' THEN 5
                     WHEN 'COMPLETED' THEN 6 ELSE 7 END,
                   updated_at DESC
          LIMIT ?`,
      )
      .all<TaskRow>(...(params as never[]))
      .map((row) => this.hydrate(row));
  }

  search(query: string, limit = 10): Task[] {
    const match = toMatchQuery(query);
    if (!match) return [];

    return this.db
      .prepare(
        `SELECT t.rowid, t.*, bm25(task_search, 6.0, 2.0, 3.0) AS score
           FROM task_search
           JOIN tasks t ON t.rowid = task_search.rowid
          WHERE task_search MATCH ? AND t.project_id = ?
          ORDER BY score
          LIMIT ?`,
      )
      .all<TaskRow>(match, this.projectId, limit)
      .map((row) => this.hydrate(row));
  }

  /**
   * The task actually underway. A READY task is a candidate to start, not the
   * current one - the difference is what makes handoff say "start" rather than
   * "continue" (PRD 32).
   */
  current(): Task | null {
    return this.list({ open: true, limit: 20 }).find((task) => ACTIVE_STATUSES.includes(task.status)) ?? null;
  }

  events(idOrKey: string, limit = 25): Array<{ event: string; at: string; agent: string | null; detail: string | null }> {
    const task = this.require(idOrKey);
    return this.db
      .prepare("SELECT event, at, agent, detail FROM task_events WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all<{ event: string; at: string; agent: string | null; detail: string | null }>(task.id, limit);
  }

  stats(): { total: number; open: number; blocked: number; completed: number; byStatus: Array<{ status: string; count: number }> } {
    const byStatus = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE project_id = ? GROUP BY status")
      .all<{ status: string; count: number }>(this.projectId);

    const total = byStatus.reduce((sum, entry) => sum + entry.count, 0);
    const open = byStatus.filter((entry) => OPEN_STATUSES.includes(entry.status as TaskStatus)).reduce((sum, entry) => sum + entry.count, 0);

    return {
      total,
      open,
      blocked: byStatus.find((entry) => entry.status === "BLOCKED")?.count ?? 0,
      completed: byStatus.find((entry) => entry.status === "COMPLETED")?.count ?? 0,
      byStatus,
    };
  }

  event(taskId: string, event: string, agent?: string, detail?: string): void {
    this.db
      .prepare("INSERT INTO task_events (task_id, event, at, agent, detail) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, event, nowIso(), agent ?? null, detail ?? null);
  }

  private setRequirement(taskId: string, reference: string | number, done: boolean): void {
    const row =
      typeof reference === "number"
        ? this.db.prepare("SELECT id FROM task_requirements WHERE task_id = ? AND id = ?").get<{ id: number }>(taskId, reference)
        : this.db
            .prepare("SELECT id FROM task_requirements WHERE task_id = ? AND text = ? COLLATE NOCASE")
            .get<{ id: number }>(taskId, reference);

    if (!row) {
      throw new DevMemoryError("INVALID_INPUT", `unknown requirement: ${reference}`, { taskId });
    }

    this.db
      .prepare("UPDATE task_requirements SET done = ?, completed_at = ? WHERE id = ?")
      .run(done ? 1 : 0, done ? nowIso() : null, row.id);
  }

  private nextKey(): string {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?")
      .get<{ n: number }>(this.projectId);
    let index = (row?.n ?? 0) + 1;

    // Counting can collide after a deletion; step forward until the key is free.
    while (this.db.prepare("SELECT 1 AS x FROM tasks WHERE project_id = ? AND key = ?").get(this.projectId, `TASK-${index}`)) {
      index++;
    }
    return `TASK-${index}`;
  }

  private rowidOf(id: string): number | null {
    const row = this.db.prepare("SELECT rowid FROM tasks WHERE id = ?").get<{ rowid: number }>(id);
    return row ? Number(row.rowid) : null;
  }

  private reindex(rowid: number, taskId: string): void {
    const task = this.db.prepare("SELECT title, description FROM tasks WHERE id = ?").get<{ title: string; description: string | null }>(taskId);
    const requirements = this.db
      .prepare("SELECT text FROM task_requirements WHERE task_id = ?")
      .all<{ text: string }>(taskId)
      .map((row) => row.text)
      .join(" ");

    this.db.prepare("DELETE FROM task_search WHERE rowid = ?").run(rowid);
    this.db
      .prepare("INSERT INTO task_search (rowid, title, description, requirements) VALUES (?, ?, ?, ?)")
      .run(rowid, task?.title ?? "", task?.description ?? "", requirements);
  }

  private hydrate(row: TaskRow): Task {
    const requirements = this.db
      .prepare("SELECT id, text, done, completed_at FROM task_requirements WHERE task_id = ? ORDER BY position, id")
      .all<{ id: number; text: string; done: number; completed_at: string | null }>(row.id)
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        done: entry.done === 1,
        completedAt: entry.completed_at,
      }));

    const done = requirements.filter((entry) => entry.done).length;

    return {
      id: row.id,
      projectId: row.project_id,
      key: row.key,
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      branch: row.branch,
      areas: parseArray(row.areas),
      paths: parseArray(row.paths),
      symbols: parseArray(row.symbols),
      tags: parseArray(row.tags),
      blockedReason: row.blocked_reason,
      requirements,
      progress: {
        done,
        total: requirements.length,
        percent: requirements.length === 0 ? (row.status === "COMPLETED" ? 100 : 0) : Math.round((done / requirements.length) * 100),
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }
}

export function assertStatus(status: string): asserts status is TaskStatus {
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new DevMemoryError("INVALID_INPUT", `unknown task status: ${status}`, { allowed: TASK_STATUSES });
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (to === "ARCHIVED" || from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new DevMemoryError("INVALID_INPUT", `cannot move a task from ${from} to ${to}`, {
      allowed: [...TRANSITIONS[from], "ARCHIVED"],
    });
  }
}

export function isOpenStatus(status: TaskStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
