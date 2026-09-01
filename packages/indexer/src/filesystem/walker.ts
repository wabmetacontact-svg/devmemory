import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizePath, relativePath } from "@samirthakur024/shared";
import { IgnoreMatcher } from "./ignore.js";
import { extensionOf, isBinaryExtension, languageOf } from "./language.js";
import { isSensitiveFile } from "../security/sensitive.js";

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  extension: string | null;
  language: string | null;
  size: number;
  lastModified: number;
}

export type SkipReason = "ignored" | "sensitive" | "too_large" | "binary" | "unreadable" | "limit";

export interface ScanResult {
  files: ScannedFile[];
  skipped: number;
  skippedByReason: Record<SkipReason, number>;
  truncated: boolean;
}

export interface ScanOptions {
  matcher: IgnoreMatcher;
  maxFileSizeBytes: number;
  maxFiles: number;
  followSymlinks: boolean;
  /**
   * Optional pre-computed candidate list (project-relative paths). The git-backed
   * enumerator supplies this so .gitignore semantics come from git itself.
   */
  candidates?: string[];
}

function emptyReasons(): Record<SkipReason, number> {
  return { ignored: 0, sensitive: 0, too_large: 0, binary: 0, unreadable: 0, limit: 0 };
}

/** Walks a project root and returns the files eligible for indexing. */
export function scanProject(root: string, options: ScanOptions): ScanResult {
  const normalizedRoot = normalizePath(root);
  const result: ScanResult = { files: [], skipped: 0, skippedByReason: emptyReasons(), truncated: false };

  const consider = (absolute: string, relative: string): void => {
    if (result.files.length >= options.maxFiles) {
      result.truncated = true;
      result.skipped++;
      result.skippedByReason.limit++;
      return;
    }

    // Sensitive files are rejected before any stat/read, unconditionally (PRD 37).
    if (isSensitiveFile(relative)) {
      result.skipped++;
      result.skippedByReason.sensitive++;
      return;
    }
    if (options.matcher.isIgnoredPath(relative)) {
      result.skipped++;
      result.skippedByReason.ignored++;
      return;
    }
    if (isBinaryExtension(relative)) {
      result.skipped++;
      result.skippedByReason.binary++;
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      result.skipped++;
      result.skippedByReason.unreadable++;
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > options.maxFileSizeBytes) {
      result.skipped++;
      result.skippedByReason.too_large++;
      return;
    }

    const extension = extensionOf(relative);
    result.files.push({
      absolutePath: absolute,
      relativePath: relative,
      extension: extension || null,
      language: languageOf(relative),
      size: stat.size,
      lastModified: Math.floor(stat.mtimeMs),
    });
  };

  if (options.candidates) {
    for (const candidate of options.candidates) {
      const relative = candidate.replace(/\\/g, "/");
      consider(path.join(normalizedRoot, relative), relative);
    }
    return result;
  }

  const stack: string[] = [normalizedRoot];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      result.skipped++;
      result.skippedByReason.unreadable++;
      continue;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = relativePath(normalizedRoot, absolute);

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        try {
          const stat = fs.statSync(absolute);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        if (options.matcher.isIgnoredDirectory(relative, entry.name)) {
          result.skipped++;
          result.skippedByReason.ignored++;
          continue;
        }
        stack.push(absolute);
      } else if (isFile) {
        consider(absolute, relative);
      }
    }
  }

  result.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return result;
}

/** Content hash used to decide whether a file needs re-indexing (PRD 15). */
export function hashFile(absolutePath: string): string {
  const buffer = fs.readFileSync(absolutePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function hashContent(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
