import { nowIso } from "@samirthakur024/shared";
import type { ProjectRecord } from "@samirthakur024/shared";
import type { MemoryEngine } from "../memory/memory-engine.js";
import type { GitEngine } from "../git/git-engine.js";
import type { Task, TaskEngine } from "../tasks/task-engine.js";
import type { Session, SessionEngine } from "./session-engine.js";

export interface HandoffTask {
  key: string;
  title: string;
  status: string;
  progress: { done: number; total: number; percent: number };
  remaining: string[];
  blockedReason?: string;
}

export interface HandoffIssue {
  source: "memory" | "task";
  title: string;
  detail: string;
}

export interface HandoffReport {
  project: {
    name: string;
    root: string;
    framework: string | null;
    languages: string[];
    branch: string | null;
    head: string | null;
  };
  currentTask: HandoffTask | null;
  openTasks: HandoffTask[];
  lastSession: {
    agent: string;
    endedAt: string | null;
    summary: string | null;
    completed: string[];
    remaining: string[];
    nextStep: string | null;
    filesChanged: string[];
    tests: string | null;
  } | null;
  decisions: Array<{ title: string; content: string; reason: string | null }>;
  constraints: Array<{ title: string; content: string }>;
  knownIssues: HandoffIssue[];
  recentChanges: string[];
  recommendedNextStep: string;
  generatedAt: string;
}

export interface HandoffDeps {
  project: ProjectRecord;
  tasks: TaskEngine;
  sessions: SessionEngine;
  memory: MemoryEngine;
  git: GitEngine | null;
}

/**
 * Everything a fresh agent needs to continue someone else's work (PRD 32).
 * Assembled entirely from durable state - tasks, sessions, memory and git - so no
 * previous conversation is required, which is the whole point of the feature.
 */
export function buildHandoff(deps: HandoffDeps): HandoffReport {
  const { project, tasks, sessions, memory, git } = deps;
  const isGit = project.repositoryType === "git" && git !== null;

  const current = tasks.current();
  const openTasks = tasks.list({ open: true, limit: 10 });
  const lastSession = sessions.lastEnded() ?? sessions.active();

  const decisions = memory.recall({ type: "DECISION", limit: 5 }).map((entry) => ({
    title: entry.title,
    content: entry.content,
    reason: entry.decision?.reason ?? null,
  }));

  const constraints = memory
    .recall({ type: "CONSTRAINT", limit: 5 })
    .map((entry) => ({ title: entry.title, content: entry.content }));

  const knownIssues: HandoffIssue[] = [
    ...memory.recall({ type: "BUG", limit: 5 }).map((entry) => ({
      source: "memory" as const,
      title: entry.title,
      detail: entry.content,
    })),
    ...tasks.list({ status: "BLOCKED", limit: 5 }).map((task) => ({
      source: "task" as const,
      title: `${task.key} is blocked`,
      detail: task.blockedReason ?? task.title,
    })),
  ];

  let recentChanges: string[] = [];
  if (isGit) {
    try {
      recentChanges = git.status(project.rootPath).files.map((file) => file.path).slice(0, 20);
    } catch {
      recentChanges = [];
    }
  }

  return {
    project: {
      name: project.name,
      root: project.rootPath,
      framework: project.framework,
      languages: project.languages,
      branch: isGit ? git.currentBranch(project.rootPath) : null,
      head: isGit ? git.headCommit(project.rootPath) : null,
    },
    currentTask: current ? toHandoffTask(current) : null,
    openTasks: openTasks.filter((task) => task.id !== current?.id).map(toHandoffTask),
    lastSession: lastSession ? toHandoffSession(lastSession) : null,
    decisions,
    constraints,
    knownIssues,
    recentChanges,
    recommendedNextStep: recommendNextStep(current, lastSession, openTasks),
    generatedAt: nowIso(),
  };
}

function toHandoffTask(task: Task): HandoffTask {
  return {
    key: task.key,
    title: task.title,
    status: task.status,
    progress: task.progress,
    remaining: task.requirements.filter((requirement) => !requirement.done).map((requirement) => requirement.text),
    ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
  };
}

function toHandoffSession(session: Session): NonNullable<HandoffReport["lastSession"]> {
  return {
    agent: session.agent,
    endedAt: session.endedAt,
    summary: session.summary,
    completed: session.completed,
    remaining: session.remaining,
    nextStep: session.nextStep,
    filesChanged: session.filesChanged.slice(0, 20),
    tests: session.tests,
  };
}

/**
 * The single most useful line in the report. Priority order: what the previous
 * agent said to do next, then the first unfinished requirement, then the task
 * itself, then anything open at all.
 */
function recommendNextStep(current: Task | null, lastSession: Session | null, openTasks: Task[]): string {
  if (lastSession?.nextStep) return lastSession.nextStep;

  if (current) {
    const blocked = current.status === "BLOCKED" ? ` (blocked: ${current.blockedReason ?? "reason not recorded"})` : "";
    const nextRequirement = current.requirements.find((requirement) => !requirement.done);
    if (nextRequirement) return `Continue ${current.key} - ${nextRequirement.text}${blocked}`;
    if (current.status === "TESTING") return `Verify ${current.key}: ${current.title}, then mark it COMPLETED`;
    return `Continue ${current.key}: ${current.title}${blocked}`;
  }

  const next = openTasks[0];
  if (next) return `Start ${next.key}: ${next.title}`;

  return "No open tasks. Ask the developer what to work on next.";
}
