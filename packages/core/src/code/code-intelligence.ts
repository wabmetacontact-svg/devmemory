import fs from "node:fs";
import path from "node:path";
import { DevMemoryError, estimateTokens } from "@devmemory/shared";
import type { FileStore, StoredImport, StoredReference, StoredSymbol, SymbolStore } from "@devmemory/indexer";
import { redactSecrets } from "@devmemory/indexer";

export interface DefinitionResult {
  symbol: StoredSymbol;
  source: string | null;
  truncated: boolean;
  tokenEstimate: number;
}

export interface ReferenceGroup {
  path: string;
  references: Array<{ line: number; kind: string; fromSymbol: string | null }>;
}

export interface RelatedCode {
  path: string;
  symbols: StoredSymbol[];
  imports: StoredImport[];
  dependencies: string[];
  dependents: string[];
  tests: string[];
}

export interface ImpactResult {
  path: string;
  exportedSymbols: StoredSymbol[];
  direct: string[];
  transitive: string[];
  tests: string[];
  depth: number;
  truncated: boolean;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\//i;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)test_[^/]+\.py$|_test\.py$/i;

export function looksLikeTest(relativePath: string): boolean {
  return TEST_PATH.test(relativePath) || TEST_FILE.test(relativePath);
}

/**
 * Query layer over the symbol and dependency tables (PRD 16, 17). It answers the
 * questions the code MCP tools ask - where is this defined, who uses it, what breaks
 * if it changes - without ever handing back more source than was requested (PRD 24).
 */
export class CodeIntelligence {
  constructor(
    private readonly projectId: string,
    private readonly root: string,
    private readonly symbols: SymbolStore,
    private readonly files: FileStore,
    private readonly options: { redactSecrets: boolean } = { redactSecrets: true },
  ) {}

  findSymbols(name: string, options: { type?: string; limit?: number; exportedOnly?: boolean } = {}): StoredSymbol[] {
    const exact = this.symbols.findSymbols(this.projectId, {
      name,
      ...(options.type ? { type: options.type } : {}),
      ...(options.exportedOnly ? { exportedOnly: true } : {}),
      limit: options.limit ?? 25,
    });
    if (exact.length > 0) return exact;

    // Fall back to substring matching so a half-remembered name still lands.
    return this.symbols.findSymbols(this.projectId, {
      name,
      fuzzy: true,
      ...(options.type ? { type: options.type } : {}),
      ...(options.exportedOnly ? { exportedOnly: true } : {}),
      limit: options.limit ?? 25,
    });
  }

  /** The best definition for a name, with its source lines. */
  getDefinition(name: string, options: { maxLines?: number } = {}): DefinitionResult | null {
    const candidates = this.findSymbols(name, { limit: 10 });
    if (candidates.length === 0) return null;

    // Prefer an exact, exported definition of a declaring kind.
    const ranked = [...candidates].sort((a, b) => score(b, name) - score(a, name));
    const symbol = ranked[0] as StoredSymbol;
    const maxLines = options.maxLines ?? 200;
    const span = symbol.lineEnd - symbol.lineStart + 1;
    const source = this.readLines(symbol.path, symbol.lineStart, Math.min(symbol.lineEnd, symbol.lineStart + maxLines - 1));

    return {
      symbol,
      source,
      truncated: span > maxLines,
      tokenEstimate: source ? estimateTokens(source) : 0,
    };
  }

  findReferences(name: string, limit = 100): ReferenceGroup[] {
    const references: StoredReference[] = this.symbols.findReferences(this.projectId, name, limit);
    const grouped = new Map<string, ReferenceGroup>();

    for (const reference of references) {
      const group = grouped.get(reference.path) ?? { path: reference.path, references: [] };
      group.references.push({ line: reference.line, kind: reference.kind, fromSymbol: reference.fromSymbol });
      grouped.set(reference.path, group);
    }

    return [...grouped.values()];
  }

  relatedCode(relativePath: string, options: { symbolLimit?: number } = {}): RelatedCode {
    const record = this.files.get(this.projectId, relativePath);
    if (!record || record.status !== "active") {
      throw new DevMemoryError("INVALID_INPUT", `file is not indexed: ${relativePath}`, { projectId: this.projectId });
    }

    const dependents = this.symbols.dependents(this.projectId, relativePath).map((edge) => edge.path);
    return {
      path: relativePath,
      symbols: this.symbols.symbolsInFile(this.projectId, relativePath, options.symbolLimit ?? 100),
      imports: this.symbols.importsOf(this.projectId, relativePath),
      dependencies: this.symbols.dependencies(this.projectId, relativePath).map((edge) => edge.path),
      dependents: dependents.filter((candidate) => !looksLikeTest(candidate)),
      tests: dependents.filter((candidate) => looksLikeTest(candidate)),
    };
  }

  /**
   * Everything that could break when a file changes: its exported symbols, the files
   * that import it, and how far the blast radius reaches (PRD 17, 36).
   */
  impact(relativePath: string, options: { depth?: number; limit?: number } = {}): ImpactResult {
    const record = this.files.get(this.projectId, relativePath);
    if (!record || record.status !== "active") {
      throw new DevMemoryError("INVALID_INPUT", `file is not indexed: ${relativePath}`, { projectId: this.projectId });
    }

    const maxDepth = Math.min(options.depth ?? 3, 10);
    const limit = options.limit ?? 200;

    const direct = this.symbols.dependents(this.projectId, relativePath).map((edge) => edge.path);
    const visited = new Set<string>([relativePath, ...direct]);
    const transitive: string[] = [];
    let frontier = [...direct];
    let truncated = false;

    for (let depth = 1; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const edge of this.symbols.dependents(this.projectId, current)) {
          if (visited.has(edge.path)) continue;
          visited.add(edge.path);
          if (visited.size > limit) {
            truncated = true;
            continue;
          }
          transitive.push(edge.path);
          next.push(edge.path);
        }
      }
      frontier = next;
    }

    const all = [...direct, ...transitive];
    return {
      path: relativePath,
      exportedSymbols: this.symbols
        .symbolsInFile(this.projectId, relativePath, 200)
        .filter((symbol) => symbol.exported),
      direct: direct.filter((candidate) => !looksLikeTest(candidate)),
      transitive: transitive.filter((candidate) => !looksLikeTest(candidate)),
      tests: all.filter((candidate) => looksLikeTest(candidate)),
      depth: maxDepth,
      truncated,
    };
  }

  /** Test files reachable from the given source files through the dependency graph (PRD 36). */
  affectedTests(relativePaths: string[], options: { depth?: number } = {}): string[] {
    const tests = new Set<string>();
    for (const relativePath of relativePaths) {
      if (looksLikeTest(relativePath)) {
        tests.add(relativePath);
        continue;
      }
      const record = this.files.get(this.projectId, relativePath);
      if (!record || record.status !== "active") continue;
      for (const test of this.impact(relativePath, { depth: options.depth ?? 3 }).tests) tests.add(test);
    }
    return [...tests].sort();
  }

  /** Reads a line range from a project file, redacting secrets on the way out. */
  private readLines(relativePath: string, start: number, end: number): string | null {
    const absolute = path.resolve(this.root, relativePath);
    if (!absolute.startsWith(path.resolve(this.root))) return null;

    try {
      const content = fs.readFileSync(absolute, "utf8");
      const lines = content.split(/\r?\n/).slice(Math.max(0, start - 1), end);
      const text = lines.join("\n");
      return this.options.redactSecrets ? redactSecrets(text).text : text;
    } catch {
      return null;
    }
  }
}

const DECLARATION_KINDS = new Set(["class", "function", "interface", "type", "enum", "component", "hook", "method"]);

function score(symbol: StoredSymbol, query: string): number {
  let value = 0;
  if (symbol.name === query) value += 10;
  if (symbol.qualifiedName === query) value += 8;
  if (symbol.name.toLowerCase() === query.toLowerCase()) value += 4;
  if (symbol.exported) value += 3;
  if (DECLARATION_KINDS.has(symbol.type)) value += 2;
  if (symbol.type === "variable" || symbol.type === "property") value -= 2;
  return value;
}
