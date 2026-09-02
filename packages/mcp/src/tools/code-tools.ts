import { z } from "zod";
import type { StoredSymbol } from "@samirthakur024/indexer";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

const SYMBOL_TYPES = [
  "function",
  "class",
  "method",
  "interface",
  "type",
  "enum",
  "constant",
  "variable",
  "component",
  "hook",
  "route",
  "property",
] as const;

function compact(symbol: StoredSymbol) {
  return {
    name: symbol.name,
    qualified_name: symbol.qualifiedName,
    type: symbol.type,
    path: symbol.path,
    lines: [symbol.lineStart, symbol.lineEnd],
    exported: symbol.exported,
    signature: symbol.signature,
  };
}

const findSymbol = defineTool({
  name: "find_symbol",
  title: "Find symbol",
  description:
    "Locate a function, class, method, interface, type, React component, hook or route by name. " +
    "Falls back to substring matching. Use this before opening files - it returns exact locations, not file contents.",
  permission: "READ",
  inputShape: {
    name: z.string().min(1).describe("Symbol name, e.g. 'AuthService' or 'AuthService.login'."),
    type: z.enum(SYMBOL_TYPES).optional().describe("Restrict to one symbol kind."),
    exported_only: z.boolean().optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const symbols = context.devmemory.codeIntelligence(project.projectId).findSymbols(String(input.name), {
      ...(typeof input.type === "string" ? { type: input.type } : {}),
      ...(input.exported_only === true ? { exportedOnly: true } : {}),
      limit: typeof input.limit === "number" ? input.limit : 25,
    });

    return {
      project_id: project.projectId,
      query: input.name,
      count: symbols.length,
      symbols: symbols.map(compact),
    };
  },
});

const getDefinition = defineTool({
  name: "get_definition",
  title: "Get definition",
  description:
    "Return the source of the best-matching definition for a name, with its file and line range. " +
    "Cheaper than reading the whole file; secrets are redacted.",
  permission: "READ",
  inputShape: {
    name: z.string().min(1),
    max_lines: z.number().int().min(1).max(1000).optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const definition = context.devmemory.codeIntelligence(project.projectId).getDefinition(String(input.name), {
      ...(typeof input.max_lines === "number" ? { maxLines: input.max_lines } : {}),
    });

    if (!definition) {
      return { project_id: project.projectId, name: input.name, found: false };
    }

    return {
      project_id: project.projectId,
      found: true,
      ...compact(definition.symbol),
      source: definition.source,
      truncated: definition.truncated,
      token_estimate: definition.tokenEstimate,
    };
  },
});

const findReferences = defineTool({
  name: "find_references",
  title: "Find references",
  description:
    "Every place a symbol is called, extended, implemented, decorated or used as a JSX component, grouped by file.",
  permission: "READ",
  inputShape: {
    name: z.string().min(1),
    project_id: z.string().optional(),
    root: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const groups = context.devmemory
      .codeIntelligence(project.projectId)
      .findReferences(String(input.name), typeof input.limit === "number" ? input.limit : 100);

    return {
      project_id: project.projectId,
      name: input.name,
      files: groups.length,
      total: groups.reduce((sum, group) => sum + group.references.length, 0),
      results: groups,
    };
  },
});

const getRelatedCode = defineTool({
  name: "get_related_code",
  title: "Get related code",
  description:
    "The neighbourhood of a file: its symbols, what it imports, what imports it, and its tests. " +
    "This is the fastest way to assemble the context needed to change a file.",
  permission: "READ",
  inputShape: {
    path: z.string().min(1).describe("Project-relative file path, e.g. 'src/auth/AuthService.ts'."),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const related = context.devmemory.codeIntelligence(project.projectId).relatedCode(String(input.path));

    return {
      project_id: project.projectId,
      path: related.path,
      symbols: related.symbols.map(compact),
      imports: related.imports.map((entry) => ({
        specifier: entry.specifier,
        kind: entry.kind,
        resolved: entry.resolvedPath,
        external: entry.isExternal,
        package: entry.packageName,
      })),
      dependencies: related.dependencies,
      dependents: related.dependents,
      tests: related.tests,
    };
  },
});

const impactAnalysis = defineTool({
  name: "impact_analysis",
  title: "Impact analysis",
  description:
    "What could break if this file changes: its exported symbols, the files that import it directly, " +
    "the transitive blast radius, the tests that cover it, and - when the project belongs to a " +
    "workspace - the code in other repositories that calls its HTTP routes. Nothing imports across a " +
    "network boundary, so http_callers is the part no dependency graph can tell you.",
  permission: "READ",
  inputShape: {
    path: z.string().min(1),
    depth: z.number().int().min(1).max(10).optional().describe("How far to follow the dependency graph. Default 3."),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const impact = context.devmemory.impact(project.projectId, String(input.path), {
      ...(typeof input.depth === "number" ? { depth: input.depth } : {}),
    });

    const httpCallers = impact.http.routesServed.map((route) => ({
      route: `${route.method ?? "ANY"} ${route.path}`,
      called_by: route.calledBy.map((site) => `${site.project} ${site.path}:${site.line}`),
    }));
    const httpDependencies = impact.http.routesCalled.map((route) => ({
      route: `${route.method ?? "ANY"} ${route.path}`,
      served_by: route.servedBy.map((site) => `${site.project} ${site.path}:${site.line}`),
      ...(route.unmatched ? { warning: "no route in scope serves this call" } : {}),
    }));

    return {
      project_id: project.projectId,
      path: impact.path,
      exported_symbols: impact.exportedSymbols.map((symbol) => symbol.name),
      direct_dependents: impact.direct,
      transitive_dependents: impact.transitive,
      affected_tests: impact.tests,
      total_affected: impact.direct.length + impact.transitive.length,
      depth: impact.depth,
      truncated: impact.truncated,
      http_scope: impact.httpScope,
      // Callers reached over HTTP, which no import edge connects to this file.
      http_callers: httpCallers,
      http_dependencies: httpDependencies,
      ...(httpCallers.length > 0
        ? {
            warning:
              `This file serves ${httpCallers.length} route(s) called from other code. ` +
              "Changing a path, method or response shape breaks those callers with no compile error.",
          }
        : {}),
    };
  },
});

const affectedTests = defineTool({
  name: "affected_tests",
  title: "Affected tests",
  description:
    "Test files reachable from the given source files through the dependency graph. " +
    "Use it to run the smallest useful test selection after a change.",
  permission: "READ",
  inputShape: {
    paths: z.array(z.string().min(1)).min(1).max(100).describe("Project-relative source paths that changed."),
    depth: z.number().int().min(1).max(10).optional(),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const paths = (input.paths as string[]) ?? [];
    const tests = context.devmemory.codeIntelligence(project.projectId).affectedTests(paths, {
      ...(typeof input.depth === "number" ? { depth: input.depth } : {}),
    });

    return { project_id: project.projectId, changed: paths, tests, count: tests.length };
  },
});

export const CODE_TOOLS: ToolDefinition[] = [
  findSymbol,
  getDefinition,
  findReferences,
  getRelatedCode,
  impactAnalysis,
  affectedTests,
] as ToolDefinition[];
