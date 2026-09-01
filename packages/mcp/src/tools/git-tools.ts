import { z } from "zod";
import { DevMemoryError } from "@samirthakur024/shared";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";
import { redactSecrets } from "@samirthakur024/indexer";

/** Diffs can be enormous; agents get a bounded slice with an explicit truncation flag (PRD 24). */
const MAX_DIFF_CHARS = 24_000;

function clamp(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_DIFF_CHARS)}\n... [truncated]`, truncated: true };
}

function requireGitProject(root: string, isGit: boolean): void {
  if (!isGit) {
    throw new DevMemoryError("GIT_ERROR", "this project is not a git repository", { root });
  }
}

const gitStatus = defineTool({
  name: "git_status",
  title: "Git status",
  description: "Branch, tracking state and the list of modified, staged and untracked files.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    requireGitProject(project.rootPath, project.repositoryType === "git");
    const status = context.devmemory.git.status(project.rootPath);

    return {
      project_id: project.projectId,
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      clean: status.clean,
      head: context.devmemory.git.headCommit(project.rootPath),
      files: status.files.map((file) => ({
        path: file.path,
        index: file.index.trim() || null,
        worktree: file.worktree.trim() || null,
        untracked: file.untracked,
      })),
    };
  },
});

const gitDiff = defineTool({
  name: "git_diff",
  title: "Git diff",
  description: "Working tree or staged diff, optionally for a single file or against a ref. Secrets are redacted.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
    file: z.string().optional(),
    ref: z.string().optional().describe("Compare against this ref instead of the working tree."),
    staged: z.boolean().optional(),
    names_only: z.boolean().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    requireGitProject(project.rootPath, project.repositoryType === "git");

    const raw = context.devmemory.git.diff(project.rootPath, {
      ...(typeof input.file === "string" ? { file: input.file } : {}),
      ...(typeof input.ref === "string" ? { ref: input.ref } : {}),
      ...(input.staged === true ? { staged: true } : {}),
      ...(input.names_only === true ? { nameOnly: true } : {}),
    });

    const safe = context.devmemory.config.security.redactSecrets ? redactSecrets(raw) : { text: raw, redactions: [] };
    const clamped = clamp(safe.text);

    return {
      project_id: project.projectId,
      diff: clamped.text,
      truncated: clamped.truncated,
      redacted: safe.redactions.length > 0,
    };
  },
});

const gitHistory = defineTool({
  name: "git_history",
  title: "Git history",
  description: "Recent commits, optionally limited to one file. Use this to find out why code looks the way it does.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
    file: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    since: z.string().optional().describe("Any git date expression, e.g. '2 weeks ago'."),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    requireGitProject(project.rootPath, project.repositoryType === "git");

    const commits = context.devmemory.git.log(project.rootPath, {
      limit: typeof input.limit === "number" ? input.limit : context.devmemory.config.git.historyLimit,
      ...(typeof input.file === "string" ? { file: input.file } : {}),
      ...(typeof input.since === "string" ? { since: input.since } : {}),
    });

    return {
      project_id: project.projectId,
      count: commits.length,
      commits: commits.map((commit) => ({
        hash: commit.shortHash,
        full_hash: commit.hash,
        author: commit.author,
        date: commit.date,
        subject: commit.subject,
      })),
    };
  },
});

const changesSince = defineTool({
  name: "changes_since",
  title: "Changes since a ref",
  description:
    "Files that changed since a commit, tag or branch, including uncommitted work. Use it to catch up on what moved since the last session.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
    ref: z.string().describe("Base ref, e.g. HEAD~5, a commit hash, a tag or a branch name."),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    requireGitProject(project.rootPath, project.repositoryType === "git");

    const files = context.devmemory.git.changedFilesSince(project.rootPath, String(input.ref));
    const commits = context.devmemory.git.log(project.rootPath, { limit: 20, branch: `${String(input.ref)}..HEAD` });

    return {
      project_id: project.projectId,
      since: input.ref,
      changed_files: files,
      file_count: files.length,
      commits: commits.map((commit) => ({ hash: commit.shortHash, subject: commit.subject, date: commit.date })),
    };
  },
});

export const GIT_TOOLS: ToolDefinition[] = [gitStatus, gitDiff, gitHistory, changesSince] as ToolDefinition[];
