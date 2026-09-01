import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanupAll, git, makeDevMemory, makeProject, removeFile, writeFile } from "./helpers.js";

afterAll(cleanupAll);

function paths(devmemory: ReturnType<typeof makeDevMemory>, projectId: string): string[] {
  return devmemory
    .filesFor(projectId)
    .list(projectId, { limit: 1000 })
    .map((file) => file.relativePath)
    .sort();
}

describe("filesystem indexing (PRD 15, 59)", () => {
  it("indexes source files and skips ignored, binary and sensitive ones", async () => {
    const root = makeProject({
      name: "indexing",
      files: {
        "package.json": JSON.stringify({ name: "indexing" }),
        "src/index.ts": "export const a = 1;\n",
        "src/auth/AuthService.ts": "export class AuthService {}\n",
        ".env": "SECRET=abc\n",
        ".gitignore": "generated.txt\n",
        "generated.txt": "ignored by git\n",
        "node_modules/dep/index.js": "module.exports = 1;\n",
        "assets/logo.png": "not really a png",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const indexed = paths(devmemory, project.projectId);

      expect(indexed).toContain("src/index.ts");
      expect(indexed).toContain("src/auth/AuthService.ts");
      expect(indexed).toContain("package.json");
      expect(indexed).not.toContain(".env");
      expect(indexed).not.toContain("generated.txt");
      expect(indexed).not.toContain("node_modules/dep/index.js");
      expect(indexed).not.toContain("assets/logo.png");
    } finally {
      devmemory.close();
    }
  });

  it("does not re-read unchanged files on a second pass (AC-09)", async () => {
    const root = makeProject({ name: "incremental" });
    const devmemory = makeDevMemory();
    try {
      const { project, index } = await devmemory.connect({ explicitRoot: root });
      expect(index?.added).toBeGreaterThan(0);

      const second = await devmemory.index(project.projectId);
      expect(second.added).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.unchanged).toBe(index?.scanned);
    } finally {
      devmemory.close();
    }
  });

  it("picks up added, modified, deleted and renamed files", async () => {
    const root = makeProject({ name: "changes" });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const store = devmemory.filesFor(project.projectId);
      const originalHash = store.get(project.projectId, "src/index.ts")?.hash;

      // Added
      writeFile(root, "src/added.ts", "export const added = true;\n");
      git(root, ["add", "-A"]);
      let stats = await devmemory.index(project.projectId);
      expect(stats.added).toBe(1);
      expect(paths(devmemory, project.projectId)).toContain("src/added.ts");

      // Modified
      writeFile(root, "src/index.ts", "export const value = 42;\n");
      stats = await devmemory.index(project.projectId);
      expect(stats.updated).toBe(1);
      expect(store.get(project.projectId, "src/index.ts")?.hash).not.toBe(originalHash);

      // Renamed
      fs.renameSync(path.join(root, "src/added.ts"), path.join(root, "src/renamed.ts"));
      git(root, ["add", "-A"]);
      stats = await devmemory.index(project.projectId);
      const afterRename = paths(devmemory, project.projectId);
      expect(afterRename).toContain("src/renamed.ts");
      expect(afterRename).not.toContain("src/added.ts");

      // Deleted
      removeFile(root, "src/renamed.ts");
      git(root, ["add", "-A"]);
      stats = await devmemory.index(project.projectId);
      expect(stats.deleted).toBe(1);
      expect(paths(devmemory, project.projectId)).not.toContain("src/renamed.ts");
    } finally {
      devmemory.close();
    }
  });

  it("indexing is idempotent (PRD 60)", async () => {
    const root = makeProject({ name: "idempotent" });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const first = paths(devmemory, project.projectId);

      await devmemory.index(project.projectId);
      await devmemory.index(project.projectId, { full: true });
      await devmemory.index(project.projectId);

      expect(paths(devmemory, project.projectId)).toEqual(first);
    } finally {
      devmemory.close();
    }
  });

  it("indexes a non-git project by walking the filesystem", async () => {
    const root = makeProject({
      name: "nogit",
      git: false,
      files: {
        "package.json": JSON.stringify({ name: "nogit" }),
        "app/main.py": "print('hi')\n",
        "node_modules/x/y.js": "1",
        "dist/bundle.js": "1",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const indexed = paths(devmemory, project.projectId);

      expect(indexed).toContain("app/main.py");
      expect(indexed).not.toContain("node_modules/x/y.js");
      expect(indexed).not.toContain("dist/bundle.js");
    } finally {
      devmemory.close();
    }
  });

  it("honours .gitignore rules in a non-git project too", async () => {
    const root = makeProject({
      name: "gitignore",
      git: false,
      files: {
        "package.json": JSON.stringify({ name: "gitignore" }),
        ".gitignore": "*.local\nsecrets/\n",
        "config.local": "x",
        "secrets/token.txt": "x",
        "src/keep.ts": "export const keep = 1;\n",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const indexed = paths(devmemory, project.projectId);

      expect(indexed).toContain("src/keep.ts");
      expect(indexed).not.toContain("config.local");
      expect(indexed).not.toContain("secrets/token.txt");
    } finally {
      devmemory.close();
    }
  });

  it("reports index health and file statistics", async () => {
    const root = makeProject({ name: "stats" });
    const devmemory = makeDevMemory();
    try {
      const { project } = await devmemory.connect({ explicitRoot: root });
      const status = devmemory.status(project.projectId);

      expect(status.index.status).toBe("healthy");
      expect(status.index.incomplete).toBe(false);
      expect(status.files.files).toBeGreaterThan(0);
      expect(status.files.byLanguage.some((entry) => entry.language === "typescript")).toBe(true);
      expect(fs.existsSync(status.storagePath)).toBe(true);
    } finally {
      devmemory.close();
    }
  });
});
