import { loadGrammars } from "./tree-sitter-loader.js";
import { typescriptParser } from "./typescript-parser.js";
import { pythonParser } from "./python-parser.js";
import type { LanguageParser, ParseInput, ParseResult } from "./types.js";

/**
 * Language support is a registry (PRD 18): TypeScript, JavaScript and Python ship in
 * v1; Go, Rust, Java and the rest arrive by adding a parser and one entry here.
 */
export class ParserRegistry {
  private readonly byLanguage = new Map<string, LanguageParser>();
  private ready = false;

  constructor(parsers: LanguageParser[] = [typescriptParser, pythonParser]) {
    for (const parser of parsers) {
      for (const language of parser.languages) this.byLanguage.set(language, parser);
    }
  }

  supports(language: string | null): boolean {
    return language !== null && this.byLanguage.has(language);
  }

  get languages(): string[] {
    return [...this.byLanguage.keys()];
  }

  /** Loads every grammar the registered parsers need. Must be awaited before parse(). */
  async prepare(): Promise<void> {
    if (this.ready) return;
    const grammars = new Set<string>();
    for (const parser of new Set(this.byLanguage.values())) {
      for (const grammar of parser.grammars) grammars.add(grammar);
    }
    await loadGrammars([...grammars]);
    this.ready = true;
  }

  get isReady(): boolean {
    return this.ready;
  }

  parse(input: ParseInput): ParseResult | null {
    const parser = this.byLanguage.get(input.language);
    if (!parser) return null;
    return parser.parse(input);
  }
}

export const defaultParserRegistry = new ParserRegistry();
