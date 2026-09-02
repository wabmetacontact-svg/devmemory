import { afterAll, describe, expect, it } from "vitest";
import { canonicalPath, scanEndpoints } from "@samirthakur024/indexer";
import { cleanupAll, makeDevMemory, makeProject } from "./helpers.js";

afterAll(cleanupAll);

describe("endpoint scanning", () => {
  it("reads Express routes, mounts and client calls, and tells them apart", () => {
    const found = scanEndpoints(
      [
        `app.use("/api/admin", adminRoutes);`,
        `router.get("/profile", handler);`,
        `router.delete("/users/:id", handler);`,
        `api.post("/auth/login", credentials);`,
        `const cached = map.get("/not/a/route");`,
      ].join("\n"),
      "src/mixed.ts",
    );

    const roles = found.map((endpoint) => `${endpoint.role} ${endpoint.method ?? "*"} ${endpoint.canonical}`);
    expect(roles).toContain("mounts * admin");
    expect(roles).toContain("provides GET profile");
    expect(roles).toContain("provides DELETE users/{}");
    expect(roles).toContain("consumes POST auth/login");
    // `map.get(...)` is not an endpoint: an unknown receiver is skipped, not guessed.
    expect(roles.some((role) => role.includes("not/a/route"))).toBe(false);
  });

  it("follows type arguments and concatenated paths", () => {
    const found = scanEndpoints(
      [
        `api.get<ApiResponse<Stats>>("/crm/stats");`,
        `api.post("/inbox/conversations/" + conversationId + "/messages", payload);`,
      ].join("\n"),
      "src/services/api.ts",
    );

    const paths = found.map((endpoint) => endpoint.canonical);
    // Without the type-argument rule a typed client's calls are invisible.
    expect(paths).toContain("crm/stats");
    // Reporting only the first chunk would claim a call to /inbox/conversations/.
    expect(paths).toContain("inbox/conversations/{}/messages");
  });

  it("treats a client with an absolute baseURL as third-party", () => {
    const graph = scanEndpoints(
      [`const client = axios.create({ baseURL: "https://graph.facebook.com/v21.0" });`, `client.get("/me");`].join("\n"),
      "src/meta.api.ts",
    );
    expect(graph.find((endpoint) => endpoint.canonical === "me")?.external).toBe(true);

    const own = scanEndpoints(
      [`const client = axios.create({ baseURL: process.env.API_URL });`, `client.get("/me");`].join("\n"),
      "src/api.ts",
    );
    // A baseURL from the environment is how a project addresses its own backend.
    expect(own.find((endpoint) => endpoint.canonical === "me")?.external).toBe(false);
  });

  it("reduces paths written in different dialects to the same form", () => {
    expect(canonicalPath("/api/v1/users/:id")).toBe("users/{}");
    expect(canonicalPath("/users/${userId}")).toBe("users/{}");
    expect(canonicalPath("/users/<int:user_id>")).toBe("users/{}");
    expect(canonicalPath("https://host/api/users/7?q=1")).toBe("users/7");
    // Two placeholders next to each other are still one segment.
    expect(canonicalPath("/media/${id}${query}")).toBe("media/{}");
  });
});

describe("api contracts across projects", () => {
  const BACKEND = {
    "package.json": JSON.stringify({ name: "backend", dependencies: { express: "4.18.0" } }),
    "src/app.ts": `import inboxRoutes from "./inbox.routes";\napp.use("/api/inbox", inboxRoutes);\n`,
    "src/inbox.routes.ts": `router.get("/conversations", h);\nrouter.post("/conversations/:id/messages", h);\n`,
  };
  const clientFiles = (name: string): Record<string, string> => ({
    ...CLIENT,
    "package.json": JSON.stringify({ name, dependencies: { axios: "1.6.0" } }),
  });
  const backendFiles = (name: string): Record<string, string> => ({
    ...BACKEND,
    "package.json": JSON.stringify({ name, dependencies: { express: "4.18.0" } }),
  });

  const CLIENT = {
    "package.json": JSON.stringify({ name: "client", dependencies: { axios: "1.6.0" } }),
    "src/api.ts":
      `api.get("/inbox/conversations");\n` +
      `api.post("/inbox/conversations/" + id + "/messages", body);\n` +
      `api.patch("/inbox/conversations/" + id + "/star", body);\n`,
    "src/meta.ts": `const metaApi = axios.create({ baseURL: "https://graph.facebook.com" });\nmetaApi.get("/me");\n`,
  };

  it("links a call in one repository to the route another repository serves", async () => {
    const backend = makeProject({ name: "backend", remote: "git@github.com:acme/backend.git", files: BACKEND });
    const client = makeProject({ name: "client", remote: "git@github.com:acme/client.git", files: CLIENT });

    const devmemory = makeDevMemory();
    try {
      const a = (await devmemory.connect({ explicitRoot: backend })).project;
      const b = (await devmemory.connect({ explicitRoot: client })).project;
      devmemory.workspaces.create("product", { projectIds: [a.projectId, b.projectId] });

      const report = devmemory.apiContracts("product");

      // The mount prefix lives in app.ts; the route file knows nothing about it.
      const conversations = report.linked.find((link) => link.canonical === "inbox/conversations");
      expect(conversations?.providers[0]?.project).toBe("backend");
      expect(conversations?.consumers[0]?.project).toBe("client");

      const messages = report.linked.find((link) => link.canonical === "inbox/conversations/{}/messages");
      expect(messages?.providers).toHaveLength(1);
      expect(messages?.consumers).toHaveLength(1);

      // The call with no route is the finding worth surfacing.
      const paths = report.unmatchedCalls.map((link) => link.canonical);
      expect(paths).toContain("inbox/conversations/{}/star");
      expect(paths).not.toContain("me"); // the Graph API call is not our contract
      expect(report.externalCalls).toBeGreaterThan(0);
    } finally {
      devmemory.close();
    }
  });

  it("names the call sites a route change would break", async () => {
    const backend = makeProject({ name: "backend2", remote: "git@github.com:acme/b2.git", files: backendFiles("backend2") });
    const client = makeProject({ name: "client2", remote: "git@github.com:acme/c2.git", files: clientFiles("client2") });

    const devmemory = makeDevMemory();
    try {
      const a = (await devmemory.connect({ explicitRoot: backend })).project;
      const b = (await devmemory.connect({ explicitRoot: client })).project;
      devmemory.workspaces.create("product", { projectIds: [a.projectId, b.projectId] });

      const { callersOf } = await import("@samirthakur024/core");
      const callers = callersOf(devmemory.apiContracts("product"), "inbox/conversations");
      expect(callers).toHaveLength(1);
      expect(callers[0]?.project).toBe("client2");
      expect(callers[0]?.path).toBe("src/api.ts");
    } finally {
      devmemory.close();
    }
  });
});
