import { afterAll, describe, expect, it } from "vitest";
import { cleanupAll, git, makeDevMemory, makeHome, makeProject, writeFile } from "./helpers.js";

afterAll(cleanupAll);

async function fixture(home?: string) {
  const root = makeProject({
    name: "work",
    remote: "git@github.com:acme/work.git",
    files: {
      "package.json": JSON.stringify({ name: "work" }),
      "src/auth/AuthService.ts": "export class AuthService {\n  login(email: string) {\n    return email;\n  }\n}\n",
      "src/auth/LoginButton.tsx": "export function LoginButton() {\n  return <button />;\n}\n",
    },
  });
  const devmemory = makeDevMemory(home);
  const { project } = await devmemory.connect({ explicitRoot: root });
  return {
    root,
    devmemory,
    projectId: project.projectId,
    tasks: devmemory.tasksFor(project.projectId),
    sessions: devmemory.sessionsFor(project.projectId),
  };
}

describe("task engine (PRD 30)", () => {
  it("creates tasks with sequential keys and a requirement checklist", async () => {
    const { devmemory, tasks } = await fixture();
    try {
      const first = tasks.create({
        title: "Add Google Login",
        description: "OAuth sign-in for web and mobile.",
        requirements: ["OAuth configuration", "Backend callback", "Frontend button", "Tests"],
        areas: ["authentication", "users"],
      });
      const second = tasks.create({ title: "Rate limit the API" });

      expect(first.key).toBe("TASK-1");
      expect(second.key).toBe("TASK-2");
      expect(first.status).toBe("READY");
      expect(first.requirements).toHaveLength(4);
      expect(first.progress).toEqual({ done: 0, total: 4, percent: 0 });
      expect(first.areas).toContain("authentication");
    } finally {
      devmemory.close();
    }
  });

  it("tracks progress as requirements are ticked off", async () => {
    const { devmemory, tasks } = await fixture();
    try {
      const task = tasks.create({
        title: "Add Google Login",
        requirements: ["OAuth configuration", "Backend callback", "Frontend button", "Tests"],
      });

      const progressed = tasks.update(task.key, {
        status: "IN_PROGRESS",
        completeRequirements: ["OAuth configuration", "Backend callback"],
      });

      expect(progressed.status).toBe("IN_PROGRESS");
      expect(progressed.progress).toEqual({ done: 2, total: 4, percent: 50 });
      expect(progressed.startedAt).toBeTruthy();
      expect(progressed.requirements.filter((entry) => !entry.done).map((entry) => entry.text)).toEqual([
        "Frontend button",
        "Tests",
      ]);

      const reopened = tasks.update(task.key, { reopenRequirements: ["Backend callback"] });
      expect(reopened.progress.done).toBe(1);
    } finally {
      devmemory.close();
    }
  });

  it("enforces the lifecycle but always allows archiving", async () => {
    const { devmemory, tasks } = await fixture();
    try {
      const task = tasks.create({ title: "Ship the dashboard", status: "IDEA" });

      expect(() => tasks.update(task.key, { status: "TESTING" })).toThrowError(/cannot move a task from IDEA/);
      expect(tasks.update(task.key, { status: "READY" }).status).toBe("READY");
      expect(tasks.update(task.key, { status: "IN_PROGRESS" }).status).toBe("IN_PROGRESS");
      expect(tasks.update(task.key, { status: "TESTING" }).status).toBe("TESTING");
      expect(tasks.update(task.key, { status: "COMPLETED" }).completedAt).toBeTruthy();
      expect(tasks.update(task.key, { status: "ARCHIVED" }).status).toBe("ARCHIVED");
    } finally {
      devmemory.close();
    }
  });

  it("records why a task is blocked and clears it when work resumes", async () => {
    const { devmemory, tasks } = await fixture();
    try {
      const task = tasks.create({ title: "Migrate to the new payment API", status: "IN_PROGRESS" });

      const blocked = tasks.update(task.key, { status: "BLOCKED", blockedReason: "Waiting on API credentials" });
      expect(blocked.status).toBe("BLOCKED");
      expect(blocked.blockedReason).toBe("Waiting on API credentials");

      const resumed = tasks.update(task.key, { status: "IN_PROGRESS" });
      expect(resumed.blockedReason).toBeNull();
    } finally {
      devmemory.close();
    }
  });

  it("keeps a timeline of what happened to a task", async () => {
    const { devmemory, tasks } = await fixture();
    try {
      const task = tasks.create({ title: "Add caching", requirements: ["Design"], agent: "claude-code" });
      tasks.update(task.key, { status: "IN_PROGRESS", agent: "claude-code" });
      tasks.update(task.key, { completeRequirements: ["Design"], note: "Chose an LRU", agent: "opencode" });

      const timeline = tasks.events(task.key).map((entry) => entry.event);
      expect(timeline).toEqual(expect.arrayContaining(["created", "status", "progress", "note"]));
      expect(tasks.events(task.key).some((entry) => entry.agent === "opencode")).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("orders the board by what is actually in flight", async () => {
    const { devmemory, tasks } = await fixture();
    try {
      tasks.create({ title: "Someday idea", status: "IDEA" });
      const active = tasks.create({ title: "Active work", status: "IN_PROGRESS" });
      tasks.create({ title: "Ready to pick up" });

      expect(tasks.list({ open: true })[0]?.key).toBe(active.key);
      expect(tasks.current()?.title).toBe("Active work");
      // An IDEA is not live work, so it is not counted as open.
      expect(tasks.stats().open).toBe(2);
      expect(tasks.stats().total).toBe(3);
    } finally {
      devmemory.close();
    }
  });

  it("finds tasks by title, description or requirement text", async () => {
    const { devmemory, tasks } = await fixture();
    try {
      tasks.create({
        title: "Add Google Login",
        description: "OAuth sign-in.",
        requirements: ["Frontend button"],
      });
      tasks.create({ title: "Unrelated cleanup" });

      expect(tasks.search("google oauth").map((task) => task.title)).toContain("Add Google Login");
      expect(tasks.search("frontend button").map((task) => task.title)).toContain("Add Google Login");
    } finally {
      devmemory.close();
    }
  });

  it("rejects unknown tasks and statuses", async () => {
    const { devmemory, tasks } = await fixture();
    try {
      expect(() => tasks.require("TASK-99")).toThrowError(/unknown task/);
      expect(() => tasks.create({ title: "ok" })).toThrowError(/title is too short/);
      expect(() => tasks.create({ title: "Valid title", status: "NOPE" as never })).toThrowError(
        /unknown task status/,
      );
      const task = tasks.create({ title: "Valid task" });
      expect(() => tasks.update(task.key, { completeRequirements: ["not a requirement"] })).toThrowError(
        /unknown requirement/,
      );
    } finally {
      devmemory.close();
    }
  });

  it("never mixes tasks between projects (AC-06)", async () => {
    const alpha = makeProject({ name: "task-alpha", remote: "git@github.com:acme/task-alpha.git" });
    const beta = makeProject({ name: "task-beta", remote: "git@github.com:acme/task-beta.git" });
    const devmemory = makeDevMemory();

    try {
      const a = (await devmemory.connect({ explicitRoot: alpha, index: false })).project;
      const b = (await devmemory.connect({ explicitRoot: beta, index: false })).project;

      devmemory.tasksFor(a.projectId).create({ title: "Alpha only work" });

      expect(devmemory.tasksFor(a.projectId).list({ open: true })).toHaveLength(1);
      expect(devmemory.tasksFor(b.projectId).list({ open: true })).toHaveLength(0);
      expect(devmemory.tasksFor(b.projectId).get("TASK-1")).toBeNull();
    } finally {
      devmemory.close();
    }
  });

  it("survives a restart (AC-12)", async () => {
    const home = makeHome("taskpersist");
    const { devmemory, projectId, tasks } = await fixture(home);
    const task = tasks.create({ title: "Persisted work", requirements: ["Step one"] });
    tasks.update(task.key, { status: "IN_PROGRESS", completeRequirements: ["Step one"] });
    devmemory.close();

    const reopened = makeDevMemory(home);
    try {
      const restored = reopened.tasksFor(projectId).require("TASK-1");
      expect(restored.status).toBe("IN_PROGRESS");
      expect(restored.progress.done).toBe(1);
    } finally {
      reopened.close();
    }
  });
});

describe("session engine (PRD 31)", () => {
  it("records a compact summary rather than a conversation", async () => {
    const { devmemory, sessions, tasks } = await fixture();
    try {
      const task = tasks.create({ title: "Google login", requirements: ["Backend", "Frontend"] });
      const started = sessions.start({ agent: "claude-code", taskId: task.id });

      expect(started.status).toBe("active");
      expect(started.branch).toBeTruthy();
      expect(started.startCommit).toMatch(/^[0-9a-f]{40}$/);

      const ended = sessions.end(started.id, {
        summary: "Implemented the OAuth callback and token handling.",
        completed: ["OAuth callback", "Token handling"],
        remaining: ["Frontend integration"],
        nextStep: "Implement the frontend login button",
        tests: "12 passed",
      });

      expect(ended.status).toBe("ended");
      expect(ended.summary).toContain("OAuth callback");
      expect(ended.nextStep).toBe("Implement the frontend login button");
      expect(sessions.lastEnded()?.id).toBe(ended.id);
      expect(sessions.forTask(task.id)).toHaveLength(1);
    } finally {
      devmemory.close();
    }
  });

  it("attributes changed files to the session using git", async () => {
    const { root, devmemory, sessions } = await fixture();
    try {
      const started = sessions.start({ agent: "opencode" });
      writeFile(root, "src/auth/AuthService.ts", "export class AuthService {\n  login() {\n    return true;\n  }\n}\n");
      writeFile(root, "src/auth/oauth.ts", "export const oauth = true;\n");

      const ended = sessions.end(started.id, { summary: "Reworked login." });

      expect(ended.filesChanged).toEqual(expect.arrayContaining(["src/auth/AuthService.ts", "src/auth/oauth.ts"]));
    } finally {
      devmemory.close();
    }
  });

  it("closes an abandoned session when a new one starts", async () => {
    const { devmemory, sessions } = await fixture();
    try {
      const abandoned = sessions.start({ agent: "claude-code" });
      const fresh = sessions.start({ agent: "opencode" });

      expect(sessions.get(abandoned.id)?.status).toBe("ended");
      expect(sessions.active()?.id).toBe(fresh.id);
      expect(sessions.list()).toHaveLength(2);
    } finally {
      devmemory.close();
    }
  });

  it("refuses to end a session twice", async () => {
    const { devmemory, sessions } = await fixture();
    try {
      const started = sessions.start({ agent: "claude-code" });
      sessions.end(started.id, { summary: "Did some work." });

      expect(() => sessions.end(started.id, { summary: "Again." })).toThrowError(/already ended/);
      expect(() => sessions.require("ses_missing")).toThrowError(/unknown session/);
    } finally {
      devmemory.close();
    }
  });
});

describe("agent handoff (PRD 32, AC-13)", () => {
  it("hands a different agent everything it needs to continue", async () => {
    const { devmemory, projectId, tasks, sessions } = await fixture();
    try {
      const memory = devmemory.memoryFor(projectId);
      memory.remember({
        type: "DECISION",
        title: "Google OAuth reuses the JWT session",
        content: "Google sign-in issues the same JWT session token as password login.",
        decision: { reason: "One session model for every client" },
      });
      memory.remember({
        type: "CONSTRAINT",
        title: "No tokens in logs",
        content: "Access tokens must never be written to application logs.",
      });
      memory.remember({
        type: "BUG",
        title: "Callback can fire twice",
        content: "The OAuth callback occasionally runs twice under retry.",
      });

      const task = tasks.create({
        title: "Add Google Login",
        requirements: ["OAuth configuration", "Backend callback", "Frontend button", "E2E tests"],
      });
      tasks.update(task.key, {
        status: "IN_PROGRESS",
        completeRequirements: ["OAuth configuration", "Backend callback"],
      });

      const session = sessions.start({ agent: "claude-code", taskId: task.id });
      sessions.end(session.id, {
        summary: "OAuth callback and token handling are done.",
        completed: ["OAuth configuration", "Backend callback"],
        remaining: ["Frontend button", "E2E tests"],
        nextStep: "Implement the frontend login button",
        tests: "12 passed",
      });

      // A completely fresh agent asks what is going on.
      const report = devmemory.handoff(projectId);

      expect(report.currentTask?.key).toBe(task.key);
      expect(report.currentTask?.progress).toEqual({ done: 2, total: 4, percent: 50 });
      expect(report.currentTask?.remaining).toEqual(["Frontend button", "E2E tests"]);
      expect(report.lastSession?.agent).toBe("claude-code");
      expect(report.lastSession?.summary).toContain("OAuth callback");
      expect(report.decisions.map((entry) => entry.title)).toContain("Google OAuth reuses the JWT session");
      expect(report.constraints.map((entry) => entry.title)).toContain("No tokens in logs");
      expect(report.knownIssues.map((entry) => entry.title)).toContain("Callback can fire twice");
      expect(report.recommendedNextStep).toBe("Implement the frontend login button");
      expect(report.project.branch).toBeTruthy();
    } finally {
      devmemory.close();
    }
  });

  it("falls back to the first unfinished requirement when no next step was left", async () => {
    const { devmemory, projectId, tasks } = await fixture();
    try {
      const task = tasks.create({
        title: "Add rate limiting",
        requirements: ["Choose an algorithm", "Implement middleware"],
      });
      tasks.update(task.key, { status: "IN_PROGRESS", completeRequirements: ["Choose an algorithm"] });

      expect(devmemory.handoff(projectId).recommendedNextStep).toBe(
        `Continue ${task.key} - Implement middleware`,
      );
    } finally {
      devmemory.close();
    }
  });

  it("suggests starting the next task when nothing is in progress", async () => {
    const { devmemory, projectId, tasks } = await fixture();
    try {
      tasks.create({ title: "Write the deployment guide" });
      expect(devmemory.handoff(projectId).recommendedNextStep).toBe("Start TASK-1: Write the deployment guide");
    } finally {
      devmemory.close();
    }
  });

  it("says so plainly when there is nothing to pick up", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const report = devmemory.handoff(projectId);

      expect(report.currentTask).toBeNull();
      expect(report.lastSession).toBeNull();
      expect(report.recommendedNextStep).toMatch(/No open tasks/);
      expect(report.project.name).toBe("work");
    } finally {
      devmemory.close();
    }
  });

  it("surfaces a blocked task as a known issue", async () => {
    const { devmemory, projectId, tasks } = await fixture();
    try {
      const task = tasks.create({ title: "Switch payment provider", status: "IN_PROGRESS" });
      tasks.update(task.key, { status: "BLOCKED", blockedReason: "Waiting on merchant approval" });

      const report = devmemory.handoff(projectId);
      expect(report.knownIssues.map((issue) => issue.detail)).toContain("Waiting on merchant approval");
      expect(report.recommendedNextStep).toContain("blocked");
    } finally {
      devmemory.close();
    }
  });

  it("keeps branch context in the report", async () => {
    const { root, devmemory, projectId, tasks } = await fixture();
    try {
      git(root, ["checkout", "-q", "-b", "feature/payment"]);
      devmemory.tasksFor(projectId).create({ title: "Branch work" });
      void tasks;

      const report = devmemory.handoff(projectId);
      expect(report.project.branch).toBe("feature/payment");
    } finally {
      devmemory.close();
    }
  });
});
