import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "@devmemory/mcp";
import type { DevMemory } from "@devmemory/core";
import { FAKE_SECRETS, cleanupAll, makeDevMemory, makeProject, writeFile } from "./helpers.js";

afterAll(cleanupAll);

function contextFor(devmemory: DevMemory, cwd: string, clientRoots: string[] = []): ToolContext {
  return {
    devmemory,
    cwd,
    clientRoots: async () => clientRoots,
  };
}

function tool(name: string): ToolDefinition {
  const found = ALL_TOOLS.find((definition) => definition.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

async function call(name: string, input: Record<string, unknown>, context: ToolContext): Promise<any> {
  const definition = tool(name);
  // The server validates with this shape before dispatching, so tests do the same.
  const parsed = z.object(definition.inputShape).parse(input);
  return definition.handler(parsed as Record<string, unknown>, context);
}

describe("MCP tool surface (PRD 39, 40)", () => {
  it("registers a compact, uniquely named tool set", () => {
    const names = ALL_TOOLS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining(["project_connect", "project_status", "project_map", "find_file", "git_status"]),
    );

    for (const definition of ALL_TOOLS) {
      expect(definition.description.length).toBeGreaterThan(20);
      expect(["READ", "WRITE", "EXECUTE", "DESTRUCTIVE"]).toContain(definition.permission);
    }
  });

  it("project_connect identifies the workspace and returns a compact summary", async () => {
    const root = makeProject({ name: "mcpconnect", remote: "git@github.com:acme/mcpconnect.git" });
    const devmemory = makeDevMemory();
    try {
      const result = await call("project_connect", { root }, contextFor(devmemory, process.cwd()));

      expect(result.project_id).toMatch(/^proj_/);
      expect(result.name).toBe("mcpconnect");
      expect(result.identity_source).toBe("git_remote");
      expect(result.index.files_scanned).toBeGreaterThan(0);
      expect(result.git.branch).toBeTruthy();
      expect(JSON.stringify(result).length).toBeLessThan(2000);
    } finally {
      devmemory.close();
    }
  });

  it("resolves the project from client roots when no root is given (PRD 8)", async () => {
    const root = makeProject({ name: "mcproots" });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      const connected = await call("project_connect", {}, context);
      const status = await call("project_status", {}, context);

      expect(status.project_id).toBe(connected.project_id);
      expect(status.root).toBe(root);
    } finally {
      devmemory.close();
    }
  });

  it("project_map returns directory rollups instead of a file dump (PRD 24)", async () => {
    const root = makeProject({
      name: "mcpmap",
      files: {
        "package.json": JSON.stringify({ name: "mcpmap", dependencies: { express: "4.0.0" } }),
        "src/index.ts": "export const main = 1;\n",
        "src/auth/AuthService.ts": "export class AuthService {}\n",
        "src/auth/AuthApi.ts": "export class AuthApi {}\n",
        "tests/auth.test.ts": "export const t = 1;\n",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);
      const map = await call("project_map", {}, context);

      expect(map.framework).toBe("Express");
      expect(map.directories.map((entry: { path: string }) => entry.path)).toEqual(
        expect.arrayContaining(["src/auth"]),
      );
      expect(map.entry_points).toContain("src/index.ts");
    } finally {
      devmemory.close();
    }
  });

  it("find_file searches the index and never returns sensitive files", async () => {
    const root = makeProject({
      name: "mcpfind",
      files: {
        "package.json": JSON.stringify({ name: "mcpfind" }),
        "src/auth/AuthService.ts": "export class AuthService {}\n",
        ".env": "TOKEN=abc\n",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);

      const found = await call("find_file", { query: "auth" }, context);
      expect(found.files.map((file: { path: string }) => file.path)).toContain("src/auth/AuthService.ts");
      expect(found.files[0].token_estimate).toBeGreaterThan(0);

      const env = await call("find_file", { query: "env" }, context);
      expect(env.files.map((file: { path: string }) => file.path)).not.toContain(".env");
    } finally {
      devmemory.close();
    }
  });

  it("git tools report status, history and changes since a ref", async () => {
    const root = makeProject({ name: "mcpgit" });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);
      writeFile(root, "src/index.ts", "export const value = 7;\n");

      const status = await call("git_status", {}, context);
      expect(status.clean).toBe(false);
      expect(status.files.map((file: { path: string }) => file.path)).toContain("src/index.ts");

      const history = await call("git_history", { limit: 5 }, context);
      expect(history.commits[0].subject).toBe("initial");

      const changes = await call("changes_since", { ref: "HEAD" }, context);
      expect(changes.changed_files).toContain("src/index.ts");
    } finally {
      devmemory.close();
    }
  });

  it("git_diff redacts secrets that appear in a diff", async () => {
    const root = makeProject({ name: "mcpdiff" });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);
      writeFile(root, "src/index.ts", `const key = '${FAKE_SECRETS.githubToken}';\n`);

      const diff = await call("git_diff", {}, context);
      expect(diff.diff).not.toContain(FAKE_SECRETS.githubToken);
      expect(diff.redacted).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("rejects invalid input before it reaches a handler", async () => {
    const root = makeProject({ name: "mcpinvalid" });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await expect(call("find_file", { query: "" }, context)).rejects.toThrow();
      await expect(call("find_file", { query: "x", limit: 9999 }, context)).rejects.toThrow();
      await expect(call("project_map", { limit: -1 }, context)).rejects.toThrow();
      await expect(call("changes_since", {}, context)).rejects.toThrow();
    } finally {
      devmemory.close();
    }
  });

  it("scopes results to the requested project (AC-06)", async () => {
    const alpha = makeProject({
      name: "mcpalpha",
      remote: "git@github.com:acme/mcpalpha.git",
      files: { "package.json": JSON.stringify({ name: "mcpalpha" }), "src/alpha.ts": "export const a = 1;\n" },
    });
    const beta = makeProject({
      name: "mcpbeta",
      remote: "git@github.com:acme/mcpbeta.git",
      files: { "package.json": JSON.stringify({ name: "mcpbeta" }), "src/beta.ts": "export const b = 1;\n" },
    });

    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd());
      const a = await call("project_connect", { root: alpha }, context);
      const b = await call("project_connect", { root: beta }, context);

      const alphaSearch = await call("find_file", { project_id: a.project_id, query: "beta" }, context);
      expect(alphaSearch.files).toHaveLength(0);

      const betaSearch = await call("find_file", { project_id: b.project_id, query: "beta" }, context);
      expect(betaSearch.files.map((file: { path: string }) => file.path)).toContain("src/beta.ts");
    } finally {
      devmemory.close();
    }
  });

  it("guards the destructive tool behind an explicit confirmation (PRD 38)", async () => {
    const root = makeProject({ name: "mcpforget" });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      const connected = await call("project_connect", {}, context);

      const refused = await call("project_forget", { project_id: connected.project_id, confirm: false }, context);
      expect(refused.error.code).toBe("PERMISSION_DENIED");
      expect(devmemory.registry.get(connected.project_id)).not.toBeNull();

      const removed = await call("project_forget", { project_id: connected.project_id, confirm: true }, context);
      expect(removed.removed).toBe(true);
      expect(devmemory.registry.get(connected.project_id)).toBeNull();
    } finally {
      devmemory.close();
    }
  });

  it("reports an unknown project as a structured error", async () => {
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd());
      await expect(call("project_status", { project_id: "proj_deadbeef01" }, context)).rejects.toThrow(
        /unknown project/,
      );
    } finally {
      devmemory.close();
    }
  });
});

describe("code intelligence tools (PRD 39)", () => {
  const files = {
    "package.json": JSON.stringify({ name: "codetools" }),
    "src/db/Database.ts": "export class Database {\n  findUser(email: string) {\n    return email;\n  }\n}\n",
    "src/auth/AuthService.ts":
      'import { Database } from "../db/Database";\n\nexport class AuthService {\n  constructor(private db: Database) {}\n\n  login(email: string) {\n    return this.db.findUser(email);\n  }\n}\n',
    "tests/auth.test.ts": 'import { AuthService } from "../src/auth/AuthService";\n\ntest("login", () => new AuthService({} as never));\n',
  };

  async function connected(devmemory: ReturnType<typeof makeDevMemory>, root: string) {
    const context = contextFor(devmemory, process.cwd(), [root]);
    await call("project_connect", {}, context);
    return context;
  }

  it("find_symbol locates symbols without returning file contents", async () => {
    const root = makeProject({ name: "toolsymbol", files });
    const devmemory = makeDevMemory();
    try {
      const context = await connected(devmemory, root);
      const result = await call("find_symbol", { name: "AuthService" }, context);

      expect(result.count).toBeGreaterThan(0);
      expect(result.symbols[0].path).toBe("src/auth/AuthService.ts");
      expect(result.symbols[0].type).toBe("class");
      expect(result.symbols[0].lines[0]).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("findUser(email: string) {\n");

      const methods = await call("find_symbol", { name: "login", type: "method" }, context);
      expect(methods.symbols[0].qualified_name).toBe("AuthService.login");
    } finally {
      devmemory.close();
    }
  });

  it("get_definition returns source with a token estimate", async () => {
    const root = makeProject({ name: "tooldefinition", files });
    const devmemory = makeDevMemory();
    try {
      const context = await connected(devmemory, root);
      const result = await call("get_definition", { name: "AuthService" }, context);

      expect(result.found).toBe(true);
      expect(result.source).toContain("class AuthService");
      expect(result.token_estimate).toBeGreaterThan(0);

      const missing = await call("get_definition", { name: "NotHere" }, context);
      expect(missing.found).toBe(false);
    } finally {
      devmemory.close();
    }
  });

  it("find_references groups usages by file", async () => {
    const root = makeProject({ name: "toolreferences", files });
    const devmemory = makeDevMemory();
    try {
      const context = await connected(devmemory, root);
      const result = await call("find_references", { name: "findUser" }, context);

      expect(result.total).toBeGreaterThan(0);
      expect(result.results[0].path).toBe("src/auth/AuthService.ts");
      expect(result.results[0].references[0].fromSymbol).toBe("AuthService.login");
    } finally {
      devmemory.close();
    }
  });

  it("get_related_code returns the neighbourhood of a file", async () => {
    const root = makeProject({ name: "toolrelated", files });
    const devmemory = makeDevMemory();
    try {
      const context = await connected(devmemory, root);
      const result = await call("get_related_code", { path: "src/auth/AuthService.ts" }, context);

      expect(result.dependencies).toContain("src/db/Database.ts");
      expect(result.tests).toContain("tests/auth.test.ts");
      expect(result.symbols.map((entry: { name: string }) => entry.name)).toContain("login");
    } finally {
      devmemory.close();
    }
  });

  it("impact_analysis and affected_tests answer what a change touches", async () => {
    const root = makeProject({ name: "toolimpact", files });
    const devmemory = makeDevMemory();
    try {
      const context = await connected(devmemory, root);

      const impact = await call("impact_analysis", { path: "src/db/Database.ts" }, context);
      expect(impact.direct_dependents).toContain("src/auth/AuthService.ts");
      expect(impact.affected_tests).toContain("tests/auth.test.ts");
      expect(impact.exported_symbols).toContain("Database");

      const tests = await call("affected_tests", { paths: ["src/db/Database.ts"] }, context);
      expect(tests.tests).toEqual(["tests/auth.test.ts"]);
    } finally {
      devmemory.close();
    }
  });

  it("reports project_status with code intelligence totals", async () => {
    const root = makeProject({ name: "toolstatus", files });
    const devmemory = makeDevMemory();
    try {
      const context = await connected(devmemory, root);
      const status = await call("project_status", {}, context);

      expect(status.code.symbols).toBeGreaterThan(0);
      expect(status.code.files_parsed).toBeGreaterThan(0);
      expect(status.code.internal_edges).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("validates code tool input", async () => {
    const root = makeProject({ name: "toolvalidation", files });
    const devmemory = makeDevMemory();
    try {
      const context = await connected(devmemory, root);
      await expect(call("find_symbol", { name: "" }, context)).rejects.toThrow();
      await expect(call("find_symbol", { name: "x", type: "not-a-kind" }, context)).rejects.toThrow();
      await expect(call("affected_tests", { paths: [] }, context)).rejects.toThrow();
      await expect(call("impact_analysis", { path: "nope.ts" }, context)).rejects.toThrow(/not indexed/);
    } finally {
      devmemory.close();
    }
  });
});

describe("context tools (PRD 39, 40)", () => {
  const files = {
    "package.json": JSON.stringify({ name: "ctxtools" }),
    "src/payment/PaymentService.ts":
      'import { Ledger } from "../db/Ledger";\n\nexport class PaymentService {\n  constructor(private ledger: Ledger) {}\n\n  verifyPayment(id: string) {\n    return this.ledger.find(id);\n  }\n}\n',
    "src/db/Ledger.ts": "export class Ledger {\n  find(id: string) {\n    return id;\n  }\n}\n",
    "src/ui/Sidebar.tsx": "export function Sidebar() {\n  return <nav />;\n}\n",
    "tests/payment.test.ts": 'import { PaymentService } from "../src/payment/PaymentService";\n\ntest("verify", () => new PaymentService({} as never));\n',
  };

  it("get_context returns ranked files with reasons and a token report", async () => {
    const root = makeProject({ name: "ctxget", files });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);

      const result = await call("get_context", { task: "fix payment verification" }, context);

      expect(result.intent).toBe("debug");
      expect(result.files[0].path).toBe("src/payment/PaymentService.ts");
      expect(result.files[0].why.length).toBeGreaterThan(0);
      expect(result.token_estimate).toBeGreaterThan(0);
      expect(result.token_estimate).toBeLessThanOrEqual(result.budget);
      expect(result.files_avoided).toBeGreaterThan(0);
      expect(result.files.map((file: { path: string }) => file.path)).not.toContain("src/ui/Sidebar.tsx");
    } finally {
      devmemory.close();
    }
  });

  it("get_context honours an explicit token budget", async () => {
    const root = makeProject({ name: "ctxbudget", files });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);

      const result = await call("get_context", { task: "payment verification", max_tokens: 500 }, context);
      expect(result.token_estimate).toBeLessThanOrEqual(500);
      expect(result.budget).toBe(500);
    } finally {
      devmemory.close();
    }
  });

  it("search_context answers a natural-language question", async () => {
    const root = makeProject({ name: "ctxsearch", files });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);

      const result = await call("search_context", { query: "where is payment verification handled" }, context);
      expect(result.count).toBeGreaterThan(0);
      expect(result.results.map((entry: { path: string }) => entry.path)).toContain("src/payment/PaymentService.ts");
    } finally {
      devmemory.close();
    }
  });

  it("refresh_context re-indexes before answering", async () => {
    const root = makeProject({ name: "ctxrefresh", files });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);

      writeFile(root, "src/payment/RefundService.ts", "export class RefundService {\n  issueRefund(id: string) {\n    return id;\n  }\n}\n");

      const result = await call("refresh_context", { task: "implement issueRefund" }, context);
      expect(result.reindexed.added).toBe(1);
      expect(result.files.map((file: { path: string }) => file.path)).toContain("src/payment/RefundService.ts");
    } finally {
      devmemory.close();
    }
  });

  it("validates context tool input", async () => {
    const root = makeProject({ name: "ctxvalidation", files });
    const devmemory = makeDevMemory();
    try {
      const context = contextFor(devmemory, process.cwd(), [root]);
      await call("project_connect", {}, context);

      await expect(call("get_context", { task: "hi" }, context)).rejects.toThrow();
      await expect(call("get_context", { task: "fix payment", max_tokens: 10 }, context)).rejects.toThrow();
      await expect(call("get_context", { task: "fix payment", depth: 9 }, context)).rejects.toThrow();
      await expect(call("search_context", { query: "x" }, context)).rejects.toThrow();
    } finally {
      devmemory.close();
    }
  });
});

describe("memory tools (PRD 39)", () => {
  async function connectedProject(name: string) {
    const root = makeProject({
      name,
      files: {
        "package.json": JSON.stringify({ name }),
        "src/payment/webhook.ts": "export function handleWebhook(id: string) {\n  return id;\n}\n",
      },
    });
    const devmemory = makeDevMemory();
    const context = contextFor(devmemory, process.cwd(), [root]);
    await call("project_connect", {}, context);
    return { devmemory, context, root };
  }

  it("remember stores a decision with its reasoning", async () => {
    const { devmemory, context } = await connectedProject("memremember");
    try {
      const result = await call(
        "remember",
        {
          type: "DECISION",
          title: "Webhooks are idempotent",
          content: "Every webhook handler must be safe to run twice, because Stripe retries.",
          reason: "Stripe retries on any non-2xx response",
          alternatives: ["Locking on payment id"],
          affected: ["payments"],
          paths: ["src/payment/webhook.ts"],
        },
        context,
      );

      expect(result.stored).toBe(true);
      expect(result.reinforced_existing).toBe(false);
      expect(result.memory.id).toMatch(/^mem_/);
      expect(result.memory.importance).toBe(0.9);
      expect(result.memory.decision.reason).toContain("Stripe retries");
    } finally {
      devmemory.close();
    }
  });

  it("recall returns stored knowledge, ranked", async () => {
    const { devmemory, context } = await connectedProject("memrecall");
    try {
      await call(
        "remember",
        { type: "CONSTRAINT", title: "No card data in logs", content: "Card numbers must never be written to logs." },
        context,
      );
      await call("remember", { type: "FACT", title: "Node version", content: "The service runs on Node 22." }, context);

      const searched = await call("recall", { query: "can we log card numbers" }, context);
      expect(searched.memories[0].title).toBe("No card data in logs");

      const everything = await call("recall", {}, context);
      expect(everything.count).toBe(2);
      expect(everything.memories[0].type).toBe("CONSTRAINT");

      const filtered = await call("recall", { type: "FACT" }, context);
      expect(filtered.memories.every((memory: { type: string }) => memory.type === "FACT")).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("memory reaches get_context and boosts the files it names", async () => {
    const { devmemory, context } = await connectedProject("memcontext");
    try {
      await call(
        "remember",
        {
          type: "BUG",
          title: "Webhook runs twice",
          content: "Retries cause the payment webhook to be processed more than once.",
          paths: ["src/payment/webhook.ts"],
        },
        context,
      );

      const result = await call("get_context", { task: "make the webhook idempotent" }, context);
      expect(result.memories.map((memory: { title: string }) => memory.title)).toContain("Webhook runs twice");
      expect(result.files.map((file: { path: string }) => file.path)).toContain("src/payment/webhook.ts");
    } finally {
      devmemory.close();
    }
  });

  it("forget archives by default and guards hard deletion", async () => {
    const { devmemory, context } = await connectedProject("memforget");
    try {
      const stored = await call(
        "remember",
        { type: "FACT", title: "Outdated fact", content: "This stopped being true last quarter." },
        context,
      );

      const refused = await call("forget", { id: stored.memory.id, hard: true }, context);
      expect(refused.error.code).toBe("PERMISSION_DENIED");

      const archived = await call("forget", { id: stored.memory.id }, context);
      expect(archived.archived).toBe(true);
      expect((await call("recall", {}, context)).count).toBe(0);

      const deleted = await call("forget", { id: stored.memory.id, hard: true, confirm: true }, context);
      expect(deleted.removed).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("validates memory tool input", async () => {
    const { devmemory, context } = await connectedProject("memvalidation");
    try {
      await expect(call("remember", { type: "FACT", title: "ok", content: "long enough content" }, context)).rejects.toThrow();
      await expect(
        call("remember", { type: "NOPE", title: "valid title", content: "long enough content" }, context),
      ).rejects.toThrow();
      await expect(
        call("remember", { type: "FACT", title: "valid title", content: "short", importance: 5 }, context),
      ).rejects.toThrow();
      await expect(call("forget", { id: "mem_missing" }, context)).rejects.toThrow(/unknown memory/);
    } finally {
      devmemory.close();
    }
  });
});

describe("task and session tools (PRD 30, 31, 32)", () => {
  async function workspace(name: string) {
    const root = makeProject({
      name,
      files: {
        "package.json": JSON.stringify({ name }),
        "src/auth/AuthService.ts": "export class AuthService {\n  login(email: string) {\n    return email;\n  }\n}\n",
      },
    });
    const devmemory = makeDevMemory();
    const context = contextFor(devmemory, process.cwd(), [root]);
    await call("project_connect", {}, context);
    return { devmemory, context, root };
  }

  it("task_create records requirements and returns a compact task", async () => {
    const { devmemory, context } = await workspace("tasktools");
    try {
      const result = await call(
        "task_create",
        {
          title: "Add Google Login",
          requirements: ["OAuth configuration", "Backend callback", "Frontend button"],
          areas: ["authentication"],
          paths: ["src/auth/AuthService.ts"],
        },
        context,
      );

      expect(result.task.key).toBe("TASK-1");
      expect(result.task.status).toBe("READY");
      expect(result.task.progress).toEqual({ done: 0, total: 3, percent: 0 });
      expect(result.task.requirements[0]).toEqual({ text: "OAuth configuration", done: false });
    } finally {
      devmemory.close();
    }
  });

  it("task_update moves work forward and task_status reports the board", async () => {
    const { devmemory, context } = await workspace("taskupdate");
    try {
      await call("task_create", { title: "Add Google Login", requirements: ["OAuth", "Callback"] }, context);
      const updated = await call(
        "task_update",
        { task: "TASK-1", status: "IN_PROGRESS", complete_requirements: ["OAuth"], note: "Using the web flow" },
        context,
      );

      expect(updated.task.status).toBe("IN_PROGRESS");
      expect(updated.task.progress.percent).toBe(50);

      const board = await call("task_status", {}, context);
      expect(board.current.key).toBe("TASK-1");
      expect(board.stats.open).toBe(1);

      const detail = await call("task_status", { task: "TASK-1" }, context);
      expect(detail.timeline.map((entry: { event: string }) => entry.event)).toContain("status");
    } finally {
      devmemory.close();
    }
  });

  it("task_context returns the task plus ranked code context for it", async () => {
    const { devmemory, context } = await workspace("taskcontext");
    try {
      await call(
        "task_create",
        {
          title: "Fix login validation in AuthService",
          requirements: ["Reject empty emails"],
          paths: ["src/auth/AuthService.ts"],
        },
        context,
      );

      const result = await call("task_context", { task: "TASK-1" }, context);

      expect(result.task.key).toBe("TASK-1");
      expect(result.remaining_requirements).toEqual(["Reject empty emails"]);
      expect(result.context.files.map((file: { path: string }) => file.path)).toContain("src/auth/AuthService.ts");
      expect(result.context.token_estimate).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("a session opened by one agent is handed to another (AC-13)", async () => {
    const { devmemory, context } = await workspace("handofftools");
    try {
      await call("task_create", { title: "Add Google Login", requirements: ["Backend", "Frontend"] }, context);
      await call("task_update", { task: "TASK-1", status: "IN_PROGRESS", complete_requirements: ["Backend"] }, context);
      await call(
        "remember",
        {
          type: "DECISION",
          title: "Google OAuth reuses the JWT session",
          content: "Google sign-in issues the same JWT session token as password login.",
        },
        context,
      );

      const started = await call("session_start", { agent: "claude-code", task: "TASK-1" }, context);
      expect(started.session_id).toMatch(/^ses_/);

      const ended = await call(
        "session_end",
        {
          summary: "Backend callback and token handling done.",
          completed: ["Backend"],
          remaining: ["Frontend"],
          next_step: "Implement the frontend login button",
        },
        context,
      );
      expect(ended.next_step).toBe("Implement the frontend login button");

      // A different agent asks what is going on, with no shared conversation.
      const report = await call("handoff", {}, context);
      expect(report.current_task.key).toBe("TASK-1");
      expect(report.current_task.remaining).toEqual(["Frontend"]);
      expect(report.last_session.agent).toBe("claude-code");
      expect(report.decisions.map((entry: { title: string }) => entry.title)).toContain(
        "Google OAuth reuses the JWT session",
      );
      expect(report.recommended_next_step).toBe("Implement the frontend login button");
    } finally {
      devmemory.close();
    }
  });

  it("session_end without an open session reports it instead of failing", async () => {
    const { devmemory, context } = await workspace("nosession");
    try {
      const result = await call("session_end", { summary: "Nothing was open." }, context);
      expect(result.error.message).toMatch(/no open session/);
    } finally {
      devmemory.close();
    }
  });

  it("validates task tool input", async () => {
    const { devmemory, context } = await workspace("taskvalidation");
    try {
      await expect(call("task_create", { title: "no" }, context)).rejects.toThrow();
      await expect(call("task_create", { title: "Valid title", status: "NOPE" }, context)).rejects.toThrow();
      await expect(call("task_update", { task: "TASK-99", status: "IN_PROGRESS" }, context)).rejects.toThrow(
        /unknown task/,
      );
      await expect(call("task_context", { task: "TASK-99" }, context)).rejects.toThrow(/unknown task/);
    } finally {
      devmemory.close();
    }
  });
});
