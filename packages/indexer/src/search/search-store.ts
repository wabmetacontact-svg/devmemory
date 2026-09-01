import type { SqliteDatabase } from "@samirthakur024/storage";

export interface FileSearchHit {
  fileId: number;
  path: string;
  language: string | null;
  /** Normalised 0-1 relevance, 1 being the best hit in this result set. */
  relevance: number;
}

export interface SymbolSearchHit {
  symbolId: number;
  name: string;
  qualifiedName: string;
  type: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  exported: boolean;
  relevance: number;
}

/** Words that carry no signal in a code search and only dilute bm25 scores. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for", "from", "get",
  "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "need", "of", "on", "or", "our",
  "please", "so", "than", "that", "the", "then", "there", "these", "they", "this", "to", "up", "use",
  "want", "was", "we", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]{1,}/g;
const MAX_IDENTIFIERS_PER_FILE = 4000;

/**
 * Full-text search over file contents and symbols (PRD 21, 53), backed by SQLite
 * FTS5. The tables are contentless: terms are indexed, the source text is not
 * copied into the database, and snippets are read from the file on demand so they
 * can never go stale.
 */
export class SearchStore {
  constructor(private readonly db: SqliteDatabase) {}

  indexFile(fileId: number, relativePath: string, content: string): void {
    this.removeFile(fileId);
    this.db
      .prepare("INSERT INTO file_search (rowid, path, content, identifiers) VALUES (?, ?, ?, ?)")
      .run(fileId, relativePath, content, identifierStream(content));
  }

  removeFile(fileId: number): void {
    this.db.prepare("DELETE FROM file_search WHERE rowid = ?").run(fileId);
  }

  indexSymbol(symbolId: number, name: string, qualifiedName: string, signature: string | null, path: string): void {
    this.db
      .prepare("INSERT INTO symbol_search (rowid, name, qualified_name, signature, path) VALUES (?, ?, ?, ?, ?)")
      .run(symbolId, splitIdentifier(name), splitIdentifier(qualifiedName), signature ?? "", path);
  }

  removeSymbol(symbolId: number): void {
    this.db.prepare("DELETE FROM symbol_search WHERE rowid = ?").run(symbolId);
  }

  removeSymbolsForFile(fileId: number): void {
    const ids = this.db.prepare("SELECT id FROM symbols WHERE file_id = ?").all<{ id: number }>(fileId);
    for (const row of ids) this.removeSymbol(row.id);
  }

  searchFiles(projectId: string, query: string, limit = 25): FileSearchHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];

    const rows = this.db
      .prepare(
        `SELECT f.id AS file_id, f.relative_path AS path, f.language,
                bm25(file_search, 8.0, 1.0, 4.0) AS score
           FROM file_search
           JOIN files f ON f.id = file_search.rowid
          WHERE file_search MATCH ? AND f.project_id = ? AND f.status = 'active'
          ORDER BY score
          LIMIT ?`,
      )
      .all<{ file_id: number; path: string; language: string | null; score: number }>(match, projectId, limit);

    return normalise(rows).map((row) => ({
      fileId: Number(row.file_id),
      path: String(row.path),
      language: row.language,
      relevance: row.relevance,
    }));
  }

  searchSymbols(projectId: string, query: string, limit = 25): SymbolSearchHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];

    const rows = this.db
      .prepare(
        `SELECT s.id AS symbol_id, s.name, s.qualified_name, s.type, s.line_start, s.line_end,
                s.signature, s.exported, f.relative_path AS path,
                bm25(symbol_search, 10.0, 6.0, 1.0, 2.0) AS score
           FROM symbol_search
           JOIN symbols s ON s.id = symbol_search.rowid
           JOIN files f ON f.id = s.file_id
          WHERE symbol_search MATCH ? AND s.project_id = ? AND f.status = 'active'
          ORDER BY score
          LIMIT ?`,
      )
      .all<Record<string, unknown> & { score: number }>(match, projectId, limit);

    return normalise(rows).map((row) => ({
      symbolId: Number(row.symbol_id),
      name: String(row.name),
      qualifiedName: String(row.qualified_name),
      type: String(row.type),
      path: String(row.path),
      lineStart: Number(row.line_start),
      lineEnd: Number(row.line_end),
      signature: (row.signature as string | null) ?? null,
      exported: Number(row.exported) === 1,
      relevance: row.relevance,
    }));
  }

  stats(): { files: number; symbols: number } {
    const files = this.db.prepare("SELECT COUNT(*) AS n FROM file_search").get<{ n: number }>()?.n ?? 0;
    const symbols = this.db.prepare("SELECT COUNT(*) AS n FROM symbol_search").get<{ n: number }>()?.n ?? 0;
    return { files, symbols };
  }

  clear(): void {
    this.db.exec("DELETE FROM file_search");
    this.db.exec("DELETE FROM symbol_search");
  }
}

/**
 * Turns a natural-language request into an FTS5 MATCH expression. Every term is
 * quoted (so punctuation can never become operator syntax), camel/snake names are
 * expanded into their parts, and each term also matches as a prefix.
 */
export function toMatchQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;

  const clauses = terms.flatMap((term) => {
    const quoted = `"${term.replace(/"/g, "")}"`;
    return term.length >= 4 ? [quoted, `${quoted} *`] : [quoted];
  });

  return [...new Set(clauses)].join(" OR ");
}

export function queryTerms(query: string): string[] {
  const raw = query.toLowerCase().match(/[a-z0-9_$]{2,}/g) ?? [];
  const terms = new Set<string>();

  for (const token of raw) {
    if (STOPWORDS.has(token)) continue;
    terms.add(token);
    // "verifyPayment" and "verify_payment" should also match "verify" and "payment".
    for (const part of splitIdentifier(token).split(" ")) {
      if (part.length >= 3 && !STOPWORDS.has(part)) terms.add(part);
    }
  }

  return [...terms].slice(0, 24);
}

/** camelCase / snake_case / kebab-case -> space-separated words, lowercased. */
export function splitIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._\-$/]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct identifiers in a file, split into words, for recall on natural phrasing. */
function identifierStream(content: string): string {
  const words = new Set<string>();
  for (const match of content.matchAll(IDENTIFIER)) {
    if (words.size >= MAX_IDENTIFIERS_PER_FILE) break;
    for (const part of splitIdentifier(match[0]).split(" ")) {
      if (part.length >= 3) words.add(part);
    }
  }
  return [...words].join(" ");
}

/** bm25 returns negative scores where lower is better; map them onto 0-1. */
function normalise<T extends { score: number }>(rows: T[]): Array<T & { relevance: number }> {
  if (rows.length === 0) return [];
  const scores = rows.map((row) => row.score);
  const best = Math.min(...scores);
  const worst = Math.max(...scores);
  const span = worst - best;

  return rows.map((row) => ({
    ...row,
    relevance: span === 0 ? 1 : Number((1 - (row.score - best) / span).toFixed(4)),
  }));
}
