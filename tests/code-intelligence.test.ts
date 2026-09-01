import { afterAll, describe, expect, it } from "vitest";
import { looksLikeTest } from "@devmemory/core";
import { cleanupAll, makeDevMemory, makeProject, removeFile, writeFile } from "./helpers.js";

afterAll(cleanupAll);

const FIXTURE = {
  "package.json": JSON.stringify({ name: "graph", dependencies: { react: "18.2.0" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  "src/db/Database.ts": `export class Database {
  findUser(email: string) {
    return { email };
  }
}
`,
  "src/auth/AuthService.ts": `import { Database } from "../db/Database";

export class AuthService {
  constructor(private db: Database) {}

  async login(email: string) {
    return this.db.findUser(email);
  }
}
`,
  "src/api/AuthApi.ts": `import { AuthService } from "@/auth/AuthService";
import express from "express";

const router = express.Router();
router.post("/login", (req, res) => res.json(new AuthService(req.db).login(req.body.email)));

export { router };
`,
  "src/pages/LoginPage.tsx": `import { router } from "../api/AuthApi";

export function LoginPage() {
  return <LoginForm router={router} />;
}
`,
  "tests/auth.test.ts": `import { AuthService } from "../src/auth/AuthService";

test("login", () => {
  new AuthService({} as never);
});
`,
  "app/main.py": `from app.services.users import UserService

class Runner:
    def start(self):
        return UserService().find(1)
`,
  "app/services/users.py": `class UserService:
    def find(self, user_id):
        return user_id
`,
};

async function fixture() {
  const root = makeProject({ name: "graph", files: FIXTURE });
  const devmemory = makeDevMemory();
  const { project } = await devmemory.connect({ explicitRoot: root });
  return { root, devmemory, projectId: project.projectId, code: devmemory.codeIntelligence(project.projectId) };
}

describe("symbol indexing (PRD 16)", () => {
  it("stores symbols for every parsed language", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const store = devmemory.codeFor(projectId);

      expect(store.findSymbols(projectId, { name: "AuthService" })[0]?.type).toBe("class");
      expect(store.findSymbols(projectId, { name: "login" })[0]?.qualifiedName).toBe("AuthService.login");
      expect(store.findSymbols(projectId, { name: "LoginPage" })[0]?.type).toBe("component");
      expect(store.findSymbols(projectId, { name: "UserService" })[0]?.path).toBe("app/services/users.py");

      const stats = store.stats(projectId);
      expect(stats.symbols).toBeGreaterThan(5);
      expect(stats.filesParsed).toBeGreaterThan(4);
      expect(stats.parseErrors).toBe(0);
    } finally {
      devmemory.close();
    }
  });

  it("reports parse counts on the index run", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const stats = await devmemory.index(projectId, { full: true });
      expect(stats.parsed).toBeGreaterThan(4);
      expect(stats.symbols).toBeGreaterThan(5);
      expect(stats.parseErrors).toBe(0);
    } finally {
      devmemory.close();
    }
  });

  it("does not re-parse files whose content did not change", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const second = await devmemory.index(projectId);
      expect(second.parsed).toBe(0);
      expect(devmemory.codeFor(projectId).stats(projectId).symbols).toBeGreaterThan(5);
    } finally {
      devmemory.close();
    }
  });

  it("replaces a file's symbols when it changes and drops them when it is deleted", async () => {
    const { root, devmemory, projectId } = await fixture();
    try {
      const store = devmemory.codeFor(projectId);
      expect(store.findSymbols(projectId, { name: "findUser" })).toHaveLength(1);

      writeFile(root, "src/db/Database.ts", "export class Database {\n  findAccount(id: string) {\n    return id;\n  }\n}\n");
      await devmemory.index(projectId);

      expect(store.findSymbols(projectId, { name: "findUser" })).toHaveLength(0);
      expect(store.findSymbols(projectId, { name: "findAccount" })).toHaveLength(1);

      removeFile(root, "src/db/Database.ts");
      await devmemory.index(projectId);

      expect(store.findSymbols(projectId, { name: "findAccount" })).toHaveLength(0);
      expect(store.findSymbols(projectId, { name: "Database", type: "class" })).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });

  it("keeps symbols isolated between projects (AC-06)", async () => {
    const alpha = makeProject({
      name: "sym-alpha",
      remote: "git@github.com:acme/sym-alpha.git",
      files: { "package.json": JSON.stringify({ name: "a" }), "src/alpha.ts": "export class AlphaOnly {}\n" },
    });
    const beta = makeProject({
      name: "sym-beta",
      remote: "git@github.com:acme/sym-beta.git",
      files: { "package.json": JSON.stringify({ name: "b" }), "src/beta.ts": "export class BetaOnly {}\n" },
    });

    const devmemory = makeDevMemory();
    try {
      const a = (await devmemory.connect({ explicitRoot: alpha })).project;
      const b = (await devmemory.connect({ explicitRoot: beta })).project;

      expect(devmemory.codeFor(a.projectId).findSymbols(a.projectId, { name: "AlphaOnly" })).toHaveLength(1);
      expect(devmemory.codeFor(a.projectId).findSymbols(a.projectId, { name: "BetaOnly" })).toHaveLength(0);
      expect(devmemory.codeFor(b.projectId).findSymbols(b.projectId, { name: "AlphaOnly" })).toHaveLength(0);
      expect(devmemory.codeFor(a.projectId).findSymbols(b.projectId, { name: "AlphaOnly" })).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });
});

describe("dependency graph (PRD 17)", () => {
  it("resolves relative imports to project files", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const store = devmemory.codeFor(projectId);
      const dependencies = store.dependencies(projectId, "src/auth/AuthService.ts").map((edge) => edge.path);
      expect(dependencies).toEqual(["src/db/Database.ts"]);
    } finally {
      devmemory.close();
    }
  });

  it("resolves tsconfig path aliases", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const dependencies = devmemory
        .codeFor(projectId)
        .dependencies(projectId, "src/api/AuthApi.ts")
        .map((edge) => edge.path);
      expect(dependencies).toContain("src/auth/AuthService.ts");
    } finally {
      devmemory.close();
    }
  });

  it("marks node_modules imports as external packages", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const store = devmemory.codeFor(projectId);
      const external = store.importsOf(projectId, "src/api/AuthApi.ts").find((entry) => entry.specifier === "express");

      expect(external?.isExternal).toBe(true);
      expect(external?.packageName).toBe("express");
      expect(external?.resolvedPath).toBeNull();
      expect(store.externalPackages(projectId).map((entry) => entry.package)).toContain("express");
    } finally {
      devmemory.close();
    }
  });

  it("resolves python module imports", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const dependencies = devmemory.codeFor(projectId).dependencies(projectId, "app/main.py").map((edge) => edge.path);
      expect(dependencies).toContain("app/services/users.py");
    } finally {
      devmemory.close();
    }
  });

  it("walks the graph in reverse to find dependents", async () => {
    const { devmemory, projectId } = await fixture();
    try {
      const dependents = devmemory
        .codeFor(projectId)
        .dependents(projectId, "src/auth/AuthService.ts")
        .map((edge) => edge.path);

      expect(dependents).toEqual(expect.arrayContaining(["src/api/AuthApi.ts", "tests/auth.test.ts"]));
    } finally {
      devmemory.close();
    }
  });
});

describe("code intelligence queries", () => {
  it("returns a definition with its source", async () => {
    const { devmemory, code } = await fixture();
    try {
      const definition = code.getDefinition("AuthService");

      expect(definition?.symbol.path).toBe("src/auth/AuthService.ts");
      expect(definition?.symbol.type).toBe("class");
      expect(definition?.source).toContain("class AuthService");
      expect(definition?.tokenEstimate).toBeGreaterThan(0);
      expect(code.getDefinition("NoSuchThing")).toBeNull();
    } finally {
      devmemory.close();
    }
  });

  it("finds references grouped by file, with the enclosing symbol", async () => {
    const { devmemory, code } = await fixture();
    try {
      const groups = code.findReferences("findUser");
      const group = groups.find((entry) => entry.path === "src/auth/AuthService.ts");

      expect(group?.references[0]?.kind).toBe("call");
      expect(group?.references[0]?.fromSymbol).toBe("AuthService.login");
    } finally {
      devmemory.close();
    }
  });

  it("falls back to substring matching when there is no exact name", async () => {
    const { devmemory, code } = await fixture();
    try {
      expect(code.findSymbols("AuthServ").map((symbol) => symbol.name)).toContain("AuthService");
    } finally {
      devmemory.close();
    }
  });

  it("assembles the neighbourhood of a file", async () => {
    const { devmemory, code } = await fixture();
    try {
      const related = code.relatedCode("src/auth/AuthService.ts");

      expect(related.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["AuthService", "login"]));
      expect(related.dependencies).toContain("src/db/Database.ts");
      expect(related.dependents).toContain("src/api/AuthApi.ts");
      expect(related.tests).toContain("tests/auth.test.ts");
      expect(related.imports.map((entry) => entry.specifier)).toContain("../db/Database");
    } finally {
      devmemory.close();
    }
  });

  it("computes direct and transitive impact with affected tests", async () => {
    const { devmemory, code } = await fixture();
    try {
      const impact = code.impact("src/db/Database.ts");

      expect(impact.direct).toContain("src/auth/AuthService.ts");
      expect(impact.transitive).toEqual(expect.arrayContaining(["src/api/AuthApi.ts", "src/pages/LoginPage.tsx"]));
      expect(impact.tests).toContain("tests/auth.test.ts");
      expect(impact.exportedSymbols.map((symbol) => symbol.name)).toContain("Database");
    } finally {
      devmemory.close();
    }
  });

  it("respects the requested graph depth", async () => {
    const { devmemory, code } = await fixture();
    try {
      const shallow = code.impact("src/db/Database.ts", { depth: 1 });
      expect(shallow.direct).toContain("src/auth/AuthService.ts");
      expect(shallow.transitive).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });

  it("selects the tests affected by a set of changed files (PRD 36)", async () => {
    const { devmemory, code } = await fixture();
    try {
      expect(code.affectedTests(["src/db/Database.ts"])).toEqual(["tests/auth.test.ts"]);
      expect(code.affectedTests(["app/services/users.py"])).toEqual([]);
    } finally {
      devmemory.close();
    }
  });

  it("rejects queries for files that are not indexed", async () => {
    const { devmemory, code } = await fixture();
    try {
      expect(() => code.relatedCode("src/does-not-exist.ts")).toThrowError(/not indexed/);
      expect(() => code.impact("src/does-not-exist.ts")).toThrowError(/not indexed/);
    } finally {
      devmemory.close();
    }
  });

  it("recognises test files by path and name", () => {
    expect(looksLikeTest("tests/auth.test.ts")).toBe(true);
    expect(looksLikeTest("src/__tests__/auth.ts")).toBe(true);
    expect(looksLikeTest("app/test_users.py")).toBe(true);
    expect(looksLikeTest("app/users_test.py")).toBe(true);
    expect(looksLikeTest("src/auth/AuthService.ts")).toBe(false);
  });
});

describe("monorepo workspace resolution (PRD 17)", () => {
  const monorepoFiles = {
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", main: "dist/index.js" }),
    "packages/core/src/index.ts": 'export { Engine } from "./engine.js";\n',
    "packages/core/src/engine.ts": "export class Engine {\n  start() {\n    return true;\n  }\n}\n",
    "packages/app/package.json": JSON.stringify({ name: "@acme/app", dependencies: { "@acme/core": "workspace:*" } }),
    "packages/app/src/main.ts": 'import { Engine } from "@acme/core";\n\nexport function boot() {\n  return new Engine().start();\n}\n',
    "packages/app/tests/main.test.ts": 'import { boot } from "../src/main.js";\n\ntest("boot", () => boot());\n',
  };

  it("treats cross-package imports as internal edges, not external packages", async () => {
    const root = makeProject({ name: "monorepo-graph", files: monorepoFiles });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const store = devmemory.codeFor(project.projectId);

      const dependencies = store.dependencies(project.projectId, "packages/app/src/main.ts").map((edge) => edge.path);
      expect(dependencies).toContain("packages/core/src/index.ts");
      expect(store.externalPackages(project.projectId).map((entry) => entry.package)).not.toContain("@acme/core");
    } finally {
      devmemory.close();
    }
  });

  it("follows the graph across package boundaries for impact analysis", async () => {
    const root = makeProject({ name: "monorepo-impact", files: monorepoFiles });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const impact = devmemory.codeIntelligence(project.projectId).impact("packages/core/src/engine.ts");

      expect(impact.direct).toContain("packages/core/src/index.ts");
      expect(impact.transitive).toContain("packages/app/src/main.ts");
      expect(impact.tests).toContain("packages/app/tests/main.test.ts");
    } finally {
      devmemory.close();
    }
  });

  it("resolves a package subpath import", async () => {
    const root = makeProject({
      name: "monorepo-subpath",
      files: {
        ...monorepoFiles,
        "packages/app/src/main.ts": 'import { Engine } from "@acme/core/engine.js";\n\nexport const engine = new Engine();\n',
      },
    });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const dependencies = devmemory
        .codeFor(project.projectId)
        .dependencies(project.projectId, "packages/app/src/main.ts")
        .map((edge) => edge.path);

      expect(dependencies).toContain("packages/core/src/engine.ts");
    } finally {
      devmemory.close();
    }
  });
});
