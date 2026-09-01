import { z } from "zod";
import { TASK_PRIORITIES, TASK_STATUSES, type Task } from "@samirthakur024/core";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

function compact(task: Task) {
  return {
    key: task.key,
    id: task.id,
    title: task.title,
    ...(task.description ? { description: task.description } : {}),
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    requirements: task.requirements.map((requirement) => ({
      text: requirement.text,
      done: requirement.done,
    })),
    ...(task.blockedReason ? { blocked_reason: task.blockedReason } : {}),
    ...(task.areas.length > 0 ? { areas: task.areas } : {}),
    ...(task.paths.length > 0 ? { paths: task.paths } : {}),
    ...(task.branch ? { branch: task.branch } : {}),
    updated_at: task.updatedAt,
  };
}

const taskCreate = defineTool({
  name: "task_create",
  title: "Create task",
  description:
    "Record a piece of development work as a structured task with requirements. " +
    "Tasks persist across sessions and agents, so progress is never lost when a conversation ends.",
  permission: "WRITE",
  inputShape: {
    title: z.string().min(3).max(200),
    description: z.string().max(4000).optional(),
    requirements: z.array(z.string().min(2)).max(30).optional().describe("Checklist of what 'done' means."),
    status: z.enum(TASK_STATUSES).optional().describe("Defaults to READY."),
    priority: z.enum(TASK_PRIORITIES).optional(),
    areas: z.array(z.string()).max(10).optional().describe("Affected areas, e.g. authentication, payments."),
    paths: z.array(z.string()).max(30).optional(),
    symbols: z.array(z.string()).max(30).optional(),
    tags: z.array(z.string()).max(10).optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const task = context.devmemory.tasksFor(project.projectId).create({
      title: String(input.title),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(Array.isArray(input.requirements) ? { requirements: input.requirements as string[] } : {}),
      ...(typeof input.status === "string" ? { status: input.status as Task["status"] } : {}),
      ...(typeof input.priority === "string" ? { priority: input.priority as Task["priority"] } : {}),
      ...(Array.isArray(input.areas) ? { areas: input.areas as string[] } : {}),
      ...(Array.isArray(input.paths) ? { paths: input.paths as string[] } : {}),
      ...(Array.isArray(input.symbols) ? { symbols: input.symbols as string[] } : {}),
      ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
      agent: "mcp",
    });

    return { project_id: project.projectId, task: compact(task) };
  },
});

const taskUpdate = defineTool({
  name: "task_update",
  title: "Update task",
  description:
    "Move a task forward: change its status, tick off requirements, add new ones, record why it is blocked, " +
    "or attach the files it touches. Call this as work happens, not only at the end.",
  permission: "WRITE",
  inputShape: {
    task: z.string().min(3).describe("Task key (TASK-3) or id."),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    title: z.string().min(3).max(200).optional(),
    description: z.string().max(4000).optional(),
    complete_requirements: z.array(z.string()).max(30).optional().describe("Requirement texts to tick off."),
    reopen_requirements: z.array(z.string()).max(30).optional(),
    add_requirements: z.array(z.string().min(2)).max(30).optional(),
    blocked_reason: z.string().max(1000).optional(),
    add_paths: z.array(z.string()).max(30).optional(),
    add_areas: z.array(z.string()).max(10).optional(),
    note: z.string().max(1000).optional().describe("A line for the task timeline."),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const task = context.devmemory.tasksFor(project.projectId).update(String(input.task), {
      ...(typeof input.status === "string" ? { status: input.status as Task["status"] } : {}),
      ...(typeof input.priority === "string" ? { priority: input.priority as Task["priority"] } : {}),
      ...(typeof input.title === "string" ? { title: input.title } : {}),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(Array.isArray(input.complete_requirements) ? { completeRequirements: input.complete_requirements as string[] } : {}),
      ...(Array.isArray(input.reopen_requirements) ? { reopenRequirements: input.reopen_requirements as string[] } : {}),
      ...(Array.isArray(input.add_requirements) ? { addRequirements: input.add_requirements as string[] } : {}),
      ...(typeof input.blocked_reason === "string" ? { blockedReason: input.blocked_reason } : {}),
      ...(Array.isArray(input.add_paths) ? { addPaths: input.add_paths as string[] } : {}),
      ...(Array.isArray(input.add_areas) ? { addAreas: input.add_areas as string[] } : {}),
      ...(typeof input.note === "string" ? { note: input.note } : {}),
      agent: "mcp",
    });

    return { project_id: project.projectId, task: compact(task) };
  },
});

const taskStatus = defineTool({
  name: "task_status",
  title: "Task status",
  description:
    "The project's work in flight: the current task, everything open, and progress on each. " +
    "Pass a task to get that one in full, including its timeline.",
  permission: "READ",
  inputShape: {
    task: z.string().optional().describe("Task key or id. Omit for the whole board."),
    status: z.enum(TASK_STATUSES).optional(),
    query: z.string().optional().describe("Search tasks by title, description or requirement text."),
    limit: z.number().int().min(1).max(100).optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const tasks = context.devmemory.tasksFor(project.projectId);

    if (typeof input.task === "string") {
      const task = tasks.require(input.task);
      return {
        project_id: project.projectId,
        task: compact(task),
        timeline: tasks.events(task.id, 15),
        sessions: context.devmemory
          .sessionsFor(project.projectId)
          .forTask(task.id, 5)
          .map((session) => ({
            id: session.id,
            agent: session.agent,
            ended_at: session.endedAt,
            summary: session.summary,
          })),
      };
    }

    const limit = typeof input.limit === "number" ? input.limit : 20;
    const list =
      typeof input.query === "string"
        ? tasks.search(input.query, limit)
        : tasks.list({
            ...(typeof input.status === "string" ? { status: input.status as Task["status"] } : { open: true }),
            limit,
          });

    return {
      project_id: project.projectId,
      current: tasks.current() ? compact(tasks.current() as Task) : null,
      stats: tasks.stats(),
      tasks: list.map(compact),
    };
  },
});

const taskContext = defineTool({
  name: "task_context",
  title: "Task context",
  description:
    "Everything needed to work on a task: the task itself with its remaining requirements, plus the ranked " +
    "code context for it - relevant files, symbols, project memory and tests, within a token budget.",
  permission: "READ",
  inputShape: {
    task: z.string().min(3).describe("Task key (TASK-3) or id."),
    max_tokens: z.number().int().min(500).max(60_000).optional(),
    include_source: z.boolean().optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const task = context.devmemory.tasksFor(project.projectId).require(String(input.task));

    const remaining = task.requirements.filter((requirement) => !requirement.done).map((requirement) => requirement.text);
    const assembled = context.devmemory.contextEngine(project.projectId).getContext({
      // The task's own words are the query; its files and symbols are seeds.
      task: [task.title, task.description ?? "", ...remaining].join(". "),
      paths: task.paths,
      symbols: task.symbols,
      ...(typeof input.max_tokens === "number" ? { maxTokens: input.max_tokens } : {}),
      ...(typeof input.include_source === "boolean" ? { includeSource: input.include_source } : {}),
    });

    return {
      project_id: project.projectId,
      task: compact(task),
      remaining_requirements: remaining,
      context: {
        files: assembled.files.map((file) => ({
          path: file.path,
          relevance: file.relevance,
          why: file.reasons,
          symbols: file.symbols,
          ...(file.source ? { source: file.source } : {}),
        })),
        memories: assembled.memories,
        tests: assembled.tests,
        recent_changes: assembled.recentChanges,
        token_estimate: assembled.tokenEstimate,
        files_avoided: assembled.filesAvoided,
      },
    };
  },
});

export const TASK_TOOLS: ToolDefinition[] = [taskCreate, taskUpdate, taskStatus, taskContext] as ToolDefinition[];
