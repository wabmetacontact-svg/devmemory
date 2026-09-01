import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { projectLayout } from "@samirthakur024/shared";
import { cleanupAll, git, makeDevMemory, makeHome, makeProject } from "./helpers.js";

afterAll(cleanupAll);

async function fixture(home?: string) {
  const root = makeProject({ name: "memory", remote: "git@github.com:acme/memory.git" });
  const devmemory = makeDevMemory(home);
  const { project } = await devmemory.connect({ explicitRoot: root, index: false });
  return { root, devmemory, projectId: project.projectId, memory: devmemory.memoryFor(project.projectId) };
}

describe("memory engine (PRD 27, 28)", () => {
  it("stores knowledge with type-appropriate importance", async () => {
    const { devmemory, memory } = await fixture();
    try {
      const decision = memory.remember({
        type: "DECISION",
        title: "Authentication strategy",
        content: "Use JWT authentication for web and mobile clients.",
      });
      const fact = memory.remember({
        type: "FACT",
        title: "Primary region",
        content: "Production runs in eu-west-1 only.",
      });

      expect(decision.memory.id).toMatch(/^mem_/);
      expect(decision.memory.importance).toBe(0.9);
      expect(fact.memory.importance).toBe(0.5);
      expect(decision.memory.status).toBe("active");
      expect(decision.deduplicated).toBe(false);
    } finally {
      devmemory.close();
    }
  });

  it("reinforces an identical memory instead of duplicating it", async () => {
    const { devmemory, memory } = await fixture();
    try {
      const first = memory.remember({ type: "FACT", title: "Queue", content: "Background jobs run on Redis streams." });
      const second = memory.remember({
        type: "FACT",
        title: "Queue",
        content: "  Background jobs run on Redis streams.  ",
        importance: 0.8,
        tags: ["infra"],
      });

      expect(second.deduplicated).toBe(true);
      expect(second.memory.id).toBe(first.memory.id);
      expect(second.memory.importance).toBe(0.8);
      expect(second.memory.tags).toContain("infra");
      expect(memory.list({ type: "FACT" })).toHaveLength(1);
    } finally {
      devmemory.close();
    }
  });

  it("refuses memories too thin to be worth keeping (PRD 28)", async () => {
    const { devmemory, memory } = await fixture();
    try {
      expect(() => memory.remember({ type: "FACT", title: "x", content: "something useful here" })).toThrowError(
        /title is too short/,
      );
      expect(() => memory.remember({ type: "FACT", title: "Valid title", content: "short" })).toThrowError(
        /too short/,
      );
      expect(() =>
        memory.remember({ type: "NONSENSE" as never, title: "Valid title", content: "some content here" }),
      ).toThrowError(/unknown memory type/);
    } finally {
      devmemory.close();
    }
  });

  it("expires low-value history automatically but keeps important knowledge", async () => {
    const { devmemory, memory } = await fixture();
    try {
      const history = memory.remember({
        type: "HISTORY",
        title: "Ran the migration",
        content: "Applied migration 004 against staging today.",
      });
      const decision = memory.remember({
        type: "DECISION",
        title: "Database choice",
        content: "PostgreSQL, because transactions across payments and orders must be atomic.",
      });

      expect(history.memory.expiresAt).toBeTruthy();
      expect(decision.memory.expiresAt).toBeNull();
    } finally {
      devmemory.close();
    }
  });

  it("archives memories whose expiry has passed", async () => {
    const { devmemory, memory } = await fixture();
    try {
      const stored = memory.remember({
        type: "HISTORY",
        title: "Temporary note",
        content: "This only mattered during the migration window.",
        expiresInDays: 1,
      });

      // Move the expiry into the past, then let recall sweep it.
      memory.update(stored.memory.id, { expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
      expect(memory.archiveExpired()).toBe(1);

      expect(memory.get(stored.memory.id)?.status).toBe("archived");
      expect(memory.recall({ limit: 10 }).map((entry) => entry.id)).not.toContain(stored.memory.id);
    } finally {
      devmemory.close();
    }
  });

  it("records a decision with its reason, alternatives and affected areas (PRD 29)", async () => {
    const { devmemory, memory } = await fixture();
    try {
      const stored = memory.remember({
        type: "DECISION",
        title: "Use PostgreSQL",
        content: "PostgreSQL is the primary datastore.",
        decision: {
          reason: "Strong transaction requirements.",
          alternatives: ["MongoDB"],
          affected: ["payments", "orders", "users"],
        },
      });

      const recalled = memory.get(stored.memory.id);
      expect(recalled?.decision?.reason).toBe("Strong transaction requirements.");
      expect(recalled?.decision?.alternatives).toEqual(["MongoDB"]);
      expect(recalled?.decision?.affected).toContain("payments");
      expect(memory.decisions().map((entry) => entry.title)).toContain("Use PostgreSQL");
    } finally {
      devmemory.close();
    }
  });

  it("supersedes an outdated memory", async () => {
    const { devmemory, memory } = await fixture();
    try {
      const original = memory.remember({
        type: "DECISION",
        title: "Session storage",
        content: "Sessions are stored in the database.",
      });
      const replacement = memory.remember({
        type: "DECISION",
        title: "Session storage",
        content: "Sessions are stored in Redis with a 24h TTL.",
        supersedes: original.memory.id,
      });

      expect(memory.get(original.memory.id)?.status).toBe("superseded");
      expect(replacement.memory.supersedes).toBe(original.memory.id);
      expect(memory.recall({ query: "session storage" }).map((entry) => entry.id)).toEqual([replacement.memory.id]);
      expect(memory.history(original.memory.id).some((event) => event.event === "superseded")).toBe(true);
    } finally {
      devmemory.close();
    }
  });
});

describe("recall (PRD 27, 32)", () => {
  it("ranks by relevance and importance together", async () => {
    const { devmemory, memory } = await fixture();
    try {
      memory.remember({
        type: "DECISION",
        title: "Payments use idempotency keys",
        content: "Every payment webhook is deduplicated with an idempotency key stored in Redis.",
      });
      memory.remember({
        type: "HISTORY",
        title: "Payment webhook retried",
        content: "The payment webhook was retried manually on the 3rd of March.",
      });

      const recalled = memory.recall({ query: "how are payment webhooks deduplicated" });
      expect(recalled[0]?.type).toBe("DECISION");
      expect(recalled[0]?.score).toBeGreaterThan(recalled[1]?.score ?? 0);
    } finally {
      devmemory.close();
    }
  });

  it("returns the most load-bearing knowledge when there is no query", async () => {
    const { devmemory, memory } = await fixture();
    try {
      memory.remember({ type: "FACT", title: "Minor detail", content: "The logo is stored as an SVG." });
      memory.remember({
        type: "CONSTRAINT",
        title: "PCI scope",
        content: "Card numbers must never touch application logs or the database.",
      });

      const recalled = memory.recall({ limit: 5 });
      expect(recalled[0]?.type).toBe("CONSTRAINT");
    } finally {
      devmemory.close();
    }
  });

  it("filters by type, importance, tag and path", async () => {
    const { devmemory, memory } = await fixture();
    try {
      memory.remember({
        type: "BUG",
        title: "Duplicate payment processing",
        content: "The webhook could execute twice under retry.",
        tags: ["payments"],
        paths: ["src/payment/webhook.ts"],
      });
      memory.remember({ type: "FACT", title: "Unrelated", content: "The marketing site is separate." });

      expect(memory.recall({ type: "BUG" }).every((entry) => entry.type === "BUG")).toBe(true);
      expect(memory.recall({ tag: "payments" }).map((entry) => entry.title)).toContain("Duplicate payment processing");
      expect(memory.recall({ path: "src/payment/webhook.ts" })).toHaveLength(1);
      expect(memory.recall({ minImportance: 0.8 }).every((entry) => entry.importance >= 0.8)).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("counts access so repeatedly useful knowledge rises", async () => {
    const { devmemory, memory } = await fixture();
    try {
      const stored = memory.remember({
        type: "PATTERN",
        title: "Repository pattern",
        content: "Data access goes through repository classes, never raw SQL in services.",
      });

      memory.recall({ query: "repository pattern" });
      memory.recall({ query: "repository pattern" });

      expect(memory.get(stored.memory.id)?.accessCount).toBe(2);
      expect(memory.get(stored.memory.id)?.accessedAt).toBeTruthy();
    } finally {
      devmemory.close();
    }
  });
});

describe("branch-scoped memory (PRD 57)", () => {
  it("keeps branch knowledge off other branches but global knowledge everywhere", async () => {
    const { root, devmemory, projectId } = await fixture();
    try {
      git(root, ["checkout", "-q", "-b", "feature/payments"]);
      const onFeature = devmemory.memoryFor(projectId);

      onFeature.remember({
        type: "FACT",
        title: "Global truth",
        content: "The project uses PostgreSQL in every environment.",
      });
      onFeature.remember({
        type: "DISCOVERY",
        title: "Branch specific",
        content: "On this branch the webhook handler is temporarily behind a feature flag.",
        branchSpecific: true,
      });

      expect(onFeature.recall({ limit: 10 }).map((entry) => entry.title)).toEqual(
        expect.arrayContaining(["Global truth", "Branch specific"]),
      );

      git(root, ["checkout", "-q", "master"]);
      const onMaster = devmemory.memoryFor(projectId);
      const titles = onMaster.recall({ limit: 10 }).map((entry) => entry.title);

      expect(titles).toContain("Global truth");
      expect(titles).not.toContain("Branch specific");
    } finally {
      devmemory.close();
    }
  });
});

describe("forgetting (PRD 38, 45)", () => {
  it("archives by default and deletes only on request", async () => {
    const { devmemory, memory } = await fixture();
    try {
      const archived = memory.remember({ type: "FACT", title: "Old fact", content: "This used to be true." });
      const deleted = memory.remember({ type: "FACT", title: "Wrong fact", content: "This was never true at all." });

      expect(memory.forget(archived.memory.id)).toMatchObject({ archived: true, removed: false });
      expect(memory.get(archived.memory.id)?.status).toBe("archived");

      expect(memory.forget(deleted.memory.id, { hard: true })).toMatchObject({ removed: true });
      expect(memory.get(deleted.memory.id)).toBeNull();

      expect(() => memory.forget("mem_doesnotexist")).toThrowError(/unknown memory/);
    } finally {
      devmemory.close();
    }
  });
});

describe("memory isolation and storage (PRD 7, 11)", () => {
  it("stores memory in its own database beside the index", async () => {
    const home = makeHome("memstore");
    const { devmemory, projectId, memory } = await fixture(home);
    try {
      memory.remember({ type: "FACT", title: "Stored somewhere", content: "This lives in memory.db." });
      const layout = projectLayout(projectId, home);

      expect(fs.existsSync(layout.memoryDb)).toBe(true);
      // Memory is a separate file from the code index, so re-indexing can never touch it.
      expect(layout.memoryDb).not.toBe(layout.indexDb);
      await devmemory.index(projectId, { full: true });
      expect(fs.existsSync(layout.indexDb)).toBe(true);
      expect(memory.recall({ limit: 5 })).toHaveLength(1);
    } finally {
      devmemory.close();
    }
  });

  it("never leaks memories between projects (AC-06)", async () => {
    const alpha = makeProject({ name: "mem-alpha", remote: "git@github.com:acme/mem-alpha.git" });
    const beta = makeProject({ name: "mem-beta", remote: "git@github.com:acme/mem-beta.git" });
    const devmemory = makeDevMemory();

    try {
      const a = (await devmemory.connect({ explicitRoot: alpha, index: false })).project;
      const b = (await devmemory.connect({ explicitRoot: beta, index: false })).project;

      devmemory.memoryFor(a.projectId).remember({
        type: "DECISION",
        title: "Alpha only decision",
        content: "Alpha uses server-side rendering everywhere.",
      });

      expect(devmemory.memoryFor(a.projectId).recall({ limit: 10 })).toHaveLength(1);
      expect(devmemory.memoryFor(b.projectId).recall({ limit: 10 })).toHaveLength(0);
      expect(devmemory.memoryFor(b.projectId).recall({ query: "alpha" })).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });

  it("survives a restart and a full re-index (AC-16)", async () => {
    const home = makeHome("mempersist");
    const root = makeProject({ name: "mem-persist", remote: "git@github.com:acme/mem-persist.git" });

    const first = makeDevMemory(home);
    const project = (await first.connect({ explicitRoot: root })).project;
    first.memoryFor(project.projectId).remember({
      type: "DECISION",
      title: "Durable decision",
      content: "This must outlive both the process and the code index.",
    });
    first.close();

    const second = makeDevMemory(home);
    try {
      await second.index(project.projectId, { full: true });
      const recalled = second.memoryFor(project.projectId).recall({ limit: 5 });
      expect(recalled.map((entry) => entry.title)).toContain("Durable decision");
    } finally {
      second.close();
    }
  });

  it("reports memory totals in project status", async () => {
    const { devmemory, projectId, memory } = await fixture();
    try {
      memory.remember({ type: "DECISION", title: "Counted decision", content: "This should appear in the stats." });
      const status = devmemory.status(projectId);

      expect(status.memory.active).toBe(1);
      expect(status.memory.byType[0]?.type).toBe("DECISION");
      expect(status.memory.averageImportance).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });
});

describe("memory feeding context (PRD 23)", () => {
  it("boosts files a memory points at, and returns the memory with the context", async () => {
    const root = makeProject({
      name: "mem-context",
      files: {
        "package.json": JSON.stringify({ name: "mem-context" }),
        "src/payment/webhook.ts": "export function handleWebhook(id: string) {\n  return id;\n}\n",
        "src/unrelated/widget.ts": "export function widget() {\n  return 1;\n}\n",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      devmemory.memoryFor(project.projectId).remember({
        type: "BUG",
        title: "Webhook can run twice",
        content: "Stripe retries the webhook, so handling must be idempotent.",
        paths: ["src/payment/webhook.ts"],
      });

      const result = devmemory.contextEngine(project.projectId).getContext({ task: "make webhook handling idempotent" });

      expect(result.memories.map((memory) => memory.title)).toContain("Webhook can run twice");
      const webhook = result.files.find((file) => file.path === "src/payment/webhook.ts");
      expect(webhook?.reasons.some((reason) => reason.startsWith("memory:"))).toBe(true);
    } finally {
      devmemory.close();
    }
  });
});
