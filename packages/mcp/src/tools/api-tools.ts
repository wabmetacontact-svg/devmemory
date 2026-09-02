import { z } from "zod";
import { callersOf } from "@samirthakur024/core";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

const apiContracts = defineTool({
  name: "api_contracts",
  title: "HTTP contracts between projects",
  description:
    "Which HTTP routes exist, which code calls them, and which calls reach nothing. " +
    "Import analysis stops at the network boundary, so this is the only way to see that a " +
    "mobile screen depends on an Express handler in another repository. Pass a workspace " +
    "name to span every project in it. Call this before renaming, moving or deleting a route.",
  permission: "READ",
  inputShape: {
    scope: z
      .string()
      .optional()
      .describe("Workspace or project name. Defaults to the current project's workspace."),
    path: z
      .string()
      .optional()
      .describe('One route, to list just its callers, e.g. "inbox/conversations/{}/messages".'),
    include: z
      .enum(["problems", "all"])
      .default("problems")
      .describe("problems: calls with no route. all: adds linked and uncalled routes."),
    limit: z.number().int().min(1).max(200).default(50),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const scope = await resolveScope(input, context);
    const report = context.devmemory.apiContracts(scope);

    if (typeof input.path === "string" && input.path.length > 0) {
      const callers = callersOf(report, input.path.replace(/^\/+/, ""));
      return {
        scope: report.scope,
        path: input.path,
        callers,
        note:
          callers.length === 0
            ? "No caller found in this scope. The route may be called from a project that is not a member."
            : `${callers.length} call site(s) would be affected by changing this route.`,
      };
    }

    const limit = typeof input.limit === "number" ? input.limit : 50;
    const problems = {
      scope: report.scope,
      totals: report.totals,
      external_calls_ignored: report.externalCalls,
      calls_with_no_route: report.unmatchedCalls.slice(0, limit).map(describe),
      note:
        "calls_with_no_route lists client calls whose path matches no route in scope. " +
        "A route registered dynamically, or served by a project outside this scope, will " +
        "appear here without being a defect - confirm before changing anything.",
    };

    if (input.include !== "all") return problems;

    return {
      ...problems,
      linked: report.linked.slice(0, limit).map(describe),
      routes_never_called: report.unusedRoutes.slice(0, limit).map(describe),
    };
  },
});

function describe(link: {
  method: string | null;
  canonical: string;
  providers: Array<{ project: string; path: string; line: number }>;
  consumers: Array<{ project: string; path: string; line: number }>;
}): Record<string, unknown> {
  return {
    method: link.method ?? "ANY",
    path: `/${link.canonical}`,
    served_by: link.providers.map((site) => `${site.project} ${site.path}:${site.line}`),
    called_by: link.consumers.map((site) => `${site.project} ${site.path}:${site.line}`),
  };
}

/** An explicit scope wins; otherwise the current project's workspace, else itself. */
async function resolveScope(
  input: { scope?: string; root?: string; project_id?: string },
  context: Parameters<Parameters<typeof defineTool>[0]["handler"]>[1],
): Promise<string> {
  if (typeof input.scope === "string" && input.scope.length > 0) return input.scope;

  const project = await resolveTarget(context, { ...input, auto_connect: false });
  const workspaces = context.devmemory.workspaces.forProject(project.projectId);
  return workspaces[0]?.name ?? project.name;
}

export const API_TOOLS: ToolDefinition[] = [apiContracts] as ToolDefinition[];
