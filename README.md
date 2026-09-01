# DevMemory MCP

**Persistent development intelligence for AI coding agents.** One global installation, any project, any MCP-compatible agent — and nothing written inside your project folder.

DevMemory identifies the project an agent is working in, keeps a durable index and history of it under your user profile, and exposes that knowledge over the Model Context Protocol so Claude Code, OpenCode and other agents can start productive instead of rediscovering the codebase.

---

## Status

This repository implements **all 14 steps** of the development order in the PRD, end to end and under test:

| Step | Area | State |
| --- | --- | --- |
| 1 | Monorepo, TypeScript, MCP server, CLI, config, logging, tests | Done |
| 2 | Project resolver — workspace detection, git root, repository identity, fingerprint, registry | Done |
| 3 | Storage — SQLite, migrations, projects, files, metadata | Done |
| 4 | Filesystem indexer — discovery, ignore rules, hashing, incremental indexing | Done |
| 5 | Git engine — status, diff, history, blame, change detection | Done |
| 6 | Code intelligence — tree-sitter symbols, imports, references, dependency graph | Done |
| 7 | Context engine — search, ranking, context selection, compression, token estimation | Done |
| 8 | Memory engine — facts, decisions, discoveries, bugs, constraints, history | Done |
| 9 | Tasks, sessions and agent handoff | Done |
| 10 | Context cache — context ids, hash invalidation, incremental context, token analytics | Done |
| 11 | Security — secret detection, redaction, permissions, dangerous-operation protection | Done |
| 12 | Background daemon — filesystem watcher, git watcher, background indexing | Done |
| 13 | Web dashboard — overview, projects, tasks, memory, changes, sessions, code, search, analytics | Done |
| 14 | Production hardening — recovery, performance, isolation, security and MCP verification | Done |

Security exclusions (PRD 20/37) were in from the first indexing commit, because indexing without them is not safe to ship; Step 11 completed the picture with a policy engine and operation classification.

306 tests pass across project resolution, isolation, indexing, parsing, the dependency graph, search, context assembly, caching, memory, tasks, sessions, handoff, the file watcher, the dashboard API, git, security policy, storage, recovery and the MCP protocol surface.

[`tests/acceptance.test.ts`](tests/acceptance.test.ts) has one test per acceptance criterion in PRD §72 — AC-01 through AC-18 — so "is it done?" is a question the test suite answers.

---

## Requirements

- **Node.js 24 or newer.** SQLite comes from Node's built-in `node:sqlite`, so there is no native build step and no compiler toolchain to install — but earlier versions either do not ship that module or keep it behind `--experimental-sqlite`.
- **git** on `PATH` (optional, but git projects get stronger identity and exact `.gitignore` handling).
- **pnpm** only for development (`corepack enable pnpm`).

---

## Install

```bash
npm install -g devmemory
devmemory init
```

Then connect a project:

```bash
cd D:/Projects/Wabmeta
devmemory connect
```

```text
Connected: wabmeta
  project_id  proj_e4eaa98550
  root        D:/Projects/Wabmeta
  identity    git_remote (git@github.com:acme/wabmeta.git)
  framework   Next.js, React
  languages   TypeScript
  git         main (clean)
  indexed     1284 files in 940ms (+1284 ~0 =0 -0)
```

Indexing this repository itself takes ~450ms for 82 files and produces ~580 symbols and 239 import edges. A `get_context` call against it — *"fix the ignore rules so node_modules never gets indexed"* — returns 12 ranked files in ~3,500 tokens and reports the 76 files it deliberately left out, with `ignore.ts` and the `DEFAULT_IGNORE_DIRS` config at the top.

Nothing was written into `D:/Projects/Wabmeta`. Everything lives under `%LOCALAPPDATA%\DevMemory`.

---

## Wiring it to an agent

Print the configuration for your client:

```bash
devmemory mcp-config --client claude
devmemory mcp-config --client opencode
```

**Claude Code**

```bash
claude mcp add devmemory --scope user -- devmemory-mcp
```

**OpenCode** (`opencode.json`)

```json
{
  "mcp": {
    "devmemory": {
      "type": "local",
      "command": ["devmemory-mcp"],
      "enabled": true
    }
  }
}
```

The server resolves the project from the client's workspace roots, falling back to its working directory — so the same registration works for every project without per-project setup.

---

## MCP tools

| Tool | Permission | Purpose |
| --- | --- | --- |
| `project_connect` | WRITE | Identify the workspace, register it, index it |
| `project_status` | READ | Identity, index health, file stats, git state |
| `project_map` | READ | Compact directory rollup, languages, entry points |
| `project_list` | READ | Every known project |
| `project_index` | WRITE | Incremental (or full) re-index |
| `project_forget` | DESTRUCTIVE | Delete a project's intelligence; requires `confirm: true` |
| `get_context` | READ | The smallest useful context for a task, ranked and fitted to a token budget |
| `search_context` | READ | Ranked full-text search across code and symbols |
| `refresh_context` | WRITE | Re-index what changed, then return fresh context |
| `remember` | WRITE | Store a decision, constraint, fact, discovery, bug or pattern |
| `recall` | READ | Retrieve project knowledge, ranked by relevance and importance |
| `forget` | DESTRUCTIVE | Archive a memory; hard deletion requires `confirm: true` |
| `task_create` | WRITE | Record work as a task with a requirement checklist |
| `task_update` | WRITE | Change status, tick requirements, record blockers |
| `task_status` | READ | The board, or one task with its timeline and sessions |
| `task_context` | READ | A task plus the ranked code context for it |
| `session_start` | WRITE | Open a work session (records branch and commit) |
| `session_end` | WRITE | Close it with a summary and the next step |
| `handoff` | READ | Everything another agent needs to continue this project |
| `check_operation` | READ | Classify a command or SQL statement before running it |
| `security_status` | READ | Policy in force, and files where credentials were detected |
| `find_symbol` | READ | Locate a function, class, method, interface, type, component, hook or route |
| `get_definition` | READ | Source of the best-matching definition, secrets redacted |
| `find_references` | READ | Every call, extend, implement, decorator or JSX use, grouped by file |
| `get_related_code` | READ | A file's symbols, imports, dependents and tests |
| `impact_analysis` | READ | What breaks if a file changes, plus its blast radius |
| `affected_tests` | READ | Tests reachable from a set of changed files |
| `find_file` | READ | Path search over the index |
| `recent_files` | READ | Most recently modified indexed files |
| `git_status` | READ | Branch, tracking state, changed files |
| `git_diff` | READ | Working/staged diff, secrets redacted |
| `git_history` | READ | Recent commits, optionally per file |
| `changes_since` | READ | Files and commits since a ref, including uncommitted work |

Responses are compact JSON — no verbose metadata (PRD 40).

---

## CLI

```text
devmemory init                 create global storage and config
devmemory connect [path]       identify and register a project
devmemory status [path]        identity, index health, git state
devmemory index [--full]       update the file index
devmemory context "<task>"     assemble the smallest useful context for a task
devmemory search "<query>"     search the project's code and symbols
devmemory remember --title T   store durable project knowledge
devmemory recall [query]       retrieve what DevMemory knows
devmemory forget-memory <id>   archive (or --hard delete) a memory
devmemory task-new "<title>"   create a task
devmemory tasks [task]         the board, or one task in detail
devmemory task-update <task>   move a task forward
devmemory sessions             recent AI sessions
devmemory handoff              what another agent needs to continue
devmemory analytics            cache hit rate, average context size, tokens saved
devmemory check "<operation>"  classify an operation before running it
devmemory watch [path]         keep the index current as files change (foreground)
devmemory daemon start|stop|status   run that watcher in the background
devmemory dashboard            start the local web dashboard
devmemory doctor [--repair]    health check, and fix what can be fixed
devmemory compact              reclaim space, checkpoint the WAL, vacuum
devmemory projects [--json]    list projects
devmemory disconnect <id>      mark inactive, keep data
devmemory forget <id> --yes    delete a project's intelligence
devmemory clean [--project]    purge deleted-file records, compact databases
devmemory stats                totals across all projects
devmemory doctor               subsystem health check
devmemory mcp-config           print MCP client configuration
devmemory where [project]      print storage locations
```

---

## Where data lives

```text
%LOCALAPPDATA%\DevMemory\          (Windows)
~/Library/Application Support/DevMemory/   (macOS)
~/.local/share/devmemory/          (Linux)

├── config.json
├── registry.db                 project registry
├── projects/
│   └── proj_<id>/
│       ├── index.db            files, symbols, imports, references, search, context cache
│       ├── memory.db           decisions, constraints, facts, bugs, tasks, sessions
│       ├── metadata.json       human-readable identity
│       ├── cache/
│       └── logs/
└── logs/
```

Override with `DEVMEMORY_HOME` (used by the test suite).

---

## Repository layout

```text
apps/
  mcp-server/     stdio MCP server
  cli/            devmemory command line
  dashboard/      local web dashboard (HTTP API + single-page UI)
packages/
  shared/         paths, config, types, ids, logging, token estimation
  storage/        SQLite driver interface, node:sqlite driver, migrations
  core/           git engine, project resolver, registry, code intelligence, DevMemory facade
  indexer/        ignore rules, walker, hashing, file store, secret detection,
                  tree-sitter parsers, symbol store, import resolution
  mcp/            tool definitions and MCP server construction
tests/            vitest suites
```

---

## Design decisions worth knowing

**Identity, not path.** A project is identified by its git remote, then its root commit, then a content fingerprint, and only then by path. Move a project from `D:/Projects/App` to `E:/Work/App` and it keeps its `project_id`, its index and its history.

**Git enumerates, DevMemory indexes.** In a repository, `git ls-files --cached --others --exclude-standard` produces the candidate list, so `.gitignore` semantics are exactly git's. Non-git projects fall back to a walker with a gitignore-compatible matcher.

**Hash-gated incremental indexing.** Unchanged size and mtime skips the file entirely; otherwise the content hash decides. Re-indexing a 1,200-file project with no changes reads no file contents — and re-parses nothing.

**Tree-sitter as WebAssembly.** Grammars come from `@vscode/tree-sitter-wasm` and run through `web-tree-sitter`, so code intelligence still needs no compiler. A grammar that fails to load degrades to "no symbols for that language" instead of failing the run.

**Symbols, not tokens.** The parsers record top-level declarations and class members only — a `const` inside a callback is implementation detail, not API. That distinction is what keeps 82 files at ~500 meaningful symbols rather than several thousand noisy ones.

**Search without a second copy of your code.** The FTS5 tables are contentless: terms are indexed, the source text is not duplicated into the database, and snippets are read from the file on demand so they can never be stale. Identifiers are indexed split as well as whole, which is why "verify payment" finds `verifyPayment`.

**Context is ranked, not dumped.** `get_context` seeds from explicit paths, symbol matches, full-text hits and recent git changes, expands one hop along the dependency graph, scores each candidate (PRD 23), then fills a token budget greedily — structure first, source only when the task calls for it. It reports what it left out, so the saving is visible rather than claimed.

**Memory has a quality bar.** `remember` defaults importance by kind (DECISION 0.9, CONSTRAINT 0.85, FACT 0.5, HISTORY 0.3), expires low-value kinds automatically, refuses content too thin to be worth storing, and reinforces an identical memory rather than writing a second row. Recall ranks by relevance *and* importance, so what surfaces first is what a future session actually needs. Memory lives in its own database, so re-indexing — or losing the index entirely — never loses knowledge.

**Handoff is built from durable state, never a conversation.** `handoff` assembles the current task and what remains of it, the last session's summary and next step, the decisions and constraints that bind you, known issues (BUG memories and blocked tasks), and recent changes — all from tasks, sessions, memory and git. That is what lets Claude Code stop and OpenCode continue without the developer re-explaining anything (PRD §32, §77).

**The cache is honest about staleness.** A cached context stores the content hash of every file it contains. On the next request those hashes are compared against the index: all match and the answer is returned as-is; a few moved and only those files are re-read (incremental context); a file appeared or vanished and the whole answer is rebuilt, because no hash can tell you about a file that *should* have been selected. Every request is logged, so `devmemory analytics` reports the real hit rate and token saving rather than a claim.

**One policy point for dangerous work.** Every MCP tool declares an operation class (READ / WRITE / EXECUTE / DESTRUCTIVE) and the server checks it in one place before dispatch. The default policy allows read, write and execute and requires explicit confirmation for destruction; setting `WRITE: "deny"` in config turns the whole server read-only. Separately, `check_operation` classifies a command or SQL statement an agent is about to run — unfiltered `DELETE`, `DROP TABLE`, `rm -rf`, force pushes, migrations and deploys — and escalates anything aimed at production.

**The watcher never rebuilds.** A saved file becomes a single-file index pass; a deletion or branch switch falls back to a full *scan* (not a rebuild) because those are the only changes a scan can see. Ignored and sensitive paths never wake the indexer at all, and every re-index invalidates exactly the cached contexts that contained the changed files.

**The dashboard has no build step.** It is `node:http` plus one dependency-free page — no framework, no bundler. `pnpm build` stays `tsc -b`, and the UI cannot rot separately from the server that serves it. It binds loopback and refuses any other address unless you pass `--allow-remote`.

**The index is disposable; memory is not.** That single rule shapes every repair. A corrupt `index.db` is deleted and rebuilt from the filesystem without asking, because nothing in it is unique. A corrupt `memory.db` is reported and left alone, because the decisions, tasks and sessions in it exist nowhere else. `devmemory doctor --repair` never crosses that line.

**Monorepo imports are internal.** Workspace packages are discovered from `pnpm-workspace.yaml` and `package.json` workspaces, so `@acme/core` resolves to `packages/core/src/index.ts`. Without it, impact analysis would stop at every package boundary — in exactly the repositories that need it most.

**Sensitive files are excluded unconditionally.** `.env*`, keys, credentials and `.ssh`-style directories are rejected before any read, independently of user ignore rules — relaxing the config cannot expose them. Diffs are secret-redacted on the way out.

**No native dependencies.** `node:sqlite` (with FTS5) means installing DevMemory never invokes a compiler. The `SqliteDriver` interface keeps better-sqlite3 or libsql available as drop-in alternatives.

**Never the home directory.** An inferred project root that lands on your home directory or a drive root is refused rather than indexed.

---

## Performance

Measured by [`tests/performance.test.ts`](tests/performance.test.ts) on a synthetic project of **800 files / ~49,000 lines** (Windows 11, Node 24):

| Operation | Time |
| --- | --- |
| Full cold index (walk, hash, parse, resolve, search index) | 2,519 ms |
| Re-index with no changes | 156 ms |
| Re-index after one file changed | 203 ms |
| Single-file pass (what the watcher does) | 115 ms |
| Context assembly, cold | 40 ms |
| Context assembly, cached | 1 ms |
| Full-text search | 27 ms |
| Impact analysis, depth 3 | 4 ms |

The number that matters most is not the clock but the work avoided: a no-change pass re-reads and re-parses **zero** files, and a one-file change parses exactly one.

## Platform support

| Platform | State |
| --- | --- |
| Windows 11 | Developed and tested here — 8.3 short paths, `fs.watch`, file locking all handled |
| macOS / Linux | No native dependencies, `fs.watch` recursive is supported on both, and paths are canonicalised everywhere. Verified by CI on every push; not yet used in anger. |

Everything platform-specific lives behind `resolveHome()` and `normalizePath()`.

## Development

```bash
git clone https://github.com/wabmetacontact-svg/devmemory.git
cd devmemory
pnpm install

pnpm build          # tsc -b across the workspace
pnpm typecheck
pnpm test           # vitest, runs against TypeScript sources
```

Running from a checkout instead of an install: `node apps/cli/dist/bin.js <command>`.

Tests use an isolated `DEVMEMORY_HOME` per test and create throwaway git repositories, so they never touch your real DevMemory data.

---

## Roadmap

The PRD's development order is complete. What remains is its optional Phase 5: cloud sync, multi-device access and team workspaces (PRD §62–63, §70) — opt-in by design, and deliberately not built into a local-first v1.

## License

MIT
