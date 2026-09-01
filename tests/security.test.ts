import { afterAll, describe, expect, it } from "vitest";
import { isSensitiveFile, redactSecrets, containsSecret, REDACTED } from "@devmemory/indexer";
import { PermissionEngine, assessOperation, safeProjectPath } from "@devmemory/core";
import { FAKE_SECRETS, cleanupAll, makeDevMemory, makeProject, writeFile } from "./helpers.js";

afterAll(cleanupAll);

describe("sensitive file exclusion (PRD 20, 37, AC-15)", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    "config/.env.staging",
    "certs/server.pem",
    "keys/private.key",
    "id_rsa",
    "deploy/id_ed25519",
    "credentials.json",
    "app.secrets.json",
    "home/.ssh/config",
    "keystore.jks",
  ])("treats %s as sensitive", (file) => {
    expect(isSensitiveFile(file)).toBe(true);
  });

  it.each(["src/index.ts", "README.md", "package.json", "src/environment.ts", "docs/keys-explained.md"])(
    "treats %s as safe",
    (file) => {
      expect(isSensitiveFile(file)).toBe(false);
    },
  );

  it("never indexes secret files even when ignore rules are relaxed", async () => {
    const root = makeProject({
      name: "secrets",
      files: {
        "package.json": JSON.stringify({ name: "secrets" }),
        ".env": `STRIPE_SECRET_KEY=${FAKE_SECRETS.stripeKeyShort}\n`,
        "certs/server.pem": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        "src/app.ts": "export const app = 1;\n",
      },
    });

    const devmemory = makeDevMemory(undefined, {
      indexing: {
        maxFileSizeBytes: 1_048_576,
        maxFiles: 200_000,
        respectGitignore: false,
        ignoreDirs: [],
        ignoreFiles: [],
        followSymlinks: false,
      },
    });

    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const indexed = devmemory
        .filesFor(project.projectId)
        .list(project.projectId, { limit: 100 })
        .map((file) => file.relativePath);

      expect(indexed).toContain("src/app.ts");
      expect(indexed).not.toContain(".env");
      expect(indexed).not.toContain("certs/server.pem");
    } finally {
      devmemory.close();
    }
  });
});

describe("secret redaction (PRD 37)", () => {
  it("redacts common credential formats", async () => {
    const input = [
      "const aws = 'AKIAIOSFODNN7EXAMPLE';",
      `const gh = '${FAKE_SECRETS.githubToken}';`,
      `STRIPE_SECRET_KEY=${FAKE_SECRETS.stripeKey}`,
      "DATABASE_PASSWORD=hunter2hunter2",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain(FAKE_SECRETS.githubToken);
    expect(result.text).not.toContain("hunter2hunter2");
    expect(result.text).toContain(REDACTED);
    expect(result.redactions.length).toBeGreaterThan(0);
  });

  it("redacts a private key block", async () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(input).text.trim()).toBe(REDACTED);
  });

  it("leaves ordinary source code untouched", async () => {
    const input = "export function login(user: string, password: string) {\n  return authenticate(user, password);\n}\n";
    const result = redactSecrets(input);

    expect(result.text).toBe(input);
    expect(result.redactions).toHaveLength(0);
    expect(containsSecret(input)).toBe(false);
  });
});

describe("path containment", () => {
  it("rejects paths that escape the project root", async () => {
    expect(() => safeProjectPath("C:/projects/app", "../../windows/system32/config")).toThrowError(/escapes/);
    expect(() => safeProjectPath("C:/projects/app", "src/index.ts")).not.toThrow();
  });
});

describe("permission policy (PRD 38)", () => {
  it("allows read and write, and guards destruction by default", () => {
    const permissions = new PermissionEngine();

    expect(permissions.check({ tool: "get_context", permission: "READ" }).allowed).toBe(true);
    expect(permissions.check({ tool: "remember", permission: "WRITE" }).allowed).toBe(true);
    expect(permissions.check({ tool: "run_tests", permission: "EXECUTE" }).allowed).toBe(true);

    const destructive = permissions.check({ tool: "project_forget", permission: "DESTRUCTIVE" });
    expect(destructive.allowed).toBe(false);
    expect(destructive.requiresConfirmation).toBe(true);
    expect(destructive.reason).toContain("confirm=true");

    expect(permissions.check({ tool: "project_forget", permission: "DESTRUCTIVE", confirmed: true }).allowed).toBe(true);
  });

  it("supports a read-only policy", () => {
    const permissions = new PermissionEngine({ WRITE: "deny", DESTRUCTIVE: "deny" });

    expect(permissions.check({ tool: "get_context", permission: "READ" }).allowed).toBe(true);
    const denied = permissions.check({ tool: "remember", permission: "WRITE" });
    expect(denied.allowed).toBe(false);
    expect(denied.requiresConfirmation).toBe(false);
    expect(denied.reason).toContain("disabled by policy");
    // A denial cannot be talked out of with a confirmation.
    expect(permissions.check({ tool: "remember", permission: "WRITE", confirmed: true }).allowed).toBe(false);
  });

  it("throws a structured error when enforcing", () => {
    const permissions = new PermissionEngine();
    expect(() => permissions.enforce({ tool: "project_forget", permission: "DESTRUCTIVE" })).toThrowError(
      /DESTRUCTIVE operation/,
    );
  });

  it("reads the policy from configuration", async () => {
    const devmemory = makeDevMemory(undefined, {
      security: {
        redactSecrets: true,
        blockSensitiveFiles: true,
        scanForSecrets: true,
        permissions: { READ: "allow", WRITE: "deny", EXECUTE: "allow", DESTRUCTIVE: "deny" },
      },
    });
    try {
      expect(devmemory.permissions.describe().WRITE).toBe("deny");
      expect(devmemory.permissions.check({ tool: "remember", permission: "WRITE" }).allowed).toBe(false);
    } finally {
      devmemory.close();
    }
  });
});

describe("dangerous operation detection (PRD 38)", () => {
  it.each([
    ["DROP TABLE payments;", "drop_table"],
    ["DROP DATABASE production;", "drop_database"],
    ["TRUNCATE TABLE orders", "truncate"],
    ["DELETE FROM users;", "unfiltered_delete"],
    ["UPDATE users SET admin = 1", "unfiltered_update"],
    ["rm -rf ./build", "recursive_delete"],
    ["git push --force origin main", "force_push"],
    ["git reset --hard origin/main", "history_rewrite"],
  ])("flags %s as dangerous", (operation, rule) => {
    const assessment = assessOperation(operation);
    expect(assessment.severity).toBe("dangerous");
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.risks.map((risk) => risk.rule)).toContain(rule);
  });

  it.each([
    "npm run build",
    "pnpm test",
    "git status",
    "DELETE FROM sessions WHERE expires_at < now();",
    "UPDATE users SET name = 'x' WHERE id = 1",
    "git push --force-with-lease origin feature",
  ])("leaves %s alone", (operation) => {
    expect(assessOperation(operation).severity).toBe("safe");
  });

  it("escalates a routine operation when it targets production", () => {
    const staging = assessOperation("prisma migrate deploy --env staging");
    const production = assessOperation("prisma migrate deploy --env production");

    expect(staging.severity).toBe("caution");
    expect(staging.requiresConfirmation).toBe(false);
    expect(production.severity).toBe("dangerous");
    expect(production.productionTarget).toBe(true);
  });

  it("treats deployment as something to check", () => {
    const assessment = assessOperation("vercel deploy");
    expect(assessment.severity).toBe("caution");
    expect(assessment.risks.map((risk) => risk.rule)).toContain("deployment");
  });
});

describe("secret scanning during indexing (PRD 37)", () => {
  it("flags a file containing a credential without storing the credential", async () => {
    const root = makeProject({
      name: "scan",
      files: {
        "package.json": JSON.stringify({ name: "scan" }),
        "src/config.ts": `export const config = {\n  stripeKey: "${FAKE_SECRETS.stripeKey}",\n};\n`,
        "src/clean.ts": "export const clean = true;\n",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const status = devmemory.status(project.projectId);

      expect(status.security.files).toBe(1);
      expect(status.security.findings[0]?.path).toBe("src/config.ts");
      expect(status.security.findings[0]?.detectors).toContain("stripe_key");

      // The finding records the detector, never the secret itself.
      expect(JSON.stringify(status.security)).not.toContain(FAKE_SECRETS.stripeKey);
    } finally {
      devmemory.close();
    }
  });

  it("clears the flag once the credential is removed", async () => {
    const root = makeProject({
      name: "scanclear",
      files: {
        "package.json": JSON.stringify({ name: "scanclear" }),
        "src/config.ts": `export const key = "${FAKE_SECRETS.githubToken}";\n`,
      },
    });

    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      expect(devmemory.status(project.projectId).security.files).toBe(1);

      writeFile(root, "src/config.ts", "export const key = process.env.GITHUB_TOKEN;\n");
      await devmemory.index(project.projectId);

      expect(devmemory.status(project.projectId).security.files).toBe(0);
    } finally {
      devmemory.close();
    }
  });

  it("can be turned off", async () => {
    const root = makeProject({
      name: "scanoff",
      files: {
        "package.json": JSON.stringify({ name: "scanoff" }),
        "src/config.ts": `export const key = "${FAKE_SECRETS.githubToken}";\n`,
      },
    });

    const devmemory = makeDevMemory(undefined, {
      security: {
        redactSecrets: true,
        blockSensitiveFiles: true,
        scanForSecrets: false,
        permissions: { READ: "allow", WRITE: "allow", EXECUTE: "allow", DESTRUCTIVE: "confirm" },
      },
    });
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      expect(devmemory.status(project.projectId).security.files).toBe(0);
    } finally {
      devmemory.close();
    }
  });
});

describe("secrets never reach stored derived data (PRD 37, AC-15)", () => {
  it("redacts a credential that appears in a symbol signature", async () => {
    const root = makeProject({
      name: "signature-leak",
      files: {
        "package.json": JSON.stringify({ name: "signature-leak" }),
        "src/config.ts": `export const token = "${FAKE_SECRETS.githubToken}";\n`,
      },
    });

    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });

      const symbol = devmemory.codeFor(project.projectId).findSymbols(project.projectId, { name: "token" })[0];
      expect(symbol?.signature).toContain("<REDACTED>");
      expect(symbol?.signature).not.toContain(FAKE_SECRETS.githubToken);

      // The same value must not be reachable through search or context either.
      const found = devmemory.contextEngine(project.projectId).searchContext("token");
      expect(JSON.stringify(found)).not.toContain(FAKE_SECRETS.githubToken);

      const context = devmemory.contextEngine(project.projectId).getContext({
        task: "review the token",
        includeSource: true,
        maxTokens: 20_000,
      });
      expect(JSON.stringify(context)).not.toContain(FAKE_SECRETS.githubToken);
    } finally {
      devmemory.close();
    }
  });
});
