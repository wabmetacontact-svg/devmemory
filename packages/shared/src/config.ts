import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureHome, homeLayout } from "./paths.js";

/** PRD 20 - directories never walked by the indexer. */
export const DEFAULT_IGNORE_DIRS = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".pytest_cache",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  ".devmemory",
];

/** PRD 20/37 - files never indexed or surfaced as context. */
export const DEFAULT_IGNORE_FILES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "credentials",
  "credentials.*",
  "secrets.*",
  "*.secret",
  "*secrets.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "*.log",
  "*.lock",
  "*-lock.json",
  "*.min.js",
  "*.map",
];

export const ConfigSchema = z.object({
  version: z.number().int().default(1),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  indexing: z
    .object({
      maxFileSizeBytes: z.number().int().positive().default(1_048_576),
      maxFiles: z.number().int().positive().default(200_000),
      respectGitignore: z.boolean().default(true),
      ignoreDirs: z.array(z.string()).default(DEFAULT_IGNORE_DIRS),
      ignoreFiles: z.array(z.string()).default(DEFAULT_IGNORE_FILES),
      followSymlinks: z.boolean().default(false),
      parseSymbols: z.boolean().default(true),
      maxParseFileSizeBytes: z.number().int().positive().default(524_288),
    })
    .default({}),
  security: z
    .object({
      redactSecrets: z.boolean().default(true),
      blockSensitiveFiles: z.boolean().default(true),
      /** Flag files that contain credential patterns during indexing (PRD 37). */
      scanForSecrets: z.boolean().default(true),
      /** Operation classes from PRD 38: allow, confirm or deny. */
      permissions: z
        .object({
          READ: z.enum(["allow", "confirm", "deny"]).default("allow"),
          WRITE: z.enum(["allow", "confirm", "deny"]).default("allow"),
          EXECUTE: z.enum(["allow", "confirm", "deny"]).default("allow"),
          DESTRUCTIVE: z.enum(["allow", "confirm", "deny"]).default("confirm"),
        })
        .default({}),
    })
    .default({}),
  git: z
    .object({
      enabled: z.boolean().default(true),
      binary: z.string().default("git"),
      historyLimit: z.number().int().positive().default(50),
    })
    .default({}),
  dashboard: z
    .object({
      port: z.number().int().min(0).max(65535).default(7331),
      host: z.string().default("127.0.0.1"),
    })
    .default({}),
});

export type DevMemoryConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): DevMemoryConfig {
  return ConfigSchema.parse({});
}

export function loadConfig(home?: string): DevMemoryConfig {
  const layout = homeLayout(home);
  if (!fs.existsSync(layout.configFile)) return defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(layout.configFile, "utf8")) as unknown;
    return ConfigSchema.parse(raw);
  } catch {
    // A corrupt config must never take the whole platform down (PRD 60).
    return defaultConfig();
  }
}

export function saveConfig(config: DevMemoryConfig, home?: string): void {
  const layout = homeLayout(home);
  ensureHome(home);
  const tmp = `${layout.configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, layout.configFile);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
