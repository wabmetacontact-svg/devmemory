import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDevMemoryServer } from "@samirthakur024/mcp";
import { startDashboard } from "@samirthakur024/dashboard";
import { defaultConfig, homeLayout } from "@samirthakur024/shared";
import type { DevMemory } from "@samirthakur024/core";
import { FAKE_SECRETS, cleanupAll, git, makeDevMemory, makeHome, makeProject, writeFile } from "./helpers.js";

afterAll(cleanupAll);

/**
 * The acceptance criteria from PRD 72, one test each. This file is the answer to
 * "is it done?" - every criterion that can be checked in code is checked here.
 */

const APP = {
  "package.json": JSON.stringify({ name: "acme-app", dependencies: { express: "4.18.0" } }),
  "src/auth/AuthService.ts":
    'import { UserRepository } from "../db/UserRepository";\n\nexport class AuthService {\n  constructor(private users: UserRepository) {}\n\n  async login(email: string, password: string) {\n    return this.users.findByEmail(email);\n  }\n}\n',
  "src/db/UserRepository.ts": "export class UserRepository {\n  findByEmail(email: string) {\n    return { email };\n  }\n}\n",
  "src/billing/Invoice.ts": "export class Invoice {\n  total() {\n    return 0;\n  }\n}\n",
  "tests/auth.test.ts": 'import { AuthService } from "../src/auth/AuthService";\n\ntest("login", () => new AuthService({} as never));\n',
};

async function agent(devmemory: DevMemory, root: string, name: string) {
  const { server } = createDevMemoryServer({ devmemory, cwd: root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "1.0.0" }, { capabilities: { roots: {} } });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = (result.content as Array<{ text: string }>)[0]?.text ?? "{}";
    return JSON.parse(content) as any;
  };

  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

describe("acceptance criteria (PRD 72)", () => {
  it("AC-01: installs globally and serves many projects from one installation", async () => {
    const home = makeHome("ac01");
    const devmemory = makeDevMemory(home);
    try {
      const first = makeProject({ name: "ac01-a", remote: "git@github.com:acme/ac01-a.git", files: APP });
      const second = makeProject({ name: "ac01-b", remote: "git@github.com:acme/ac01-b.git", files: APP });

      await devmemory.connect({ explicitRoot: first });
      await devmemory.connect({ explicitRoot: second });

      const layout = homeLayout(home);
      expect(fs.existsSync(layout.registryDb)).toBe(true);
      expect(devmemory.listProjects()).toHaveLength(2);
      // One storage root, outside every project.
      expect(first.startsWith(layout.root)).toBe(false);
      expect(second.startsWith(layout.root)).toBe(false);
    } finally {
      devmemory.close();
    }
  });

  it("AC-02: writes nothing into the project folder", async () => {
    const root = makeProject({ name: "ac02", files: APP });
    const before = fs.readdirSync(root).sort();
    const devmemory = makeDevMemory();

    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      devmemory.memoryFor(project.projectId).remember({
        type: "DECISION",
        title: "Sessions are JWT",
        content: "Authentication uses stateless JWT sessions.",
      });
      devmemory.tasksFor(project.projectId).create({ title: "Add Google login" });
      devmemory.contextEngine(project.projectId).getContext({ task: "fix login" });

      expect(fs.readdirSync(root).sort()).toEqual(before);
      for (const forbidden of [".dev-mcp", ".ai", ".memory", ".devmemory"]) {
        expect(fs.existsSync(path.join(root, forbidden))).toBe(false);
      }
    } finally {
      devmemory.close();
    }
  });

  it("AC-03: identifies the current project automatically from the working directory", async () => {
    const root = makeProject({ name: "ac03", files: APP });
    const devmemory = makeDevMemory();
    try {
      // No project id, no explicit root - just a directory inside the project.
      const resolved = await devmemory.requireProject({ cwd: path.join(root, "src", "auth") });
      expect(resolved.rootPath).toBe(root);
      expect(resolved.projectId).toMatch(/^proj_/);
    } finally {
      devmemory.close();
    }
  });

  it("AC-04: identifies git projects by repository, not by path", async () => {
    const root = makeProject({ name: "ac04", remote: "git@github.com:acme/ac04.git", files: APP });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root, index: false });
      expect(project.identitySource).toBe("git_remote");
      expect(project.repositoryUrl).toBe("git@github.com:acme/ac04.git");
    } finally {
      devmemory.close();
    }
  });

  it("AC-05: identifies non-git projects too", async () => {
    const root = makeProject({ name: "ac05", git: false, files: APP });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      expect(project.identitySource).toBe("fingerprint");
      expect(devmemory.filesFor(project.projectId).stats(project.projectId).files).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("AC-06: projects have isolated intelligence", async () => {
    const alpha = makeProject({ name: "ac06-a", remote: "git@github.com:acme/ac06-a.git", files: APP });
    const beta = makeProject({
      name: "ac06-b",
      remote: "git@github.com:acme/ac06-b.git",
      files: { "package.json": JSON.stringify({ name: "beta" }), "src/beta.ts": "export const betaOnly = 1;\n" },
    });
    const devmemory = makeDevMemory();

    try {
      const a = (await devmemory.connect({ explicitRoot: alpha })).project;
      const b = (await devmemory.connect({ explicitRoot: beta })).project;

      devmemory.memoryFor(a.projectId).remember({ type: "FACT", title: "Alpha fact", content: "Only true for alpha." });
      devmemory.tasksFor(a.projectId).create({ title: "Alpha task" });

      expect(devmemory.memoryFor(b.projectId).recall({ limit: 10 })).toHaveLength(0);
      expect(devmemory.tasksFor(b.projectId).list({ limit: 10 })).toHaveLength(0);
      expect(devmemory.codeFor(b.projectId).findSymbols(b.projectId, { name: "AuthService" })).toHaveLength(0);
      expect(devmemory.contextEngine(b.projectId).searchContext("AuthService")).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });

  it("AC-07 and AC-08: any MCP client can drive it, and two agents share one project", async () => {
    const root = makeProject({ name: "ac07", files: APP });
    const devmemory = makeDevMemory();

    const claude = await agent(devmemory, root, "claude-code");
    const opencode = await agent(devmemory, root, "opencode");

    try {
      const tools = await claude.client.listTools();
      expect(tools.tools.length).toBeGreaterThan(20);

      const connected = await claude.call("project_connect", { root });
      expect(connected.project_id).toMatch(/^proj_/);

      // The second agent, with no shared conversation, sees the same project.
      const status = await opencode.call("project_status", { root });
      expect(status.project_id).toBe(connected.project_id);
      expect(status.files).toBeGreaterThan(0);
    } finally {
      await claude.close();
      await opencode.close();
      devmemory.close();
    }
  });

  it("AC-09: a change does not trigger a full re-index", async () => {
    const root = makeProject({ name: "ac09", files: APP });
    const devmemory = makeDevMemory();
    try {
      const { project, index } = await devmemory.connect({ explicitRoot: root });
      const total = index?.scanned as number;

      writeFile(root, "src/billing/Invoice.ts", "export class Invoice {\n  total() {\n    return 42;\n  }\n}\n");
      const second = await devmemory.index(project.projectId);

      expect(second.fullRebuild).toBe(false);
      expect(second.updated).toBe(1);
      expect(second.parsed).toBe(1);
      expect(second.unchanged).toBe(total - 1);
    } finally {
      devmemory.close();
    }
  });

  it("AC-10: only relevant context is returned", async () => {
    const root = makeProject({ name: "ac10", files: APP });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const context = devmemory.contextEngine(project.projectId).getContext({ task: "fix login validation" });
      const paths = context.files.map((file) => file.path);

      expect(paths).toContain("src/auth/AuthService.ts");
      expect(paths).not.toContain("src/billing/Invoice.ts");
      expect(context.tokenEstimate).toBeLessThanOrEqual(context.budget);
      expect(context.filesAvoided).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("AC-11: important decisions can be retrieved later", async () => {
    const home = makeHome("ac11");
    const root = makeProject({ name: "ac11", remote: "git@github.com:acme/ac11.git", files: APP });

    const first = makeDevMemory(home);
    const project = (await first.connect({ explicitRoot: root, index: false })).project;
    first.memoryFor(project.projectId).remember({
      type: "DECISION",
      title: "PostgreSQL for transactional data",
      content: "Payments and orders must be atomic, so PostgreSQL is the primary datastore.",
      decision: { reason: "Strong transaction requirements", alternatives: ["MongoDB"], affected: ["payments", "orders"] },
    });
    first.close();

    const later = makeDevMemory(home);
    try {
      const recalled = later.memoryFor(project.projectId).recall({ query: "which database and why" });
      expect(recalled[0]?.title).toBe("PostgreSQL for transactional data");
      expect(recalled[0]?.decision?.reason).toBe("Strong transaction requirements");
      expect(recalled[0]?.decision?.affected).toContain("payments");
    } finally {
      later.close();
    }
  });

  it("AC-12: tasks persist between sessions", async () => {
    const home = makeHome("ac12");
    const root = makeProject({ name: "ac12", remote: "git@github.com:acme/ac12.git", files: APP });

    const first = makeDevMemory(home);
    const project = (await first.connect({ explicitRoot: root, index: false })).project;
    const task = first.tasksFor(project.projectId).create({
      title: "Add Google login",
      requirements: ["OAuth config", "Callback", "Button"],
    });
    first.tasksFor(project.projectId).update(task.key, { status: "IN_PROGRESS", completeRequirements: ["OAuth config"] });
    first.close();

    const later = makeDevMemory(home);
    try {
      const restored = later.tasksFor(project.projectId).require("TASK-1");
      expect(restored.status).toBe("IN_PROGRESS");
      expect(restored.progress).toEqual({ done: 1, total: 3, percent: 33 });
    } finally {
      later.close();
    }
  });

  it("AC-13: a session can be handed from one agent to another", async () => {
    const root = makeProject({ name: "ac13", files: APP });
    const devmemory = makeDevMemory();
    const claude = await agent(devmemory, root, "claude-code");
    const opencode = await agent(devmemory, root, "opencode");

    try {
      await claude.call("project_connect", { root });
      await claude.call("task_create", { title: "Add Google login", requirements: ["Backend", "Frontend"] });
      await claude.call("task_update", { task: "TASK-1", status: "IN_PROGRESS", complete_requirements: ["Backend"] });
      await claude.call("session_start", { agent: "claude-code", task: "TASK-1" });
      await claude.call("session_end", {
        summary: "Backend callback done.",
        completed: ["Backend"],
        remaining: ["Frontend"],
        next_step: "Implement the frontend login button",
      });

      const report = await opencode.call("handoff", {});
      expect(report.current_task.key).toBe("TASK-1");
      expect(report.current_task.remaining).toEqual(["Frontend"]);
      expect(report.last_session.agent).toBe("claude-code");
      expect(report.recommended_next_step).toBe("Implement the frontend login button");
    } finally {
      await claude.close();
      await opencode.close();
      devmemory.close();
    }
  });

  it("AC-14: git changes can be associated with a task", async () => {
    const root = makeProject({ name: "ac14", files: APP });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const task = devmemory.tasksFor(project.projectId).create({ title: "Harden login", status: "IN_PROGRESS" });

      const sessions = devmemory.sessionsFor(project.projectId);
      const session = sessions.start({ agent: "claude-code", taskId: task.id });
      writeFile(root, "src/auth/AuthService.ts", "export class AuthService {\n  login() {\n    return true;\n  }\n}\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-qm", "harden login"]);
      const ended = sessions.end(session.id, { summary: "Hardened login." });

      expect(ended.taskId).toBe(task.id);
      expect(ended.filesChanged).toContain("src/auth/AuthService.ts");
      expect(ended.startCommit).not.toBe(ended.endCommit);
      expect(sessions.forTask(task.id)).toHaveLength(1);
    } finally {
      devmemory.close();
    }
  });

  it("AC-15: secrets cannot leak through indexing or context", async () => {
    const root = makeProject({
      name: "ac15",
      files: {
        ...APP,
        ".env": `STRIPE_SECRET_KEY=${FAKE_SECRETS.stripeKeyAlt}\n`,
        "certs/key.pem": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        "src/config.ts": `export const token = "${FAKE_SECRETS.githubToken}";\n`,
      },
    });
    const devmemory = makeDevMemory();

    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const indexed = devmemory
        .filesFor(project.projectId)
        .list(project.projectId, { limit: 100 })
        .map((file) => file.relativePath);

      expect(indexed).not.toContain(".env");
      expect(indexed).not.toContain("certs/key.pem");

      const context = devmemory.contextEngine(project.projectId).getContext({
        task: "review the token in config",
        paths: ["src/config.ts"],
        includeSource: true,
        maxTokens: 20_000,
      });
      const serialised = JSON.stringify(context);

      expect(serialised).not.toContain(FAKE_SECRETS.githubToken);
      expect(serialised).not.toContain(FAKE_SECRETS.stripeKeyAlt);
      expect(devmemory.status(project.projectId).security.files).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("AC-16: restarting DevMemory loses nothing", async () => {
    const home = makeHome("ac16");
    const root = makeProject({ name: "ac16", remote: "git@github.com:acme/ac16.git", files: APP });

    const first = makeDevMemory(home);
    const project = (await first.connect({ explicitRoot: root })).project;
    first.memoryFor(project.projectId).remember({ type: "FACT", title: "Kept", content: "This must survive a restart." });
    first.tasksFor(project.projectId).create({ title: "Kept task" });
    const filesBefore = first.filesFor(project.projectId).stats(project.projectId).files;
    const symbolsBefore = first.codeFor(project.projectId).stats(project.projectId).symbols;
    first.close();

    const later = makeDevMemory(home);
    try {
      expect(later.filesFor(project.projectId).stats(project.projectId).files).toBe(filesBefore);
      expect(later.codeFor(project.projectId).stats(project.projectId).symbols).toBe(symbolsBefore);
      expect(later.memoryFor(project.projectId).recall({ limit: 5 })).toHaveLength(1);
      expect(later.tasksFor(project.projectId).list({ limit: 5 })).toHaveLength(1);
      expect(later.recovery().check().healthy).toBe(true);
    } finally {
      later.close();
    }
  });

  it("AC-17: the dashboard can display and manage project intelligence", async () => {
    const root = makeProject({ name: "ac17", files: APP });
    const devmemory = makeDevMemory();
    const { project } = await devmemory.connect({ explicitRoot: root });
    const dashboard = await startDashboard({ devmemory, port: 0 });

    const get = async (route: string) => (await fetch(`${dashboard.url}${route}`)).json() as any;
    const send = async (route: string, method: string, body: unknown) =>
      (await fetch(`${dashboard.url}${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })).json() as any;

    try {
      expect((await get("/api/overview")).files).toBeGreaterThan(0);
      expect((await get(`/api/projects/${project.projectId}`)).code.symbols).toBeGreaterThan(0);

      // Manage, not just display.
      const created = await send(`/api/projects/${project.projectId}/tasks`, "POST", { title: "From the dashboard" });
      expect(created.task.key).toBe("TASK-1");
      const updated = await send(`/api/projects/${project.projectId}/tasks/TASK-1`, "PATCH", { status: "IN_PROGRESS" });
      expect(updated.task.status).toBe("IN_PROGRESS");

      const remembered = await send(`/api/projects/${project.projectId}/memory`, "POST", {
        type: "DECISION",
        title: "From the dashboard",
        content: "Recorded through the dashboard API.",
      });
      expect(remembered.memory.id).toMatch(/^mem_/);
    } finally {
      await dashboard.close();
      devmemory.close();
    }
  });

  it("AC-18: works with no external service, key or account", async () => {
    const root = makeProject({ name: "ac18", files: APP });
    const devmemory = makeDevMemory();
    try {
      const config = defaultConfig();
      // There is nowhere in the configuration to put a key, endpoint or account.
      const serialised = JSON.stringify(config).toLowerCase();
      for (const forbidden of ["apikey", "api_key", "token", "endpoint", "account", "openai", "anthropic"]) {
        expect(serialised).not.toContain(forbidden);
      }

      // And the full flow runs regardless: everything here is local computation.
      const { project } = await devmemory.connect({ explicitRoot: root });
      devmemory.memoryFor(project.projectId).remember({ type: "FACT", title: "Local", content: "No network required." });
      const context = devmemory.contextEngine(project.projectId).getContext({ task: "fix login validation" });

      expect(context.files.length).toBeGreaterThan(0);
      expect(devmemory.databases.driver.name).toBe("node:sqlite");
    } finally {
      devmemory.close();
    }
  });
});
