import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanupAll, makeDevMemory, makeProject } from "./helpers.js";
import type { DevMemory } from "@samirthakur024/core";

afterAll(cleanupAll);

/** Roughly the shape of a real application: modules, services, components, tests. */
const MODULES = 40;
const FILES_PER_MODULE = 20;
const TOTAL_FILES = MODULES * FILES_PER_MODULE;

function sourceFile(moduleIndex: number, fileIndex: number): string {
  const dependency = fileIndex === 0 ? "" : `import { Service${moduleIndex}_${fileIndex - 1} } from "./Service${moduleIndex}_${fileIndex - 1}";\n`;
  const crossModule = moduleIndex > 0 && fileIndex === 0
    ? `import { Service${moduleIndex - 1}_0 } from "../module${moduleIndex - 1}/Service${moduleIndex - 1}_0";\n`
    : "";

  const methods = Array.from({ length: 8 }, (_, index) =>
    `  method${index}(input: string): string {\n` +
    `    const value = input.trim().toLowerCase();\n` +
    `    if (!value) return "";\n` +
    `    return value.repeat(${index + 1});\n` +
    "  }\n",
  ).join("\n");

  return (
    `${dependency}${crossModule}\n` +
    `export interface Options${moduleIndex}_${fileIndex} {\n  id: string;\n  retries: number;\n}\n\n` +
    `export const DEFAULT_${moduleIndex}_${fileIndex} = { id: "x", retries: 3 };\n\n` +
    `export class Service${moduleIndex}_${fileIndex} {\n` +
    `  constructor(private readonly options: Options${moduleIndex}_${fileIndex} = DEFAULT_${moduleIndex}_${fileIndex}) {}\n\n` +
    `${methods}` +
    "}\n"
  );
}

function buildLargeProject(): { root: string; lines: number } {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "large", dependencies: { express: "4.18.0" } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
  };

  let lines = 0;
  for (let moduleIndex = 0; moduleIndex < MODULES; moduleIndex++) {
    for (let fileIndex = 0; fileIndex < FILES_PER_MODULE; fileIndex++) {
      const content = sourceFile(moduleIndex, fileIndex);
      lines += content.split("\n").length;
      files[`src/module${moduleIndex}/Service${moduleIndex}_${fileIndex}.ts`] = content;
    }
  }

  return { root: makeProject({ name: "large", files, commit: false, git: false }), lines };
}

async function time<T>(label: string, work: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const started = Date.now();
  const value = await work();
  const ms = Date.now() - started;
  process.stdout.write(`      ${label.padEnd(34)} ${ms} ms\n`);
  return { ms, value };
}

describe("performance on a large project (PRD 59)", () => {
  let devmemory: DevMemory;
  let projectId: string;
  let root: string;
  let lines: number;

  beforeAll(async () => {
    const project = buildLargeProject();
    root = project.root;
    lines = project.lines;
    devmemory = makeDevMemory();
    process.stdout.write(`\n      project: ${TOTAL_FILES} files, ~${lines} lines\n`);

    const connected = await time("full index (cold)", () => devmemory.connect({ explicitRoot: root }));
    projectId = connected.value.project.projectId;

    expect(connected.value.index?.scanned).toBe(TOTAL_FILES + 2);
    expect(connected.ms).toBeLessThan(120_000);
  }, 180_000);

  afterAll(() => {
    devmemory?.close();
  });

  it("indexed everything it should have", () => {
    const stats = devmemory.filesFor(projectId).stats(projectId);
    const code = devmemory.codeFor(projectId).stats(projectId);

    expect(stats.files).toBe(TOTAL_FILES + 2);
    expect(code.symbols).toBeGreaterThan(TOTAL_FILES * 8);
    expect(code.internalEdges).toBeGreaterThan(TOTAL_FILES / 2);
  });

  it("re-indexing an unchanged project reads and parses nothing", async () => {
    const result = await time("re-index (no changes)", () => devmemory.index(projectId));

    expect(result.value.unchanged).toBe(TOTAL_FILES + 2);
    expect(result.value.added).toBe(0);
    expect(result.value.updated).toBe(0);
    // The property that matters more than the clock: no file was re-parsed.
    expect(result.value.parsed).toBe(0);
    expect(result.ms).toBeLessThan(20_000);
  });

  it("one changed file costs one file of work (PRD 59)", async () => {
    fs.writeFileSync(
      path.join(root, "src/module5/Service5_5.ts"),
      "export class Service5_5 {\n  renamed(input: string) {\n    return input;\n  }\n}\n",
      "utf8",
    );

    const result = await time("re-index (one file changed)", () => devmemory.index(projectId));

    expect(result.value.updated).toBe(1);
    expect(result.value.parsed).toBe(1);
    expect(result.value.unchanged).toBe(TOTAL_FILES + 1);
    expect(result.ms).toBeLessThan(15_000);
    expect(devmemory.codeFor(projectId).findSymbols(projectId, { name: "renamed" })).toHaveLength(1);
  });

  it("a watcher-style single-file pass touches only that file", async () => {
    fs.writeFileSync(
      path.join(root, "src/module9/Service9_9.ts"),
      "export class Service9_9 {\n  touched() {\n    return true;\n  }\n}\n",
      "utf8",
    );

    const result = await time("single-file pass", () =>
      devmemory.index(projectId, { only: ["src/module9/Service9_9.ts"] }),
    );

    expect(result.value.scanned).toBe(1);
    expect(result.value.parsed).toBe(1);
    expect(result.ms).toBeLessThan(5000);
  });

  it("assembles context inside a token budget, quickly", async () => {
    const engine = devmemory.contextEngine(projectId);
    const first = await time("context (cold)", () => engine.getContext({ task: "fix Service5_5 method3 handling" }));
    const second = await time("context (cached)", () => engine.getContext({ task: "fix Service5_5 method3 handling" }));

    expect(first.value.cache).toBe("miss");
    expect(first.value.tokenEstimate).toBeLessThanOrEqual(first.value.budget);
    expect(first.value.filesAvoided).toBeGreaterThan(TOTAL_FILES / 2);
    expect(first.ms).toBeLessThan(10_000);

    expect(second.value.cache).toBe("hit");
    expect(second.ms).toBeLessThan(2000);
  });

  it("searches the whole project in well under a second of work", async () => {
    const engine = devmemory.contextEngine(projectId);
    const result = await time("search", () => engine.searchContext("service method repeat"));

    expect(result.value.length).toBeGreaterThan(0);
    expect(result.ms).toBeLessThan(5000);
  });

  it("answers graph questions without walking the whole project", async () => {
    const code = devmemory.codeIntelligence(projectId);
    const result = await time("impact analysis", () => code.impact("src/module0/Service0_0.ts", { depth: 3 }));

    expect(result.value.direct.length).toBeGreaterThan(0);
    expect(result.ms).toBeLessThan(5000);
  });
});
