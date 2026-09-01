import { DevMemoryError, nowIso } from "@samirthakur024/shared";
import { toMatchQuery } from "@samirthakur024/indexer";
import {
  MemoryStore,
  MEMORY_TYPES,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryStats,
  type MemoryType,
} from "./memory-store.js";

export interface RememberInput {
  type: MemoryType;
  title: string;
  content: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  paths?: string[];
  symbols?: string[];
  /** Scope this memory to the current branch rather than the whole project (PRD 57). */
  branchSpecific?: boolean;
  branch?: string | null;
  /** Automatic archival for knowledge that is only true for a while (PRD 28). */
  expiresInDays?: number;
  /** Id of the memory this one replaces. */
  supersedes?: string;
  source?: string;
  decision?: { reason?: string; alternatives?: string[]; affected?: string[] };
}

export interface RememberResult {
  memory: MemoryRecord;
  /** True when an identical memory already existed and was reinforced instead. */
  deduplicated: boolean;
}

export interface RecallOptions {
  query?: string;
  type?: MemoryType;
  limit?: number;
  minImportance?: number;
  includeArchived?: boolean;
  /** Include memories scoped to this branch. Defaults to the project's current branch. */
  branch?: string | null;
  path?: string;
  tag?: string;
}

export interface RecalledMemory extends MemoryRecord {
  score: number;
  relevance: number;
}

/**
 * Default importance per kind (PRD 28): architecture decisions and constraints are
 * what a future session actually needs; running commentary is not.
 */
const DEFAULT_IMPORTANCE: Record<MemoryType, number> = {
  DECISION: 0.9,
  CONSTRAINT: 0.85,
  BUG: 0.7,
  PATTERN: 0.7,
  DISCOVERY: 0.6,
  FACT: 0.5,
  HISTORY: 0.3,
};

/** Low-value kinds expire unless the caller says otherwise, so memory stays useful. */
const DEFAULT_TTL_DAYS: Partial<Record<MemoryType, number>> = {
  HISTORY: 30,
};

const MIN_CONTENT_LENGTH = 8;
const RECENCY_HALF_LIFE_DAYS = 90;

/**
 * The memory engine (PRD 27-29). It decides what is worth keeping, keeps it
 * de-duplicated, and ranks recall so the most load-bearing knowledge surfaces first.
 */
export class MemoryEngine {
  constructor(
    private readonly projectId: string,
    private readonly store: MemoryStore,
    /** Current git branch, used for branch-scoped memory. */
    private readonly currentBranch: string | null = null,
  ) {}

  remember(input: RememberInput): RememberResult {
    const type = input.type;
    if (!MEMORY_TYPES.includes(type)) {
      throw new DevMemoryError("INVALID_INPUT", `unknown memory type: ${type}`, { allowed: MEMORY_TYPES });
    }

    const title = input.title.trim();
    const content = input.content.trim();
    if (title.length < 3) throw new DevMemoryError("INVALID_INPUT", "memory title is too short to be useful");
    if (content.length < MIN_CONTENT_LENGTH) {
      throw new DevMemoryError("INVALID_INPUT", "memory content is too short to be worth storing", {
        minimum: MIN_CONTENT_LENGTH,
      });
    }

    const importance = clamp(input.importance ?? DEFAULT_IMPORTANCE[type]);
    const confidence = clamp(input.confidence ?? 0.8);

    // An identical memory is reinforced rather than duplicated - repetition is a
    // signal of importance, not a reason for a second row.
    const existing = this.store.findByHash(this.projectId, type, title, content);
    if (existing) {
      const updated = this.store.update(existing.id, {
        importance: Math.max(existing.importance, importance),
        confidence: Math.max(existing.confidence, confidence),
        tags: mergeUnique(existing.tags, input.tags ?? []),
        paths: mergeUnique(existing.paths, input.paths ?? []),
        symbols: mergeUnique(existing.symbols, input.symbols ?? []),
        status: "active",
      });
      this.store.recordEvent(existing.id, "reinforced");
      return { memory: updated, deduplicated: true };
    }

    const branch = input.branch !== undefined ? input.branch : input.branchSpecific ? this.currentBranch : null;
    const ttlDays = input.expiresInDays ?? (importance >= 0.7 ? undefined : DEFAULT_TTL_DAYS[type]);

    const memory = this.store.insert({
      projectId: this.projectId,
      type,
      title,
      content,
      importance,
      confidence,
      branch: branch ?? null,
      source: input.source ?? null,
      tags: input.tags ?? [],
      paths: input.paths ?? [],
      symbols: input.symbols ?? [],
      expiresAt: ttlDays ? isoInDays(ttlDays) : null,
      supersedes: input.supersedes ?? null,
      ...(type === "DECISION" || input.decision
        ? {
            decision: {
              reason: input.decision?.reason ?? null,
              alternatives: input.decision?.alternatives ?? [],
              affected: input.decision?.affected ?? [],
            },
          }
        : {}),
    });

    return { memory, deduplicated: false };
  }

  /**
   * Retrieval ranked by relevance, importance, recency and confidence. With no
   * query it returns the project's most load-bearing knowledge, which is what a new
   * session or a handing-over agent needs (PRD 32).
   */
  recall(options: RecallOptions = {}): RecalledMemory[] {
    const limit = options.limit ?? 10;
    this.store.archiveExpired(this.projectId);

    const branchScope = options.branch === undefined ? this.currentBranch : options.branch;
    const query = options.query?.trim();

    let candidates: Array<MemoryRecord & { relevance: number }>;

    if (query) {
      const match = toMatchQuery(query);
      candidates = match ? this.store.search(this.projectId, match, limit * 4) : [];

      // Structured filters still apply to full-text hits.
      candidates = candidates.filter((memory) => this.matchesFilters(memory, options, branchScope));

      if (candidates.length === 0) {
        candidates = this.listFallback(options, branchScope, limit).map((memory) => ({ ...memory, relevance: 0.2 }));
      }
    } else {
      candidates = this.listFallback(options, branchScope, limit * 2).map((memory) => ({ ...memory, relevance: 0.5 }));
    }

    const ranked = candidates
      .map((memory) => ({ ...memory, score: this.score(memory, memory.relevance) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    this.store.markAccessed(ranked.map((memory) => memory.id));
    return ranked;
  }

  get(id: string): MemoryRecord | null {
    return this.store.get(id);
  }

  list(query: MemoryQuery = {}): MemoryRecord[] {
    return this.store.list(this.projectId, query);
  }

  /** Decisions, newest first - the record of why the project looks like this (PRD 29). */
  decisions(limit = 25): MemoryRecord[] {
    return this.store.list(this.projectId, { type: "DECISION", limit });
  }

  update(id: string, patch: Parameters<MemoryStore["update"]>[1]): MemoryRecord {
    const existing = this.store.get(id);
    if (!existing || existing.projectId !== this.projectId) {
      throw new DevMemoryError("INVALID_INPUT", `unknown memory: ${id}`);
    }
    return this.store.update(id, patch);
  }

  /**
   * Archives by default: knowledge that stopped being true is still useful history.
   * A hard delete removes the row entirely and is not recoverable (PRD 38).
   */
  forget(id: string, options: { hard?: boolean } = {}): { id: string; removed: boolean; archived: boolean } {
    const existing = this.store.get(id);
    if (!existing || existing.projectId !== this.projectId) {
      throw new DevMemoryError("INVALID_INPUT", `unknown memory: ${id}`);
    }

    if (options.hard) {
      this.store.delete(id);
      return { id, removed: true, archived: false };
    }

    this.store.setStatus(id, "archived");
    return { id, removed: false, archived: true };
  }

  history(id: string, limit = 20) {
    return this.store.events(id, limit);
  }

  stats(): MemoryStats {
    return this.store.stats(this.projectId);
  }

  archiveExpired(): number {
    return this.store.archiveExpired(this.projectId);
  }

  private listFallback(options: RecallOptions, branchScope: string | null, limit: number): MemoryRecord[] {
    return this.store.list(this.projectId, {
      ...(options.type ? { type: options.type } : {}),
      ...(options.includeArchived ? { status: "archived" as const } : {}),
      ...(options.minImportance !== undefined ? { minImportance: options.minImportance } : {}),
      ...(options.tag ? { tag: options.tag } : {}),
      ...(options.path ? { path: options.path } : {}),
      branchScope,
      limit,
    });
  }

  private matchesFilters(memory: MemoryRecord, options: RecallOptions, branchScope: string | null): boolean {
    if (options.type && memory.type !== options.type) return false;
    if (options.minImportance !== undefined && memory.importance < options.minImportance) return false;
    if (options.tag && !memory.tags.includes(options.tag)) return false;
    if (options.path && !memory.paths.includes(options.path)) return false;
    if (memory.branch !== null && memory.branch !== branchScope) return false;
    return true;
  }

  /** Relevance is only part of the answer; importance is what makes memory worth keeping. */
  private score(memory: MemoryRecord, relevance: number): number {
    const ageDays = (Date.now() - Date.parse(memory.updatedAt)) / 86_400_000;
    const recency = Number.isFinite(ageDays) ? Math.pow(0.5, Math.max(0, ageDays) / RECENCY_HALF_LIFE_DAYS) : 0.5;
    const reinforcement = Math.min(0.1, memory.accessCount * 0.01);

    return Number(
      (relevance * 0.5 + memory.importance * 0.3 + recency * 0.1 + memory.confidence * 0.05 + reinforcement).toFixed(4),
    );
  }
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export { nowIso };
