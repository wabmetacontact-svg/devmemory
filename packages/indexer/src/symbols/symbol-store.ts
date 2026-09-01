import type { SqliteDatabase } from "@samirthakur024/storage";
import type { ParseResult } from "../ast/types.js";
import type { ImportResolver } from "../dependencies/import-resolver.js";
import { SearchStore } from "../search/search-store.js";
import { redactSecrets } from "../security/sensitive.js";

export interface StoredSymbol {
  id: number;
  fileId: number;
  path: string;
  name: string;
  qualifiedName: string;
  type: string;
  signature: string | null;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  language: string | null;
  hash: string;
}

export interface StoredReference {
  id: number;
  path: string;
  name: string;
  kind: string;
  line: number;
  fromSymbol: string | null;
}

export interface StoredImport {
  id: number;
  fromPath: string;
  specifier: string;
  kind: string;
  line: number;
  names: string[];
  isExternal: boolean;
  packageName: string | null;
  resolvedPath: string | null;
}

export interface FileEdge {
  fileId: number;
  path: string;
  via: string;
}

export interface CodeStats {
  symbols: number;
  byType: Array<{ type: string; count: number }>;
  imports: number;
  internalEdges: number;
  externalPackages: number;
  filesParsed: number;
  parseErrors: number;
}

export interface SymbolSearchOptions {
  name?: string;
  type?: string;
  exportedOnly?: boolean;
  limit?: number;
  /** Match anywhere in the name instead of requiring an exact match. */
  fuzzy?: boolean;
}

/**
 * Storage and graph queries for symbols, imports and references (PRD 16, 17).
 * Every statement is scoped by project_id even though each project owns its
 * database file - the same defence-in-depth rule as the file index (PRD 11).
 */
export class SymbolStore {
  private readonly search: SearchStore;

  constructor(private readonly db: SqliteDatabase) {
    this.search = new SearchStore(db);
  }

  /** Replaces everything derived from one file. Called only when its hash changed. */
  replaceFileAnalysis(
    projectId: string,
    fileId: number,
    language: string | null,
    result: ParseResult,
    relativePath: string,
    resolver: ImportResolver,
  ): { symbols: number } {
    this.clearFile(projectId, fileId);

    const insertSymbol = this.db.prepare(
      `INSERT INTO symbols (project_id, file_id, name, qualified_name, type, signature, line_start, line_end, parent_id, exported, language, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const symbolIds: number[] = [];
    for (const symbol of result.symbols) {
      const parentId = symbol.parentIndex === null ? null : (symbolIds[symbol.parentIndex] ?? null);

      // A signature is source text, so `const token = "ghp_..."` would otherwise be
      // stored verbatim and returned by find_symbol and get_context. Redact before
      // it is persisted, which also keeps it out of the search index (PRD 37).
      const signature = symbol.signature === null ? null : redactSecrets(symbol.signature).text;

      const inserted = insertSymbol.run(
        projectId,
        fileId,
        symbol.name,
        symbol.qualifiedName,
        symbol.type,
        signature,
        symbol.lineStart,
        symbol.lineEnd,
        parentId,
        symbol.exported ? 1 : 0,
        language,
        symbol.hash,
      );
      const symbolId = Number(inserted.lastInsertRowid);
      symbolIds.push(symbolId);
      this.search.indexSymbol(symbolId, symbol.name, symbol.qualifiedName, signature, relativePath);
    }

    const insertImport = this.db.prepare(
      `INSERT INTO imports (project_id, file_id, specifier, kind, line, names, is_external, package_name, resolved_file_id, resolved_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const lookupFile = this.db.prepare(
      "SELECT id FROM files WHERE project_id = ? AND relative_path = ? AND status = 'active'",
    );

    for (const entry of result.imports) {
      const resolved = resolver.resolve(entry.specifier, relativePath, language);
      const resolvedFileId = resolved.relativePath
        ? (lookupFile.get<{ id: number }>(projectId, resolved.relativePath)?.id ?? null)
        : null;

      insertImport.run(
        projectId,
        fileId,
        entry.specifier,
        entry.kind,
        entry.line,
        JSON.stringify(entry.names),
        resolved.isExternal ? 1 : 0,
        resolved.packageName,
        resolvedFileId,
        resolved.relativePath,
      );
    }

    const insertReference = this.db.prepare(
      "INSERT INTO symbol_references (project_id, file_id, name, kind, line, from_symbol_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const reference of result.references) {
      const fromSymbolId = reference.fromSymbolIndex === null ? null : (symbolIds[reference.fromSymbolIndex] ?? null);
      insertReference.run(projectId, fileId, reference.name, reference.kind, reference.line, fromSymbolId);
    }

    this.db
      .prepare("UPDATE files SET parse_status = ?, symbol_count = ? WHERE id = ?")
      .run(result.hasErrors ? "partial" : "ok", result.symbols.length, fileId);

    return { symbols: result.symbols.length };
  }

  clearFile(projectId: string, fileId: number): void {
    this.search.removeSymbolsForFile(fileId);
    this.db.prepare("DELETE FROM symbols WHERE project_id = ? AND file_id = ?").run(projectId, fileId);
    this.db.prepare("DELETE FROM imports WHERE project_id = ? AND file_id = ?").run(projectId, fileId);
    this.db.prepare("DELETE FROM symbol_references WHERE project_id = ? AND file_id = ?").run(projectId, fileId);
    this.db.prepare("UPDATE files SET parse_status = NULL, symbol_count = 0 WHERE id = ?").run(fileId);
  }

  markUnparsed(projectId: string, fileId: number, status: string): void {
    this.db.prepare("UPDATE files SET parse_status = ? WHERE id = ? AND project_id = ?").run(status, fileId, projectId);
  }

  /**
   * Import rows are written before every file is necessarily indexed, so unresolved
   * internal specifiers are re-checked once at the end of a run.
   */
  relinkImports(projectId: string): number {
    const result = this.db
      .prepare(
        `UPDATE imports
            SET resolved_file_id = (
              SELECT f.id FROM files f
               WHERE f.project_id = imports.project_id
                 AND f.relative_path = imports.resolved_path
                 AND f.status = 'active'
            )
          WHERE project_id = ?
            AND resolved_path IS NOT NULL
            AND (resolved_file_id IS NULL
                 OR resolved_file_id NOT IN (SELECT id FROM files WHERE project_id = imports.project_id))`,
      )
      .run(projectId);
    return Number(result.changes);
  }

  findSymbols(projectId: string, options: SymbolSearchOptions = {}): StoredSymbol[] {
    const clauses = ["s.project_id = ?", "f.status = 'active'"];
    const params: Array<string | number> = [projectId];

    if (options.name) {
      if (options.fuzzy) {
        clauses.push("(s.name LIKE ? ESCAPE '\\' OR s.qualified_name LIKE ? ESCAPE '\\')");
        const like = `%${escapeLike(options.name)}%`;
        params.push(like, like);
      } else {
        clauses.push("(s.name = ? COLLATE NOCASE OR s.qualified_name = ? COLLATE NOCASE)");
        params.push(options.name, options.name);
      }
    }
    if (options.type) {
      clauses.push("s.type = ?");
      params.push(options.type);
    }
    if (options.exportedOnly) clauses.push("s.exported = 1");

    params.push(options.limit ?? 50);

    return this.db
      .prepare(
        `SELECT s.*, f.relative_path AS path
           FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY s.exported DESC, LENGTH(s.name) ASC, s.name ASC
          LIMIT ?`,
      )
      .all<Record<string, unknown>>(...(params as never[]))
      .map(toSymbol);
  }

  symbolsInFile(projectId: string, relativePath: string, limit = 200): StoredSymbol[] {
    return this.db
      .prepare(
        `SELECT s.*, f.relative_path AS path
           FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.project_id = ? AND f.relative_path = ?
          ORDER BY s.line_start ASC
          LIMIT ?`,
      )
      .all<Record<string, unknown>>(projectId, relativePath, limit)
      .map(toSymbol);
  }

  findReferences(projectId: string, name: string, limit = 100): StoredReference[] {
    return this.db
      .prepare(
        `SELECT r.id, r.name, r.kind, r.line, f.relative_path AS path, s.qualified_name AS from_symbol
           FROM symbol_references r
           JOIN files f ON f.id = r.file_id
      LEFT JOIN symbols s ON s.id = r.from_symbol_id
          WHERE r.project_id = ? AND r.name = ? COLLATE NOCASE AND f.status = 'active'
          ORDER BY f.relative_path, r.line
          LIMIT ?`,
      )
      .all<Record<string, unknown>>(projectId, name, limit)
      .map((row) => ({
        id: Number(row.id),
        path: String(row.path),
        name: String(row.name),
        kind: String(row.kind),
        line: Number(row.line),
        fromSymbol: (row.from_symbol as string | null) ?? null,
      }));
  }

  importsOf(projectId: string, relativePath: string): StoredImport[] {
    return this.db
      .prepare(
        `SELECT i.*, f.relative_path AS from_path
           FROM imports i JOIN files f ON f.id = i.file_id
          WHERE i.project_id = ? AND f.relative_path = ?
          ORDER BY i.line`,
      )
      .all<Record<string, unknown>>(projectId, relativePath)
      .map(toImport);
  }

  /** Files this file imports. */
  dependencies(projectId: string, relativePath: string): FileEdge[] {
    return this.db
      .prepare(
        `SELECT DISTINCT target.id AS file_id, target.relative_path AS path, i.kind AS via
           FROM imports i
           JOIN files source ON source.id = i.file_id
           JOIN files target ON target.id = i.resolved_file_id
          WHERE i.project_id = ? AND source.relative_path = ? AND target.status = 'active'
          ORDER BY target.relative_path`,
      )
      .all<Record<string, unknown>>(projectId, relativePath)
      .map(toEdge);
  }

  /** Files that import this file. */
  dependents(projectId: string, relativePath: string): FileEdge[] {
    return this.db
      .prepare(
        `SELECT DISTINCT source.id AS file_id, source.relative_path AS path, i.kind AS via
           FROM imports i
           JOIN files source ON source.id = i.file_id
           JOIN files target ON target.id = i.resolved_file_id
          WHERE i.project_id = ? AND target.relative_path = ? AND source.status = 'active'
          ORDER BY source.relative_path`,
      )
      .all<Record<string, unknown>>(projectId, relativePath)
      .map(toEdge);
  }

  externalPackages(projectId: string, limit = 50): Array<{ package: string; files: number }> {
    return this.db
      .prepare(
        `SELECT package_name AS package, COUNT(DISTINCT file_id) AS files
           FROM imports
          WHERE project_id = ? AND is_external = 1 AND package_name IS NOT NULL
          GROUP BY package_name
          ORDER BY files DESC
          LIMIT ?`,
      )
      .all<{ package: string; files: number }>(projectId, limit);
  }

  stats(projectId: string): CodeStats {
    const symbols = this.db
      .prepare("SELECT COUNT(*) AS n FROM symbols WHERE project_id = ?")
      .get<{ n: number }>(projectId)?.n ?? 0;

    const byType = this.db
      .prepare(
        "SELECT type, COUNT(*) AS count FROM symbols WHERE project_id = ? GROUP BY type ORDER BY count DESC",
      )
      .all<{ type: string; count: number }>(projectId);

    const importTotals = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN resolved_file_id IS NOT NULL THEN 1 ELSE 0 END) AS internal,
                COUNT(DISTINCT CASE WHEN is_external = 1 THEN package_name END) AS packages
           FROM imports WHERE project_id = ?`,
      )
      .get<{ total: number; internal: number | null; packages: number }>(projectId);

    const parse = this.db
      .prepare(
        `SELECT SUM(CASE WHEN parse_status IS NOT NULL THEN 1 ELSE 0 END) AS parsed,
                SUM(CASE WHEN parse_status IN ('partial', 'error') THEN 1 ELSE 0 END) AS errors
           FROM files WHERE project_id = ? AND status = 'active'`,
      )
      .get<{ parsed: number | null; errors: number | null }>(projectId);

    return {
      symbols,
      byType,
      imports: importTotals?.total ?? 0,
      internalEdges: importTotals?.internal ?? 0,
      externalPackages: importTotals?.packages ?? 0,
      filesParsed: parse?.parsed ?? 0,
      parseErrors: parse?.errors ?? 0,
    };
  }
}

function toSymbol(row: Record<string, unknown>): StoredSymbol {
  return {
    id: Number(row.id),
    fileId: Number(row.file_id),
    path: String(row.path),
    name: String(row.name),
    qualifiedName: String(row.qualified_name),
    type: String(row.type),
    signature: (row.signature as string | null) ?? null,
    lineStart: Number(row.line_start),
    lineEnd: Number(row.line_end),
    exported: Number(row.exported) === 1,
    language: (row.language as string | null) ?? null,
    hash: String(row.hash),
  };
}

function toImport(row: Record<string, unknown>): StoredImport {
  let names: string[] = [];
  try {
    const parsed = JSON.parse(String(row.names)) as unknown;
    if (Array.isArray(parsed)) names = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    names = [];
  }

  return {
    id: Number(row.id),
    fromPath: String(row.from_path),
    specifier: String(row.specifier),
    kind: String(row.kind),
    line: Number(row.line),
    names,
    isExternal: Number(row.is_external) === 1,
    packageName: (row.package_name as string | null) ?? null,
    resolvedPath: (row.resolved_path as string | null) ?? null,
  };
}

function toEdge(row: Record<string, unknown>): FileEdge {
  return { fileId: Number(row.file_id), path: String(row.path), via: String(row.via) };
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}
