import fs from "node:fs";
import path from "node:path";
import type { WorkspacePackage } from "./workspace-packages.js";

export interface ResolvedImport {
  relativePath: string | null;
  isExternal: boolean;
  packageName: string | null;
}

export interface ImportResolverOptions {
  /** Project-relative paths of every indexed file. */
  files: Iterable<string>;
  /** tsconfig-style path aliases: "@/*" -> ["src/*"]. */
  aliases?: Record<string, string[]>;
  /** Packages belonging to this repository, so monorepo imports stay internal. */
  workspacePackages?: WorkspacePackage[];
}

const TS_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];
const TS_INDEX_FILES = TS_EXTENSIONS.map((extension) => `index${extension}`);
const PYTHON_CANDIDATES = [".py", ".pyi"];

/**
 * Maps an import specifier onto a file in the project, or marks it external
 * (PRD 17). Deterministic and filesystem-free: it only consults the set of paths
 * already in the index, so resolution can never drag in an ignored file.
 */
export class ImportResolver {
  private readonly files: Set<string>;
  private readonly aliases: Array<{ prefix: string; targets: string[]; wildcard: boolean }> = [];
  private readonly workspacePackages: WorkspacePackage[];

  constructor(options: ImportResolverOptions) {
    this.files = new Set([...options.files].map((file) => file.replace(/\\/g, "/")));
    // Longest name first so "@scope/ui-core" wins over "@scope/ui".
    this.workspacePackages = [...(options.workspacePackages ?? [])].sort((a, b) => b.name.length - a.name.length);
    for (const [pattern, targets] of Object.entries(options.aliases ?? {})) {
      const wildcard = pattern.endsWith("*");
      this.aliases.push({
        prefix: wildcard ? pattern.slice(0, -1) : pattern,
        targets: targets.map((target) => (target.endsWith("*") ? target.slice(0, -1) : target)),
        wildcard,
      });
    }
  }

  resolve(specifier: string, fromRelativePath: string, language: string | null): ResolvedImport {
    if (language === "python") return this.resolvePython(specifier, fromRelativePath);
    return this.resolveJs(specifier, fromRelativePath);
  }

  private resolveJs(specifier: string, fromRelativePath: string): ResolvedImport {
    if (specifier.startsWith("node:")) return external("node");

    if (specifier.startsWith(".")) {
      const base = path.posix.join(path.posix.dirname(toPosix(fromRelativePath)), specifier);
      const match = this.matchJsFile(normalizeRelative(base));
      return match ? internal(match) : { relativePath: null, isExternal: false, packageName: null };
    }

    if (specifier.startsWith("/")) {
      const match = this.matchJsFile(normalizeRelative(specifier.slice(1)));
      if (match) return internal(match);
    }

    for (const alias of this.aliases) {
      if (!specifier.startsWith(alias.prefix)) continue;
      const remainder = alias.wildcard ? specifier.slice(alias.prefix.length) : "";
      for (const target of alias.targets) {
        const candidate = normalizeRelative(path.posix.join(target, remainder));
        const match = this.matchJsFile(candidate);
        if (match) return internal(match);
      }
    }

    const workspaceMatch = this.resolveWorkspacePackage(specifier);
    if (workspaceMatch) return internal(workspaceMatch);

    return external(packageNameOf(specifier));
  }

  /** "@devmemory/core" -> "packages/core/src/index.ts" in this repository. */
  private resolveWorkspacePackage(specifier: string): string | null {
    for (const workspacePackage of this.workspacePackages) {
      if (specifier !== workspacePackage.name && !specifier.startsWith(`${workspacePackage.name}/`)) continue;

      const subpath = specifier.slice(workspacePackage.name.length).replace(/^\//, "");
      if (subpath) {
        for (const base of [path.posix.join(workspacePackage.directory, "src", subpath), path.posix.join(workspacePackage.directory, subpath)]) {
          const match = this.matchJsFile(normalizeRelative(base));
          if (match) return match;
        }
      }

      const candidates = [
        workspacePackage.source,
        "src/index.ts",
        "src/index.tsx",
        "src/index.js",
        "src/main.ts",
        "index.ts",
        "index.js",
      ].filter((candidate): candidate is string => Boolean(candidate));

      for (const candidate of candidates) {
        const match = this.matchJsFile(normalizeRelative(path.posix.join(workspacePackage.directory, candidate)));
        if (match) return match;
      }
    }
    return null;
  }

  private matchJsFile(candidate: string): string | null {
    if (!candidate || candidate.startsWith("..")) return null;
    if (this.files.has(candidate)) return candidate;

    for (const extension of TS_EXTENSIONS) {
      const withExtension = `${candidate}${extension}`;
      if (this.files.has(withExtension)) return withExtension;
    }

    // "./auth" may mean "./auth/index.ts"
    for (const indexFile of TS_INDEX_FILES) {
      const nested = path.posix.join(candidate, indexFile);
      if (this.files.has(nested)) return nested;
    }

    // "./AuthService.js" in an ESM TypeScript project means "./AuthService.ts"
    const jsExtension = /\.(js|jsx|mjs|cjs)$/.exec(candidate);
    if (jsExtension) {
      const stem = candidate.slice(0, -jsExtension[0].length);
      for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
        if (this.files.has(`${stem}${extension}`)) return `${stem}${extension}`;
      }
    }

    return null;
  }

  private resolvePython(specifier: string, fromRelativePath: string): ResolvedImport {
    const fromDir = path.posix.dirname(toPosix(fromRelativePath));

    if (specifier.startsWith(".")) {
      const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 1;
      const moduleTail = specifier.slice(leadingDots).replace(/\./g, "/");
      const upwards = "../".repeat(Math.max(0, leadingDots - 1));
      const base = normalizeRelative(path.posix.join(fromDir, upwards, moduleTail));
      const match = this.matchPythonFile(base);
      return match ? internal(match) : { relativePath: null, isExternal: false, packageName: null };
    }

    const modulePath = specifier.replace(/\./g, "/");
    // A module can be rooted at the project root or under a source directory.
    const roots = ["", "src", "app", "lib", firstSegment(fromDir)];
    for (const root of roots) {
      const match = this.matchPythonFile(normalizeRelative(path.posix.join(root, modulePath)));
      if (match) return internal(match);
    }

    return external(specifier.split(".")[0] ?? specifier);
  }

  private matchPythonFile(candidate: string): string | null {
    if (!candidate || candidate.startsWith("..")) return null;
    for (const extension of PYTHON_CANDIDATES) {
      if (this.files.has(`${candidate}${extension}`)) return `${candidate}${extension}`;
    }
    for (const extension of PYTHON_CANDIDATES) {
      const initFile = path.posix.join(candidate, `__init__${extension}`);
      if (this.files.has(initFile)) return initFile;
    }
    return null;
  }
}

/** Reads tsconfig path aliases, tolerating comments and trailing commas. */
export function loadTsconfigAliases(root: string): Record<string, string[]> {
  for (const filename of ["tsconfig.json", "jsconfig.json", "tsconfig.base.json"]) {
    const file = path.join(root, filename);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(stripJsonComments(raw)) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const options = parsed.compilerOptions;
      if (!options?.paths) continue;

      const baseUrl = (options.baseUrl ?? ".").replace(/^\.\//, "").replace(/^\.$/, "");
      const aliases: Record<string, string[]> = {};
      for (const [pattern, targets] of Object.entries(options.paths)) {
        aliases[pattern] = targets.map((target) =>
          normalizeRelative(path.posix.join(baseUrl, target.replace(/^\.\//, ""))),
        );
      }
      return aliases;
    } catch {
      // A malformed tsconfig costs alias resolution, nothing more.
    }
  }
  return {};
}

function stripJsonComments(text: string): string {
  return text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment: string | undefined) =>
      comment ? "" : match,
    )
    .replace(/,(\s*[}\]])/g, "$1");
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeRelative(value: string): string {
  const normalized = path.posix.normalize(toPosix(value)).replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}

function firstSegment(value: string): string {
  return toPosix(value).split("/")[0] ?? "";
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}

function internal(relativePath: string): ResolvedImport {
  return { relativePath, isExternal: false, packageName: null };
}

function external(packageName: string): ResolvedImport {
  return { relativePath: null, isExternal: true, packageName };
}
