import { z } from "zod";
import type { ContextResult } from "@samirthakur024/core";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

function payload(result: ContextResult) {
  return {
    context_id: result.contextId,
    project_id: result.projectId,
    task: result.task,
    intent: result.intent,
    project: {
      name: result.project.name,
      framework: result.project.framework,
      languages: result.project.languages,
      branch: result.project.branch,
      head: result.project.head,
    },
    files: result.files.map((file) => ({
      path: file.path,
      relevance: file.relevance,
      why: file.reasons,
      language: file.language,
      symbols: file.symbols,
      ...(file.source ? { source: file.source } : {}),
    })),
    symbols: result.symbols,
    memories: result.memories,
    recent_changes: result.recentChanges,
    tests: result.tests,
    token_estimate: result.tokenEstimate,
    budget: result.budget,
    files_selected: result.filesSelected,
    files_considered: result.filesConsidered,
    files_avoided: result.filesAvoided,
    symbols_selected: result.symbolsSelected,
    truncated: result.truncated,
    cache: result.cache,
    ...(result.refreshedFiles.length > 0 ? { refreshed_files: result.refreshedFiles } : {}),
  };
}

const getContext = defineTool({
  name: "get_context",
  title: "Get context",
  description:
    "Assemble the smallest useful context for a task: the relevant files, their symbols, recent changes and tests, " +
    "ranked and fitted to a token budget. Call this before reading files - it tells you which ones matter and why.",
  permission: "READ",
  inputShape: {
    task: z.string().min(3).describe("What you are about to do, in plain words. e.g. 'fix login validation'."),
    paths: z.array(z.string()).max(20).optional().describe("Files you already know are involved."),
    symbols: z.array(z.string()).max(20).optional().describe("Symbols you already know are involved."),
    max_tokens: z.number().int().min(500).max(60_000).optional().describe("Token budget. Default 6000."),
    include_source: z.boolean().optional().describe("Include source slices, not just structure. Default: only for debugging tasks."),
    depth: z.number().int().min(0).max(3).optional().describe("Dependency-graph expansion depth. Default 1."),
    max_files: z.number().int().min(1).max(50).optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const result = context.devmemory.contextEngine(project.projectId).getContext({
      task: String(input.task),
      ...(Array.isArray(input.paths) ? { paths: input.paths as string[] } : {}),
      ...(Array.isArray(input.symbols) ? { symbols: input.symbols as string[] } : {}),
      ...(typeof input.max_tokens === "number" ? { maxTokens: input.max_tokens } : {}),
      ...(typeof input.include_source === "boolean" ? { includeSource: input.include_source } : {}),
      ...(typeof input.depth === "number" ? { depth: input.depth } : {}),
      ...(typeof input.max_files === "number" ? { maxFiles: input.max_files } : {}),
    });

    return payload(result);
  },
});

const searchContext = defineTool({
  name: "search_context",
  title: "Search context",
  description:
    "Full-text search across the project's code and symbols, ranked. Answers questions like " +
    "'where is payment verification handled' without reading files.",
  permission: "READ",
  inputShape: {
    query: z.string().min(2),
    limit: z.number().int().min(1).max(50).optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const results = context.devmemory
      .contextEngine(project.projectId)
      .searchContext(String(input.query), typeof input.limit === "number" ? input.limit : 20);

    return {
      project_id: project.projectId,
      query: input.query,
      count: results.length,
      results: results.map((result) => ({
        path: result.path,
        kind: result.kind,
        relevance: result.relevance,
        ...(result.symbol ? { symbol: result.symbol } : {}),
        ...(result.snippet ? { snippet: result.snippet } : {}),
      })),
    };
  },
});

const refreshContext = defineTool({
  name: "refresh_context",
  title: "Refresh context",
  description:
    "Re-index anything that changed on disk, then return fresh context for a task. " +
    "Use it after editing files so the next answer reflects the current state.",
  permission: "WRITE",
  inputShape: {
    task: z.string().min(3),
    max_tokens: z.number().int().min(500).max(60_000).optional(),
    include_source: z.boolean().optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const stats = await context.devmemory.index(project.projectId);
    const result = context.devmemory.contextEngine(project.projectId).getContext({
      task: String(input.task),
      ...(typeof input.max_tokens === "number" ? { maxTokens: input.max_tokens } : {}),
      ...(typeof input.include_source === "boolean" ? { includeSource: input.include_source } : {}),
    });

    return {
      ...payload(result),
      reindexed: {
        added: stats.added,
        updated: stats.updated,
        deleted: stats.deleted,
        unchanged: stats.unchanged,
        parsed: stats.parsed,
        duration_ms: stats.durationMs,
      },
    };
  },
});

export const CONTEXT_TOOLS: ToolDefinition[] = [getContext, searchContext, refreshContext] as ToolDefinition[];
