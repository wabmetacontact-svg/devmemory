#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Command } from "commander";
import {
  defaultConfig,
  ensureHome,
  homeLayout,
  loadConfig,
  projectLayout,
  saveConfig,
  requireSupportedRuntime,
  toDevMemoryError,
} from "@samirthakur024/shared";
import type { ProjectRecord } from "@samirthakur024/shared";
import {
  DevMemory,
  DevMemoryDaemon,
  callersOf,
  assessOperation,
  clearDaemonRecord,
  isProcessAlive,
  readDaemonRecord,
  writeDaemonRecord,
} from "@samirthakur024/core";
import type { MemoryType, TaskPriority, TaskStatus } from "@samirthakur024/core";
import { ALL_TOOLS } from "@samirthakur024/mcp";
import { startDashboard } from "@samirthakur024/dashboard";

requireSupportedRuntime();

/**
 * Read from the manifest rather than typed here: the constant said 0.1.0 while the
 * published package was 0.1.1, so `devmemory --version` reported a release that
 * did not exist. A hardcoded version only ever drifts in the direction of a lie.
 */
const VERSION: string = readVersion();

function readVersion(): string {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return String(JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function open(): DevMemory {
  return new DevMemory();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Wraps an argument in quotes only when it contains something a shell would split. */
function quoteIfNeeded(value: string): string {
  return /[\s"]/.test(value) ? `"${value}"` : value;
}

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function printProjectLine(project: ProjectRecord): void {
  const framework = project.framework ? ` [${project.framework}]` : "";
  print(`  ${project.projectId}  ${project.name}${framework}`);
  print(`      ${project.rootPath}`);
  print(`      status=${project.status} index=${project.indexStatus} identity=${project.identitySource}`);
}

function fail(error: unknown): never {
  const devMemoryError = toDevMemoryError(error);
  process.stderr.write(`error [${devMemoryError.code}]: ${devMemoryError.message}\n`);
  process.exit(1);
}

const program = new Command();
program.name("devmemory").description("DevMemory - persistent development intelligence for AI coding agents").version(VERSION);

program
  .command("init")
  .description("Create the global DevMemory storage and default configuration")
  .action(() => {
    try {
      const layout = ensureHome();
      if (!fs.existsSync(layout.configFile)) saveConfig(defaultConfig());
      const devmemory = open();
      devmemory.databases.openRegistry();
      devmemory.close();

      print("DevMemory initialised.");
      print(`  home      ${layout.root}`);
      print(`  config    ${layout.configFile}`);
      print(`  registry  ${layout.registryDb}`);
      print("");
      print("Next: cd into a project and run 'devmemory connect'.");
    } catch (error) {
      fail(error);
    }
  });

program
  .command("connect")
  .argument("[path]", "project directory (defaults to the current directory)")
  .option("--no-index", "register the project without indexing it")
  .option("--full", "force a full re-index")
  .description("Identify and register the project in this directory")
  .action(async (target: string | undefined, options: { index?: boolean; full?: boolean }) => {
    const devmemory = open();
    try {
      const result = await devmemory.connect({
        ...(target ? { explicitRoot: path.resolve(target) } : {}),
        cwd: process.cwd(),
        index: options.index !== false,
        full: options.full === true,
      });

      print(`${result.reconnected ? "Reconnected" : "Connected"}: ${result.project.name}`);
      print(`  project_id  ${result.project.projectId}`);
      print(`  root        ${result.project.rootPath}`);
      print(`  identity    ${result.project.identitySource}${result.project.repositoryUrl ? ` (${result.project.repositoryUrl})` : ""}`);
      if (result.movedFrom) print(`  moved from  ${result.movedFrom}`);
      if (result.detection.framework) print(`  framework   ${result.detection.frameworks.join(", ")}`);
      if (result.detection.languages.length) print(`  languages   ${result.detection.languages.join(", ")}`);
      if (result.git) print(`  git         ${result.git.branch ?? "detached"}${result.git.clean ? " (clean)" : ` (${result.git.changedFiles} changed)`}`);
      if (result.index) {
        print(
          `  indexed     ${result.index.scanned} files in ${result.index.durationMs}ms ` +
            `(+${result.index.added} ~${result.index.updated} =${result.index.unchanged} -${result.index.deleted})`,
        );
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("projects")
  .option("--json", "machine readable output")
  .description("List every project DevMemory knows about")
  .action((options: { json?: boolean }) => {
    const devmemory = open();
    try {
      const projects = devmemory.listProjects();
      if (options.json) {
        print(JSON.stringify(projects, null, 2));
        return;
      }
      if (projects.length === 0) {
        print("No projects connected yet. Run 'devmemory connect' inside a project.");
        return;
      }
      print(`Projects (${projects.length}):`);
      for (const project of projects) printProjectLine(project);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("status")
  .argument("[path]", "project directory (defaults to the current directory)")
  .option("--project <id>", "explicit project id")
  .option("--json", "machine readable output")
  .description("Show project identity, index health and git state")
  .action(async (target: string | undefined, options: { project?: string; json?: boolean }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({
        ...(options.project ? { projectId: options.project } : {}),
        ...(target ? { explicitRoot: path.resolve(target) } : {}),
        cwd: process.cwd(),
        autoConnect: false,
      });
      const status = devmemory.status(project.projectId);

      if (options.json) {
        print(JSON.stringify(status, null, 2));
        return;
      }

      print(`${status.project.name}  (${status.project.projectId})`);
      print(`  root        ${status.project.rootPath}`);
      print(`  framework   ${status.project.framework ?? "-"}`);
      print(`  languages   ${status.project.languages.join(", ") || "-"}`);
      print(`  files       ${status.files.files} (${formatBytes(status.files.bytes)})`);
      const top = status.files.byLanguage.slice(0, 5).map((entry) => `${entry.language}:${entry.files}`).join("  ");
      if (top) print(`  by language ${top}`);
      print(`  symbols     ${status.code.symbols} in ${status.code.filesParsed} parsed files`);
      const symbolTypes = status.code.byType.slice(0, 5).map((entry) => `${entry.type}:${entry.count}`).join("  ");
      if (symbolTypes) print(`  by kind     ${symbolTypes}`);
      print(`  imports     ${status.code.imports} (${status.code.internalEdges} internal, ${status.code.externalPackages} packages)`);
      print(`  tasks       ${status.tasks.open} open of ${status.tasks.total}${status.tasks.blocked > 0 ? `, ${status.tasks.blocked} blocked` : ""}`);
      print(`  sessions    ${status.sessions.total} recorded`);
      print(`  memories    ${status.memory.active} active (${status.memory.byType.slice(0, 4).map((entry) => `${entry.type.toLowerCase()}:${entry.count}`).join(" ")})`);
      print(`  index       ${status.index.status}${status.index.incomplete ? " (incomplete run detected)" : ""}`);
      print(`  indexed at  ${status.index.lastIndexedAt ?? "never"}`);
      if (status.git) {
        print(`  branch      ${status.git.branch ?? "detached"}`);
        print(`  worktree    ${status.git.clean ? "clean" : `${status.git.changedFiles} changed files`}`);
      }
      print(`  context     ${status.context.requests} requests, ${(status.context.hitRate * 100).toFixed(0)}% cache hits, ~${status.context.averageTokens} tokens each`);
      if (status.security.files > 0) print(`  secrets     ${status.security.files} file(s) contain credential patterns`);
      print(`  storage     ${status.storagePath}`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("index")
  .argument("[path]", "project directory (defaults to the current directory)")
  .option("--project <id>", "explicit project id")
  .option("--full", "rebuild the index from scratch")
  .description("Update the file index (incremental by default)")
  .action(async (target: string | undefined, options: { project?: string; full?: boolean }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({
        ...(options.project ? { projectId: options.project } : {}),
        ...(target ? { explicitRoot: path.resolve(target) } : {}),
        cwd: process.cwd(),
      });
      const stats = await devmemory.index(project.projectId, { full: options.full === true });

      print(`Indexed ${project.name} in ${stats.durationMs}ms`);
      print(`  scanned   ${stats.scanned}`);
      print(`  added     ${stats.added}`);
      print(`  updated   ${stats.updated}`);
      print(`  unchanged ${stats.unchanged}`);
      print(`  deleted   ${stats.deleted}`);
      print(`  skipped   ${stats.skipped}`);
      print(`  parsed    ${stats.parsed} files -> ${stats.symbols} symbols${stats.parseErrors > 0 ? ` (${stats.parseErrors} with syntax errors)` : ""}`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("disconnect")
  .argument("<project>", "project id")
  .description("Mark a project inactive without deleting its intelligence")
  .action((projectId: string) => {
    const devmemory = open();
    try {
      const project = devmemory.disconnect(projectId);
      print(`Disconnected ${project.name} (${project.projectId}). Its data is kept.`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("forget")
  .argument("<project>", "project id")
  .requiredOption("--yes", "confirm permanent deletion of this project's intelligence")
  .description("Permanently delete a project's DevMemory data (never touches project files)")
  .action((projectId: string) => {
    const devmemory = open();
    try {
      const project = devmemory.registry.get(projectId);
      if (!project) fail(new Error(`unknown project: ${projectId}`));
      devmemory.remove(projectId);
      print(`Removed ${project?.name} (${projectId}). Project files were not touched.`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("clean")
  .option("--project <id>", "only clean this project")
  .description("Drop records for deleted files and compact the databases")
  .action((options: { project?: string }) => {
    const devmemory = open();
    try {
      const projects = options.project
        ? [devmemory.registry.get(options.project)].filter((project): project is ProjectRecord => project !== null)
        : devmemory.listProjects();

      for (const project of projects) {
        const purged = devmemory.filesFor(project.projectId).purgeDeleted(project.projectId);
        const db = devmemory.databases.openProjectIndex(project.projectId);
        db.exec("VACUUM");
        print(`${project.name}: purged ${purged} deleted file records`);
      }
      print("Done.");
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("stats")
  .description("Show storage and index totals across all projects")
  .action(() => {
    const devmemory = open();
    try {
      const projects = devmemory.listProjects();
      let files = 0;
      let bytes = 0;
      let symbols = 0;
      let memories = 0;
      for (const project of projects) {
        const stats = devmemory.filesFor(project.projectId).stats(project.projectId);
        files += stats.files;
        bytes += stats.bytes;
        symbols += devmemory.codeFor(project.projectId).stats(project.projectId).symbols;
        memories += devmemory.memoryFor(project.projectId).stats().active;
      }

      const layout = homeLayout();
      print("DevMemory");
      print(`  home           ${layout.root}`);
      print(`  projects       ${projects.length}`);
      print(`  indexed files  ${files}`);
      print(`  symbols        ${symbols}`);
      print(`  memories       ${memories}`);
      print(`  indexed bytes  ${formatBytes(bytes)}`);
      print(`  mcp tools      ${ALL_TOOLS.length}`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("doctor")
  .option("--json", "machine readable output")
  .option("--repair", "fix what can be fixed automatically")
  .option("--remove-orphans", "also delete storage belonging to no registered project")
  .description("Check that every DevMemory subsystem is healthy, and optionally repair it")
  .action((options: { json?: boolean; repair?: boolean; removeOrphans?: boolean }) => {
    const devmemory = open();
    try {
      const recovery = devmemory.recovery();
      const repair = options.repair
        ? recovery.repair({ rebuildIndex: true, removeOrphans: options.removeOrphans === true })
        : null;
      const report = recovery.check();

      if (options.json) {
        print(JSON.stringify({ report, repair }, null, 2));
        if (!report.healthy) process.exitCode = 1;
        return;
      }

      print("DevMemory doctor");
      print(`  home      ${report.home}`);
      print(`  platform  ${report.platform.os} · node ${report.platform.node} · ${report.platform.driver}`);
      print("");

      for (const check of report.checks) {
        print(`  ${check.ok ? "OK  " : "FAIL"}  ${check.name.padEnd(18)} ${check.detail}`);
      }

      const config = loadConfig();
      const policy = devmemory.permissions.describe();
      print(`  ${config.security.blockSensitiveFiles ? "OK  " : "FAIL"}  ${"security".padEnd(18)} sensitive files ${config.security.blockSensitiveFiles ? "blocked" : "NOT blocked"}, secrets ${config.security.redactSecrets ? "redacted" : "NOT redacted"}`);
      print(`  ${policy.DESTRUCTIVE === "allow" ? "WARN" : "OK  "}  ${"permissions".padEnd(18)} read=${policy.READ} write=${policy.WRITE} destructive=${policy.DESTRUCTIVE}`);
      print(`  OK    ${"mcp".padEnd(18)} ${ALL_TOOLS.length} tools registered`);

      if (repair && repair.actions.length > 0) {
        print("");
        print("Repaired:");
        for (const action of repair.actions) {
          print(`  - ${action.detail}${action.projectId ? ` (${action.projectId})` : ""}`);
        }
      }

      if (report.issues.length > 0) {
        print("");
        print("Issues:");
        for (const issue of report.issues) {
          const label = issue.severity === "error" ? "error" : "warn ";
          const hint = issue.repairable && !options.repair ? "  (fixable with --repair)" : "";
          print(`  ${label}  ${issue.message}${hint}`);
        }
      }

      print("");
      print(report.healthy ? "All checks passed." : "Attention needed - see the issues above.");
      if (!report.healthy) process.exitCode = 1;
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("compact")
  .argument("[path]", "project directory (defaults to the current directory)")
  .description("Reclaim space: purge deleted-file records, checkpoint the WAL and vacuum")
  .action(async (target: string | undefined) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({
        ...(target ? { explicitRoot: path.resolve(target) } : {}),
        cwd: process.cwd(),
        autoConnect: false,
      });
      const result = devmemory.recovery().compact(project.projectId);
      print(`Compacted ${project.name}: purged ${result.purgedFiles} deleted file records.`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("context")
  .argument("<task...>", "what you are about to do")
  .option("--tokens <n>", "token budget", "6000")
  .option("--depth <n>", "dependency graph expansion depth", "1")
  .option("--source", "include source slices, not just structure")
  .option("--workspace <name>", "assemble across every project in this workspace")
  .option("--json", "machine readable output")
  .description("Assemble the smallest useful context for a task")
  .action(async (taskParts: string[], options: { tokens: string; depth: string; source?: boolean; workspace?: string; json?: boolean }) => {
    const devmemory = open();
    try {
      if (options.workspace) {
        const across = devmemory.workspaceContext(options.workspace, {
          task: taskParts.join(" "),
          maxTokens: Number(options.tokens),
          depth: Number(options.depth),
          includeSource: options.source === true,
        });

        if (options.json) {
          print(JSON.stringify(across, null, 2));
          return;
        }

        print(`Context for: ${across.task}`);
        print(`  workspace   ${across.workspace}  (${across.projects.length} projects)`);
        print(`  tokens      ~${across.tokenEstimate} of ${across.budget} budget`);
        print(`  files       ${across.filesSelected} selected, ${across.filesAvoided} avoided`);
        for (const entry of across.projects) {
          print("");
          print(`  ${entry.name}${entry.role ? " (" + entry.role + ")" : ""}  -  ${entry.filesSelected} files, ~${entry.tokenEstimate} tokens`);
          for (const file of entry.files.slice(0, 6)) {
            print(`    ${file.relevance.toFixed(2)}  ${file.path}`);
          }
        }
        return;
      }

      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const result = devmemory.contextEngine(project.projectId).getContext({
        task: taskParts.join(" "),
        maxTokens: Number(options.tokens),
        depth: Number(options.depth),
        includeSource: options.source === true,
      });

      if (options.json) {
        print(JSON.stringify(result, null, 2));
        return;
      }

      print(`Context for: ${result.task}`);
      print(`  intent      ${result.intent}`);
      print(`  project     ${result.project.name}${result.project.branch ? ` (${result.project.branch})` : ""}`);
      print(`  tokens      ~${result.tokenEstimate} of ${result.budget} budget`);
      print(`  files       ${result.filesSelected} selected of ${result.filesConsidered} considered, ${result.filesAvoided} avoided`);
      print("");
      for (const file of result.files) {
        print(`  ${file.relevance.toFixed(2)}  ${file.path}`);
        print(`        ${file.reasons.join("; ")}`);
        const names = file.symbols.slice(0, 5).map((symbol) => `${symbol.name}:${symbol.type}`).join(", ");
        if (names) print(`        ${names}`);
      }
      if (result.memories.length > 0) {
        print("");
        print("  project memory:");
        for (const memory of result.memories) print(`    [${memory.type}] ${memory.title}`);
      }
      if (result.recentChanges.length > 0) {
        print("");
        print(`  recent changes: ${result.recentChanges.slice(0, 5).join(", ")}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("search")
  .argument("<query...>", "what to look for")
  .option("--limit <n>", "maximum results", "15")
  .option("--workspace <name>", "search every project in this workspace")
  .option("--json", "machine readable output")
  .description("Search the project's code and symbols")
  .action(async (queryParts: string[], options: { limit: string; workspace?: string; json?: boolean }) => {
    const devmemory = open();
    try {
      if (options.workspace) {
        const across = devmemory.workspaceSearch(options.workspace, queryParts.join(" "), Number(options.limit));
        if (options.json) {
          print(JSON.stringify(across, null, 2));
          return;
        }
        for (const result of across) {
          const label = result.symbol ? `${result.symbol.name} (${result.symbol.type})` : result.path;
          print(`  ${result.relevance.toFixed(2)}  [${result.project}]  ${label}`);
          print(`        ${result.path}${result.symbol ? ":" + result.symbol.lines[0] : ""}`);
        }
        if (across.length === 0) print("No matches.");
        return;
      }

      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const results = devmemory
        .contextEngine(project.projectId)
        .searchContext(queryParts.join(" "), Number(options.limit));

      if (options.json) {
        print(JSON.stringify(results, null, 2));
        return;
      }
      if (results.length === 0) {
        print("No matches.");
        return;
      }
      for (const result of results) {
        const label = result.symbol ? `${result.symbol.name} (${result.symbol.type})` : result.path;
        print(`  ${result.relevance.toFixed(2)}  ${label}`);
        if (result.symbol) print(`        ${result.path}:${result.symbol.lines[0]}`);
        else if (result.snippet) print(`        :${result.snippet.line}  ${result.snippet.text}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("remember")
  .argument("<content...>", "what to remember")
  .requiredOption("--title <title>", "short title for the memory")
  .option("--type <type>", "FACT | DECISION | DISCOVERY | BUG | PATTERN | CONSTRAINT | HISTORY", "FACT")
  .option("--importance <n>", "0-1; defaults by type")
  .option("--tags <tags>", "comma separated")
  .option("--paths <paths>", "comma separated project-relative files")
  .option("--reason <reason>", "for a DECISION: why")
  .option("--branch", "scope this memory to the current branch")
  .description("Store durable project knowledge")
  .action(async (contentParts: string[], options: Record<string, string | boolean | undefined>) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const result = devmemory.memoryFor(project.projectId).remember({
        type: String(options.type).toUpperCase() as MemoryType,
        title: String(options.title),
        content: contentParts.join(" "),
        ...(options.importance ? { importance: Number(options.importance) } : {}),
        ...(options.tags ? { tags: String(options.tags).split(",").map((tag) => tag.trim()) } : {}),
        ...(options.paths ? { paths: String(options.paths).split(",").map((entry) => entry.trim()) } : {}),
        ...(options.reason ? { decision: { reason: String(options.reason) } } : {}),
        ...(options.branch === true ? { branchSpecific: true } : {}),
        source: "cli",
      });

      print(`${result.deduplicated ? "Reinforced" : "Remembered"} ${result.memory.id}  [${result.memory.type}]`);
      print(`  ${result.memory.title}`);
      print(`  importance ${result.memory.importance}${result.memory.branch ? `  branch ${result.memory.branch}` : ""}`);
      if (result.memory.expiresAt) print(`  expires    ${result.memory.expiresAt}`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("recall")
  .argument("[query...]", "what you want to know")
  .option("--type <type>", "restrict to one memory type")
  .option("--limit <n>", "maximum results", "10")
  .option("--json", "machine readable output")
  .description("Retrieve project knowledge, ranked by relevance and importance")
  .action(async (queryParts: string[], options: { type?: string; limit: string; json?: boolean }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const memories = devmemory.memoryFor(project.projectId).recall({
        ...(queryParts.length > 0 ? { query: queryParts.join(" ") } : {}),
        ...(options.type ? { type: options.type.toUpperCase() as MemoryType } : {}),
        limit: Number(options.limit),
      });

      if (options.json) {
        print(JSON.stringify(memories, null, 2));
        return;
      }
      if (memories.length === 0) {
        print("Nothing remembered yet. Use 'devmemory remember' or the remember MCP tool.");
        return;
      }
      for (const memory of memories) {
        print(`  ${memory.score.toFixed(2)}  [${memory.type}] ${memory.title}  (${memory.id})`);
        print(`        ${memory.content.replace(/\s+/g, " ").slice(0, 160)}`);
        if (memory.decision?.reason) print(`        reason: ${memory.decision.reason.slice(0, 140)}`);
        if (memory.paths.length > 0) print(`        files: ${memory.paths.join(", ")}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("forget-memory")
  .argument("<id>", "memory id")
  .option("--hard", "delete permanently instead of archiving")
  .description("Archive (or delete) a memory")
  .action(async (id: string, options: { hard?: boolean }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const result = devmemory.memoryFor(project.projectId).forget(id, { hard: options.hard === true });
      print(result.removed ? `Deleted ${id}.` : `Archived ${id}. It no longer appears in recall.`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("task-new")
  .argument("<title...>", "task title")
  .option("--requirements <items>", "comma separated checklist")
  .option("--status <status>", "IDEA | PLANNING | READY | IN_PROGRESS | BLOCKED | TESTING | COMPLETED")
  .option("--priority <priority>", "low | normal | high | critical")
  .option("--areas <areas>", "comma separated affected areas")
  .description("Create a task")
  .action(async (titleParts: string[], options: Record<string, string | undefined>) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const task = devmemory.tasksFor(project.projectId).create({
        title: titleParts.join(" "),
        ...(options.requirements ? { requirements: splitList(options.requirements) } : {}),
        ...(options.status ? { status: options.status.toUpperCase() as TaskStatus } : {}),
        ...(options.priority ? { priority: options.priority as TaskPriority } : {}),
        ...(options.areas ? { areas: splitList(options.areas) } : {}),
        agent: "cli",
      });

      print(`${task.key}  ${task.title}  [${task.status}]`);
      for (const requirement of task.requirements) print(`   [ ] ${requirement.text}`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("tasks")
  .argument("[task]", "task key or id for detail")
  .option("--all", "include completed and archived tasks")
  .option("--json", "machine readable output")
  .description("Show the project's work in flight")
  .action(async (target: string | undefined, options: { all?: boolean; json?: boolean }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const tasks = devmemory.tasksFor(project.projectId);

      if (target) {
        const task = tasks.require(target);
        if (options.json) {
          print(JSON.stringify(task, null, 2));
          return;
        }
        print(`${task.key}  ${task.title}`);
        print(`  status     ${task.status}${task.blockedReason ? `  (${task.blockedReason})` : ""}`);
        print(`  progress   ${task.progress.done}/${task.progress.total} (${task.progress.percent}%)`);
        if (task.description) print(`  ${task.description}`);
        for (const requirement of task.requirements) print(`   [${requirement.done ? "x" : " "}] ${requirement.text}`);
        if (task.paths.length > 0) print(`  files      ${task.paths.join(", ")}`);
        print("");
        for (const event of tasks.events(task.id, 8)) {
          print(`  ${event.at.slice(0, 19)}  ${event.event}${event.detail ? `  ${event.detail}` : ""}`);
        }
        return;
      }

      const list = options.all ? tasks.list({ limit: 50 }) : tasks.list({ open: true, limit: 50 });
      if (options.json) {
        print(JSON.stringify(list, null, 2));
        return;
      }
      if (list.length === 0) {
        print("No tasks yet. Create one with 'devmemory task-new'.");
        return;
      }
      for (const task of list) {
        print(`  ${task.key.padEnd(8)} ${task.status.padEnd(12)} ${task.progress.done}/${task.progress.total}  ${task.title}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("task-update")
  .argument("<task>", "task key or id")
  .option("--status <status>", "new status")
  .option("--done <items>", "comma separated requirement texts to tick off")
  .option("--add <items>", "comma separated requirements to add")
  .option("--blocked <reason>", "mark blocked with a reason")
  .option("--note <note>", "add a line to the task timeline")
  .description("Move a task forward")
  .action(async (target: string, options: Record<string, string | undefined>) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const task = devmemory.tasksFor(project.projectId).update(target, {
        ...(options.status ? { status: options.status.toUpperCase() as TaskStatus } : {}),
        ...(options.blocked ? { status: "BLOCKED" as TaskStatus, blockedReason: options.blocked } : {}),
        ...(options.done ? { completeRequirements: splitList(options.done) } : {}),
        ...(options.add ? { addRequirements: splitList(options.add) } : {}),
        ...(options.note ? { note: options.note } : {}),
        agent: "cli",
      });

      print(`${task.key}  ${task.status}  ${task.progress.done}/${task.progress.total} (${task.progress.percent}%)`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("sessions")
  .option("--limit <n>", "how many to show", "10")
  .description("Show recent AI sessions")
  .action(async (options: { limit: string }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const sessions = devmemory.sessionsFor(project.projectId).list(Number(options.limit));

      if (sessions.length === 0) {
        print("No sessions recorded yet.");
        return;
      }
      for (const session of sessions) {
        print(`  ${session.startedAt.slice(0, 19)}  ${session.agent}  ${session.status}`);
        if (session.summary) print(`        ${session.summary.slice(0, 140)}`);
        if (session.nextStep) print(`        next: ${session.nextStep.slice(0, 140)}`);
        if (session.filesChanged.length > 0) print(`        files: ${session.filesChanged.length}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("handoff")
  .option("--json", "machine readable output")
  .description("Everything another agent needs to continue this project")
  .action(async (options: { json?: boolean }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const report = devmemory.handoff(project.projectId);

      if (options.json) {
        print(JSON.stringify(report, null, 2));
        return;
      }

      print(`${report.project.name}${report.project.branch ? `  (${report.project.branch})` : ""}`);
      print("");
      if (report.currentTask) {
        print(`Current task: ${report.currentTask.key} - ${report.currentTask.title}  [${report.currentTask.status}]`);
        print(`  progress ${report.currentTask.progress.done}/${report.currentTask.progress.total}`);
        for (const remaining of report.currentTask.remaining) print(`   [ ] ${remaining}`);
      } else {
        print("Current task: none");
      }

      if (report.lastSession) {
        print("");
        print(`Last session: ${report.lastSession.agent}${report.lastSession.endedAt ? ` (${report.lastSession.endedAt.slice(0, 19)})` : ""}`);
        if (report.lastSession.summary) print(`  ${report.lastSession.summary}`);
        for (const done of report.lastSession.completed) print(`   done: ${done}`);
        for (const left of report.lastSession.remaining) print(`   left: ${left}`);
      }

      if (report.decisions.length > 0) {
        print("");
        print("Decisions:");
        for (const decision of report.decisions) print(`  - ${decision.title}${decision.reason ? ` (${decision.reason})` : ""}`);
      }
      if (report.constraints.length > 0) {
        print("");
        print("Constraints:");
        for (const constraint of report.constraints) print(`  - ${constraint.title}`);
      }
      if (report.knownIssues.length > 0) {
        print("");
        print("Known issues:");
        for (const issue of report.knownIssues) print(`  - ${issue.title}`);
      }
      if (report.recentChanges.length > 0) {
        print("");
        print(`Recent changes: ${report.recentChanges.slice(0, 8).join(", ")}`);
      }

      print("");
      print(`Next step: ${report.recommendedNextStep}`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("analytics")
  .option("--json", "machine readable output")
  .description("Token analytics: cache hit rate, average context size, files avoided")
  .action(async (options: { json?: boolean }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const analytics = devmemory.contextCacheFor(project.projectId).analytics();

      if (options.json) {
        print(JSON.stringify(analytics, null, 2));
        return;
      }

      print(`Context analytics for ${project.name}`);
      print(`  requests           ${analytics.requests}`);
      print(`  cache hit rate     ${(analytics.hitRate * 100).toFixed(0)}%  (${analytics.hits} hits, ${analytics.incremental} incremental, ${analytics.misses} misses)`);
      print(`  average context    ${analytics.averageTokens} tokens`);
      print(`  files retrieved    ${analytics.filesRetrieved}`);
      print(`  files avoided      ${analytics.filesAvoided}`);
      print(`  tokens saved       ~${analytics.estimatedTokensSaved} (answers served without reassembly)`);
      print(`  cached contexts    ${analytics.cachedEntries}`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("check")
  .argument("<operation...>", "the command or statement to classify")
  .description("Classify an operation as safe, caution or dangerous before running it")
  .action((parts: string[]) => {
    const assessment = assessOperation(parts.join(" "));
    print(`${assessment.severity.toUpperCase()}${assessment.productionTarget ? "  (targets production)" : ""}`);
    for (const risk of assessment.risks) print(`  - ${risk.reason} [${risk.rule}]`);
    if (assessment.requiresConfirmation) print("  Confirm with the developer before running this.");
    if (assessment.risks.length === 0) print("  No destructive pattern detected.");
  });

program
  .command("watch")
  .argument("[path]", "project directory (defaults to every connected project)")
  .option("--debounce <ms>", "how long to let edits settle", "300")
  .description("Keep the index current as files change (foreground)")
  .action(async (target: string | undefined, options: { debounce: string }) => {
    const devmemory = open();
    try {
      const projectIds: string[] = [];
      if (target) {
        const project = await devmemory.requireProject({ explicitRoot: path.resolve(target), autoConnect: false });
        projectIds.push(project.projectId);
      }

      const daemon = new DevMemoryDaemon(devmemory, {
        ...(projectIds.length > 0 ? { projectIds } : {}),
        debounceMs: Number(options.debounce),
        onEvent: (event) => {
          const parts: string[] = [];
          if (event.changed.length > 0) parts.push(`${event.changed.length} changed`);
          if (event.removed.length > 0) parts.push(`${event.removed.length} removed`);
          if (event.branchChanged) parts.push(`branch -> ${event.branchChanged}`);
          if (event.stats) parts.push(`${event.stats.parsed} parsed`);
          print(`${event.at.slice(11, 19)}  ${parts.join(", ")}`);
        },
      });

      const status = daemon.start();
      if (status.watching.length === 0) {
        print("No connected projects to watch. Run 'devmemory connect' first.");
        daemon.stop();
        return;
      }

      print(`Watching ${status.watching.length} project(s). Ctrl+C to stop.`);
      for (const entry of status.watching) print(`  ${entry.name}  ${entry.root}`);

      await new Promise<void>((resolve) => {
        const shutdown = () => {
          void daemon.flush().finally(() => {
            daemon.stop();
            resolve();
          });
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      });
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

const daemonCommand = program.command("daemon").description("Manage the background indexing daemon");

daemonCommand
  .command("start")
  .option("--debounce <ms>", "how long to let edits settle", "300")
  .description("Start the daemon in the background")
  .action((options: { debounce: string }) => {
    try {
      const existing = readDaemonRecord();
      if (existing && isProcessAlive(existing.pid)) {
        print(`Daemon already running (pid ${existing.pid}).`);
        return;
      }

      const entry = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [entry, "watch", "--debounce", options.debounce], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      writeDaemonRecord({ pid: child.pid ?? 0, startedAt: new Date().toISOString(), home: homeLayout().root });
      print(`Daemon started (pid ${child.pid}). Logs: ${path.join(homeLayout().logsDir, "devmemory.log")}`);
    } catch (error) {
      fail(error);
    }
  });

daemonCommand
  .command("stop")
  .description("Stop the background daemon")
  .action(() => {
    const record = readDaemonRecord();
    if (!record || !isProcessAlive(record.pid)) {
      clearDaemonRecord();
      print("Daemon is not running.");
      return;
    }

    try {
      process.kill(record.pid);
    } catch (error) {
      fail(error);
    }
    clearDaemonRecord();
    print(`Stopped daemon (pid ${record.pid}).`);
  });

daemonCommand
  .command("status")
  .description("Is the daemon running?")
  .action(() => {
    const record = readDaemonRecord();
    if (!record || !isProcessAlive(record.pid)) {
      print("Daemon: not running");
      return;
    }
    print(`Daemon: running (pid ${record.pid}, since ${record.startedAt.slice(0, 19)})`);
  });

program
  .command("dashboard")
  .option("--port <port>", "port to listen on")
  .option("--host <host>", "host to bind (loopback only unless --allow-remote)")
  .option("--allow-remote", "permit binding a non-loopback address")
  .description("Start the local web dashboard")
  .action(async (options: { port?: string; host?: string; allowRemote?: boolean }) => {
    const devmemory = open();
    try {
      const config = loadConfig();
      const dashboard = await startDashboard({
        devmemory,
        port: options.port ? Number(options.port) : config.dashboard.port,
        host: options.host ?? config.dashboard.host,
        allowRemote: options.allowRemote === true,
      });

      print(`DevMemory dashboard: ${dashboard.url}`);
      print("Ctrl+C to stop.");

      await new Promise<void>((resolve) => {
        const shutdown = () => {
          void dashboard.close().then(resolve);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      });
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("impact")
  .argument("<path>", "project-relative file path")
  .option("--depth <n>", "how far to follow the dependency graph", "3")
  .option("--json", "machine readable output")
  .description("What could break if this file changes, through imports and over HTTP")
  .action(async (target: string, options: { depth: string; json?: boolean }) => {
    const devmemory = open();
    try {
      const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
      const impact = devmemory.impact(project.projectId, target, { depth: Number(options.depth) });

      if (options.json) {
        print(JSON.stringify(impact, null, 2));
        return;
      }

      print(`Impact of ${impact.path}`);
      print(`  exports    ${impact.exportedSymbols.map((symbol) => symbol.name).join(", ") || "-"}`);
      print(`  imported by ${impact.direct.length} direct, ${impact.transitive.length} transitive`);
      for (const dependent of impact.direct.slice(0, 10)) print(`    ${dependent}`);
      print(`  tests      ${impact.tests.length}`);
      for (const test of impact.tests.slice(0, 5)) print(`    ${test}`);

      if (impact.http.routesServed.length > 0) {
        print("");
        print(`  Routes this file serves, and who calls them (${impact.httpScope}):`);
        for (const route of impact.http.routesServed) {
          print(`    ${route.method ?? "ANY"} ${route.path}`);
          for (const caller of route.calledBy) print(`        ${caller.project}  ${caller.path}:${caller.line}`);
        }
        print("");
        print("  Nothing imports across a network boundary: renaming one of these paths");
        print("  breaks those callers without a single compile error.");
      }

      const called = impact.http.routesCalled;
      if (called.length > 0) {
        print("");
        print("  Routes this file calls:");
        for (const route of called) {
          const served = route.servedBy.map((site) => `${site.project} ${site.path}:${site.line}`).join(", ");
          print(`    ${route.method ?? "ANY"} ${route.path}  ${route.unmatched ? "<- NO ROUTE FOUND" : "-> " + served}`);
        }
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("api")
  .argument("[scope]", "workspace or project name (defaults to the current project)")
  .option("--all", "also list linked routes and routes nobody calls")
  .option("--path <route>", "show only the callers of one route")
  .option("--json", "machine readable output")
  .description("HTTP routes, the code that calls them, and calls that reach nothing")
  .action(async (scope: string | undefined, options: { all?: boolean; path?: string; json?: boolean }) => {
    const devmemory = open();
    try {
      let target = scope;
      if (!target) {
        const project = await devmemory.requireProject({ cwd: process.cwd(), autoConnect: false });
        target = devmemory.workspaces.forProject(project.projectId)[0]?.name ?? project.name;
      }

      const report = devmemory.apiContracts(target);
      if (options.json) {
        print(JSON.stringify(report, null, 2));
        return;
      }

      if (options.path) {
        const callers = callersOf(report, options.path.replace(/^\/+/, ""));
        print(`Callers of ${options.path} in ${report.scope}:`);
        if (callers.length === 0) print("  none found in this scope");
        for (const caller of callers) print(`  ${caller.project}  ${caller.path}:${caller.line}`);
        return;
      }

      print(`API contracts for ${report.scope}`);
      print(
        `  ${report.totals.providers} routes, ${report.totals.consumers} calls, ` +
          `${report.totals.linked} linked, ${report.externalCalls} third-party calls ignored`,
      );

      print("");
      if (report.unmatchedCalls.length === 0) {
        print("  Every call reaches a route.");
      } else {
        print(`  Calls with no matching route (${report.unmatchedCalls.length}):`);
        for (const link of report.unmatchedCalls) {
          print(`    ${(link.method ?? "ANY").padEnd(6)} /${link.canonical}`);
          for (const consumer of link.consumers) {
            print(`           called by ${consumer.project}  ${consumer.path}:${consumer.line}`);
          }
        }
        print("");
        print("  A route registered dynamically, or served outside this scope, can appear");
        print("  here without being a defect. Confirm before changing anything.");
      }

      if (!options.all) return;

      print("");
      print(`  Linked (${report.linked.length}):`);
      for (const link of report.linked.slice(0, 40)) {
        print(`    ${(link.method ?? "ANY").padEnd(6)} /${link.canonical}`);
        print(`           serves ${link.providers.map((p) => p.project).join(", ")}`);
        print(`           calls  ${link.consumers.map((c) => `${c.project} ${c.path}:${c.line}`).join(", ")}`);
      }

      print("");
      print(`  Routes nobody in scope calls (${report.unusedRoutes.length}):`);
      for (const link of report.unusedRoutes.slice(0, 40)) {
        print(`    ${(link.method ?? "ANY").padEnd(6)} /${link.canonical}  (${link.providers[0]?.project ?? "?"})`);
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

const workspaceCommand = program.command("workspace").description("Groups of projects worked on together");

workspaceCommand
  .command("create")
  .argument("<name>", "workspace name")
  .option("--projects <names>", "comma separated project names or ids")
  .option("--description <text>", "what this workspace is")
  .description("Create a workspace")
  .action((name: string, options: { projects?: string; description?: string }) => {
    const devmemory = open();
    try {
      const wanted = options.projects ? splitList(options.projects) : [];
      const projectIds = wanted.map((entry) => {
        const byId = devmemory.registry.get(entry);
        if (byId) return byId.projectId;
        const byName = devmemory.registry.findByName(entry)[0];
        if (!byName) fail(new Error(`unknown project: ${entry}`));
        return (byName as ProjectRecord).projectId;
      });

      const workspace = devmemory.workspaces.create(name, {
        ...(options.description ? { description: options.description } : {}),
        projectIds,
      });

      print(`Workspace ${workspace.name} created with ${workspace.members.length} project(s).`);
      for (const member of workspace.members) {
        print(`  ${devmemory.registry.get(member.projectId)?.name ?? member.projectId}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

workspaceCommand
  .command("list")
  .description("List workspaces")
  .action(() => {
    const devmemory = open();
    try {
      const workspaces = devmemory.workspaces.list();
      if (workspaces.length === 0) {
        print("No workspaces yet. Create one with 'devmemory workspace create <name> --projects a,b'.");
        return;
      }
      for (const workspace of workspaces) {
        const names = workspace.members
          .map((member) => devmemory.registry.get(member.projectId)?.name ?? member.projectId)
          .join(", ");
        print(`  ${workspace.name.padEnd(16)} ${names}`);
        if (workspace.description) print(`      ${workspace.description}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

workspaceCommand
  .command("add")
  .argument("<workspace>", "workspace name")
  .argument("<project>", "project name or id")
  .option("--role <role>", "label such as backend, mobile or web")
  .description("Add a project to a workspace")
  .action((workspaceName: string, projectName: string, options: { role?: string }) => {
    const devmemory = open();
    try {
      const project = devmemory.registry.get(projectName) ?? devmemory.registry.findByName(projectName)[0];
      if (!project) fail(new Error(`unknown project: ${projectName}`));
      const workspace = devmemory.workspaces.addProject(
        workspaceName,
        (project as ProjectRecord).projectId,
        options.role,
      );
      print(`${workspace.name}: ${workspace.members.length} project(s).`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

workspaceCommand
  .command("remove")
  .argument("<workspace>", "workspace name")
  .argument("<project>", "project name or id")
  .description("Remove a project from a workspace")
  .action((workspaceName: string, projectName: string) => {
    const devmemory = open();
    try {
      const project = devmemory.registry.get(projectName) ?? devmemory.registry.findByName(projectName)[0];
      if (!project) fail(new Error(`unknown project: ${projectName}`));
      const workspace = devmemory.workspaces.removeProject(workspaceName, (project as ProjectRecord).projectId);
      print(`${workspace.name}: ${workspace.members.length} project(s).`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

workspaceCommand
  .command("status")
  .argument("<workspace>", "workspace name")
  .option("--json", "machine readable output")
  .description("Totals for every project in a workspace")
  .action((workspaceName: string, options: { json?: boolean }) => {
    const devmemory = open();
    try {
      const status = devmemory.workspaceStatus(workspaceName);
      if (options.json) {
        print(JSON.stringify(status, null, 2));
        return;
      }

      print(`${status.workspace}`);
      print("  project              role      files  symbols  memories  tasks  branch");
      for (const project of status.projects) {
        print(
          "  " + project.name.padEnd(20) + (project.role ?? "-").padEnd(10) +
          String(project.files).padStart(5) + String(project.symbols).padStart(9) +
          String(project.memories).padStart(10) + String(project.openTasks).padStart(7) +
          "  " + (project.branch ?? "-"),
        );
      }
      print("");
      print(`  total: ${status.totals.files} files, ${status.totals.symbols} symbols, ${status.totals.memories} memories`);
    } catch (error) {
      fail(error);
    } finally {
      devmemory.close();
    }
  });

program
  .command("mcp-config")
  .option("--client <name>", "claude | opencode | generic", "claude")
  .description("Print the MCP client configuration for this DevMemory installation")
  .action((options: { client: string }) => {
    // After a global install this command is on PATH. Inside a checkout it is not,
    // so the built entry point is offered as the fallback.
    const installed = { command: "devmemory-mcp-server", args: [] as string[] };
    const fromCheckout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mcp-server/dist/main.js");
    const entry = fs.existsSync(fromCheckout) ? { command: process.execPath, args: [fromCheckout] } : installed;
    if (options.client === "opencode") {
      print(JSON.stringify({ mcp: { devmemory: { type: "local", command: [entry.command, ...entry.args], enabled: true } } }, null, 2));
    } else if (options.client === "claude") {
      print(JSON.stringify({ mcpServers: { devmemory: entry } }, null, 2));
      print("");
      print("Or register it directly:");
      print(`  claude mcp add devmemory --scope user -- ${[entry.command, ...entry.args].map(quoteIfNeeded).join(" ")}`);
    } else {
      print(JSON.stringify({ name: "devmemory", transport: "stdio", ...entry }, null, 2));
    }
  });

program
  .command("where")
  .argument("[project]", "project id")
  .description("Print where DevMemory stores data for a project")
  .action((projectId: string | undefined) => {
    const layout = homeLayout();
    if (!projectId) {
      print(layout.root);
      return;
    }
    print(projectLayout(projectId).root);
  });

program.parseAsync(process.argv).catch(fail);
