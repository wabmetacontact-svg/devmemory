export type ProjectStatus = "active" | "disconnected" | "archived";
export type IndexStatus = "never" | "indexing" | "healthy" | "stale" | "error";
export type FileStatus = "active" | "deleted";

/** How a project's identity was established (PRD 9, highest confidence first). */
export type IdentitySource = "git_remote" | "git_root_commit" | "fingerprint" | "path";

export interface ProjectIdentity {
  projectId: string;
  name: string;
  rootPath: string;
  identitySource: IdentitySource;
  identityKey: string;
  repositoryUrl: string | null;
  repositoryType: "git" | null;
  isGitRepo: boolean;
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  rootPath: string;
  repositoryUrl: string | null;
  repositoryType: string | null;
  identitySource: IdentitySource;
  identityKey: string;
  framework: string | null;
  languages: string[];
  packageManager: string | null;
  createdAt: string;
  lastSeenAt: string;
  lastIndexedAt: string | null;
  status: ProjectStatus;
  indexStatus: IndexStatus;
}

export interface IndexedFile {
  id: number;
  projectId: string;
  path: string;
  relativePath: string;
  language: string | null;
  extension: string | null;
  size: number;
  hash: string;
  lastModified: number;
  indexedAt: string;
  status: FileStatus;
}

export interface IndexRunStats {
  projectId: string;
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  bytesIndexed: number;
  durationMs: number;
  fullRebuild: boolean;
  /** Files handed to a language parser this run (PRD 16). */
  parsed: number;
  parseErrors: number;
  symbols: number;
}

export interface ProjectDetection {
  framework: string | null;
  frameworks: string[];
  languages: string[];
  packageManager: string | null;
}
