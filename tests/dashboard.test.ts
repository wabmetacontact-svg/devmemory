import { afterAll, describe, expect, it } from "vitest";
import { startDashboard, type RunningDashboard } from "@samirthakur024/dashboard";
import type { DevMemory } from "@samirthakur024/core";
import { cleanupAll, makeDevMemory, makeProject } from "./helpers.js";

afterAll(cleanupAll);

const FIXTURE = {
  "package.json": JSON.stringify({ name: "shopfront", dependencies: { express: "4.18.0" } }),
  "src/payment/PaymentService.ts":
    'import { Ledger } from "../db/Ledger";\n\nexport class PaymentService {\n  constructor(private ledger: Ledger) {}\n\n  verifyPayment(id: string) {\n    return this.ledger.find(id);\n  }\n}\n',
  "src/db/Ledger.ts": "export class Ledger {\n  find(id: string) {\n    return id;\n  }\n}\n",
  "src/server.ts":
    'import express from "express";\n\nconst app = express();\napp.post("/payments/verify", (req, res) => res.json({ ok: true }));\n\nexport { app };\n',
  "tests/payment.test.ts": 'import { PaymentService } from "../src/payment/PaymentService";\n\ntest("x", () => new PaymentService({} as never));\n',
};

interface Harness {
  devmemory: DevMemory;
  dashboard: RunningDashboard;
  projectId: string;
  get: (path: string) => Promise<any>;
  send: (path: string, method: string, body?: unknown) => Promise<any>;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = makeProject({ name: "dashboard", files: FIXTURE });
  const devmemory = makeDevMemory();
  const { project } = await devmemory.connect({ explicitRoot: root });
  // Port 0 lets the OS pick a free port, so tests never collide.
  const dashboard = await startDashboard({ devmemory, port: 0 });

  const request = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`${dashboard.url}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    return { status: response.status, body: payload };
  };

  return {
    devmemory,
    dashboard,
    projectId: project.projectId,
    get: async (path: string) => (await request(path, "GET")).body,
    send: async (path: string, method: string, body?: unknown) => (await request(path, method, body ?? {})).body,
    close: async () => {
      await dashboard.close();
      devmemory.close();
    },
  };
}

describe("dashboard server (PRD 41, 42)", () => {
  it("serves the UI and a health check", async () => {
    const app = await harness();
    try {
      const page = await fetch(app.dashboard.url);
      const html = await page.text();

      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(html).toContain("<title>DevMemory</title>");
      expect(html).toContain("Analytics");

      const health = await app.get("/health");
      expect(health.ok).toBe(true);
      expect(health.home).toBe(app.devmemory.home);
    } finally {
      await app.close();
    }
  });

  it("binds loopback and refuses anything else without explicit consent", async () => {
    const devmemory = makeDevMemory();
    try {
      await expect(startDashboard({ devmemory, port: 0, host: "0.0.0.0" })).rejects.toThrowError(/local-only/);

      const loopback = await startDashboard({ devmemory, port: 0 });
      expect(loopback.host).toBe("127.0.0.1");
      await loopback.close();
    } finally {
      devmemory.close();
    }
  });

  it("answers with a structured 404 for unknown routes", async () => {
    const app = await harness();
    try {
      const response = await fetch(`${app.dashboard.url}/api/nope`);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");

      const missingProject = await fetch(`${app.dashboard.url}/api/projects/proj_00deadbeef`);
      expect(missingProject.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("dashboard data (PRD 43-53)", () => {
  it("reports the overview totals", async () => {
    const app = await harness();
    try {
      const overview = await app.get("/api/overview");

      expect(overview.projects).toBeGreaterThan(0);
      expect(overview.files).toBeGreaterThan(0);
      expect(overview.symbols).toBeGreaterThan(0);
      expect(overview.recent[0].name).toBe("shopfront");
    } finally {
      await app.close();
    }
  });

  it("lists projects and one project's full status", async () => {
    const app = await harness();
    try {
      const projects = await app.get("/api/projects");
      expect(projects.projects[0].project_id).toBe(app.projectId);

      const status = await app.get(`/api/projects/${app.projectId}`);
      expect(status.name).toBe("shopfront");
      expect(status.files.files).toBeGreaterThan(0);
      expect(status.code.symbols).toBeGreaterThan(0);
      expect(status.index.status).toBe("healthy");
      expect(status.storage).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("creates and advances a task through the API (AC-17)", async () => {
    const app = await harness();
    try {
      const created = await app.send(`/api/projects/${app.projectId}/tasks`, "POST", {
        title: "Add refunds",
        requirements: ["Design the API", "Implement it"],
      });
      expect(created.task.key).toBe("TASK-1");

      const updated = await app.send(`/api/projects/${app.projectId}/tasks/TASK-1`, "PATCH", {
        status: "IN_PROGRESS",
        complete_requirements: ["Design the API"],
      });
      expect(updated.task.status).toBe("IN_PROGRESS");
      expect(updated.task.progress.percent).toBe(50);

      const board = await app.get(`/api/projects/${app.projectId}/tasks`);
      expect(board.current.key).toBe("TASK-1");
      expect(board.stats.open).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("creates, lists and archives memory through the API", async () => {
    const app = await harness();
    try {
      const created = await app.send(`/api/projects/${app.projectId}/memory`, "POST", {
        type: "DECISION",
        title: "Payments are idempotent",
        content: "Every payment webhook must be safe to process twice.",
        reason: "The provider retries",
      });
      expect(created.memory.type).toBe("DECISION");

      const listed = await app.get(`/api/projects/${app.projectId}/memory`);
      expect(listed.memories).toHaveLength(1);

      const archived = await app.send(
        `/api/projects/${app.projectId}/memory/${created.memory.id}`,
        "DELETE",
      );
      expect(archived.archived).toBe(true);
      expect((await app.get(`/api/projects/${app.projectId}/memory`)).memories).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("re-indexes on demand", async () => {
    const app = await harness();
    try {
      const result = await app.send(`/api/projects/${app.projectId}/index`, "POST", { full: true });
      expect(result.stats.fullRebuild).toBe(true);
      expect(result.stats.scanned).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("serves changes, sessions and handoff", async () => {
    const app = await harness();
    try {
      const changes = await app.get(`/api/projects/${app.projectId}/changes`);
      expect(changes.commits.length).toBeGreaterThan(0);
      expect(changes.recent_files.length).toBeGreaterThan(0);

      expect((await app.get(`/api/projects/${app.projectId}/sessions`)).sessions).toEqual([]);

      const handoff = await app.get(`/api/projects/${app.projectId}/handoff`);
      expect(handoff.recommendedNextStep).toMatch(/No open tasks/);
      expect(handoff.project.name).toBe("shopfront");
    } finally {
      await app.close();
    }
  });

  it("searches code, memory and tasks together (PRD 53)", async () => {
    const app = await harness();
    try {
      const results = await app.get(`/api/projects/${app.projectId}/search?q=verify%20payment`);
      expect(results.results.some((entry: { path: string }) => entry.path === "src/payment/PaymentService.ts")).toBe(true);

      const tooShort = await app.get(`/api/projects/${app.projectId}/search?q=a`);
      expect(tooShort.results).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("exposes the dependency graph and architecture (PRD 48, 52)", async () => {
    const app = await harness();
    try {
      const graph = await app.get(`/api/projects/${app.projectId}/graph`);
      expect(graph.files.some((file: { path: string }) => file.path === "src/db/Ledger.ts")).toBe(true);

      const detail = await app.get(`/api/projects/${app.projectId}/graph?path=src/payment/PaymentService.ts`);
      expect(detail.dependencies.map((edge: { path: string }) => edge.path)).toContain("src/db/Ledger.ts");
      expect(detail.symbols.map((symbol: { name: string }) => symbol.name)).toContain("verifyPayment");

      const architecture = await app.get(`/api/projects/${app.projectId}/architecture`);
      expect(architecture.languages).toContain("TypeScript");
      expect(architecture.external_packages.map((entry: { package: string }) => entry.package)).toContain("express");
    } finally {
      await app.close();
    }
  });

  it("reports token analytics and settings (PRD 51, 54)", async () => {
    const app = await harness();
    try {
      app.devmemory.contextEngine(app.projectId).getContext({ task: "fix payment verification" });

      const analytics = await app.get(`/api/projects/${app.projectId}/analytics`);
      expect(analytics.requests).toBe(1);
      expect(analytics.filesAvoided).toBeGreaterThanOrEqual(0);

      const settings = await app.get("/api/settings");
      expect(settings.driver).toBe("node:sqlite");
      expect(settings.security.permissions.DESTRUCTIVE).toBe("confirm");
      expect(settings.home).toBe(app.devmemory.home);
    } finally {
      await app.close();
    }
  });

  it("keeps one project's data out of another's responses (AC-06)", async () => {
    const app = await harness();
    const otherRoot = makeProject({
      name: "other",
      remote: "git@github.com:acme/other.git",
      files: { "package.json": JSON.stringify({ name: "other" }), "src/secretly.ts": "export const otherOnly = 1;\n" },
    });

    try {
      const other = (await app.devmemory.connect({ explicitRoot: otherRoot })).project;

      const search = await app.get(`/api/projects/${app.projectId}/search?q=otherOnly`);
      expect(search.results).toEqual([]);

      const graph = await app.get(`/api/projects/${other.projectId}/graph`);
      expect(graph.files.every((file: { path: string }) => !file.path.includes("PaymentService"))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
