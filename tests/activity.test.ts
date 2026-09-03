import { afterAll, describe, expect, it } from "vitest";
import { ProjectWatcher } from "@samirthakur024/core";
import type { WatchEvent } from "@samirthakur024/core";
import { describeCall, describeResult } from "@samirthakur024/mcp";
import { FAKE_SECRETS, cleanupAll, makeDevMemory, makeProject, writeFile } from "./helpers.js";

afterAll(cleanupAll);

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was not met in time");
}

describe("activity summaries", () => {
  it("takes the one field that makes a row readable, never the whole argument", () => {
    expect(describeCall("get_context", { task: "add a field to the template" })).toEqual({
      summary: "add a field to the template",
      instruction: true,
    });
    expect(describeCall("remember", { title: "Route prefixes live in app.ts", content: "long body" }).summary).toBe(
      "Route prefixes live in app.ts",
    );
    // An unknown tool contributes no argument text at all, so a tool added later
    // cannot start leaking its arguments into the feed by default.
    expect(describeCall("some_future_tool", { secret: "value" }).summary).toBe("");
  });

  it("describes a result by its counts, not its payload", () => {
    expect(describeResult("impact_analysis", { direct_dependents: ["a.ts"], http_callers: [{}, {}] })).toBe(
      "1 importers, 2 route(s) called from other projects",
    );
    expect(describeResult("api_contracts", { calls_with_no_route: [] })).toBe("every call reaches a route");
    expect(describeResult("get_context", { files_selected: 4, token_estimate: 900, cache: "hit" })).toBe(
      "4 files, ~900 tokens, hit",
    );
  });
});

describe("activity log", () => {
  it("redacts, orders oldest first, and pages by id", () => {
    const devmemory = makeDevMemory();
    try {
      const log = devmemory.activity;
      log.record({ source: "tool", tool: "remember", summary: "first" });
      log.record({ source: "tool", tool: "recall", summary: `token is ${FAKE_SECRETS.githubToken}` });
      log.record({ source: "file", summary: "src/app.ts" });

      const entries = log.recent();
      expect(entries).toHaveLength(3);
      expect(entries[0]?.summary).toBe("first");

      // A feed row is not a place for a credential to survive.
      const second = entries[1]?.summary ?? "";
      expect(second).not.toContain(FAKE_SECRETS.githubToken);
      expect(second).toContain("token is");

      // `since` returns only what is new - what the dashboard polls with.
      const firstId = entries[0]?.id as number;
      expect(log.recent({ since: firstId }).map((entry) => entry.summary)).toEqual([second, "src/app.ts"]);

      expect(log.summary().find((row) => row.tool === "remember")?.count).toBe(1);
    } finally {
      devmemory.close();
    }
  });

  it("never lets a bad row fail the work it describes", () => {
    const devmemory = makeDevMemory();
    try {
      expect(() => devmemory.activity.record({ source: "tool", summary: "x", durationMs: Number.NaN })).not.toThrow();
    } finally {
      devmemory.close();
    }
  });
});

describe("file activity", () => {
  it("records a file only when its contents actually changed", async () => {
    const root = makeProject({
      name: "touched",
      files: {
        "package.json": JSON.stringify({ name: "touched" }),
        "src/index.ts": "export const value = 1;\n",
      },
    });

    const devmemory = makeDevMemory();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(devmemory, (await devmemory.connect({ explicitRoot: root })).project, {
      debounceMs: 20,
      onEvent: (event) => events.push(event),
    });

    try {
      devmemory.activity.clear();
      watcher.start();

      // Rewriting identical bytes is what an editor save and a Windows metadata
      // touch both look like to a watcher. Neither is a change, and reporting one
      // makes the feed lie about what an instruction did.
      writeFile(root, "src/index.ts", "export const value = 1;\n");
      await waitFor(() => events.length > 0);
      expect(devmemory.activity.recent()).toHaveLength(0);

      writeFile(root, "src/index.ts", "export const value = 2;\n");
      await waitFor(() => devmemory.activity.recent().length > 0);

      const entries = devmemory.activity.recent();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toBe("file");
      expect(entries[0]?.summary).toBe("src/index.ts");
    } finally {
      await watcher.stop();
      devmemory.close();
    }
  });
});
