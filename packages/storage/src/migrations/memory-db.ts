import type { Migration } from "../migrator.js";

export const MEMORY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_memory",
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Long-lived project knowledge (PRD 27, 28). One row per remembered thing; the
-- content hash is what stops the same fact being written a hundred times.
CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  importance     REAL NOT NULL DEFAULT 0.5,
  confidence     REAL NOT NULL DEFAULT 0.8,
  status         TEXT NOT NULL DEFAULT 'active',
  -- NULL means the memory holds for the whole project; a branch name scopes it
  -- to that branch only (PRD 57).
  branch         TEXT,
  source         TEXT,
  tags           TEXT NOT NULL DEFAULT '[]',
  paths          TEXT NOT NULL DEFAULT '[]',
  symbols        TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  accessed_at    TEXT,
  access_count   INTEGER NOT NULL DEFAULT 0,
  expires_at     TEXT,
  supersedes     TEXT,
  content_hash   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(project_id, type, status);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(project_id, status, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_branch ON memories(project_id, branch);
CREATE INDEX IF NOT EXISTS idx_memories_expiry ON memories(project_id, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_id, content_hash);

-- The structured half of a decision record (PRD 29): what was decided, why, what
-- was rejected, and which areas it binds.
CREATE TABLE IF NOT EXISTS decisions (
  memory_id     TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  reason        TEXT,
  alternatives  TEXT NOT NULL DEFAULT '[]',
  affected      TEXT NOT NULL DEFAULT '[]',
  decided_at    TEXT
);

CREATE TABLE IF NOT EXISTS memory_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL,
  event      TEXT NOT NULL,
  at         TEXT NOT NULL,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_events ON memory_events(memory_id, at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
  title,
  content,
  tags,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
`,
  },
  {
    version: 2,
    name: "tasks_and_sessions",
    sql: `
-- Development work as structured state (PRD 30). Tasks live beside memory rather
-- than in the code index, so a re-index never disturbs them.
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  key             TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'IDEA',
  priority        TEXT NOT NULL DEFAULT 'normal',
  branch          TEXT,
  areas           TEXT NOT NULL DEFAULT '[]',
  paths           TEXT NOT NULL DEFAULT '[]',
  symbols         TEXT NOT NULL DEFAULT '[]',
  tags            TEXT NOT NULL DEFAULT '[]',
  blocked_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_key ON tasks(project_id, key);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_requirements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_requirements ON task_requirements(task_id, position);

CREATE TABLE IF NOT EXISTS task_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event    TEXT NOT NULL,
  at       TEXT NOT NULL,
  agent    TEXT,
  detail   TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, at DESC);

-- Compact session summaries, never whole conversations (PRD 31).
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent          TEXT NOT NULL,
  branch         TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  start_commit   TEXT,
  end_commit     TEXT,
  summary        TEXT,
  completed      TEXT NOT NULL DEFAULT '[]',
  remaining      TEXT NOT NULL DEFAULT '[]',
  next_step      TEXT,
  files_changed  TEXT NOT NULL DEFAULT '[]',
  tests          TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);

CREATE VIRTUAL TABLE IF NOT EXISTS task_search USING fts5(
  title,
  description,
  requirements,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
`,
  },
];
