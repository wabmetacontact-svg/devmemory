import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Platform-specific global storage root (PRD 7).
 * Windows: %LOCALAPPDATA%\DevMemory
 * macOS:   ~/Library/Application Support/DevMemory
 * Linux:   ~/.local/share/devmemory
 *
 * DEVMEMORY_HOME overrides everything (used by tests and power users).
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DEVMEMORY_HOME?.trim();
  if (override) return path.resolve(override);

  switch (process.platform) {
    case "win32": {
      const base = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
      return path.join(base, "DevMemory");
    }
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "DevMemory");
    default: {
      const base = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
      return path.join(base, "devmemory");
    }
  }
}

export interface HomeLayout {
  root: string;
  configFile: string;
  registryDb: string;
  projectsDir: string;
  runtimeDir: string;
  logsDir: string;
}

export function homeLayout(home = resolveHome()): HomeLayout {
  return {
    root: home,
    configFile: path.join(home, "config.json"),
    registryDb: path.join(home, "registry.db"),
    projectsDir: path.join(home, "projects"),
    runtimeDir: path.join(home, "runtime"),
    logsDir: path.join(home, "logs"),
  };
}

export interface ProjectLayout {
  root: string;
  indexDb: string;
  memoryDb: string;
  metadataFile: string;
  cacheDir: string;
  logsDir: string;
}

export function projectLayout(projectId: string, home = resolveHome()): ProjectLayout {
  const root = path.join(homeLayout(home).projectsDir, projectId);
  return {
    root,
    indexDb: path.join(root, "index.db"),
    memoryDb: path.join(root, "memory.db"),
    metadataFile: path.join(root, "metadata.json"),
    cacheDir: path.join(root, "cache"),
    logsDir: path.join(root, "logs"),
  };
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureHome(home = resolveHome()): HomeLayout {
  const layout = homeLayout(home);
  ensureDir(layout.root);
  ensureDir(layout.projectsDir);
  ensureDir(layout.runtimeDir);
  ensureDir(layout.logsDir);
  return layout;
}

export function ensureProjectDirs(projectId: string, home = resolveHome()): ProjectLayout {
  const layout = projectLayout(projectId, home);
  ensureDir(layout.root);
  ensureDir(layout.cacheDir);
  ensureDir(layout.logsDir);
  return layout;
}

/**
 * Canonical path form: forward slashes, and the real on-disk path when it exists.
 * The realpath step matters on Windows, where the same directory can be reached as
 * both an 8.3 short path (C:/Users/SAMEER~1/...) and its long form; without it the
 * two would register as two different projects.
 */
export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved).replace(/\\/g, "/");
  } catch {
    // Path does not exist (yet) - fall back to lexical normalisation.
    return resolved.replace(/\\/g, "/");
  }
}

/** Project-relative path, always forward-slashed, no leading "./". */
export function relativePath(root: string, absolute: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(absolute)).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}
