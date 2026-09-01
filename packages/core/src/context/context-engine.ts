import fs from "node:fs";
import path from "node:path";
import { estimateTokens, shortId } from "@samirthakur024/shared";
import type { ProjectRecord } from "@samirthakur024/shared";
import type { FileStore, SearchStore, StoredSymbol, SymbolStore } from "@samirthakur024/indexer";
import { redactSecrets } from "@samirthakur024/indexer";
import type { GitEngine } from "../git/git-engine.js";
import { CodeIntelligence, looksLikeTest } from "../code/code-intelligence.js";
import type { MemoryEngine } from "../memory/memory-engine.js";
import { ContextCache, type CachedFile, type CacheOutcome } from "./context-cache.js";
import { parseRequest, type Intent, type ParsedRequest } from "./intent.js";

export interface ContextRequest {
  /** What the agent is about to do, in the developer's own words. */
  task: string;
  /** Files the agent already knows are relevant. */
  paths?: string[];
  /** Symbols the agent already knows are relevant. */
  symbols?: string[];
  /** Token budget for the whole response. */
  maxTokens?: number;
  /** Include source slices (L2) rather than structure only (L1). */
  includeSource?: boolean;
  /** How far to expand along the dependency graph from the seeds. */
  depth?: number;
  maxFiles?: number;
}

export interface ContextSymbol {
  name: string;
  type: string;
  lines: [number, number];
  signature?: string;
  exported?: boolean;
}

export interface ContextFile {
  path: string;
  language: string | null;
  relevance: number;
  reasons: string[];
  symbols: ContextSymbol[];
  source?: { lines: [number, number]; text: string };
  tokens: number;
}

export interface ContextResult {
  /** Stable id for this context, reusable by a later request (PRD 25). */
  contextId: string;
  projectId: string;
  task: string;
  intent: Intent;
  project: {
    name: string;
    root: string;
    framework: string | null;
    languages: string[];
    branch: string | null;
    head: string | null;
  };
  files: ContextFile[];
  symbols: Array<{ name: string; qualifiedName: string; type: string; path: string; lines: [number, number] }>;
  memories: Array<{ id: string; type: string; title: string; content: string; importance: number }>;
  recentChanges: string[];
  tests: string[];
  tokenEstimate: number;
  budget: number;
  filesConsidered: number;
  filesSelected: number;
  filesAvoided: number;
  symbolsSelected: number;
  includedSource: boolean;
  truncated: boolean;
  /** Whether this answer came from cache, was patched, or was assembled fresh. */
  cache: CacheOutcome;
  /** Files re-read because they changed since the cached answer (PRD 26). */
  refreshedFiles: string[];
}

export interface SearchResult {
  path: string;
  language: string | null;
  relevance: number;
  kind: "file" | "symbol";
  symbol?: { name: string; type: string; lines: [number, number] };
  snippet?: { line: number; text: string };
}

interface Candidate {
  path: string;
  language: string | null;
  scores: Partial<Record<ScoreComponent, number>>;
  reasons: Set<string>;
  symbols: StoredSymbol[];
}

type ScoreComponent = "explicit" | "symbol" | "search" | "pathMatch" | "dependency" | "recent" | "test" | "memory";

/** Weights for the relevance formula in PRD 23. */
const WEIGHTS: Record<ScoreComponent, number> = {
  explicit: 1.0,
  symbol: 0.9,
  search: 0.7,
  pathMatch: 0.5,
  dependency: 0.4,
  recent: 0.3,
  test: 0.25,
  memory: 0.6,
};

/** Beyond a handful of changed files it is cheaper to reassemble than to patch. */
const INCREMENTAL_LIMIT = 3;

const DEFAULT_BUDGET = 6000;
const DEFAULT_MAX_FILES = 12;
const MAX_SYMBOLS_PER_FILE = 12;
const MAX_SOURCE_LINES = 80;

export interface ContextEngineDeps {
  project: ProjectRecord;
  files: FileStore;
  symbols: SymbolStore;
  search: SearchStore;
  code: CodeIntelligence;
  memory: MemoryEngine;
  cache: ContextCache;
  git: GitEngine | null;
  redactSecrets: boolean;
}

/**
 * Assembles the smallest useful context for a request (PRD 21-24). The pipeline is
 * seed -> expand -> rank -> select under a token budget, and every stage is
 * deterministic: search, the dependency graph, symbol tables and git, never an LLM.
 */
export class ContextEngine {
  constructor(private readonly deps: ContextEngineDeps) {}

  /**
   * Cache-aware entry point (PRD 25, 26). An unchanged project answers from cache;
   * a project where a few of the cached files moved is patched rather than
   * reassembled; anything else is built from scratch.
   */
  getContext(request: ContextRequest): ContextResult {
    const started = Date.now();
    const key = ContextCache.keyFor(request.task, {
      paths: request.paths,
      symbols: request.symbols,
      maxTokens: request.maxTokens,
      includeSource: request.includeSource,
      depth: request.depth,
      maxFiles: request.maxFiles,
    });

    const cached = this.deps.cache.lookup(key);
    if (cached && cached.missingFiles.length === 0 && cached.staleFiles.length === 0) {
      this.deps.cache.touch(cached.entry.id);
      const result: ContextResult = { ...cached.entry.payload, cache: "hit", refreshedFiles: [] };
      this.deps.cache.record("hit", result, Date.now() - started);
      return result;
    }

    if (cached && cached.missingFiles.length === 0 && cached.staleFiles.length <= INCREMENTAL_LIMIT) {
      const result = this.patch(cached.entry.payload, cached.staleFiles, request);
      this.deps.cache.store(key, result, this.fileHashes(result), this.head());
      this.deps.cache.record("incremental", result, Date.now() - started);
      return result;
    }

    const result = this.assemble(request);
    const id = this.deps.cache.store(key, result, this.fileHashes(result), this.head());
    const stored: ContextResult = { ...result, contextId: id };
    this.deps.cache.record("miss", stored, Date.now() - started);
    return stored;
  }

  /**
   * Incremental context (PRD 26): keep the previous answer, re-read only the files
   * whose content actually changed, and refresh project memory.
   */
  private patch(previous: ContextResult, staleFiles: string[], request: ContextRequest): ContextResult {
    const stale = new Set(staleFiles);
    const includeSource = request.includeSource ?? previous.includedSource;
    const memories = this.deps.memory.recall({ query: previous.task, limit: 6 });

    const files = previous.files.map((file) => {
      if (!stale.has(file.path)) return file;
      const record = this.deps.files.get(this.deps.project.projectId, file.path);
      return this.buildFile(
        {
          path: file.path,
          language: record?.language ?? file.language,
          scores: {},
          reasons: new Set([...file.reasons, "refreshed after change"]),
          symbols: [],
        },
        file.relevance,
        { includeSource: includeSource && file.source !== undefined, highlight: [] },
      );
    });

    const tokenEstimate =
      estimateTokens(JSON.stringify(this.projectHeader())) +
      estimateTokens(JSON.stringify(memories)) +
      files.reduce((sum, file) => sum + file.tokens, 0);

    return {
      ...previous,
      project: this.projectHeader(),
      files,
      memories: memories.map((memory) => ({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        content: memory.content,
        importance: memory.importance,
      })),
      recentChanges: this.recentlyChanged().slice(0, 15),
      tokenEstimate,
      cache: "incremental",
      refreshedFiles: staleFiles,
    };
  }

  private fileHashes(result: ContextResult): CachedFile[] {
    const hashes: CachedFile[] = [];
    for (const file of result.files) {
      const record = this.deps.files.get(this.deps.project.projectId, file.path);
      if (record) hashes.push({ path: file.path, hash: record.hash });
    }
    return hashes;
  }

  private head(): string | null {
    const project = this.deps.project;
    if (!this.deps.git || project.repositoryType !== "git") return null;
    return this.deps.git.headCommit(project.rootPath);
  }

  private assemble(request: ContextRequest): ContextResult {
    const parsed = parseRequest(request.task);
    const projectId = this.deps.project.projectId;
    const budget = request.maxTokens ?? DEFAULT_BUDGET;
    const maxFiles = request.maxFiles ?? DEFAULT_MAX_FILES;

    const candidates = new Map<string, Candidate>();
    const matchedSymbols: StoredSymbol[] = [];

    // --- seeds -------------------------------------------------------------
    for (const requested of request.paths ?? []) {
      const record = this.deps.files.get(projectId, normalise(requested));
      if (record?.status === "active") {
        this.add(candidates, record.relativePath, record.language, "explicit", 1, "requested by the agent");
      }
    }

    const symbolQueries = [...(request.symbols ?? []), ...parsed.symbolCandidates];
    for (const name of symbolQueries) {
      for (const symbol of this.deps.code.findSymbols(name, { limit: 5 })) {
        matchedSymbols.push(symbol);
        this.add(candidates, symbol.path, null, "symbol", symbol.name === name ? 1 : 0.7, `defines ${symbol.name}`);
      }
    }

    for (const hit of this.deps.search.searchSymbols(projectId, parsed.raw, 20)) {
      this.add(candidates, hit.path, null, "search", hit.relevance, `symbol match: ${hit.name}`);
      if (hit.relevance >= 0.5) {
        matchedSymbols.push({
          id: hit.symbolId,
          fileId: 0,
          path: hit.path,
          name: hit.name,
          qualifiedName: hit.qualifiedName,
          type: hit.type,
          signature: hit.signature,
          lineStart: hit.lineStart,
          lineEnd: hit.lineEnd,
          exported: hit.exported,
          language: null,
          hash: "",
        });
      }
    }

    for (const hit of this.deps.search.searchFiles(projectId, parsed.raw, 20)) {
      this.add(candidates, hit.path, hit.language, "search", hit.relevance * 0.8, "content match");
    }

    for (const pathToken of parsed.pathCandidates) {
      for (const file of this.deps.files.searchPaths(projectId, pathToken, 5)) {
        this.add(candidates, file.relativePath, file.language, "pathMatch", 1, `path mentions ${pathToken}`);
      }
    }

    const recentChanges = this.recentlyChanged();
    for (const changed of recentChanges) {
      const record = this.deps.files.get(projectId, changed);
      if (record?.status === "active") {
        this.add(candidates, record.relativePath, record.language, "recent", 1, "changed since last commit");
      }
    }

    // --- project memory (PRD 23 memory importance, 27) ---------------------
    const memories = this.deps.memory.recall({ query: parsed.raw, limit: 6 });
    for (const memory of memories) {
      for (const memoryPath of memory.paths) {
        const record = this.deps.files.get(projectId, normalise(memoryPath));
        if (record?.status !== "active") continue;
        this.add(candidates, record.relativePath, record.language, "memory", memory.importance, `memory: ${memory.title}`);
      }
    }

    // --- graph expansion ---------------------------------------------------
    const depth = Math.max(0, Math.min(request.depth ?? 1, 3));
    const seeds = [...candidates.values()]
      .sort((a, b) => this.score(b) - this.score(a))
      .slice(0, 6)
      .map((candidate) => candidate.path);

    let frontier = seeds;
    for (let level = 1; level <= depth && frontier.length > 0; level++) {
      const next: string[] = [];
      const decay = 1 / (level + 1);

      for (const current of frontier) {
        for (const edge of this.deps.symbols.dependencies(projectId, current)) {
          if (!candidates.has(edge.path)) next.push(edge.path);
          this.add(candidates, edge.path, null, "dependency", decay, `imported by ${current}`);
        }
        for (const edge of this.deps.symbols.dependents(projectId, current)) {
          const isTest = looksLikeTest(edge.path);
          if (isTest && parsed.intent !== "test" && parsed.intent !== "debug") continue;
          if (!candidates.has(edge.path)) next.push(edge.path);
          this.add(
            candidates,
            edge.path,
            null,
            isTest ? "test" : "dependency",
            decay,
            isTest ? `tests ${current}` : `imports ${current}`,
          );
        }
      }
      frontier = next;
    }

    // --- rank --------------------------------------------------------------
    const ranked = [...candidates.values()].sort((a, b) => this.score(b) - this.score(a));
    const best = ranked.length > 0 ? this.score(ranked[0] as Candidate) : 1;

    // --- select under budget ----------------------------------------------
    const includeSource = request.includeSource ?? parsed.intent === "debug";
    const files: ContextFile[] = [];
    let used = estimateTokens(JSON.stringify(this.projectHeader())) + estimateTokens(JSON.stringify(memories));
    let truncated = false;
    let symbolsSelected = 0;

    for (const candidate of ranked) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }

      const relevance = Number((this.score(candidate) / (best || 1)).toFixed(3));
      const entry = this.buildFile(candidate, relevance, {
        includeSource: includeSource && files.length < 4,
        highlight: matchedSymbols.filter((symbol) => symbol.path === candidate.path),
      });

      if (used + entry.tokens > budget) {
        // A file that does not fit at L2 may still fit as structure only.
        if (entry.source) {
          const structural = this.buildFile(candidate, relevance, { includeSource: false, highlight: [] });
          if (used + structural.tokens <= budget) {
            files.push(structural);
            used += structural.tokens;
            symbolsSelected += structural.symbols.length;
            continue;
          }
        }
        truncated = true;
        break;
      }

      files.push(entry);
      used += entry.tokens;
      symbolsSelected += entry.symbols.length;
    }

    const selectedPaths = new Set(files.map((file) => file.path));

    return {
      contextId: shortId("ctx", 5),
      projectId,
      task: request.task,
      intent: parsed.intent,
      project: this.projectHeader(),
      files,
      symbols: dedupeSymbols(matchedSymbols)
        .slice(0, 15)
        .map((symbol) => ({
          name: symbol.name,
          qualifiedName: symbol.qualifiedName,
          type: symbol.type,
          path: symbol.path,
          lines: [symbol.lineStart, symbol.lineEnd] as [number, number],
        })),
      memories: memories.map((memory) => ({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        content: memory.content,
        importance: memory.importance,
      })),
      recentChanges: recentChanges.slice(0, 15),
      tests: [...selectedPaths].filter((file) => looksLikeTest(file)),
      tokenEstimate: used,
      budget,
      filesConsidered: candidates.size,
      filesSelected: files.length,
      // Everything in the index that this response deliberately left out (PRD 24).
      filesAvoided: Math.max(0, this.deps.files.stats(projectId).files - files.length),
      symbolsSelected,
      includedSource: files.some((file) => file.source !== undefined),
      truncated,
      cache: "miss",
      refreshedFiles: [],
    };
  }

  /** Ranked search across file contents and symbols (PRD 53). */
  searchContext(query: string, limit = 20): SearchResult[] {
    const projectId = this.deps.project.projectId;
    const results: SearchResult[] = [];

    for (const hit of this.deps.search.searchSymbols(projectId, query, limit)) {
      results.push({
        path: hit.path,
        language: null,
        relevance: hit.relevance,
        kind: "symbol",
        symbol: { name: hit.qualifiedName, type: hit.type, lines: [hit.lineStart, hit.lineEnd] },
      });
    }

    for (const hit of this.deps.search.searchFiles(projectId, query, limit)) {
      const snippet = this.firstMatchingLine(hit.path, query);
      results.push({
        path: hit.path,
        language: hit.language,
        relevance: hit.relevance,
        kind: "file",
        ...(snippet ? { snippet } : {}),
      });
    }

    return results.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
  }

  private projectHeader(): ContextResult["project"] {
    const project = this.deps.project;
    const git = this.deps.git;
    return {
      name: project.name,
      root: project.rootPath,
      framework: project.framework,
      languages: project.languages,
      branch: git && project.repositoryType === "git" ? git.currentBranch(project.rootPath) : null,
      head: git && project.repositoryType === "git" ? git.headCommit(project.rootPath) : null,
    };
  }

  private add(
    candidates: Map<string, Candidate>,
    filePath: string,
    language: string | null,
    component: ScoreComponent,
    strength: number,
    reason: string,
  ): void {
    const existing = candidates.get(filePath) ?? {
      path: filePath,
      language,
      scores: {},
      reasons: new Set<string>(),
      symbols: [],
    };

    // A component contributes at its strongest observation, not the sum of many weak ones.
    existing.scores[component] = Math.max(existing.scores[component] ?? 0, strength);
    if (existing.reasons.size < 4) existing.reasons.add(reason);
    if (language && !existing.language) existing.language = language;

    candidates.set(filePath, existing);
  }

  private score(candidate: Candidate): number {
    let total = 0;
    for (const [component, strength] of Object.entries(candidate.scores)) {
      total += WEIGHTS[component as ScoreComponent] * (strength ?? 0);
    }
    return total;
  }

  private buildFile(
    candidate: Candidate,
    relevance: number,
    options: { includeSource: boolean; highlight: StoredSymbol[] },
  ): ContextFile {
    const projectId = this.deps.project.projectId;
    const stored = this.deps.symbols.symbolsInFile(projectId, candidate.path, 100);
    const record = this.deps.files.get(projectId, candidate.path);

    const symbols = rankSymbols(stored, options.highlight)
      .slice(0, MAX_SYMBOLS_PER_FILE)
      .map((symbol) => ({
        name: symbol.qualifiedName,
        type: symbol.type,
        lines: [symbol.lineStart, symbol.lineEnd] as [number, number],
        ...(symbol.signature ? { signature: symbol.signature } : {}),
        ...(symbol.exported ? { exported: true } : {}),
      }));

    const entry: ContextFile = {
      path: candidate.path,
      language: candidate.language ?? record?.language ?? null,
      relevance,
      reasons: [...candidate.reasons],
      symbols,
      tokens: 0,
    };

    if (options.includeSource) {
      const target = options.highlight[0] ?? stored[0];
      const source = target
        ? this.readLines(candidate.path, target.lineStart, Math.min(target.lineEnd, target.lineStart + MAX_SOURCE_LINES - 1))
        : this.readLines(candidate.path, 1, 40);
      if (source) entry.source = source;
    }

    entry.tokens = estimateTokens(JSON.stringify(entry));
    return entry;
  }

  private readLines(relativePath: string, start: number, end: number): { lines: [number, number]; text: string } | null {
    const absolute = path.resolve(this.deps.project.rootPath, relativePath);
    if (!absolute.startsWith(path.resolve(this.deps.project.rootPath))) return null;

    try {
      const all = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
      const from = Math.max(1, start);
      const to = Math.min(all.length, end);
      const text = all.slice(from - 1, to).join("\n");
      return { lines: [from, to], text: this.deps.redactSecrets ? redactSecrets(text).text : text };
    } catch {
      return null;
    }
  }

  private firstMatchingLine(relativePath: string, query: string): { line: number; text: string } | undefined {
    const terms = (query.toLowerCase().match(/[a-z0-9_$]{3,}/g) ?? []).slice(0, 8);
    if (terms.length === 0) return undefined;

    const absolute = path.resolve(this.deps.project.rootPath, relativePath);
    try {
      const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] as string;
        const lowered = line.toLowerCase();
        if (!terms.some((term) => lowered.includes(term))) continue;
        const text = line.trim().slice(0, 200);
        return { line: index + 1, text: this.deps.redactSecrets ? redactSecrets(text).text : text };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** Files touched in the working tree, newest first (PRD 21 "recent changes"). */
  private recentlyChanged(): string[] {
    const project = this.deps.project;
    if (this.deps.git && project.repositoryType === "git") {
      try {
        return this.deps.git.status(project.rootPath).files.map((file) => file.path);
      } catch {
        // fall through to mtime ordering
      }
    }
    return this.deps.files
      .recentlyModified(project.projectId, 10)
      .map((file) => file.relativePath);
  }
}

function rankSymbols(symbols: StoredSymbol[], highlight: StoredSymbol[]): StoredSymbol[] {
  const highlighted = new Set(highlight.map((symbol) => symbol.name));
  const weight = (symbol: StoredSymbol): number => {
    let value = 0;
    if (highlighted.has(symbol.name)) value += 10;
    if (symbol.exported) value += 3;
    if (symbol.type === "class" || symbol.type === "interface" || symbol.type === "component") value += 2;
    if (symbol.type === "function" || symbol.type === "method" || symbol.type === "hook" || symbol.type === "route") value += 1;
    if (symbol.type === "variable" || symbol.type === "property") value -= 2;
    return value;
  };
  return [...symbols].sort((a, b) => weight(b) - weight(a) || a.lineStart - b.lineStart);
}

function dedupeSymbols(symbols: StoredSymbol[]): StoredSymbol[] {
  const seen = new Set<string>();
  const unique: StoredSymbol[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.path}:${symbol.qualifiedName}:${symbol.lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol);
  }
  return unique;
}

function normalise(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export type { ParsedRequest };
