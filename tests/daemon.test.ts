import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DevMemoryDaemon, ProjectWatcher } from "@samirthakur024/core";
import type { WatchEvent } from "@samirthakur024/core";
import { cleanupAll, git, makeDevMemory, makeProject, removeFile, writeFile } from "./helpers.js";

afterAll(cleanupAll);

const FIXTURE = {
  "package.json": JSON.stringify({ name: "watched" }),
  "src/auth/AuthService.ts": "export class AuthService {\n  login(email: string) {\n    return email;\n  }\n}\n",
  "src/db/Ledger.ts": "export class Ledger {\n  find(id: string) {\n    return id;\n  }\n}\n",
};

/** A project whose package.json name matches, so status output is identifiable. */
function namedProject(name: string): string {
  return makeProject({
    name,
    remote: `git@github.com:acme/${name}.git`,
    files: { ...FIXTURE, "package.json": JSON.stringify({ name }) },
  });
}

async function fixture() {
  const root = makeProject({ name: "watched", files: FIXTURE });
  const devmemory = makeDevMemory();
  const { project } = await devmemory.connect({ explicitRoot: root });
  return { root, devmemory, project };
}

/** Waits for a condition, polling - fs.watch delivery timing is not guaranteed. */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was not met in time");
}

describe("project watcher (PRD 56)", () => {
  it("re-indexes only the file that changed", async () => {
    const { root, devmemory, project } = await fixture();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(devmemory, project, { debounceMs: 50, onEvent: (event) => events.push(event) });

    try {
      watcher.start();
      expect(watcher.isWatching).toBe(true);

      writeFile(root, "src/auth/AuthService.ts", "export class AuthService {\n  login() {\n    return true;\n  }\n  logout() {}\n}\n");
      await waitFor(() => events.length > 0);

      const event = events[0] as WatchEvent;
      expect(event.changed).toContain("src/auth/AuthService.ts");
      expect(event.removed).toHaveLength(0);
      // A single edit is a single-file pass, never a rebuild.
      expect(event.stats?.scanned).toBe(1);
      expect(event.stats?.fullRebuild).toBe(false);

      const symbols = devmemory.codeFor(project.projectId).findSymbols(project.projectId, { name: "logout" });
      expect(symbols).toHaveLength(1);
    } finally {
      watcher.stop();
      devmemory.close();
    }
  });

  it("picks up a new file", async () => {
    const { root, devmemory, project } = await fixture();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(devmemory, project, { debounceMs: 50, onEvent: (event) => events.push(event) });

    try {
      watcher.start();
      writeFile(root, "src/payment/RefundService.ts", "export class RefundService {\n  refund(id: string) {\n    return id;\n  }\n}\n");
      await waitFor(() => events.length > 0);

      const indexed = devmemory
        .filesFor(project.projectId)
        .list(project.projectId, { limit: 100 })
        .map((file) => file.relativePath);
      expect(indexed).toContain("src/payment/RefundService.ts");
    } finally {
      watcher.stop();
      devmemory.close();
    }
  });

  it("notices a deletion and falls back to a full scan for it", async () => {
    const { root, devmemory, project } = await fixture();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(devmemory, project, { debounceMs: 50, onEvent: (event) => events.push(event) });

    try {
      watcher.start();
      removeFile(root, "src/db/Ledger.ts");
      await waitFor(() => events.some((event) => event.removed.length > 0));

      const indexed = devmemory
        .filesFor(project.projectId)
        .list(project.projectId, { limit: 100 })
        .map((file) => file.relativePath);
      expect(indexed).not.toContain("src/db/Ledger.ts");
      expect(devmemory.codeFor(project.projectId).findSymbols(project.projectId, { name: "Ledger" })).toHaveLength(0);
    } finally {
      watcher.stop();
      devmemory.close();
    }
  });

  it("ignores churn in ignored and sensitive paths", async () => {
    const { root, devmemory, project } = await fixture();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(devmemory, project, { debounceMs: 50, onEvent: (event) => events.push(event) });

    try {
      watcher.start();
      fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
      writeFile(root, "node_modules/dep/index.js", "module.exports = 1;\n");
      writeFile(root, ".env", "SECRET=abc\n");
      writeFile(root, "dist/bundle.js", "console.log(1);\n");

      // Give the watcher a chance to react to something it should not react to.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(events).toHaveLength(0);

      // A real source edit still gets through.
      writeFile(root, "src/db/Ledger.ts", "export class Ledger {\n  findAll() {\n    return [];\n  }\n}\n");
      await waitFor(() => events.length > 0);
      expect(events[0]?.changed).toEqual(["src/db/Ledger.ts"]);
    } finally {
      watcher.stop();
      devmemory.close();
    }
  });

  it("invalidates cached context for the files it re-indexes", async () => {
    const { root, devmemory, project } = await fixture();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(devmemory, project, { debounceMs: 50, onEvent: (event) => events.push(event) });

    try {
      devmemory.contextEngine(project.projectId).getContext({ task: "change AuthService login" });
      expect(devmemory.contextCacheFor(project.projectId).analytics().cachedEntries).toBe(1);

      watcher.start();
      writeFile(root, "src/auth/AuthService.ts", "export class AuthService {\n  login() {\n    return false;\n  }\n}\n");
      await waitFor(() => events.length > 0);

      expect(events[0]?.invalidatedContexts).toBeGreaterThan(0);
      expect(devmemory.contextCacheFor(project.projectId).analytics().cachedEntries).toBe(0);
    } finally {
      watcher.stop();
      devmemory.close();
    }
  });

  it("reacts to a branch switch", async () => {
    const { root, devmemory, project } = await fixture();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(devmemory, project, { debounceMs: 50, onEvent: (event) => events.push(event) });

    try {
      watcher.start();
      git(root, ["checkout", "-q", "-b", "feature/watched"]);
      await waitFor(() => events.some((event) => event.branchChanged !== null));

      expect(events.find((event) => event.branchChanged)?.branchChanged).toBe("feature/watched");
    } finally {
      watcher.stop();
      devmemory.close();
    }
  });

  it("stops cleanly and stops reacting", async () => {
    const { root, devmemory, project } = await fixture();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(devmemory, project, { debounceMs: 50, onEvent: (event) => events.push(event) });

    try {
      watcher.start();
      watcher.stop();
      expect(watcher.isWatching).toBe(false);

      writeFile(root, "src/db/Ledger.ts", "export class Ledger {\n  changed() {}\n}\n");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(events).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });
});

describe("daemon (PRD 56)", () => {
  it("watches every connected project and reports status", async () => {
    const alpha = namedProject("daemon-alpha");
    const beta = namedProject("daemon-beta");
    const devmemory = makeDevMemory();
    const daemon = new DevMemoryDaemon(devmemory, { debounceMs: 50 });

    try {
      await devmemory.connect({ explicitRoot: alpha });
      await devmemory.connect({ explicitRoot: beta });

      const status = daemon.start();
      expect(status.running).toBe(true);
      expect(status.watching.map((entry) => entry.name).sort()).toEqual(["daemon-alpha", "daemon-beta"]);

      writeFile(alpha, "src/db/Ledger.ts", "export class Ledger {\n  findOne() {\n    return 1;\n  }\n}\n");
      await waitFor(() => daemon.status().events > 0);

      expect(daemon.status().lastEventAt).toBeTruthy();
    } finally {
      daemon.stop();
      devmemory.close();
    }
  });

  it("picks up a project connected after it started", async () => {
    const devmemory = makeDevMemory();
    const daemon = new DevMemoryDaemon(devmemory, { debounceMs: 50 });

    try {
      daemon.start();
      expect(daemon.status().watching).toHaveLength(0);

      const root = namedProject("daemon-late");
      await devmemory.connect({ explicitRoot: root });
      daemon.syncWatchers();

      expect(daemon.status().watching.map((entry) => entry.name)).toContain("daemon-late");
    } finally {
      daemon.stop();
      devmemory.close();
    }
  });

  it("drops a project that was disconnected", async () => {
    const root = namedProject("daemon-gone");
    const devmemory = makeDevMemory();
    const daemon = new DevMemoryDaemon(devmemory, { debounceMs: 50 });

    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      daemon.start();
      expect(daemon.status().watching).toHaveLength(1);

      devmemory.disconnect(project.projectId);
      daemon.syncWatchers();
      expect(daemon.status().watching).toHaveLength(0);
    } finally {
      daemon.stop();
      devmemory.close();
    }
  });

  it("runs housekeeping over the projects it watches", async () => {
    const root = namedProject("daemon-maintain");
    const devmemory = makeDevMemory();
    const daemon = new DevMemoryDaemon(devmemory, { debounceMs: 50 });

    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const memory = devmemory.memoryFor(project.projectId);
      const stored = memory.remember({
        type: "HISTORY",
        title: "Temporary note",
        content: "Only relevant during the migration window.",
        expiresInDays: 1,
      });
      memory.update(stored.memory.id, { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });

      daemon.start();
      const result = daemon.maintain();

      expect(result.projects).toBe(1);
      expect(result.archivedMemories).toBe(1);
      expect(devmemory.memoryFor(project.projectId).get(stored.memory.id)?.status).toBe("archived");
      expect(daemon.status().maintenanceRuns).toBeGreaterThan(0);
    } finally {
      daemon.stop();
      devmemory.close();
    }
  });
});
