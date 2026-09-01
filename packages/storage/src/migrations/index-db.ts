import type { Migration } from "../migrator.js";

export const INDEX_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_file_index",
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL,
  path           TEXT NOT NULL,
  relative_path  TEXT NOT NULL,
  language       TEXT,
  extension      TEXT,
  size           INTEGER NOT NULL,
  hash           TEXT NOT NULL,
  last_modified  INTEGER NOT NULL,
  indexed_at     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  UNIQUE (project_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id, status);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(project_id, language);
CREATE INDEX IF NOT EXISTS idx_files_modified ON files(project_id, last_modified DESC);

CREATE TABLE IF NOT EXISTS index_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  full_rebuild   INTEGER NOT NULL DEFAULT 0,
  scanned        INTEGER NOT NULL DEFAULT 0,
  added          INTEGER NOT NULL DEFAULT 0,
  updated        INTEGER NOT NULL DEFAULT 0,
  unchanged      INTEGER NOT NULL DEFAULT 0,
  deleted        INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  bytes_indexed  INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'running',
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_index_runs_project ON index_runs(project_id, started_at DESC);
`,
  },
  {
    version: 2,
    name: "code_intelligence",
    sql: `
-- Symbols, imports and references (PRD 16, 17). Rows hang off files(id) with
-- ON DELETE CASCADE, so removing a file removes everything derived from it.
CREATE TABLE IF NOT EXISTS symbols (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,
  type            TEXT NOT NULL,
  signature       TEXT,
  line_start      INTEGER NOT NULL,
  line_end        INTEGER NOT NULL,
  parent_id       INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  exported        INTEGER NOT NULL DEFAULT 0,
  language        TEXT,
  hash            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(project_id, name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(project_id, qualified_name);
CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(project_id, type);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);

CREATE TABLE IF NOT EXISTS imports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL,
  file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  specifier         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  line              INTEGER NOT NULL,
  names             TEXT NOT NULL DEFAULT '[]',
  is_external       INTEGER NOT NULL DEFAULT 0,
  package_name      TEXT,
  resolved_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL,
  resolved_path     TEXT
);

CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
-- The reverse edge is what impact analysis walks, so it gets its own index.
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(project_id, resolved_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_package ON imports(project_id, package_name);

CREATE TABLE IF NOT EXISTS symbol_references (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  line            INTEGER NOT NULL,
  from_symbol_id  INTEGER REFERENCES symbols(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_references_name ON symbol_references(project_id, name);
CREATE INDEX IF NOT EXISTS idx_references_file ON symbol_references(file_id);

ALTER TABLE files ADD COLUMN parse_status TEXT;
ALTER TABLE files ADD COLUMN symbol_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE index_runs ADD COLUMN parsed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE index_runs ADD COLUMN parse_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE index_runs ADD COLUMN symbols INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 3,
    name: "full_text_search",
    sql: `
-- Contentless FTS5: the terms are indexed, the source text is not duplicated on
-- disk. Snippets are read from the file itself, so they are always current.
-- contentless_delete=1 (SQLite 3.43+) lets rows be deleted without resupplying text.
CREATE VIRTUAL TABLE IF NOT EXISTS file_search USING fts5(
  path,
  content,
  identifiers,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS symbol_search USING fts5(
  name,
  qualified_name,
  signature,
  path,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
`,
  },
  {
    version: 4,
    name: "context_cache",
    sql: `
-- Cached context results (PRD 25). The payload is the whole compact response; the
-- file hashes beside it are what decide whether it is still true.
CREATE TABLE IF NOT EXISTS context_cache (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  key             TEXT NOT NULL,
  task            TEXT NOT NULL,
  intent          TEXT,
  git_head        TEXT,
  budget          INTEGER NOT NULL,
  token_estimate  INTEGER NOT NULL,
  files           TEXT NOT NULL DEFAULT '[]',
  memory_ids      TEXT NOT NULL DEFAULT '[]',
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL,
  hits            INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_context_cache_key ON context_cache(project_id, key);
CREATE INDEX IF NOT EXISTS idx_context_cache_used ON context_cache(project_id, last_used_at DESC);

-- One row per context request, so the token claim can be measured (PRD 51, 65).
CREATE TABLE IF NOT EXISTS context_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL,
  at              TEXT NOT NULL,
  cache           TEXT NOT NULL,
  tokens          INTEGER NOT NULL DEFAULT 0,
  files_selected  INTEGER NOT NULL DEFAULT 0,
  files_avoided   INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_context_events ON context_events(project_id, at DESC);
`,
  },
  {
    version: 5,
    name: "security_findings",
    sql: `
-- Files where a credential pattern was detected during indexing (PRD 37). The
-- secret itself is never stored - only that one was seen, and where.
ALTER TABLE files ADD COLUMN has_secrets INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS security_findings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  detector     TEXT NOT NULL,
  occurrences  INTEGER NOT NULL DEFAULT 1,
  detected_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_findings ON security_findings(project_id, file_id);
`,
  },
];
