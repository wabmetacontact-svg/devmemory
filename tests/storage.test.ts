import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DatabaseManager,
  INDEX_MIGRATIONS,
  REGISTRY_MIGRATIONS,
  migrate,
  nodeSqliteDriver,
} from "@samirthakur024/storage";
import { defaultConfig, homeLayout, loadConfig, saveConfig } from "@samirthakur024/shared";
import { cleanupAll, makeDevMemory, makeHome, makeProject } from "./helpers.js";

afterAll(cleanupAll);

describe("storage layer (PRD 14)", () => {
  it("creates the global layout under a single home directory (PRD 7)", async () => {
    const home = makeHome("layout");
    const devmemory = makeDevMemory(home);
    try {
      devmemory.databases.openRegistry();
      const layout = homeLayout(home);

      expect(fs.existsSync(layout.registryDb)).toBe(true);
      expect(fs.existsSync(layout.projectsDir)).toBe(true);
      expect(fs.existsSync(layout.logsDir)).toBe(true);
    } finally {
      devmemory.close();
    }
  });

  it("applies migrations once and is safe to re-run", async () => {
    const db = nodeSqliteDriver.open(":memory:");
    try {
      const first = migrate(db, REGISTRY_MIGRATIONS);
      const second = migrate(db, REGISTRY_MIGRATIONS);

      expect(first).toBe(REGISTRY_MIGRATIONS.length);
      expect(second).toBe(first);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get<{ n: number }>()?.n).toBe(
        REGISTRY_MIGRATIONS.length,
      );
    } finally {
      db.close();
    }
  });

  it("rolls a failed transaction back", async () => {
    const db = nodeSqliteDriver.open(":memory:");
    try {
      migrate(db, INDEX_MIGRATIONS);
      expect(() =>
        db.transaction(() => {
          db.prepare("INSERT INTO meta (key, value) VALUES ('a', 'b')").run();
          throw new Error("boom");
        }),
      ).toThrowError("boom");

      expect(db.prepare("SELECT COUNT(*) AS n FROM meta").get<{ n: number }>()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("reopens existing data after a restart (AC-16)", async () => {
    const home = makeHome("restart");
    const project = makeProject({ name: "restartable", remote: "git@github.com:acme/restartable.git" });

    const first = makeDevMemory(home);
    const connected = (await first.connect({ explicitRoot: project })).project;
    const filesBefore = first.filesFor(connected.projectId).stats(connected.projectId).files;
    first.close();

    const second = makeDevMemory(home);
    try {
      const reopened = second.registry.get(connected.projectId);
      expect(reopened?.name).toBe("restartable");
      expect(second.filesFor(connected.projectId).stats(connected.projectId).files).toBe(filesBefore);
    } finally {
      second.close();
    }
  });

  it("survives a corrupt config file by falling back to defaults (PRD 60)", async () => {
    const home = makeHome("corruptconfig");
    const layout = homeLayout(home);
    fs.mkdirSync(layout.root, { recursive: true });
    fs.writeFileSync(layout.configFile, "{ not json", "utf8");

    const config = loadConfig(home);
    expect(config.indexing.maxFiles).toBe(defaultConfig().indexing.maxFiles);
  });

  it("round-trips configuration", async () => {
    const home = makeHome("config");
    const config = defaultConfig();
    config.logLevel = "debug";
    config.indexing.maxFileSizeBytes = 4096;
    saveConfig(config, home);

    const loaded = loadConfig(home);
    expect(loaded.logLevel).toBe("debug");
    expect(loaded.indexing.maxFileSizeBytes).toBe(4096);
  });

  it("uses the configured driver name for diagnostics", async () => {
    const manager = new DatabaseManager({ home: makeHome("driver") });
    try {
      expect(manager.driver.name).toBe("node:sqlite");
      expect(path.basename(manager.layout.registryDb)).toBe("registry.db");
    } finally {
      manager.closeAll();
    }
  });
});

describe("project registry (PRD 10)", () => {
  it("supports connect, rename, disconnect, list and remove", async () => {
    const devmemory = makeDevMemory();
    try {
      const root = makeProject({ name: "registry", remote: "git@github.com:acme/registry.git" });
      const connected = (await devmemory.connect({ explicitRoot: root, index: false })).project;

      expect(devmemory.listProjects()).toHaveLength(1);
      expect(devmemory.registry.findByPath(root)?.projectId).toBe(connected.projectId);

      const renamed = devmemory.rename(connected.projectId, "Renamed Project");
      expect(renamed.name).toBe("Renamed Project");

      const disconnected = devmemory.disconnect(connected.projectId);
      expect(disconnected.status).toBe("disconnected");
      expect(devmemory.registry.list({ status: "active" })).toHaveLength(0);

      // Reconnecting keeps the id and restores active status.
      const reconnected = await devmemory.connect({ explicitRoot: root, index: false });
      expect(reconnected.project.projectId).toBe(connected.projectId);
      expect(reconnected.project.status).toBe("active");
      expect(reconnected.project.name).toBe("Renamed Project");

      devmemory.remove(connected.projectId);
      expect(devmemory.listProjects()).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });

  it("rejects operations on unknown projects", async () => {
    const devmemory = makeDevMemory();
    try {
      expect(() => devmemory.rename("proj_aaaaaaaaaa", "x")).toThrowError(/unknown project/);
      expect(() => devmemory.remove("proj_aaaaaaaaaa")).toThrowError(/unknown project/);
      expect(() => devmemory.status("proj_aaaaaaaaaa")).toThrowError(/unknown project/);
    } finally {
      devmemory.close();
    }
  });

  it("does not auto-connect when the caller forbids it", async () => {
    const devmemory = makeDevMemory();
    try {
      const root = makeProject({ name: "noauto" });
      await expect(devmemory.requireProject({ explicitRoot: root, autoConnect: false })).rejects.toThrowError(
        /no DevMemory project is connected/,
      );
      expect(devmemory.listProjects()).toHaveLength(0);
    } finally {
      devmemory.close();
    }
  });
});
