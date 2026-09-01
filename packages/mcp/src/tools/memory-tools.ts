import { z } from "zod";
import { MEMORY_TYPES, type MemoryRecord } from "@samirthakur024/core";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

function compact(memory: MemoryRecord & { score?: number }) {
  return {
    id: memory.id,
    type: memory.type,
    title: memory.title,
    content: memory.content,
    importance: memory.importance,
    confidence: memory.confidence,
    ...(memory.branch ? { branch: memory.branch } : {}),
    ...(memory.tags.length > 0 ? { tags: memory.tags } : {}),
    ...(memory.paths.length > 0 ? { paths: memory.paths } : {}),
    ...(memory.symbols.length > 0 ? { symbols: memory.symbols } : {}),
    ...(memory.decision ? { decision: memory.decision } : {}),
    ...(memory.expiresAt ? { expires_at: memory.expiresAt } : {}),
    updated_at: memory.updatedAt,
    ...(typeof memory.score === "number" ? { score: memory.score } : {}),
  };
}

const remember = defineTool({
  name: "remember",
  title: "Remember",
  description:
    "Store durable project knowledge: an architecture DECISION and why, a CONSTRAINT, a business FACT, " +
    "a DISCOVERY, a known BUG, or a PATTERN. Use it for things a future session would otherwise have to " +
    "rediscover - not for running commentary. Identical memories are reinforced, not duplicated.",
  permission: "WRITE",
  inputShape: {
    type: z.enum(MEMORY_TYPES).describe("DECISION and CONSTRAINT outrank FACT; HISTORY expires after 30 days."),
    title: z.string().min(3).max(200),
    content: z.string().min(8).max(8000),
    importance: z.number().min(0).max(1).optional().describe("Defaults by type: DECISION 0.9, FACT 0.5, HISTORY 0.3."),
    confidence: z.number().min(0).max(1).optional(),
    tags: z.array(z.string()).max(12).optional(),
    paths: z.array(z.string()).max(20).optional().describe("Files this knowledge is about - they get boosted in get_context."),
    symbols: z.array(z.string()).max(20).optional(),
    branch_specific: z.boolean().optional().describe("Scope to the current git branch instead of the whole project."),
    expires_in_days: z.number().int().min(1).max(3650).optional(),
    supersedes: z.string().optional().describe("Id of the memory this one replaces."),
    reason: z.string().max(2000).optional().describe("For a DECISION: why it was made."),
    alternatives: z.array(z.string()).max(10).optional().describe("For a DECISION: what was rejected."),
    affected: z.array(z.string()).max(20).optional().describe("For a DECISION: the areas it binds."),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const decision =
      input.reason || input.alternatives || input.affected
        ? {
            ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
            ...(Array.isArray(input.alternatives) ? { alternatives: input.alternatives as string[] } : {}),
            ...(Array.isArray(input.affected) ? { affected: input.affected as string[] } : {}),
          }
        : undefined;

    const result = context.devmemory.memoryFor(project.projectId).remember({
      type: input.type as (typeof MEMORY_TYPES)[number],
      title: String(input.title),
      content: String(input.content),
      ...(typeof input.importance === "number" ? { importance: input.importance } : {}),
      ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
      ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
      ...(Array.isArray(input.paths) ? { paths: input.paths as string[] } : {}),
      ...(Array.isArray(input.symbols) ? { symbols: input.symbols as string[] } : {}),
      ...(input.branch_specific === true ? { branchSpecific: true } : {}),
      ...(typeof input.expires_in_days === "number" ? { expiresInDays: input.expires_in_days } : {}),
      ...(typeof input.supersedes === "string" ? { supersedes: input.supersedes } : {}),
      ...(decision ? { decision } : {}),
      source: "mcp",
    });

    return {
      project_id: project.projectId,
      stored: true,
      reinforced_existing: result.deduplicated,
      memory: compact(result.memory),
    };
  },
});

const recall = defineTool({
  name: "recall",
  title: "Recall",
  description:
    "Retrieve what DevMemory knows about this project, ranked by relevance and importance. " +
    "With no query it returns the most load-bearing knowledge - the right way to start a session " +
    "or to pick up work another agent left.",
  permission: "READ",
  inputShape: {
    query: z.string().optional().describe("What you want to know. Omit for the project's key knowledge."),
    type: z.enum(MEMORY_TYPES).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    min_importance: z.number().min(0).max(1).optional(),
    include_archived: z.boolean().optional(),
    path: z.string().optional().describe("Only memories attached to this file."),
    tag: z.string().optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const memories = context.devmemory.memoryFor(project.projectId).recall({
      ...(typeof input.query === "string" ? { query: input.query } : {}),
      ...(typeof input.type === "string" ? { type: input.type as (typeof MEMORY_TYPES)[number] } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      ...(typeof input.min_importance === "number" ? { minImportance: input.min_importance } : {}),
      ...(input.include_archived === true ? { includeArchived: true } : {}),
      ...(typeof input.path === "string" ? { path: input.path } : {}),
      ...(typeof input.tag === "string" ? { tag: input.tag } : {}),
    });

    return {
      project_id: project.projectId,
      ...(typeof input.query === "string" ? { query: input.query } : {}),
      count: memories.length,
      memories: memories.map(compact),
    };
  },
});

const forget = defineTool({
  name: "forget",
  title: "Forget",
  description:
    "Archive a memory that is no longer true. Archived memories stop appearing in recall but remain " +
    "as history; hard deletion requires confirm=true and cannot be undone.",
  // Archiving is reversible, so the tool is WRITE; the hard path guards itself.
  permission: "WRITE",
  inputShape: {
    id: z.string().min(3).describe("Memory id from recall, e.g. mem_ab12cd34."),
    hard: z.boolean().optional().describe("Delete permanently instead of archiving."),
    confirm: z.boolean().optional().describe("Required when hard=true."),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });

    if (input.hard === true && input.confirm !== true) {
      return { error: { code: "PERMISSION_DENIED", message: "hard deletion requires confirm=true" } };
    }

    const result = context.devmemory
      .memoryFor(project.projectId)
      .forget(String(input.id), { hard: input.hard === true });

    return { project_id: project.projectId, ...result };
  },
});

export const MEMORY_TOOLS: ToolDefinition[] = [remember, recall, forget] as ToolDefinition[];
