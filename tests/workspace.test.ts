import { afterAll, describe, expect, it } from "vitest";
import { DevMemoryError } from "@samirthakur024/shared";
import { budgetPerProject, MINIMUM_PROJECT_BUDGET } from "@samirthakur024/core";
import { cleanupAll, makeDevMemory, makeProject } from "./helpers.js";

afterAll(cleanupAll);

/**
 * Three projects that share a vocabulary the way a real product does: the same
 * Template type is declared once per repository, with nothing linking them.
 */
function makeTrio() {
  const web = makeProject({
    name: "web",
    remote: "git@github.com:acme/web.git",
    files: {
      "package.json": JSON.stringify({ name: "web" }),
      "src/types/template.ts": "export interface Template {\n  id: string;\n  body: string;\n}\n",
      "src/pages/Login.tsx": "export function Login() {\n  const field = 1;\n  return field;\n}\n",
    },
  });
  const api = makeProject({
    name: "api",
    remote: "git@github.com:acme/api.git",
    files: {
      "package.json": JSON.stringify({ name: "api" }),
      "src/template.service.ts": "export interface Template {\n  id: string;\n  body: string;\n}\n",
    },
  });
  const outsider = makeProject({
    name: "outsider",
    remote: "git@github.com:acme/outsider.git",
    files: {
      "package.json": JSON.stringify({ name: "outsider" }),
      "src/template.ts": "export interface Template {\n  secret: string;\n}\n",
    },
  });
  return { web, api, outsider };
}

describe("workspaces (cross-project grouping)", () => {
  it("groups projects, reports their totals, and never reaches outside the group", async () => {
    const { web, api, outsider } = makeTrio();
    const devmemory = makeDevMemory();
    try {
      const a = (await devmemory.connect({ explicitRoot: web })).project;
      const b = (await devmemory.connect({ explicitRoot: api })).project;
      const c = (await devmemory.connect({ explicitRoot: outsider })).project;

      devmemory.workspaces.create("product", { projectIds: [a.projectId, b.projectId] });

      const status = devmemory.workspaceStatus("product");
      expect(status.projects.map((project) => project.name).sort()).toEqual(["api", "web"]);
      expect(status.totals.files).toBeGreaterThan(0);

      // The whole point of PRD 11 survives: a project outside the workspace is
      // invisible, even though it contains the strongest match for the query.
      const results = devmemory.workspaceSearch("product", "Template", 20);
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((result) => result.project)).not.toContain("outsider");
      expect(new Set(results.map((result) => result.project))).toEqual(new Set(["web", "api"]));

      const context = devmemory.workspaceContext("product", { task: "change the Template type" });
      expect(context.projects.map((entry) => entry.name).sort()).toEqual(["api", "web"]);
      expect(context.files.every((file) => file.project !== "outsider")).toBe(true);

      // Both sides of the change are visible in one answer - the reason to group.
      expect(new Set(context.files.map((file) => file.project))).toEqual(new Set(["web", "api"]));
      expect(c.projectId).toBeTruthy();
    } finally {
      devmemory.close();
    }
  });

  it("adds, labels and removes members, and refuses unknown workspaces", async () => {
    const { web, api } = makeTrio();
    const devmemory = makeDevMemory();
    try {
      const a = (await devmemory.connect({ explicitRoot: web })).project;
      const b = (await devmemory.connect({ explicitRoot: api })).project;

      devmemory.workspaces.create("product", { projectIds: [a.projectId] });
      const added = devmemory.workspaces.addProject("product", b.projectId, "backend");
      expect(added.members).toHaveLength(2);
      expect(added.members.find((member) => member.projectId === b.projectId)?.role).toBe("backend");

      // Adding twice updates the label instead of duplicating the membership.
      const relabelled = devmemory.workspaces.addProject("product", b.projectId, "api");
      expect(relabelled.members).toHaveLength(2);
      expect(relabelled.members.find((member) => member.projectId === b.projectId)?.role).toBe("api");

      expect(devmemory.workspaces.removeProject("product", b.projectId).members).toHaveLength(1);
      expect(devmemory.workspaces.forProject(a.projectId).map((w) => w.name)).toEqual(["product"]);
      expect(() => devmemory.workspaceStatus("nope")).toThrow(DevMemoryError);
    } finally {
      devmemory.close();
    }
  });

  it("splits the token budget so no single project can consume it", () => {
    expect(budgetPerProject(6000, 1)).toBe(6000);
    expect(budgetPerProject(6000, 3)).toBe(2000);
    // A budget too small to divide still gives every project enough to say something.
    expect(budgetPerProject(900, 3)).toBe(MINIMUM_PROJECT_BUDGET);
  });
});
