import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import { DevMemoryError } from "@devmemory/shared";

const require = createRequire(import.meta.url);

/** Grammar name -> wasm file shipped by @vscode/tree-sitter-wasm. */
const GRAMMAR_FILES: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
};

let initPromise: Promise<void> | undefined;
const languages = new Map<string, Language>();
const failed = new Map<string, string>();

function wasmDirectory(): string {
  const packageJson = require.resolve("@vscode/tree-sitter-wasm/package.json");
  return path.join(path.dirname(packageJson), "wasm");
}

/**
 * Tree-sitter runs as WebAssembly rather than a native addon, so installing
 * DevMemory still needs no compiler (PRD 12 leaves the stack free to choose how).
 * Initialisation and grammar loading are async; parsing afterwards is synchronous.
 */
export async function initTreeSitter(): Promise<void> {
  initPromise ??= Parser.init();
  await initPromise;
}

export async function loadGrammar(grammar: string): Promise<Language | null> {
  const cached = languages.get(grammar);
  if (cached) return cached;
  if (failed.has(grammar)) return null;

  const file = GRAMMAR_FILES[grammar];
  if (!file) {
    failed.set(grammar, "unknown grammar");
    return null;
  }

  await initTreeSitter();
  const wasmPath = path.join(wasmDirectory(), file);
  if (!fs.existsSync(wasmPath)) {
    failed.set(grammar, `wasm not found: ${wasmPath}`);
    return null;
  }

  try {
    const language = await Language.load(wasmPath);
    languages.set(grammar, language);
    return language;
  } catch (error) {
    // A missing or incompatible grammar degrades to "no symbols for this language"
    // rather than failing the whole index run (PRD 60).
    failed.set(grammar, error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function loadGrammars(grammars: readonly string[]): Promise<void> {
  await Promise.all(grammars.map((grammar) => loadGrammar(grammar)));
}

export function getLoadedGrammar(grammar: string): Language | null {
  return languages.get(grammar) ?? null;
}

export function grammarError(grammar: string): string | null {
  return failed.get(grammar) ?? null;
}

export function availableGrammars(): string[] {
  return Object.keys(GRAMMAR_FILES);
}

const parsers = new Map<string, Parser>();

/** Reuses one Parser per grammar; creating them is not free. */
export function parserFor(grammar: string): Parser {
  const existing = parsers.get(grammar);
  if (existing) return existing;

  const language = languages.get(grammar);
  if (!language) {
    throw new DevMemoryError("INDEX_ERROR", `grammar not loaded: ${grammar}`, {
      reason: failed.get(grammar) ?? "loadGrammar was not awaited",
    });
  }

  const parser = new Parser();
  parser.setLanguage(language);
  parsers.set(grammar, parser);
  return parser;
}

/** Test hook: drops cached parsers so a run starts from a known state. */
export function resetParsers(): void {
  for (const parser of parsers.values()) parser.delete();
  parsers.clear();
}
