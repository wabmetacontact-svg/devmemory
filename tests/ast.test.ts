import { beforeAll, describe, expect, it } from "vitest";
import { ParserRegistry } from "@samirthakur024/indexer";
import type { ParseResult } from "@samirthakur024/indexer";

const registry = new ParserRegistry();

beforeAll(async () => {
  await registry.prepare();
});

function parse(relativePath: string, content: string, language: string): ParseResult {
  const result = registry.parse({ relativePath, content, language });
  if (!result) throw new Error(`no parser for ${language}`);
  return result;
}

function symbol(result: ParseResult, name: string) {
  return result.symbols.find((entry) => entry.name === name);
}

describe("TypeScript parsing (PRD 16)", () => {
  const source = `
import { Database } from "./db/Database";
import type { User } from "../types/User";
import express from "express";

export const MAX_RETRIES = 3;

export interface AuthResult {
  token: string;
}

export type AuthMode = "jwt" | "session";

export class AuthService extends BaseService implements Authenticator {
  private db: Database;

  constructor(db: Database) {
    super();
    this.db = db;
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.db.findUser(email);
    return { token: sign(user) };
  }
}

export function refreshToken(token: string): string {
  return sign(token);
}

const helper = () => validate(1);

export default AuthService;
`;

  it("extracts classes, methods, interfaces, types and constants", () => {
    const result = parse("src/auth/AuthService.ts", source, "typescript");

    expect(symbol(result, "AuthService")?.type).toBe("class");
    expect(symbol(result, "AuthService")?.exported).toBe(true);
    expect(symbol(result, "login")?.type).toBe("method");
    expect(symbol(result, "login")?.qualifiedName).toBe("AuthService.login");
    expect(symbol(result, "login")?.signature).toContain("async login(email: string, password: string)");
    expect(symbol(result, "AuthResult")?.type).toBe("interface");
    expect(symbol(result, "AuthMode")?.type).toBe("type");
    expect(symbol(result, "MAX_RETRIES")?.type).toBe("constant");
    expect(symbol(result, "refreshToken")?.type).toBe("function");
    expect(symbol(result, "helper")?.type).toBe("function");
    expect(symbol(result, "helper")?.exported).toBe(false);
    expect(result.hasErrors).toBe(false);
  });

  it("records line ranges and a stable per-symbol hash", () => {
    const first = parse("src/auth/AuthService.ts", source, "typescript");
    const second = parse("src/auth/AuthService.ts", source, "typescript");

    const login = symbol(first, "login");
    expect(login?.lineStart).toBeGreaterThan(0);
    expect(login?.lineEnd).toBeGreaterThan(login?.lineStart ?? 0);
    expect(symbol(second, "login")?.hash).toBe(login?.hash);
    expect(symbol(first, "refreshToken")?.hash).not.toBe(login?.hash);
  });

  it("extracts imports with their kinds and bindings", () => {
    const result = parse("src/auth/AuthService.ts", source, "typescript");
    const specifiers = result.imports.map((entry) => entry.specifier);

    expect(specifiers).toEqual(expect.arrayContaining(["./db/Database", "../types/User", "express"]));
    expect(result.imports.find((entry) => entry.specifier === "../types/User")?.kind).toBe("type");
    expect(result.imports.find((entry) => entry.specifier === "./db/Database")?.names).toContain("Database");
  });

  it("records calls, inheritance and the enclosing symbol", () => {
    const result = parse("src/auth/AuthService.ts", source, "typescript");

    expect(result.references.some((ref) => ref.name === "BaseService" && ref.kind === "extends")).toBe(true);
    expect(result.references.some((ref) => ref.name === "Authenticator" && ref.kind === "implements")).toBe(true);

    const findUser = result.references.find((ref) => ref.name === "findUser");
    expect(findUser?.kind).toBe("call");
    expect(result.symbols[findUser?.fromSymbolIndex ?? -1]?.name).toBe("login");
  });

  it("handles dynamic imports and require calls", () => {
    const result = parse("src/loader.ts", `const mod = await import("./lazy");\nconst fs = require("node:fs");\n`, "typescript");

    expect(result.imports.find((entry) => entry.specifier === "./lazy")?.kind).toBe("dynamic");
    expect(result.imports.find((entry) => entry.specifier === "node:fs")?.kind).toBe("require");
  });

  it("re-exports count as dependencies", () => {
    const result = parse("src/index.ts", `export { AuthService } from "./auth/AuthService";\n`, "typescript");
    expect(result.imports[0]?.specifier).toBe("./auth/AuthService");
    expect(result.imports[0]?.kind).toBe("export_from");
  });

  it("classifies React components and hooks in TSX", () => {
    const result = parse(
      "src/components/LoginPage.tsx",
      `import { useAuth } from "../hooks/useAuth";

export function LoginPage() {
  const { login } = useAuth();
  return <LoginForm onSubmit={login} />;
}

export function useSession() {
  return null;
}
`,
      "typescript",
    );

    expect(symbol(result, "LoginPage")?.type).toBe("component");
    expect(symbol(result, "useSession")?.type).toBe("hook");
    expect(result.references.some((ref) => ref.name === "LoginForm" && ref.kind === "jsx")).toBe(true);
  });

  it("detects express-style routes", () => {
    const result = parse(
      "src/server.ts",
      `const app = express();\napp.get("/users/:id", getUser);\nrouter.post("/orders", createOrder);\n`,
      "typescript",
    );

    const routes = result.symbols.filter((entry) => entry.type === "route").map((entry) => entry.name);
    expect(routes).toEqual(expect.arrayContaining(["GET /users/:id", "POST /orders"]));
  });

  it("parses plain JavaScript", () => {
    const result = parse(
      "src/util.js",
      `const path = require("node:path");\nmodule.exports.join = function join(a, b) { return path.join(a, b); };\nclass Helper { run() {} }\n`,
      "javascript",
    );

    expect(symbol(result, "Helper")?.type).toBe("class");
    expect(symbol(result, "run")?.qualifiedName).toBe("Helper.run");
    expect(result.imports[0]?.specifier).toBe("node:path");
  });

  it("keeps partial results for a file with syntax errors", () => {
    const result = parse("src/broken.ts", `export function ok() {}\nexport class Broken {\n`, "typescript");

    expect(result.hasErrors).toBe(true);
    expect(symbol(result, "ok")?.type).toBe("function");
  });

  it("ignores functions nested inside other functions", () => {
    const result = parse(
      "src/nested.ts",
      `export function outer() {\n  function inner() { return 1; }\n  return inner();\n}\n`,
      "typescript",
    );

    expect(symbol(result, "outer")).toBeDefined();
    expect(symbol(result, "inner")).toBeUndefined();
    expect(result.references.some((ref) => ref.name === "inner")).toBe(true);
  });
});

describe("Python parsing (PRD 18)", () => {
  const source = `
import os
from app.services.auth import AuthService, verify
from . import helpers

MAX_USERS = 100

class UserService(BaseService):
    def __init__(self, db):
        self.db = db

    def find(self, user_id):
        return self.db.query(user_id)

def _private_helper():
    return 1

@app.get("/users")
def list_users():
    return UserService().find(1)
`;

  it("extracts classes, methods, functions and constants", () => {
    const result = parse("app/services/users.py", source, "python");

    expect(symbol(result, "UserService")?.type).toBe("class");
    expect(symbol(result, "find")?.type).toBe("method");
    expect(symbol(result, "find")?.qualifiedName).toBe("UserService.find");
    expect(symbol(result, "MAX_USERS")?.type).toBe("constant");
    expect(symbol(result, "_private_helper")?.exported).toBe(false);
    expect(symbol(result, "list_users")?.exported).toBe(true);
  });

  it("extracts imports including from-imports", () => {
    const result = parse("app/services/users.py", source, "python");
    const specifiers = result.imports.map((entry) => entry.specifier);

    expect(specifiers).toEqual(expect.arrayContaining(["os", "app.services.auth"]));
    expect(result.imports.find((entry) => entry.specifier === "app.services.auth")?.names).toEqual(
      expect.arrayContaining(["AuthService", "verify"]),
    );
  });

  it("records inheritance, calls and decorator routes", () => {
    const result = parse("app/services/users.py", source, "python");

    expect(result.references.some((ref) => ref.name === "BaseService" && ref.kind === "extends")).toBe(true);
    expect(result.references.some((ref) => ref.name === "query" && ref.kind === "call")).toBe(true);
    expect(result.symbols.some((entry) => entry.type === "route" && entry.name === "GET /users")).toBe(true);
  });
});
