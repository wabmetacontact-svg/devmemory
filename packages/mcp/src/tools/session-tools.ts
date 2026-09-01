import { z } from "zod";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

const sessionStart = defineTool({
  name: "session_start",
  title: "Start session",
  description:
    "Open a work session for this agent. DevMemory records the branch and commit you started from, so the " +
    "files you change can be attributed to the session when it ends.",
  permission: "WRITE",
  inputShape: {
    agent: z.string().min(1).max(60).describe("Which agent you are, e.g. 'claude-code' or 'opencode'."),
    task: z.string().optional().describe("Task key or id this session is working on."),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const taskId =
      typeof input.task === "string" ? context.devmemory.tasksFor(project.projectId).require(input.task).id : undefined;

    const session = context.devmemory.sessionsFor(project.projectId).start({
      agent: String(input.agent),
      ...(taskId ? { taskId } : {}),
    });

    return {
      project_id: project.projectId,
      session_id: session.id,
      agent: session.agent,
      branch: session.branch,
      start_commit: session.startCommit,
      started_at: session.startedAt,
    };
  },
});

const sessionEnd = defineTool({
  name: "session_end",
  title: "End session",
  description:
    "Close the session with a compact summary: what you completed, what is left, and the single next step. " +
    "This is what the next agent - or the next you - picks up from, so write the next step as an instruction.",
  permission: "WRITE",
  inputShape: {
    session_id: z.string().optional().describe("Defaults to the currently open session."),
    summary: z.string().min(5).max(4000),
    completed: z.array(z.string()).max(30).optional(),
    remaining: z.array(z.string()).max(30).optional(),
    next_step: z.string().max(500).optional().describe("The single most useful thing to do next."),
    tests: z.string().max(500).optional().describe("Test outcome, e.g. '12 passed'."),
    files_changed: z.array(z.string()).max(100).optional().describe("Git fills this in for repositories."),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const sessions = context.devmemory.sessionsFor(project.projectId);

    const target = typeof input.session_id === "string" ? sessions.require(input.session_id) : sessions.active();
    if (!target) {
      return { error: { code: "INVALID_INPUT", message: "no open session; call session_start first" } };
    }

    const session = sessions.end(target.id, {
      summary: String(input.summary),
      ...(Array.isArray(input.completed) ? { completed: input.completed as string[] } : {}),
      ...(Array.isArray(input.remaining) ? { remaining: input.remaining as string[] } : {}),
      ...(typeof input.next_step === "string" ? { nextStep: input.next_step } : {}),
      ...(typeof input.tests === "string" ? { tests: input.tests } : {}),
      ...(Array.isArray(input.files_changed) ? { filesChanged: input.files_changed as string[] } : {}),
    });

    return {
      project_id: project.projectId,
      session_id: session.id,
      ended_at: session.endedAt,
      files_changed: session.filesChanged,
      next_step: session.nextStep,
    };
  },
});

const handoff = defineTool({
  name: "handoff",
  title: "Handoff",
  description:
    "Pick up this project's development state: the current task and what remains of it, what the last session " +
    "did, the decisions and constraints that bind you, known issues, recent changes, and the recommended next " +
    "step. Call this at the start of a session instead of asking the developer to re-explain the project.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const report = context.devmemory.handoff(project.projectId);

    return {
      project_id: project.projectId,
      project: report.project,
      current_task: report.currentTask,
      open_tasks: report.openTasks,
      last_session: report.lastSession,
      decisions: report.decisions,
      constraints: report.constraints,
      known_issues: report.knownIssues,
      recent_changes: report.recentChanges,
      recommended_next_step: report.recommendedNextStep,
    };
  },
});

export const SESSION_TOOLS: ToolDefinition[] = [sessionStart, sessionEnd, handoff] as ToolDefinition[];
