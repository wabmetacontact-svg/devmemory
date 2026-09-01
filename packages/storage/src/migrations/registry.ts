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
];
