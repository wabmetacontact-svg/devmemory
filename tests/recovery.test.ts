import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { projectLayout } from "@devmemory/shared";
import { cleanupAll, makeDevMemory, makeHome, makeProject } from "./helpers.js";

afterAll(cleanupAll);

const FIXTURE = {
  "package.json": JSON.stringify({ name: "recoverable" }),
  "src/auth/AuthService.ts": "export class AuthService {\n  login(email: string) {\n    return email;\n  }\n}\n",
  "src/db/Ledger.ts": "export class Ledger {\n  find(id: string) {\n    return id;\n  }\n}\n",
};

async function fixture(home = makeHome("recovery")) {
  const root = makeProject({ name: "recoverable", files: FIXTURE });
  const devmemory = makeDevMemory(home);
  const { project } = await devmemory.connect({ explicitRoot: root });
  return { home, root, devmemory, projectId: project.projectId };
}

describe("health checks (PRD 60, 64)", () => {
  it("reports a healthy installation with platform detail", async () => {
    const { devmemory } = await fixture();
    try {
      const report = devmemory.recovery().check();

      expect(report.healthy).toBe(true);
      expect(report.issues).toHaveLength(0);
      expect(report.projects).toBe(1);
      expect(report.platform.driver).toBe("node:sqlite");
      expect(report.platform.node).toBe(process.version);
      expect(report.checks.find((check) => check.name === "registry integrity")?.detail).toBe("ok");
    } finally {
      devmemory.close();
    }
  });

  it("notices a project whose root has gone", async () => {
    const { root, devmemory } = await fixture();
    try {
      fs.rmSync(root, { recursive: true, force: true });
      const report = devmemory.recovery().check();

      const issue = report.issues.find((entry) => entry.code === "missing_root");
      expect(issue?.severity).toBe("warning");
      expect(issue?.message).toContain("no longer exists");
      // A missing checkout is not corruption; the intelligence is still valid.
      expect(report.healthy).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("notices an interrupted index run and completes it on repair", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const store = devmemory.filesFor(projectId);
      // Simulate a crash mid-run: the row stays marked 'running'.
      store.startRun(projectId, false);
      expect(store.hasUnfinishedRun(projectId)).toBe(true);

      const before = devmemory.recovery().check();
      expect(before.issues.some((issue) => issue.code === "incomplete_index")).toBe(true);

      const repair = devmemory.recovery().repair();
      expect(repair.actions.some((action) => action.code === "abandoned_stale_run")).toBe(true);
      expect(store.hasUnfinishedRun(projectId)).toBe(false);
      expect(repair.remaining.some((issue) => issue.code === "incomplete_index")).toBe(false);
    } finally {
      devmemory.close();
    }
  });

  it("finds storage that belongs to no project", async () => {
    const { home, devmemory } = await fixture();
    try {
      const orphan = projectLayout("proj_00orphan99", home).root;
      fs.mkdirSync(orphan, { recursive: true });

      expect(devmemory.recovery().check().issues.some((issue) => issue.code === "orphan_storage")).toBe(true);

      // Deleting storage is never automatic; it has to be asked for.
      devmemory.recovery().repair();
      expect(fs.existsSync(orphan)).toBe(true);

      devmemory.recovery().repair({ removeOrphans: true });
      expect(fs.existsSync(orphan)).toBe(false);
    } finally {
      devmemory.close();
    }
  });
});

describe("recovery (PRD 60)", () => {
  it("rebuilds a corrupted index and re-indexes from the filesystem", async () => {
    const home = makeHome("corruptindex");
    const { devmemory, projectId } = await fixture(home);
    const layout = projectLayout(projectId, home);
    devmemory.close();

    // Overwrite the index with rubbish, the way a bad shutdown or a bad disk would.
    const broken = makeDevMemory(home);
    broken.databases.closeProject(projectId);
    fs.writeFileSync(layout.indexDb, "this is not a database", "utf8");
    fs.rmSync(`${layout.indexDb}-wal`, { force: true });
    fs.rmSync(`${layout.indexDb}-shm`, { force: true });

    try {
      const report = broken.recovery().check();
      const issue = report.issues.find((entry) => entry.code === "index_corrupt");
      expect(issue?.repairable).toBe(true);
      expect(report.healthy).toBe(false);

      const repair = broken.recovery().repair({ rebuildIndex: true });
      expect(repair.actions.some((action) => action.code === "rebuilt_index")).toBe(true);
      expect(broken.recovery().check().healthy).toBe(true);

      // The rebuilt index is empty but valid, and a normal pass refills it.
      const stats = await broken.index(projectId);
      expect(stats.added).toBeGreaterThan(0);
      expect(broken.codeFor(projectId).findSymbols(projectId, { name: "AuthService" })).toHaveLength(1);
    } finally {
      broken.close();
    }
  });

  it("never destroys memory to fix an index", async () => {
    const home = makeHome("memorysafe");
    const { devmemory, projectId } = await fixture(home);
    devmemory.memoryFor(projectId).remember({
      type: "DECISION",
      title: "Irreplaceable decision",
      content: "This exists nowhere but in DevMemory and must survive an index rebuild.",
    });
    devmemory.tasksFor(projectId).create({ title: "Irreplaceable task", requirements: ["Step one"] });

    const layout = projectLayout(projectId, home);
    devmemory.close();

    const broken = makeDevMemory(home);
    broken.databases.closeProject(projectId);
    fs.writeFileSync(layout.indexDb, "corrupt", "utf8");

    try {
      broken.recovery().repair({ rebuildIndex: true });

      expect(fs.existsSync(layout.memoryDb)).toBe(true);
      expect(broken.memoryFor(projectId).recall({ limit: 5 }).map((entry) => entry.title)).toContain(
        "Irreplaceable decision",
      );
      expect(broken.tasksFor(projectId).require("TASK-1").title).toBe("Irreplaceable task");
    } finally {
      broken.close();
    }
  });

  it("reports a corrupted memory database instead of quietly recreating it", async () => {
    const home = makeHome("corruptmemory");
    const { devmemory, projectId } = await fixture(home);
    devmemory.memoryFor(projectId).remember({ type: "FACT", title: "Something", content: "Worth keeping around." });
    const layout = projectLayout(projectId, home);
    devmemory.close();

    const broken = makeDevMemory(home);
    broken.databases.closeProject(projectId);
    fs.writeFileSync(layout.memoryDb, "corrupt", "utf8");

    try {
      const report = broken.recovery().check();
      const issue = report.issues.find((entry) => entry.code === "memory_corrupt");

      expect(issue).toBeDefined();
      expect(issue?.repairable).toBe(false);
      expect(issue?.message).toContain("cannot be regenerated");

      // Repair leaves it alone rather than losing what only it holds.
      broken.recovery().repair({ rebuildIndex: true });
      expect(broken.recovery().check().issues.some((entry) => entry.code === "memory_corrupt")).toBe(true);
    } finally {
      broken.close();
    }
  });

  it("resumes indexing after an interrupted run without losing data", async () => {
    const { root, devmemory, projectId } = await fixture();
    try {
      const store = devmemory.filesFor(projectId);
      const before = store.stats(projectId).files;

      store.startRun(projectId, false);
      fs.writeFileSync(`${root}/src/new.ts`, "export const added = 1;\n", "utf8");

      // The next ordinary pass abandons the stale run and completes normally.
      const stats = await devmemory.index(projectId);
      expect(stats.added).toBe(1);
      expect(store.stats(projectId).files).toBe(before + 1);
      expect(store.hasUnfinishedRun(projectId)).toBe(false);
    } finally {
      devmemory.close();
    }
  });

  it("compacts a project without losing anything live", async () => {
    const { root, devmemory, projectId } = await fixture();
    try {
      fs.rmSync(`${root}/src/db/Ledger.ts`, { force: true });
      await devmemory.index(projectId);

      const result = devmemory.recovery().compact(projectId);
      expect(result.purgedFiles).toBeGreaterThan(0);

      const remaining = devmemory
        .filesFor(projectId)
        .list(projectId, { limit: 50 })
        .map((file) => file.relativePath);
      expect(remaining).toContain("src/auth/AuthService.ts");
      expect(devmemory.recovery().check().healthy).toBe(true);
    } finally {
      devmemory.close();
    }
  });
});
