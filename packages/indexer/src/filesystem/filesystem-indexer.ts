import fs from "node:fs";
import crypto from "node:crypto";
import { DevMemoryError, normalizePath } from "@devmemory/shared";
import type { DevMemoryConfig, IndexRunStats } from "@devmemory/shared";
import type { SqliteDatabase } from "@devmemory/storage";
import { FileStore } from "./file-store.js";
import { IgnoreMatcher } from "./ignore.js";
import { scanProject, type ScannedFile, type ScanResult } from "./walker.js";
import { ParserRegistry, defaultParserRegistry } from "../ast/parser-registry.js";
import type { ParseResult } from "../ast/types.js";
import { SymbolStore } from "../symbols/symbol-store.js";
import { SearchStore } from "../search/search-store.js";
import { findSecrets } from "../security/sensitive.js";
import { ImportResolver, loadTsconfigAliases } from "../dependencies/import-resolver.js";
import { discoverWorkspacePackages } from "../dependencies/workspace-packages.js";

export interface IndexOptions {
  projectId: string;
  root: string;
  /** Rebuild from scratch instead of reusing stored hashes. */
  full?: boolean;
  /**
   * Project-relative candidate paths. The caller supplies git's own file list when
   * the project is a repository, so .gitignore is honoured exactly (PRD 5.7, 20).
   */
  candidates?: string[];
  /** Restrict the run to specific paths - used by the watcher for single-file updates (PRD 56). */
  only?: string[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

interface PendingParse {
  fileId: number;
  relativePath: string;
  language: string;
  result: ParseResult;
}

/**
 * Incremental file indexer (PRD 15, 59) with code intelligence (PRD 16, 17).
 * A file whose content hash is unchanged is never re-read or re-parsed, and a
 * single changed file never triggers a full rebuild.
 */
export class FilesystemIndexer {
  private readonly store: FileStore;
  private readonly symbols: SymbolStore;
  private readonly search: SearchStore;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly config: DevMemoryConfig,
    private readonly parsers: ParserRegistry = defaultParserRegistry,
  ) {
    this.store = new FileStore(db);
    this.symbols = new SymbolStore(db);
    this.search = new SearchStore(db);
  }

  get files(): FileStore {
    return this.store;
  }

  get code(): SymbolStore {
    return this.symbols;
  }

  get fullText(): SearchStore {
    return this.search;
  }

  buildMatcher(root: string): IgnoreMatcher {
    const matcher = new IgnoreMatcher({
      ignoreDirs: this.config.indexing.ignoreDirs,
      ignoreFiles: this.config.indexing.ignoreFiles,
    });

    if (this.config.indexing.respectGitignore) {
      for (const rule of IgnoreMatcher.loadIgnoreFile(root, ".gitignore")) matcher.addRule(rule, ".gitignore");
    }
    for (const rule of IgnoreMatcher.loadIgnoreFile(root, ".devmemoryignore")) matcher.addRule(rule, ".devmemoryignore");

    return matcher;
  }

  async run(options: IndexOptions): Promise<IndexRunStats> {
    const started = Date.now();
    const root = normalizePath(options.root);
    const full = options.full ?? false;
    const partial = Array.isArray(options.only);

    this.store.abandonUnfinishedRuns(options.projectId);
    const runId = this.store.startRun(options.projectId, full);

    const stats: IndexRunStats = {
      projectId: options.projectId,
      scanned: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      skipped: 0,
      bytesIndexed: 0,
      durationMs: 0,
      fullRebuild: full,
      parsed: 0,
      parseErrors: 0,
      symbols: 0,
    };

    try {
      const scan: ScanResult = scanProject(root, {
        matcher: this.buildMatcher(root),
        maxFileSizeBytes: this.config.indexing.maxFileSizeBytes,
        maxFiles: this.config.indexing.maxFiles,
        followSymlinks: this.config.indexing.followSymlinks,
        ...(options.candidates ? { candidates: options.candidates } : {}),
      });

      const selected = partial
        ? scan.files.filter((file) => (options.only as string[]).includes(file.relativePath))
        : scan.files;

      stats.scanned = selected.length;
      stats.skipped = scan.skipped;

      if (full) {
        this.store.clear(options.projectId);
        this.db.exec("DELETE FROM symbols");
        this.db.exec("DELETE FROM imports");
        this.db.exec("DELETE FROM symbol_references");
        this.search.clear();
      }
      const existing = full ? new Map() : this.store.existingByPath(options.projectId);

      // Phase 1 - file records. One transaction keeps the index atomic: a crash
      // leaves the previous index intact rather than a half-written one (PRD 60).
      const changed: ScannedFile[] = [];
      this.db.transaction(() => {
        for (const file of selected) {
          const previous = existing.get(file.relativePath);

          // Fast path: identical size and mtime means the content cannot have changed
          // in any way we care about, so the file is not even read.
          if (
            previous &&
            previous.status === "active" &&
            previous.size === file.size &&
            previous.last_modified === file.lastModified
          ) {
            stats.unchanged++;
            continue;
          }

          let hash: string;
          try {
            hash = crypto.createHash("sha256").update(fs.readFileSync(file.absolutePath)).digest("hex");
          } catch {
            stats.skipped++;
            continue;
          }

          const unchangedContent = previous?.hash === hash && previous?.status === "active";
          this.store.upsert({
            projectId: options.projectId,
            path: file.absolutePath,
            relativePath: file.relativePath,
            language: file.language,
            extension: file.extension,
            size: file.size,
            hash,
            lastModified: file.lastModified,
          });

          if (unchangedContent) {
            // Touched but not modified - metadata refreshed, no re-parse needed.
            stats.unchanged++;
            continue;
          }

          stats.bytesIndexed += file.size;
          if (previous) stats.updated++;
          else stats.added++;
          changed.push(file);
        }

        // Deletions can only be inferred from a complete scan.
        if (!partial) {
          const present = new Set(selected.map((file) => file.relativePath));
          const missing = [...existing.values()]
            .filter((row) => row.status === "active" && !present.has(row.relative_path))
            .map((row) => row.relative_path);

          for (const relativePath of missing) {
            const record = this.store.get(options.projectId, relativePath);
            if (!record) continue;
            this.symbols.clearFile(options.projectId, record.id);
            this.search.removeFile(record.id);
          }
          stats.deleted = this.store.markDeleted(options.projectId, missing);
        }
      });

      // Phase 2 - content analysis: full-text indexing and parsing. Parsing runs
      // outside any transaction because it is CPU-bound and must not hold a write
      // lock while the dashboard or another agent reads.
      const pending = await this.analyzeChanged(options.projectId, changed, full, partial);
      stats.parsed = pending.length;
      stats.parseErrors = pending.filter((entry) => entry.result.hasErrors).length;

      // Phase 3 - code intelligence. Resolution needs the complete file list, so it
      // happens after every file record exists.
      if (this.config.indexing.parseSymbols) {
        const resolver = new ImportResolver({
          files: this.store.allPaths(options.projectId),
          aliases: loadTsconfigAliases(root),
          workspacePackages: discoverWorkspacePackages(root),
        });

        this.db.transaction(() => {
          for (const entry of pending) {
            const written = this.symbols.replaceFileAnalysis(
              options.projectId,
              entry.fileId,
              entry.language,
              entry.result,
              entry.relativePath,
              resolver,
            );
            stats.symbols += written.symbols;
          }
          if (!partial) this.symbols.relinkImports(options.projectId);
        });
      }

      stats.durationMs = Date.now() - started;
      this.store.finishRun(runId, stats);
      return stats;
    } catch (error) {
      stats.durationMs = Date.now() - started;
      this.store.finishRun(runId, stats, error instanceof Error ? error.message : String(error));
      throw new DevMemoryError(
        "INDEX_ERROR",
        `indexing failed: ${error instanceof Error ? error.message : String(error)}`,
        { projectId: options.projectId, root },
      );
    }
  }

  /**
   * Records which credential detectors fired for a file. The secret itself is never
   * stored - only that one was seen, and where (PRD 37).
   */
  private recordSecrets(projectId: string, fileId: number, content: string): void {
    this.db.prepare("DELETE FROM security_findings WHERE project_id = ? AND file_id = ?").run(projectId, fileId);

    const findings = findSecrets(content);
    if (findings.length === 0) {
      this.db.prepare("UPDATE files SET has_secrets = 0 WHERE id = ?").run(fileId);
      return;
    }

    const insert = this.db.prepare(
      "INSERT INTO security_findings (project_id, file_id, detector, occurrences, detected_at) VALUES (?, ?, ?, ?, ?)",
    );
    const timestamp = new Date().toISOString();
    for (const finding of findings) insert.run(projectId, fileId, finding.name, finding.count, timestamp);
    this.db.prepare("UPDATE files SET has_secrets = 1 WHERE id = ?").run(fileId);
  }

  /**
   * Reads each changed file once and does two things with it: adds it to the
   * full-text index, and parses it when its language is supported. Files are
   * processed in batches so only a bounded amount of source is ever in memory.
   */
  private async analyzeChanged(
    projectId: string,
    changed: ScannedFile[],
    full: boolean,
    partial: boolean,
  ): Promise<PendingParse[]> {
    const targets = new Map<string, { relativePath: string; language: string | null; absolutePath: string }>();

    for (const file of changed) {
      targets.set(file.relativePath, {
        relativePath: file.relativePath,
        language: file.language,
        absolutePath: file.absolutePath,
      });
    }

    // Files indexed before parsing existed, or before a grammar was available.
    if (!full && !partial && this.config.indexing.parseSymbols) {
      for (const row of this.store.unparsed(projectId, this.parsers.languages)) {
        targets.set(row.relativePath, {
          relativePath: row.relativePath,
          language: row.language,
          absolutePath: row.path,
        });
      }
    }

    if (targets.size === 0) return [];

    const parseable = [...targets.values()].some(
      (target) => target.language !== null && this.parsers.supports(target.language),
    );
    if (this.config.indexing.parseSymbols && parseable) await this.parsers.prepare();

    const maxBytes = this.config.indexing.maxParseFileSizeBytes;
    const pending: PendingParse[] = [];
    const batches = chunk([...targets.values()], 100);

    for (const batch of batches) {
      const loaded: Array<{ fileId: number; relativePath: string; language: string | null; content: string }> = [];

      for (const target of batch) {
        const record = this.store.get(projectId, target.relativePath);
        if (!record) continue;

        if (record.size > maxBytes) {
          if (this.config.indexing.parseSymbols) this.symbols.markUnparsed(projectId, record.id, "skipped_size");
          continue;
        }

        try {
          loaded.push({
            fileId: record.id,
            relativePath: target.relativePath,
            language: target.language,
            content: fs.readFileSync(target.absolutePath, "utf8"),
          });
        } catch {
          if (this.config.indexing.parseSymbols) this.symbols.markUnparsed(projectId, record.id, "unreadable");
        }
      }

      // Full-text rows, and the secret scan, for the whole batch in one transaction.
      this.db.transaction(() => {
        for (const entry of loaded) {
          this.search.indexFile(entry.fileId, entry.relativePath, entry.content);
          if (this.config.security.scanForSecrets) this.recordSecrets(projectId, entry.fileId, entry.content);
        }
      });

      if (!this.config.indexing.parseSymbols) continue;

      for (const entry of loaded) {
        if (!entry.language || !this.parsers.supports(entry.language)) continue;
        try {
          const result = this.parsers.parse({
            relativePath: entry.relativePath,
            content: entry.content,
            language: entry.language,
          });
          if (result) {
            pending.push({
              fileId: entry.fileId,
              relativePath: entry.relativePath,
              language: entry.language,
              result,
            });
          }
        } catch {
          // A grammar failure on one file must not abort the run.
          this.symbols.markUnparsed(projectId, entry.fileId, "error");
        }
      }
    }

    return pending;
  }
}
