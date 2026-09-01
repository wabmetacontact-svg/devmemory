# DevMemory architecture (as built)

This document describes what exists today — all 14 steps of the PRD development order — and the seams left for the optional work that follows.

## Layering

```text
apps/cli ──┐                    ┌── apps/mcp-server
           ├──► packages/mcp ───┤
           │                    └── apps/dashboard (HTTP API + UI)
           ▼
     packages/core          DevMemory facade, project resolver, registry, git engine, code
           │                intelligence, context engine, memory, tasks, sessions, daemon
           ├──► packages/indexer     walker, ignore rules, hashing, file store,
           │                        tree-sitter parsers, symbols, imports, FTS5 search
           ├──► packages/storage     driver interface, migrations, db manager
           └──► packages/shared      paths, config, types, logging, tokens
```

Dependencies point one way only: `shared ← storage ← indexer ← core ← mcp ← apps`. Every surface (CLI, MCP server, and later the dashboard) drives the same `DevMemory` facade, which is what keeps them consistent (PRD 41).

## Project resolution (PRD 8, 9)

```text
explicit root  ─┐
client roots   ─┼─► first readable directory ─► git root? ─► nearest manifest ─► that directory
cwd            ─┘
```

Identity is then derived in priority order:

| Priority | Source | Key |
| --- | --- | --- |
| 1 | git remote | `git:remote:github.com/acme/app` |
| 2 | git root commit | `git:root-commit:<sha>` |
| 3 | fingerprint | `fingerprint:<sha256(package name, directory name, manifest set)>` |
| 4 | path | `path:<normalized absolute path>` |

`project_id = "proj_" + sha256(identity_key).slice(0, 10)`.

Two consequences worth stating:

- ssh and https clones of one repository collapse to a single project.
- A project that moves keeps its id; the registry updates `root_path` and appends to `project_paths`, so a path it used to occupy still resolves.

**Root safety.** `findMarkerRoot` returns the *nearest* manifest and then promotes at most six levels to a monorepo root (`pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`, `rush.json`, `go.work`, or a `package.json` with `workspaces`). It never ascends into the home directory. An *inferred* root that lands on the home directory or a drive root is refused outright — indexing a user's entire home folder is both slow and a privacy failure.

**Path canonicalisation.** `normalizePath` resolves the real on-disk path. On Windows the same directory can arrive as `C:/Users/RUNNER~1/...` (8.3 short form) or `C:/Users/Runner Name/...`; without canonicalisation those register as two projects.

## Storage (PRD 7, 14)

`DatabaseManager` owns every SQLite handle. The registry lives in `registry.db`; each project gets `projects/<project_id>/index.db`. Project databases are opened lazily, cached, and stamped with their owning `project_id` in a `meta` table — reopening a database under a different id fails loudly.

Isolation is therefore enforced twice: by file separation, and by `project_id` predicates on every query. `tests/isolation.test.ts` asserts both, including that deliberately mixing ids returns nothing.

Migrations are versioned per database kind, applied in order, each in its own transaction, and are idempotent.

The `SqliteDriver` interface (`open(file, options) -> SqliteDatabase`) is the substitution seam. The shipped driver wraps `node:sqlite`, loaded through `createRequire` rather than a static import: an ESM graph links every module — builtins included — before any of it runs, so a static import would emit the `ExperimentalWarning` before the filter could install itself. On an MCP stdio transport that noise is worth removing.

## Indexing (PRD 15, 20, 59, 60)

```text
candidates ─► sensitive? ─► ignored? ─► binary? ─► size limit? ─► stat
                                                                   │
                                       size+mtime unchanged ───────┴─► skip (no read)
                                       otherwise ─► sha256 ─► compare ─► insert/update
```

- **Candidates.** In a git repository, `git ls-files --cached --others --exclude-standard -z`. Otherwise a walker that prunes ignored directories and applies a gitignore-compatible matcher (anchoring, `**`, negation, directory-only rules).
- **Ancestor checks.** A git-supplied candidate list is flat, so `isIgnoredPath` re-checks every ancestor segment — without it, `node_modules/**` slips through in repositories that track it.
- **Deletions** are inferred only from a complete scan; partial runs (the future watcher's single-file updates) never delete.
- **Atomicity.** One transaction per run: a crash leaves the previous index intact, and an interrupted run is detectable via an `index_runs` row still marked `running`.

## Git (PRD 34)

`GitEngine` shells out to the native git binary with `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`, never touching the network. It provides repository root, remote, root commit, head, branch, porcelain status, log (unit/record-separated so subjects and bodies survive), diff, blame, `ls-files` and `changedFilesSince`. Every call is deterministic and read-only.

## MCP surface (PRD 39, 40)

Tools are plain definitions — name, title, description, permission class, a Zod input shape, and a handler — collected in `ALL_TOOLS`. `createDevMemoryServer` registers each with the SDK, maps the permission class onto MCP annotations (`readOnlyHint`, `destructiveHint`), and serialises results as compact JSON text so every client can consume them.

Errors become `DevMemoryError` payloads (`{ error: { code, message, details } }`) returned with `isError: true`, rather than transport failures.

Workspace roots are requested once per session via `listRoots()` when the client advertises the capability, then cached.

## Security (PRD 20, 37, 38)

- Sensitive files are rejected before any read, independently of user ignore rules.
- `redactSecrets` covers AWS keys, GitHub/Slack/Stripe/Google/OpenAI/Anthropic tokens, JWTs, private key blocks and `NAME=secret` assignments; it is applied to diffs before they leave the process.
- `safeProjectPath` refuses paths that escape a project root.
- `project_forget` requires `confirm: true`; project ids are validated against `^proj_[a-f0-9]{6,32}$` before any filesystem operation.

## Code intelligence (PRD 16, 17, 18)

Added in Step 6. Three phases run inside one index pass:

```text
phase 1  file records        one transaction: upsert, hash-gate, mark deletions
phase 2  parsing             outside any transaction - CPU-bound, holds no write lock
phase 3  symbols + graph     one transaction: symbols, imports, references, relink
```

**Parsers.** Tree-sitter compiled to WebAssembly (`web-tree-sitter` + grammars from
`@vscode/tree-sitter-wasm`), so there is still no native build step. Grammar loading is
async and happens once per process; parsing afterwards is synchronous, which is why
`DevMemory.index()` and `connect()` are async while everything below them stays sync.

Each language implements `LanguageParser` — TypeScript/TSX/JavaScript and Python in v1.
The tree is walked explicitly rather than queried: node-type switches stay readable,
degrade predictably across grammar versions, and make it obvious which constructs are
deliberately ignored.

**What becomes a symbol.** Top-level declarations and class members only. A `const`
inside a function body or a callback is implementation detail, not API — that single
rule is the difference between ~500 useful symbols and several thousand noisy ones for
this repository. Functions are refined into React components (PascalCase in a JSX file)
and hooks (`use*`); express-style `app.get("/path", …)` calls and Python
`@app.get("/path")` decorators become `route` symbols.

**References** record calls, `new`, `extends`, `implements`, decorators and JSX usage,
each attributed to the enclosing symbol — which is what lets `find_references` answer
"who calls this, and from where".

**Import resolution** is deterministic and consults only paths already in the index, so
it can never pull in an ignored file. It handles relative specifiers with extension and
`index.*` inference, ESM `./x.js` → `./x.ts` rewriting, tsconfig `paths` aliases, Python
relative and dotted modules, and workspace packages discovered from
`pnpm-workspace.yaml` / `package.json` workspaces. Unresolved-but-internal specifiers are
re-linked once at the end of a run, because a file may be parsed before its target is
indexed.

**Graph queries** live in `SymbolStore` (`dependencies`, `dependents`, `externalPackages`)
with `CodeIntelligence` on top for `getDefinition`, `findReferences`, `relatedCode`,
`impact` (bounded BFS over dependents) and `affectedTests`. Symbols carry a per-symbol
content hash so a later step can diff symbols rather than files (PRD 33).

Everything derived from a file is keyed to `files(id)` with `ON DELETE CASCADE`, and is
replaced wholesale whenever that file's content hash changes.

## Context engine (PRD 21-24)

Added in Step 7. `get_context` is the flagship: it answers "what should I look at to do
this?" without handing the agent the repository.

```text
request ──► intent + entities ──► seeds ──► graph expansion ──► rank ──► budget fill ──► result
                                    │
              explicit paths, symbol matches, full-text hits,
              path mentions, files changed since last commit
```

**Intent and entities** are deterministic keyword work, not an LLM call: the request is
classified as debug / implement / test / refactor / explain / review, and tokens that
look like code (PascalCase, camelCase, `foo()`, backticked names, paths) are pulled out
as retrieval hints. Getting this wrong costs ranking quality, never correctness -
ranking corrects for it.

**Search** is SQLite FTS5 over two contentless tables: `file_search(path, content,
identifiers)` and `symbol_search(name, qualified_name, signature, path)`. Contentless
means terms are indexed but the source is not copied into the database; snippets are read
from the file on demand and so are always current. `contentless_delete=1` lets a row be
removed without resupplying its text, which is what makes re-indexing cheap. Identifiers
are indexed both whole and split (`verifyPayment` → `verify payment`), so natural phrasing
finds code. Raw queries are never passed through: they are tokenised, stopword-filtered,
quoted and OR-ed, so punctuation can never become FTS operator syntax.

**Ranking** implements the PRD 23 formula with one weight per signal - explicit request,
symbol definition, search relevance, path mention, dependency distance, recent change,
test affinity. A signal contributes at its strongest observation rather than the sum of
many weak ones, so a file cannot climb by matching a common word ten times.

**Selection** fills the token budget greedily in rank order. Each file is emitted as L1
structure (path, language, ranked symbols with signatures and line ranges, and the reasons
it was chosen); L2 source slices are attached only when the caller asks or the intent is
debugging, and only for the top few files. A file that does not fit with source is retried
as structure alone before the loop gives up. Everything returned is secret-redacted.

**Honesty about savings.** The result carries `token_estimate`, `files_selected`,
`files_considered` and `files_avoided`, so the token claim in PRD 24 is measurable rather
than asserted.

## Memory engine (PRD 27-29)

Added in Step 8, in its own database (`projects/<id>/memory.db`) so that re-indexing,
or losing the index entirely, never loses knowledge.

**What is worth storing.** `remember` applies policy before anything is written:
importance defaults by kind (DECISION 0.9, CONSTRAINT 0.85, BUG/PATTERN 0.7,
DISCOVERY 0.6, FACT 0.5, HISTORY 0.3), content below a minimum length is refused, and
low-importance kinds are given a TTL - HISTORY expires after 30 days unless the caller
says otherwise. Expired memories are archived, never silently deleted.

**Deduplication.** A content hash over (type, title, content) is unique per project, so
storing the same knowledge twice reinforces the existing memory - raising its importance
and merging tags and paths - instead of creating a duplicate. Repetition is treated as a
signal, not as new information.

**Superseding.** A memory can replace another; the old one moves to `superseded` and
stays queryable as history. Nothing that was once believed is thrown away by default -
`forget` archives, and only a hard delete with explicit confirmation removes a row.

**Decisions** (PRD 29) carry a structured half in their own table: reason, alternatives
rejected, and the areas the decision binds.

**Branch awareness** (PRD 57). A memory with a null branch holds for the whole project;
one recorded with `branch_specific` is scoped to the branch it was made on and simply
does not appear elsewhere.

**Recall** combines FTS5 relevance with importance, recency (90-day half-life),
confidence and reinforcement count. With no query it returns the project's most
load-bearing knowledge, which is what a new session - or an agent picking up someone
else's work - actually needs.

**Feeding context.** `ContextEngine` recalls against the task and does two things with
the result: it attaches the memories to the response, and it boosts any file a memory
names, with the memory's title as the reason. That closes the loop the PRD 23 scoring
formula describes - memory importance is a ranking signal, not a separate feature.

## Tasks, sessions and handoff (PRD 30-32)

Added in Step 9, in `memory.db` alongside knowledge - work state is knowledge, and it
must survive a re-index for the same reason memory does.

**Tasks** carry a per-project key (TASK-1, TASK-2), a requirement checklist that yields
real progress numbers, affected areas and files, and a timeline of events attributed to
the agent that caused them. Status changes are validated against an explicit transition
table: an IDEA cannot jump to TESTING, anything can be archived, and a COMPLETED task can
be reopened - because "done" is a claim that sometimes turns out to be false.

`current()` deliberately means *underway* (IN_PROGRESS, BLOCKED, TESTING), not merely
open. A READY task is a candidate to start, and that distinction is what makes handoff
say "Start TASK-3" rather than "Continue TASK-3".

**Sessions** store the outcome of a stretch of work, never the conversation (PRD 77):
agent, branch, start and end commit, a summary, what was completed, what remains, the
test result, and one recommended next step. Files changed are attributed automatically by
diffing against the commit the session started from. Only one session is open at a time;
starting a new one closes an abandoned predecessor so state never looks live when it is
not.

**Handoff** (PRD 32) is the payoff, and it reads only durable state:

```text
tasks ──┐
sessions├──► current task + remaining work
memory ─┤    last session summary + next step
git ────┘    decisions, constraints, known issues, recent changes
                              │
                    recommended next step
```

The recommendation follows a priority order: what the previous session said to do next,
then the first unfinished requirement of the current task, then the task itself, then
anything open at all, and finally an honest "no open tasks - ask the developer". Nothing
in the report comes from a conversation, which is precisely why a different agent can act
on it.

## Context cache and token analytics (PRD 25, 26, 51, 65)

Added in Step 10, in `index.db` beside the files it depends on.

```text
request ──► key = hash(task + options)
              │
              ├─ entry, every file hash matches ──────────► hit        (return as stored)
              ├─ entry, <= 3 files changed ───────────────► incremental (re-read only those)
              ├─ entry, a file is gone ───────────────────► miss
              └─ no entry ────────────────────────────────► miss        (assemble, store)
```

An entry stores the whole compact response plus the content hash of every file in it.
Validation compares those hashes against the *index*, not the disk - the cache is
consistent with what DevMemory knows, which is why `refresh_context` re-indexes first.

Hashes cannot detect a file that appeared or disappeared, and a new file may be one that
*should* have been selected. So a run that adds or deletes files clears the cache
outright, while modifications are handled by hash comparison. Entries are bounded per
project and evicted least-recently-used first.

Every request writes a row to `context_events` - outcome, tokens, files selected, files
avoided, duration. `analytics()` reads those rows, so the token claim in PRD 24 is
measured rather than asserted:

```text
requests 3   hit rate 67%   average 3,979 tokens   files avoided 182
```

## Security (PRD 20, 37, 38)

Completed in Step 11; the exclusion half has been in place since indexing existed.

**Sensitive files** are rejected before any read, independently of user ignore rules, so
relaxing the config cannot expose a private key.

**Secret detection** now runs during indexing: each file's content is checked against the
credential detectors, and what is recorded is the *detector name and where* - never the
secret. `security_status` and `devmemory status` report the affected files. Output is
redacted separately on the way out (diffs, context source slices, search snippets), so a
credential that slips into a file still cannot leave through an answer.

**Permissions** (PRD 38) are one policy point. Every tool declares a class, and
`PermissionEngine` decides allow / confirm / deny before dispatch:

| Class | Default | Meaning |
| --- | --- | --- |
| READ | allow | queries, search, context, recall |
| WRITE | allow | indexing, memory, tasks, sessions |
| EXECUTE | allow | reserved for test and build runs |
| DESTRUCTIVE | confirm | deleting a project's intelligence |

`security.permissions` in config overrides any of them; `WRITE: "deny"` makes the whole
server read-only. A denial cannot be argued out of with a confirmation - only a `confirm`
rule accepts one.

**Dangerous operations** are classified by `assessOperation`, which DevMemory exposes as
`check_operation` rather than executing anything itself. It flags unfiltered DELETE and
UPDATE, DROP, TRUNCATE, recursive and wildcard deletion, force pushes and history
rewrites as dangerous, treats migrations, deploys and package publishes as caution, and
escalates anything that names production. The rules are deliberately conservative: a
missed match costs a warning, a false positive costs the developer's trust in every
warning after it.

## Background daemon (PRD 56)

Added in Step 12, dependency-free: `fs.watch` with `recursive: true` is supported on
every platform DevMemory targets, so no watcher library is needed.

```text
file event ──► ignore/sensitive filter ──► debounce 300ms ──► batch
                                                                │
                    plain edits ────────────────────────────────┼──► index({ only: [...] })
                    deletion or branch switch ──────────────────┴──► index()  (full scan, not a rebuild)
                                                                │
                                                    invalidate the cached contexts
```

The filter matters as much as the watcher: a watcher receives bare directory events, so
`node_modules` arriving on its own must be ignored even though it is not a file path -
that is what `isIgnoredAnySegment` is for. Without it the daemon would re-index on every
`npm install`.

Deletions and branch switches fall back to a full *scan* rather than a single-file pass,
because a partial run has no way to notice something that is no longer there. A scan is
still hash-gated, so it re-reads nothing that did not change.

`DevMemoryDaemon` runs one watcher per active project, picks up projects connected after
it started, drops disconnected ones, and runs housekeeping on a timer (expiring stale
memories). `devmemory watch` runs it in the foreground; `devmemory daemon start` detaches
it and records the pid under `runtime/`.

## Web dashboard (PRD 41-54)

Added in Step 13: `node:http` plus one page. No framework, no bundler, no asset pipeline -
the UI is a string in `apps/dashboard/src/ui.ts`, so `pnpm build` remains `tsc -b` and the
page cannot drift from the server that serves it.

```text
browser ──► GET /            single-page UI
        ──► GET /api/*       JSON, straight off the DevMemory facade
```

Every route reads the same facade the MCP server and CLI use (PRD 41), which is what keeps
the three surfaces consistent. The API covers the dashboard sections the PRD asks for:
overview, projects, tasks, memory, changes, sessions, code graph, architecture, issues,
search, analytics and settings - with writes for re-indexing, memory and tasks, so the
dashboard can manage state and not merely display it (AC-17).

Two deliberate choices. It binds `127.0.0.1` and refuses any other address unless the
operator passes `--allow-remote` (PRD 42). And where the index and the manifests disagree -
a project full of `.ts` files with no tsconfig - the dashboard reports what the index
measured, not what a manifest claimed.

## Production hardening (PRD 59, 60, 64, 71, 72)

Step 14, and mostly a matter of proving what the earlier steps claimed.

**Recovery** (`RecoveryEngine`) checks the registry and every project database with
SQLite's own `quick_check`, looks for missing project roots, interrupted index runs and
storage directories belonging to no project, and reports each as a repairable or
unrepairable issue. `devmemory doctor --repair` acts on the repairable ones.

One rule governs every repair:

```text
index.db   derived from the filesystem  ──► delete and rebuild freely
memory.db  decisions, tasks, sessions   ──► never touched; reported for restore
```

A corrupt index is rebuilt without asking. A corrupt memory database is reported with an
explicit "cannot be regenerated", because nothing else in the world holds that content.

**Two real defects surfaced while building this step.** A corrupt database file stayed
*locked* on Windows: `new DatabaseSync()` succeeds on a junk file and the first PRAGMA
throws, leaking the handle, so the file could not even be deleted to repair it. Both the
driver and `DatabaseManager` now close a handle on any failure after opening.

And the acceptance suite caught a leak the redaction layer had missed: symbol
*signatures* are captured source text, so `const token = "ghp_..."` was stored verbatim
in `symbols.signature` and indexed into `symbol_search` - reachable through
`find_symbol`, `get_definition` and `get_context`. Signatures are now redacted before
they are persisted, which also keeps the value out of the search index. Output-time
redaction was never enough on its own; the fix had to be at the write.

**Performance** (PRD 59) is measured, not asserted, on 800 files / ~49k lines:

```text
full cold index      2519 ms      re-index, no changes    156 ms   (0 files parsed)
one file changed      203 ms      single-file pass        115 ms   (1 file parsed)
context cold           40 ms      context cached            1 ms
search                 27 ms      impact analysis (d3)      4 ms
```

The tests assert the *shape* of the work as well as the time: a no-change pass must
report zero parses, and a one-file change exactly one. That is what PRD 59 actually asks
for - a clock reading alone would not catch a regression that quietly re-parses
everything on a fast machine.

**Acceptance** (PRD 72) has its own suite: `tests/acceptance.test.ts` contains one test
per criterion, AC-01 to AC-18, including the two-agent handoff over the real MCP protocol
and the dashboard managing state rather than only displaying it.

**Cross-platform.** Everything platform-specific is behind `resolveHome()` and
`normalizePath()`; there are no native dependencies, and `fs.watch` recursive is supported
on all three targets. Windows is verified on real hardware, including 8.3 short paths and
file-locking behaviour. macOS and Linux are prepared for but not yet run.

## Seams for what comes next

| Next engine | Where it plugs in |
| --- | --- |
| More languages (Go, Rust, Java…) | One `LanguageParser` implementation plus an entry in `ParserRegistry`; grammars already ship in `@vscode/tree-sitter-wasm` |
| Cloud sync, multi-device (PRD 62-63) | Memory, tasks and sessions live in one `memory.db` per project - the natural sync unit; secrets are never in it |
| macOS / Linux verification | No native dependencies and no platform branches outside `resolveHome()` and `normalizePath()`; the suite should run as-is |
