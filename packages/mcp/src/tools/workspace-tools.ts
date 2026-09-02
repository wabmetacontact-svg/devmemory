import { z } from "zod";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

const workspaceStatus = defineTool({
  name: "workspace_status",
  title: "Workspace status",
  description:
    "Groups of projects that are worked on together - a mobile app and the backend it calls, say. " +
    "Call this to find out whether the project you are in belongs to a wider workspace; if it does, " +
    "pass that workspace name to get_context and search_context so you see both sides of a change.",
  permission: "READ",
  inputShape: {
    workspace: z.string().optional().describe("Workspace name or id. Omit to list them all."),
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const registry = context.devmemory.workspaces;

    if (typeof input.workspace === "string") {
      const status = context.devmemory.workspaceStatus(input.workspace);
      return {
        workspace: status.workspace,
        projects: status.projects,
        totals: status.totals,
      };
    }

    // No workspace named: report the ones that exist, and flag the current project's.
    const all = registry.list();
    let current: string[] = [];
    try {
      const project = await resolveTarget(context, { ...(input as { root?: string }), auto_connect: false });
      current = registry.forProject(project.projectId).map((workspace) => workspace.name);
    } catch {
      current = [];
    }

    return {
      count: all.length,
      workspaces: all.map((workspace) => ({
        name: workspace.name,
        description: workspace.description,
        projects: workspace.members.length,
      })),
      current_project_belongs_to: current,
    };
  },
});

export const WORKSPACE_TOOLS: ToolDefinition[] = [workspaceStatus] as ToolDefinition[];
