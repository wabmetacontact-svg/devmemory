import type { ProjectRecord } from "@samirthakur024/shared";
import type { ContextFile, ContextRequest } from "../context/context-engine.js";
import type { SearchResult } from "../context/context-engine.js";
import type { Intent } from "../context/intent.js";
import type { RecalledMemory } from "../memory/memory-engine.js";

export interface WorkspaceProjectContext {
  projectId: string;
  name: string;
  role: string | null;
  files: ContextFile[];
  memories: Array<{ id: string; type: string; title: string; content: string; importance: number }>;
  tokenEstimate: number;
  filesSelected: number;
  filesAvoided: number;
}

export interface WorkspaceContextResult {
  workspace: string;
  task: string;
  intent: Intent;
  projects: WorkspaceProjectContext[];
  /** Every file across the workspace, ranked together. */
  files: Array<ContextFile & { project: string }>;
  tokenEstimate: number;
  budget: number;
  filesSelected: number;
  filesAvoided: number;
}

export interface WorkspaceSearchResult extends SearchResult {
  project: string;
  projectId: string;
}

export interface WorkspaceStatus {
  workspace: string;
  projects: Array<{
    projectId: string;
    name: string;
    role: string | null;
    files: number;
    symbols: number;
    memories: number;
    openTasks: number;
    branch: string | null;
  }>;
  totals: { files: number; symbols: number; memories: number; openTasks: number };
}

/**
 * A workspace answers one question with several projects' worth of context. The
 * budget is split evenly rather than pooled: a shared budget would let the first
 * project consume all of it and leave the second - usually the one the developer
 * had not thought about - invisible, which defeats the point.
 */
export const MINIMUM_PROJECT_BUDGET = 800;

export function budgetPerProject(totalBudget: number, projectCount: number): number {
  if (projectCount <= 1) return totalBudget;
  return Math.max(MINIMUM_PROJECT_BUDGET, Math.floor(totalBudget / projectCount));
}

export function mergeWorkspaceContext(
  workspace: string,
  task: string,
  budget: number,
  parts: Array<{
    project: ProjectRecord;
    role: string | null;
    intent: Intent;
    files: ContextFile[];
    memories: WorkspaceProjectContext["memories"];
    tokenEstimate: number;
    filesAvoided: number;
  }>,
): WorkspaceContextResult {
  const projects: WorkspaceProjectContext[] = parts.map((part) => ({
    projectId: part.project.projectId,
    name: part.project.name,
    role: part.role,
    files: part.files,
    memories: part.memories,
    tokenEstimate: part.tokenEstimate,
    filesSelected: part.files.length,
    filesAvoided: part.filesAvoided,
  }));

  // One ranked list across the workspace, so the most relevant file wins even when
  // it lives in the project the developer was not looking at.
  const files = parts
    .flatMap((part) => part.files.map((file) => ({ ...file, project: part.project.name })))
    .sort((a, b) => b.relevance - a.relevance);

  return {
    workspace,
    task,
    intent: parts[0]?.intent ?? "general",
    projects,
    files,
    tokenEstimate: parts.reduce((sum, part) => sum + part.tokenEstimate, 0),
    budget,
    filesSelected: files.length,
    filesAvoided: parts.reduce((sum, part) => sum + part.filesAvoided, 0),
  };
}

export function mergeWorkspaceSearch(
  parts: Array<{ project: ProjectRecord; results: SearchResult[] }>,
  limit: number,
): WorkspaceSearchResult[] {
  return parts
    .flatMap((part) =>
      part.results.map((result) => ({
        ...result,
        project: part.project.name,
        projectId: part.project.projectId,
      })),
    )
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

export type { RecalledMemory };
