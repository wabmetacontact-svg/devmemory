import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DevMemoryError, projectLayout } from "@samirthakur024/shared";
import { cleanupAll, makeDevMemory, makeHome, makeProject } from "./helpers.js";

afterAll(cleanupAll);

describe("project isolation (PRD 11, AC-06)", () => {
  it("keeps two projects' file indexes completely separate", async () => {
    const alpha = makeProject({
      name: "alpha",
      remote: "git@github.com:acme/alpha.git",
      files: { "package.json": JSON.stringify({ name: "alpha" }), "src/alpha-only.ts": "export const alpha = 1;\n" },
    });
    const beta = makeProject({
      name: "beta",
      remote: "git@github.com:acme/beta.git",
      files: { "package.json": JSON.stringify({ name: "beta" }), "src/beta-only.ts": "export const beta = 1;\n" },
    });

    const devmemory = makeDevMemory();
    try {
      const a = (await devmemory.connect({ explicitRoot: alpha })).project;
      const b = (await devmemory.connect({ explicitRoot: beta })).project;
      expect(a.projectId).not.toBe(b.projectId);

      const alphaFiles = devmemory.filesFor(a.projectId).list(a.projectId, { limit: 100 }).map((f) => f.relativePath);
      const betaFiles = devmemory.filesFor(b.projectId).list(b.projectId, { limit: 100 }).map((f) => f.relativePath);

      expect(alphaFiles).toContain("src/alpha-only.ts");
      expect(alphaFiles).not.toContain("src/beta-only.ts");
      expect(betaFiles).toContain("src/beta-only.ts");
      expect(betaFiles).not.toContain("src/alpha-only.ts");

      // Cross-project reads return nothing even when the ids are deliberately mixed.
      expect(devmemory.filesFor(a.projectId).list(b.projectId, { limit: 100 })).toHaveLength(0);
      expect(devmemory.filesFor(a.projectId).searchPaths(b.projectId, "beta")).toHaveLength(0);
      expect(devmemory.filesFor(b.projectId).get(a.projectId, "src/alpha-only.ts")).toBeNull();
    } finally {
      devmemory.close();
    }
  });

  it("stores each project's data in its own directory", async () => {
    const home = makeHome("isolated");
    const alpha = makeProject({ name: "alpha2", remote: "git@github.com:acme/alpha2.git" });
    const beta = makeProject({ name: "beta2", remote: "git@github.com:acme/beta2.git" });

    const devmemory = makeDevMemory(home);
    try {
      const a = (await devmemory.connect({ explicitRoot: alpha })).project;
      const b = (await devmemory.connect({ explicitRoot: beta })).project;

      const aLayout = projectLayout(a.projectId, home);
      const bLayout = projectLayout(b.projectId, home);

      expect(aLayout.root).not.toBe(bLayout.root);
      expect(fs.existsSync(aLayout.indexDb)).toBe(true);
      expect(fs.existsSync(bLayout.indexDb)).toBe(true);
      expect(fs.existsSync(aLayout.metadataFile)).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("refuses to open an index database that belongs to another project", async () => {
    const home = makeHome("mismatch");
    const project = makeProject({ name: "owned" });
    const devmemory = makeDevMemory(home);

    try {
      const connected = (await devmemory.connect({ explicitRoot: project })).project;
      devmemory.databases.closeProject(connected.projectId);

      // Simulate a database file copied under a different project id.
      const impostorId = "proj_00112233aa";
      const impostorLayout = projectLayout(impostorId, home);
      fs.mkdirSync(impostorLayout.root, { recursive: true });
      fs.copyFileSync(projectLayout(connected.projectId, home).indexDb, impostorLayout.indexDb);

      expect(() => devmemory.databases.openProjectIndex(impostorId)).toThrowError(DevMemoryError);
    } finally {
      devmemory.close();
    }
  });

  it("rejects malformed project ids before touching the filesystem", async () => {
    const devmemory = makeDevMemory();
    try {
      expect(() => devmemory.databases.openProjectIndex("../escape")).toThrowError(/invalid project id/);
      expect(() => devmemory.databases.openProjectIndex("proj_../../etc")).toThrowError(/invalid project id/);
    } finally {
      devmemory.close();
    }
  });

  it("removing one project leaves the others intact", async () => {
    const home = makeHome("removal");
    const alpha = makeProject({ name: "alpha3", remote: "git@github.com:acme/alpha3.git" });
    const beta = makeProject({ name: "beta3", remote: "git@github.com:acme/beta3.git" });

    const devmemory = makeDevMemory(home);
    try {
      const a = (await devmemory.connect({ explicitRoot: alpha })).project;
      const b = (await devmemory.connect({ explicitRoot: beta })).project;

      devmemory.remove(a.projectId);

      expect(devmemory.registry.get(a.projectId)).toBeNull();
      expect(fs.existsSync(projectLayout(a.projectId, home).root)).toBe(false);
      expect(devmemory.registry.get(b.projectId)).not.toBeNull();
      expect(devmemory.filesFor(b.projectId).stats(b.projectId).files).toBeGreaterThan(0);

      // The project's own files are never touched (PRD 60).
      expect(fs.existsSync(path.join(alpha, "package.json"))).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("keeps separate DevMemory homes fully independent", async () => {
    const project = makeProject({ name: "shared-project", remote: "git@github.com:acme/shared-project.git" });
    const first = makeDevMemory(makeHome("home-a"));
    const second = makeDevMemory(makeHome("home-b"));

    try {
      await first.connect({ explicitRoot: project, index: false });
      expect(first.listProjects()).toHaveLength(1);
      expect(second.listProjects()).toHaveLength(0);
    } finally {
      first.close();
      second.close();
    }
  });
});
