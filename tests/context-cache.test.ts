import { afterAll, describe, expect, it } from "vitest";
import { ContextCache } from "@devmemory/core";
import { cleanupAll, git, makeDevMemory, makeProject, removeFile, writeFile } from "./helpers.js";

afterAll(cleanupAll);

const FIXTURE = {
  "package.json": JSON.stringify({ name: "cached" }),
  "src/payment/PaymentService.ts":
    'import { Ledger } from "../db/Ledger";\n\nexport class PaymentService {\n  constructor(private ledger: Ledger) {}\n\n  verifyPayment(id: string) {\n    return this.ledger.find(id);\n  }\n}\n',
  "src/db/Ledger.ts": "export class Ledger {\n  find(id: string) {\n    return id;\n  }\n}\n",
  "src/ui/Sidebar.tsx": "export function Sidebar() {\n  return <nav />;\n}\n",
};

async function fixture() {
  const root = makeProject({ name: "cached", files: FIXTURE });
  const devmemory = makeDevMemory();
  const { project } = await devmemory.connect({ explicitRoot: root });
  return {
    root,
    devmemory,
    projectId: project.projectId,
    engine: devmemory.contextEngine(project.projectId),
    cache: devmemory.contextCacheFor(project.projectId),
  };
}

describe("context cache (PRD 25)", () => {
  it("assembles once and serves the repeat from cache", async () => {
    const { devmemory, engine } = await fixture();
    try {
      const first = engine.getContext({ task: "fix payment verification" });
      const second = engine.getContext({ task: "fix payment verification" });

      expect(first.cache).toBe("miss");
      expect(first.contextId).toMatch(/^ctx_/);
      expect(second.cache).toBe("hit");
      expect(second.contextId).toBe(first.contextId);
      expect(second.files.map((file) => file.path)).toEqual(first.files.map((file) => file.path));
      expect(second.tokenEstimate).toBe(first.tokenEstimate);
    } finally {
      devmemory.close();
    }
  });

  it("treats the same request phrased identically as the same key", () => {
    const key = ContextCache.keyFor("Fix Payment Verification", { maxTokens: 6000 });
    expect(ContextCache.keyFor("  fix payment verification  ", { maxTokens: 6000 })).toBe(key);
    expect(ContextCache.keyFor("fix payment verification", { maxTokens: 3000 })).not.toBe(key);
    expect(ContextCache.keyFor("something else", { maxTokens: 6000 })).not.toBe(key);
  });

  it("different options are different cache entries", async () => {
    const { devmemory, engine, cache } = await fixture();
    try {
      engine.getContext({ task: "fix payment verification" });
      const narrower = engine.getContext({ task: "fix payment verification", maxTokens: 1500 });

      expect(narrower.cache).toBe("miss");
      expect(cache.analytics().cachedEntries).toBe(2);
    } finally {
      devmemory.close();
    }
  });

  it("patches only the changed file instead of reassembling (PRD 26)", async () => {
    const { root, devmemory, projectId, engine } = await fixture();
    try {
      const first = engine.getContext({ task: "fix payment verification" });
      expect(first.files.map((file) => file.path)).toContain("src/payment/PaymentService.ts");

      writeFile(
        root,
        "src/payment/PaymentService.ts",
        'import { Ledger } from "../db/Ledger";\n\nexport class PaymentService {\n  constructor(private ledger: Ledger) {}\n\n  verifyPayment(id: string) {\n    if (!id) return null;\n    return this.ledger.find(id);\n  }\n}\n',
      );
      await devmemory.index(projectId);

      const patched = devmemory.contextEngine(projectId).getContext({ task: "fix payment verification" });

      expect(patched.cache).toBe("incremental");
      expect(patched.refreshedFiles).toEqual(["src/payment/PaymentService.ts"]);
      expect(patched.files.map((file) => file.path)).toEqual(first.files.map((file) => file.path));
      const refreshed = patched.files.find((file) => file.path === "src/payment/PaymentService.ts");
      expect(refreshed?.reasons).toContain("refreshed after change");
    } finally {
      devmemory.close();
    }
  });

  it("reassembles when a new file appears, because hashes cannot see that", async () => {
    const { root, devmemory, projectId, engine } = await fixture();
    try {
      engine.getContext({ task: "fix payment verification" });

      writeFile(root, "src/payment/RefundService.ts", "export class RefundService {\n  refund(id: string) {\n    return id;\n  }\n}\n");
      git(root, ["add", "-A"]);
      await devmemory.index(projectId);

      const after = devmemory.contextEngine(projectId).getContext({ task: "fix payment verification" });
      expect(after.cache).toBe("miss");
    } finally {
      devmemory.close();
    }
  });

  it("reassembles when a cached file is deleted", async () => {
    const { root, devmemory, projectId, engine } = await fixture();
    try {
      const first = engine.getContext({ task: "ledger lookup for payments", depth: 1 });
      expect(first.files.map((file) => file.path)).toContain("src/db/Ledger.ts");

      removeFile(root, "src/db/Ledger.ts");
      git(root, ["add", "-A"]);
      await devmemory.index(projectId);

      const after = devmemory.contextEngine(projectId).getContext({ task: "ledger lookup for payments", depth: 1 });
      expect(after.cache).toBe("miss");
      expect(after.files.map((file) => file.path)).not.toContain("src/db/Ledger.ts");
    } finally {
      devmemory.close();
    }
  });

  it("measures what the cache actually saved (PRD 51, 65)", async () => {
    const { devmemory, engine, cache } = await fixture();
    try {
      engine.getContext({ task: "fix payment verification" });
      engine.getContext({ task: "fix payment verification" });
      engine.getContext({ task: "fix payment verification" });

      const analytics = cache.analytics();
      expect(analytics.requests).toBe(3);
      expect(analytics.hits).toBe(2);
      expect(analytics.misses).toBe(1);
      expect(analytics.hitRate).toBeCloseTo(0.667, 2);
      expect(analytics.averageTokens).toBeGreaterThan(0);
      expect(analytics.estimatedTokensSaved).toBeGreaterThan(0);
      expect(analytics.filesAvoided).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("keeps cached context isolated per project (AC-06)", async () => {
    const alpha = makeProject({
      name: "cache-alpha",
      remote: "git@github.com:acme/cache-alpha.git",
      files: { "package.json": "{}", "src/alpha.ts": "export const alphaThing = 1;\n" },
    });
    const beta = makeProject({
      name: "cache-beta",
      remote: "git@github.com:acme/cache-beta.git",
      files: { "package.json": "{}", "src/beta.ts": "export const betaThing = 1;\n" },
    });

    const devmemory = makeDevMemory();
    try {
      const a = (await devmemory.connect({ explicitRoot: alpha })).project;
      const b = (await devmemory.connect({ explicitRoot: beta })).project;

      devmemory.contextEngine(a.projectId).getContext({ task: "change alphaThing" });
      const other = devmemory.contextEngine(b.projectId).getContext({ task: "change alphaThing" });

      expect(other.cache).toBe("miss");
      expect(devmemory.contextCacheFor(a.projectId).analytics().cachedEntries).toBe(1);
      expect(devmemory.contextCacheFor(b.projectId).analytics().cachedEntries).toBe(1);
      expect(other.files.map((file) => file.path)).not.toContain("src/alpha.ts");
    } finally {
      devmemory.close();
    }
  });

  it("can be cleared, and invalidated by path", async () => {
    const { devmemory, engine, cache } = await fixture();
    try {
      engine.getContext({ task: "fix payment verification" });
      expect(cache.invalidatePaths(["src/ui/Sidebar.tsx"])).toBe(0);
      expect(cache.invalidatePaths(["src/payment/PaymentService.ts"])).toBe(1);
      expect(cache.analytics().cachedEntries).toBe(0);

      engine.getContext({ task: "fix payment verification" });
      expect(cache.clear()).toBe(1);
      expect(engine.getContext({ task: "fix payment verification" }).cache).toBe("miss");
    } finally {
      devmemory.close();
    }
  });

  it("survives a restart, because the cache lives with the index", async () => {
    const { devmemory, projectId, engine } = await fixture();
    engine.getContext({ task: "fix payment verification" });
    const home = devmemory.home;
    devmemory.close();

    const reopened = makeDevMemory(home);
    try {
      const result = reopened.contextEngine(projectId).getContext({ task: "fix payment verification" });
      expect(result.cache).toBe("hit");
    } finally {
      reopened.close();
    }
  });
});
