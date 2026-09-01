import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDevMemoryServer } from "@devmemory/mcp";
import { cleanupAll, makeDevMemory, makeProject } from "./helpers.js";

afterAll(cleanupAll);

/** Connects a real MCP client to the real server over an in-memory transport. */
async function connect(root: string, config?: Parameters<typeof makeDevMemory>[1]) {
  const devmemory = makeDevMemory(undefined, config);
  const { server } = createDevMemoryServer({ devmemory, cwd: root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-agent", version: "1.0.0" }, { capabilities: { roots: {} } });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    devmemory,
    async close() {
      await client.close();
      await server.close();
      devmemory.close();
    },
  };
}

function payload(result: unknown): any {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]?.text as string);
}

describe("MCP protocol integration (AC-07, AC-08)", () => {
  it("advertises its tools over the protocol", async () => {
    const root = makeProject({ name: "protocol" });
    const session = await connect(root);
    try {
      const { tools } = await session.client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain("project_connect");
      expect(names).toContain("project_map");
      expect(names).toContain("git_status");

      const connectTool = tools.find((tool) => tool.name === "project_connect");
      expect(connectTool?.description).toBeTruthy();
      expect(connectTool?.inputSchema.type).toBe("object");
      expect(tools.find((tool) => tool.name === "find_file")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((tool) => tool.name === "project_forget")?.annotations?.destructiveHint).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("connects a project and answers follow-up calls in the same session", async () => {
    const root = makeProject({
      name: "protocolflow",
      files: {
        "package.json": JSON.stringify({ name: "protocolflow", dependencies: { express: "4.18.0" } }),
        "src/index.ts": "export const app = 1;\n",
        "src/auth/AuthService.ts": "export class AuthService {}\n",
      },
    });

    const session = await connect(root);
    try {
      const connected = payload(await session.client.callTool({ name: "project_connect", arguments: { root } }));
      expect(connected.project_id).toMatch(/^proj_/);
      expect(connected.framework).toBe("Express");

      const map = payload(await session.client.callTool({ name: "project_map", arguments: {} }));
      expect(map.project_id).toBe(connected.project_id);
      expect(map.files).toBeGreaterThan(0);

      const found = payload(await session.client.callTool({ name: "find_file", arguments: { query: "AuthService" } }));
      expect(found.files[0].path).toBe("src/auth/AuthService.ts");
    } finally {
      await session.close();
    }
  });

  it("returns errors as structured tool results rather than transport failures", async () => {
    const root = makeProject({ name: "protocolerror" });
    const session = await connect(root);
    try {
      const result = await session.client.callTool({
        name: "project_status",
        arguments: { project_id: "proj_00deadbeef" },
      });

      expect(result.isError).toBe(true);
      expect(payload(result).error.code).toBe("PROJECT_NOT_FOUND");
    } finally {
      await session.close();
    }
  });

  it("rejects arguments that violate a tool's schema", async () => {
    const root = makeProject({ name: "protocolschema" });
    const session = await connect(root);
    try {
      // The SDK validates against the declared schema and never reaches the handler.
      const result = await session.client.callTool({ name: "find_file", arguments: { query: 123 } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("Invalid arguments for tool find_file");
    } finally {
      await session.close();
    }
  });
});

describe("permission enforcement over the protocol (PRD 38)", () => {
  it("refuses a destructive call that carries no confirmation", async () => {
    const root = makeProject({ name: "protocolpermission" });
    const session = await connect(root);
    try {
      const connected = payload(await session.client.callTool({ name: "project_connect", arguments: { root } }));

      const refused = await session.client.callTool({
        name: "project_forget",
        arguments: { project_id: connected.project_id, confirm: false },
      });

      expect(refused.isError).toBe(true);
      expect(payload(refused).error.code).toBe("PERMISSION_DENIED");
      expect(payload(refused).error.details.requires_confirmation).toBe(true);

      const allowed = await session.client.callTool({
        name: "project_forget",
        arguments: { project_id: connected.project_id, confirm: true },
      });
      expect(payload(allowed).removed).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("honours a read-only policy for every write tool", async () => {
    const root = makeProject({ name: "protocolreadonly" });
    const session = await connect(root, {
      security: {
        redactSecrets: true,
        blockSensitiveFiles: true,
        scanForSecrets: true,
        permissions: { READ: "allow", WRITE: "deny", EXECUTE: "allow", DESTRUCTIVE: "deny" },
      },
    });
    try {
      const blocked = await session.client.callTool({ name: "project_connect", arguments: { root } });
      expect(blocked.isError).toBe(true);
      expect(payload(blocked).error.message).toContain("disabled by policy");

      // Reading is still fine.
      const listed = await session.client.callTool({ name: "project_list", arguments: {} });
      expect(listed.isError).toBeFalsy();
    } finally {
      await session.close();
    }
  });

  it("classifies an operation before an agent runs it", async () => {
    const root = makeProject({ name: "protocolcheck" });
    const session = await connect(root);
    try {
      const dangerous = payload(
        await session.client.callTool({ name: "check_operation", arguments: { operation: "DROP TABLE payments" } }),
      );
      expect(dangerous.severity).toBe("dangerous");
      expect(dangerous.requires_confirmation).toBe(true);

      const safe = payload(
        await session.client.callTool({ name: "check_operation", arguments: { operation: "pnpm test" } }),
      );
      expect(safe.severity).toBe("safe");
    } finally {
      await session.close();
    }
  });

  it("reports what security is in force", async () => {
    const root = makeProject({
      name: "protocolsecuritystatus",
      files: {
        "package.json": JSON.stringify({ name: "protocolsecuritystatus" }),
        "src/config.ts": 'export const key = "AKIAIOSFODNN7EXAMPLE";\n',
      },
    });
    const session = await connect(root);
    try {
      await session.client.callTool({ name: "project_connect", arguments: { root } });
      const status = payload(await session.client.callTool({ name: "security_status", arguments: {} }));

      expect(status.policy.DESTRUCTIVE).toBe("confirm");
      expect(status.redaction_enabled).toBe(true);
      expect(status.files_with_secrets).toBe(1);
      expect(JSON.stringify(status)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    } finally {
      await session.close();
    }
  });

  it("reports cache state on context calls", async () => {
    const root = makeProject({
      name: "protocolcache",
      files: {
        "package.json": JSON.stringify({ name: "protocolcache" }),
        "src/auth/AuthService.ts": "export class AuthService {\n  login(email: string) {\n    return email;\n  }\n}\n",
      },
    });
    const session = await connect(root);
    try {
      await session.client.callTool({ name: "project_connect", arguments: { root } });

      const first = payload(await session.client.callTool({ name: "get_context", arguments: { task: "fix login" } }));
      const second = payload(await session.client.callTool({ name: "get_context", arguments: { task: "fix login" } }));

      expect(first.cache).toBe("miss");
      expect(first.context_id).toMatch(/^ctx_/);
      expect(second.cache).toBe("hit");
      expect(second.context_id).toBe(first.context_id);

      const status = payload(await session.client.callTool({ name: "project_status", arguments: {} }));
      expect(status.context_analytics.requests).toBeGreaterThanOrEqual(2);
      expect(status.context_analytics.cache_hit_rate).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});
