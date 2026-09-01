import fs from "node:fs";
import path from "node:path";

export interface IgnoreRule {
  source: string;
  pattern: string;
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
}

export interface IgnoreMatcherOptions {
  /** Directory names pruned during the walk. */
  ignoreDirs: string[];
  /** Glob patterns matched against file basenames and relative paths. */
  ignoreFiles: string[];
  /** Additional gitignore-style rules (from .gitignore, .devmemoryignore, config). */
  rules?: string[];
}

/**
 * gitignore-flavoured matcher. It covers the syntax that actually appears in real
 * ignore files - anchoring, directory-only rules, negation, `*`, `**` and `?` -
 * and is only used when git itself cannot enumerate the files (PRD 5.7).
 */
export class IgnoreMatcher {
  private readonly dirs: Set<string>;
  private readonly rules: IgnoreRule[] = [];

  constructor(options: IgnoreMatcherOptions) {
    this.dirs = new Set(options.ignoreDirs.map((dir) => dir.toLowerCase()));
    for (const pattern of options.ignoreFiles) this.addRule(pattern, "config");
    for (const pattern of options.rules ?? []) this.addRule(pattern, "rules");
  }

  addRule(rawPattern: string, source = "rule"): void {
    const line = rawPattern.trim();
    if (!line || line.startsWith("#")) return;

    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }

    let directoryOnly = false;
    if (pattern.endsWith("/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    if (!pattern) return;
    this.rules.push({ source, pattern: line, regex: globToRegex(pattern), negated, directoryOnly });
  }

  /** True when a directory should not be walked at all. */
  isIgnoredDirectory(relativePath: string, name: string): boolean {
    if (this.dirs.has(name.toLowerCase())) return true;
    return this.matches(relativePath, true);
  }

  isIgnoredFile(relativePath: string): boolean {
    return this.matches(relativePath, false);
  }

  /**
   * True when the file, or any directory above it, is ignored. Directory pruning
   * happens naturally during a walk, but a pre-computed candidate list (from git)
   * arrives as flat paths, so ancestors have to be checked explicitly.
   */
  isIgnoredPath(relativePath: string): boolean {
    const segments = relativePath.replace(/\\/g, "/").split("/");
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i] as string;
      const ancestor = segments.slice(0, i + 1).join("/");
      if (this.isIgnoredDirectory(ancestor, name)) return true;
    }
    return this.isIgnoredFile(relativePath);
  }

  /**
   * True when any segment - including the last - names an ignored directory. A file
   * walk knows which entries are directories; a filesystem watcher only gets a path,
   * and "node_modules" arriving on its own must still be ignored.
   */
  isIgnoredAnySegment(relativePath: string): boolean {
    const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      if (this.isIgnoredDirectory(segments.slice(0, i + 1).join("/"), segments[i] as string)) return true;
    }
    return false;
  }

  private matches(relativePath: string, isDirectory: boolean): boolean {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
    let ignored = false;

    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.regex.test(normalized)) ignored = !rule.negated;
    }

    return ignored;
  }

  static loadIgnoreFile(root: string, filename: string): string[] {
    const target = path.join(root, filename);
    try {
      if (!fs.existsSync(target)) return [];
      return fs
        .readFileSync(target, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    } catch {
      return [];
    }
  }
}

/**
 * Compiles one gitignore pattern into a regex tested against the project-relative
 * path. Unanchored patterns match at any depth, matching git's own behaviour.
 */
export function globToRegex(pattern: string): RegExp {
  const anchored = pattern.includes("/") && !pattern.startsWith("**/");
  let working = pattern.startsWith("/") ? pattern.slice(1) : pattern;

  let regex = "";
  for (let i = 0; i < working.length; i++) {
    const char = working[i] as string;
    const next = working[i + 1];

    if (char === "*" && next === "*") {
      // "**/" spans zero or more directories; a trailing "**" spans everything.
      if (working[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
      continue;
    }

    switch (char) {
      case "*":
        regex += "[^/]*";
        break;
      case "?":
        regex += "[^/]";
        break;
      case ".":
      case "+":
      case "(":
      case ")":
      case "|":
      case "^":
      case "$":
      case "{":
      case "}":
      case "[":
      case "]":
      case "\\":
        regex += `\\${char}`;
        break;
      default:
        regex += char;
    }
  }

  // An unanchored pattern may match any path segment; anything matched also
  // ignores everything beneath it.
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${regex}(?:/.*)?$`, process.platform === "win32" ? "i" : "");
}
