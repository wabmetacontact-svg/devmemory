/** Symbol kinds extracted by v1 parsers (PRD 16). */
export type SymbolType =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "constant"
  | "variable"
  | "component"
  | "hook"
  | "route"
  | "property";

export type ReferenceKind = "call" | "new" | "extends" | "implements" | "jsx" | "decorator";

export type ImportKind = "static" | "dynamic" | "require" | "type" | "export_from";

export interface ParsedSymbol {
  name: string;
  /** Dotted path including the enclosing class, e.g. AuthService.login. */
  qualifiedName: string;
  type: SymbolType;
  signature: string | null;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  /** Index of the parent symbol within the same ParseResult, or null. */
  parentIndex: number | null;
  /** Hash of the symbol's source text - lets a later step diff symbols, not files. */
  hash: string;
}

export interface ParsedImport {
  /** Raw module specifier as written, e.g. "./auth/AuthService" or "react". */
  specifier: string;
  kind: ImportKind;
  line: number;
  /** Named bindings pulled from the module; empty for side-effect imports. */
  names: string[];
}

export interface ParsedReference {
  name: string;
  kind: ReferenceKind;
  line: number;
  /** Index of the symbol that encloses this reference, or null at file scope. */
  fromSymbolIndex: number | null;
}

export interface ParseResult {
  language: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  references: ParsedReference[];
  /** True when tree-sitter reported syntax errors; partial results are still kept. */
  hasErrors: boolean;
}

export interface ParseInput {
  /** Project-relative path - parsers use it for file-convention detection. */
  relativePath: string;
  content: string;
  language: string;
}

/**
 * One implementation per language family (PRD 18). Adding Go or Rust means adding a
 * parser here and registering it; nothing else in the pipeline changes.
 */
export interface LanguageParser {
  readonly name: string;
  readonly languages: readonly string[];
  /** Grammars this parser needs loaded before parse() can run. */
  readonly grammars: readonly string[];
  parse(input: ParseInput): ParseResult;
}

export function emptyParseResult(language: string): ParseResult {
  return { language, symbols: [], imports: [], references: [], hasErrors: false };
}
