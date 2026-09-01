import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { ProjectResolver, normalizeRemoteUrl } from "@devmemory/core";
import { cleanupAll, makeDevMemory, makeProject, moveProject } from "./helpers.js";

afterAll(cleanupAll);

describe("project resolution (PRD 8, 9)", () => {
  it("identifies a git project by its remote", async () => {
    const root = makeProject({ remote: "git@github.com:acme/wabmeta.git", name: "wabmeta" });
    const identity = new ProjectResolver().resolveIdentity({ explicitRoot: root });

    expect(identity.identitySource).toBe("git_remote");
    expect(identity.identityKey).toBe("git:remote:github.com/acme/wabmeta");
    expect(identity.repositoryUrl).toBe("git@github.com:acme/wabmeta.git");
    expect(identity.projectId).toMatch(/^proj_[a-f0-9]{10}$/);
  });

  it("treats ssh and https clones of one repository as the same project", async () => {
    const ssh = makeProject({ remote: "git@github.com:acme/shared.git", name: "ssh-clone" });
    const https = makeProject({ remote: "https://github.com/acme/shared.git", name: "https-clone" });

    const resolver = new ProjectResolver();
    expect(resolver.resolveIdentity({ explicitRoot: ssh }).projectId).toBe(
      resolver.resolveIdentity({ explicitRoot: https }).projectId,
    );
  });

  it("falls back to the root commit for a git project without a remote", async () => {
    const root = makeProject({ name: "no-remote" });
    const identity = new ProjectResolver().resolveIdentity({ explicitRoot: root });

    expect(identity.identitySource).toBe("git_root_commit");
    expect(identity.isGitRepo).toBe(true);
  });

  it("identifies a non-git project by fingerprint", async () => {
    const root = makeProject({ git: false, name: "plain" });
    const identity = new ProjectResolver().resolveIdentity({ explicitRoot: root });

    expect(identity.identitySource).toBe("fingerprint");
    expect(identity.isGitRepo).toBe(false);
    expect(identity.repositoryUrl).toBeNull();
  });

  it("resolves the repository root from a nested directory", async () => {
    const root = makeProject({ name: "nested" });
    const nested = path.join(root, "src");
    const workspace = new ProjectResolver().resolveWorkspace({ explicitRoot: nested });

    expect(workspace.root).toBe(root);
    expect(workspace.gitRoot).toBe(root);
  });

  it("prefers an explicit root over client roots and cwd", async () => {
    const explicit = makeProject({ name: "explicit" });
    const other = makeProject({ name: "other" });
    const workspace = new ProjectResolver().resolveWorkspace({
      explicitRoot: explicit,
      clientRoots: [other],
      cwd: other,
    });

    expect(workspace.root).toBe(explicit);
    expect(workspace.origin).toBe("explicit");
  });

  it("uses a client-provided workspace root when there is no explicit root", async () => {
    const clientRoot = makeProject({ name: "client" });
    const workspace = new ProjectResolver().resolveWorkspace({ clientRoots: [clientRoot], cwd: process.cwd() });

    expect(workspace.root).toBe(clientRoot);
    expect(workspace.origin).toBe("client_root");
  });

  it("keeps the same project_id after the project moves on disk (AC-16)", async () => {
    const original = makeProject({ remote: "git@github.com:acme/movable.git", name: "movable" });
    const devmemory = makeDevMemory();
    try {
      const before = await devmemory.connect({ explicitRoot: original, index: false });
      const moved = moveProject(original);
      const after = await devmemory.connect({ explicitRoot: moved, index: false });

      expect(after.project.projectId).toBe(before.project.projectId);
      expect(after.reconnected).toBe(true);
      expect(after.movedFrom).toBe(before.project.rootPath);
      expect(after.project.rootPath).toBe(moved);
      expect(devmemory.listProjects()).toHaveLength(1);
    } finally {
      devmemory.close();
    }
  });

  it("stops at the nearest manifest instead of a stray one higher up", async () => {
    // A temp directory can sit under a home directory that happens to contain an
    // unrelated manifest; the project root must still be the project itself.
    const root = makeProject({ git: false, name: "nearest" });
    const workspace = new ProjectResolver().resolveWorkspace({ explicitRoot: path.join(root, "src") });

    expect(workspace.root).toBe(root);
  });

  it("promotes to the monorepo root when one sits above the package", async () => {
    const monorepo = makeProject({
      git: false,
      name: "monorepo",
      files: {
        "package.json": JSON.stringify({ name: "monorepo", workspaces: ["apps/*"] }),
        "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
        "apps/web/package.json": JSON.stringify({ name: "web" }),
        "apps/web/src/index.ts": "export const web = 1;\n",
      },
    });

    const workspace = new ProjectResolver().resolveWorkspace({
      explicitRoot: path.join(monorepo, "apps", "web", "src"),
    });
    expect(workspace.root).toBe(monorepo);
  });

  it("refuses to infer the home directory as a project root", async () => {
    const resolver = new ProjectResolver();
    expect(() => resolver.resolveWorkspace({ cwd: os.homedir() })).toThrowError(/refusing to treat/);
  });

  it("gives different projects different ids", async () => {
    const a = makeProject({ remote: "git@github.com:acme/a.git", name: "a" });
    const b = makeProject({ remote: "git@github.com:acme/b.git", name: "b" });
    const resolver = new ProjectResolver();

    expect(resolver.resolveIdentity({ explicitRoot: a }).projectId).not.toBe(
      resolver.resolveIdentity({ explicitRoot: b }).projectId,
    );
  });
});

describe("remote url normalisation", () => {
  it.each([
    ["git@github.com:acme/repo.git", "github.com/acme/repo"],
    ["https://github.com/acme/repo.git", "github.com/acme/repo"],
    ["https://github.com/acme/repo", "github.com/acme/repo"],
    ["ssh://git@gitlab.com:2222/group/repo.git", "gitlab.com/group/repo"],
    ["https://user:token@bitbucket.org/team/repo.git", "bitbucket.org/team/repo"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });
});

describe("framework and language detection (PRD 19)", () => {
  it("detects Next.js ahead of React", async () => {
    const root = makeProject({
      name: "nextapp",
      files: {
        "package.json": JSON.stringify({ name: "nextapp", dependencies: { next: "14.0.0", react: "18.2.0" } }),
        "tsconfig.json": "{}",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "src/app/page.tsx": "export default function Page() { return null; }\n",
      },
    });

    const devmemory = makeDevMemory();
    try {
      const result = await devmemory.connect({ explicitRoot: root, index: false });
      expect(result.detection.framework).toBe("Next.js");
      expect(result.detection.frameworks).toContain("React");
      expect(result.detection.languages).toContain("TypeScript");
      expect(result.detection.packageManager).toBe("pnpm");
    } finally {
      devmemory.close();
    }
  });

  it("detects a Django project", async () => {
    const root = makeProject({
      name: "django",
      files: { "manage.py": "#!/usr/bin/env python\n", "requirements.txt": "Django==5.0\n" },
    });

    const devmemory = makeDevMemory();
    try {
      const result = await devmemory.connect({ explicitRoot: root, index: false });
      expect(result.detection.framework).toBe("Django");
      expect(result.detection.languages).toContain("Python");
    } finally {
      devmemory.close();
    }
  });
});
