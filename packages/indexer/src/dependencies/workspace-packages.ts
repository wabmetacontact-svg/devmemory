import fs from "node:fs";
import path from "node:path";

export interface WorkspacePackage {
  name: string;
  /** Project-relative directory of the package. */
  directory: string;
  /** Declared source entry, if the manifest names one. */
  source: string | null;
}

/**
 * Packages that belong to the project itself rather than node_modules. Without
 * this, every cross-package import in a monorepo looks external and the dependency
 * graph stops at the package boundary - which would make impact analysis useless in
 * exactly the repositories that need it most (PRD 17).
 */
export function discoverWorkspacePackages(root: string): WorkspacePackage[] {
  const globs = new Set<string>();

  for (const pattern of readPnpmWorkspaceGlobs(root)) globs.add(pattern);
  for (const pattern of readPackageJsonWorkspaces(root)) globs.add(pattern);

  const packages: WorkspacePackage[] = [];
  const seen = new Set<string>();

  for (const glob of globs) {
    for (const directory of expandGlob(root, glob)) {
      if (seen.has(directory)) continue;
      seen.add(directory);

      const manifest = readJson(path.join(root, directory, "package.json")) as
        | { name?: string; source?: string; main?: string; module?: string }
        | null;
      if (!manifest?.name) continue;

      packages.push({
        name: manifest.name,
        directory,
        source: manifest.source ?? null,
      });
    }
  }

  return packages;
}

function readPnpmWorkspaceGlobs(root: string): string[] {
  const file = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const globs: string[] = [];
    let inPackages = false;

    for (const line of lines) {
      if (/^packages:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) break;
      const match = /^\s*-\s*["']?([^"'#]+)["']?\s*$/.exec(line);
      if (inPackages && match?.[1]) globs.push(match[1].trim());
    }
    return globs;
  } catch {
    return [];
  }
}

function readPackageJsonWorkspaces(root: string): string[] {
  const manifest = readJson(path.join(root, "package.json")) as
    | { workspaces?: string[] | { packages?: string[] } }
    | null;
  if (!manifest?.workspaces) return [];
  return Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces.packages ?? []);
}

/** Supports the shapes workspace globs actually use: "packages/*", "apps/**", "tools/cli". */
function expandGlob(root: string, glob: string): string[] {
  const normalized = glob.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith("!")) return [];

  const starIndex = normalized.indexOf("*");
  if (starIndex === -1) {
    return fs.existsSync(path.join(root, normalized, "package.json")) ? [normalized] : [];
  }

  const parent = normalized.slice(0, starIndex).replace(/\/$/, "");
  const parentPath = path.join(root, parent);
  if (!fs.existsSync(parentPath)) return [];

  try {
    return fs
      .readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => (parent ? `${parent}/${entry.name}` : entry.name))
      .filter((directory) => fs.existsSync(path.join(root, directory, "package.json")));
  } catch {
    return [];
  }
}

function readJson(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}
