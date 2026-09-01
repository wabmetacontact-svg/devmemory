import { z } from "zod";
import { estimateTokensForBytes } from "@devmemory/shared";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

const findFile = defineTool({
  name: "find_file",
  title: "Find file",
  description:
    "Search the project's file index by path substring. Returns indexed files only, so ignored, binary and sensitive files never appear.",
  permission: "READ",
  inputShape: {
    query: z.string().min(1).describe("Substring of a path or file name, e.g. 'auth/service' or 'webhook'."),
    project_id: z.string().optional(),
    root: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const limit = typeof input.limit === "number" ? input.limit : 25;
    const matches = context.devmemory.filesFor(project.projectId).searchPaths(project.projectId, String(input.query), limit);

    return {
      project_id: project.projectId,
      query: input.query,
      count: matches.length,
      files: matches.map((file) => ({
        path: file.relativePath,
        language: file.language,
        size: file.size,
        token_estimate: estimateTokensForBytes(file.size),
      })),
    };
  },
});

const recentFiles = defineTool({
  name: "recent_files",
  title: "Recently modified files",
  description: "Most recently modified indexed files. A cheap way to see where work is currently happening.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const limit = typeof input.limit === "number" ? input.limit : 15;
    const files = context.devmemory.filesFor(project.projectId).recentlyModified(project.projectId, limit);

    return {
      project_id: project.projectId,
      files: files.map((file) => ({
        path: file.relativePath,
        language: file.language,
        modified: new Date(file.lastModified).toISOString(),
        size: file.size,
      })),
    };
  },
});

export const FILE_TOOLS: ToolDefinition[] = [findFile, recentFiles] as ToolDefinition[];
