import type { Migration } from "../migrator.js";

export const REGISTRY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_registry",
    sql: `
CREATE TABLE IF NOT EXISTS projects (
  project_id       TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  root_path        TEXT NOT NULL,
  repository_url   TEXT,
  repository_type  TEXT,
  identity_source  TEXT NOT NULL,
  identity_key     TEXT NOT NULL UNIQUE,
  framework        TEXT,
  languages        TEXT NOT NULL DEFAULT '[]',
  package_manager  TEXT,
  created_at       TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  last_indexed_at  TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  index_status     TEXT NOT NULL DEFAULT 'never'
);

CREATE INDEX IF NOT EXISTS idx_projects_root_path ON projects(root_path);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_last_seen ON projects(last_seen_at DESC);

-- A project keeps working after it is moved on disk (PRD 9); every location it has
-- been seen at is remembered so path-identified projects survive relocation too.
CREATE TABLE IF NOT EXISTS project_paths (
  project_id     TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_project_paths_path ON project_paths(path);
`,
  },
  {
    version: 2,
    name: "workspaces",
    sql: `
-- A workspace groups projects that are worked on together - a mobile app and the
-- backend it calls, say. Isolation stays the default: context and search only span
-- a workspace when the caller asks for one by name (PRD 11 is not weakened).
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_name ON workspaces(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS workspace_projects (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  role          TEXT,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_projects ON workspace_projects(project_id);
`,
  },
  {
    version: 3,
    name: "activity",
    sql: `
-- What agents actually did, newest last (PRD 41 surfaces, one shared log).
-- It lives in the registry rather than per project because a single instruction
-- routinely crosses projects, and a feed split three ways reads as noise.
--
-- summary and detail are written already-redacted and already-shortened by the
-- caller: this table must never become a second copy of source text or of a
-- tool argument nobody screened.
CREATE TABLE IF NOT EXISTS activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  source        TEXT NOT NULL,
  agent         TEXT,
  project_id    TEXT,
  project_name  TEXT,
  tool          TEXT,
  summary       TEXT NOT NULL,
  detail        TEXT,
  outcome       TEXT NOT NULL DEFAULT 'ok',
  duration_ms   INTEGER,
  session_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_recent ON activity(id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, id DESC);
`,
  },
];
