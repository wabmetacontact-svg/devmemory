import { afterAll, describe, expect, it } from "vitest";
import { GitEngine } from "@samirthakur024/core";
import { cleanupAll, git, makeProject, writeFile } from "./helpers.js";

const engine = new GitEngine();

afterAll(cleanupAll);

describe("git engine (PRD 34)", () => {
  it("reports the repository root, branch and head commit", () => {
    const root = makeProject({ name: "gitbasics" });

    expect(engine.isAvailable()).toBe(true);
    expect(engine.repoRoot(root)).toBe(root);
    expect(engine.isRepo(root)).toBe(true);
    expect(engine.currentBranch(root)).toBeTruthy();
    expect(engine.headCommit(root)).toMatch(/^[0-9a-f]{40}$/);
    expect(engine.rootCommit(root)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null outside a repository", () => {
    const root = makeProject({ name: "nogit-engine", git: false });
    expect(engine.repoRoot(root)).toBeNull();
    expect(engine.isRepo(root)).toBe(false);
  });

  it("reports status for clean, modified and untracked trees", () => {
    const root = makeProject({ name: "gitstatus" });
    expect(engine.status(root).clean).toBe(true);

    writeFile(root, "src/index.ts", "export const value = 2;\n");
    writeFile(root, "src/new.ts", "export const created = true;\n");

    const status = engine.status(root);
    expect(status.clean).toBe(false);
    expect(status.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["src/index.ts", "src/new.ts"]),
    );
    expect(status.files.find((file) => file.path === "src/new.ts")?.untracked).toBe(true);
  });

  it("reads history, including per-file history", () => {
    const root = makeProject({ name: "githistory" });
    writeFile(root, "src/index.ts", "export const value = 2;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "update value"]);

    const commits = engine.log(root, { limit: 10 });
    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe("update value");
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(commits[0]?.author).toBe("DevMemory Test");

    const fileHistory = engine.log(root, { limit: 10, file: "src/index.ts" });
    expect(fileHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("produces diffs and redactable output", () => {
    const root = makeProject({ name: "gitdiff" });
    writeFile(root, "src/index.ts", "export const value = 99;\n");

    const diff = engine.diff(root);
    expect(diff).toContain("src/index.ts");
    expect(diff).toContain("+export const value = 99;");

    const names = engine.diff(root, { nameOnly: true });
    expect(names.trim().split(/\r?\n/)).toContain("src/index.ts");
  });

  it("lists files changed since a ref, including uncommitted work", () => {
    const root = makeProject({ name: "gitsince" });
    const base = engine.headCommit(root) as string;

    writeFile(root, "src/committed.ts", "export const committed = true;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "add committed"]);
    writeFile(root, "src/uncommitted.ts", "export const uncommitted = true;\n");

    const changed = engine.changedFilesSince(root, base);
    expect(changed).toEqual(expect.arrayContaining(["src/committed.ts", "src/uncommitted.ts"]));
  });

  it("enumerates project files the way git sees them", () => {
    const root = makeProject({
      name: "gitls",
      files: {
        "package.json": JSON.stringify({ name: "gitls" }),
        ".gitignore": "ignored/\n",
        "src/tracked.ts": "export const tracked = 1;\n",
        "ignored/file.ts": "export const hidden = 1;\n",
      },
    });

    const files = engine.listFiles(root);
    expect(files).toContain("src/tracked.ts");
    expect(files).not.toContain("ignored/file.ts");
  });

  it("does not throw on a repository with no commits", () => {
    const root = makeProject({ name: "gitempty", commit: false });
    expect(engine.rootCommit(root)).toBeNull();
    expect(engine.headCommit(root)).toBeNull();
    expect(() => engine.status(root)).not.toThrow();
  });
});
