import { z } from "zod";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";
import type { ProjectRecord } from "@devmemory/shared";

function projectSummary(project: ProjectRecord) {
  return {
    project_id: project.projectId,
    name: project.name,
    root: project.rootPath,
    framework: project.framework,
    languages: project.languages,
    package_manager: project.packageManager,
    repository: project.repositoryUrl,
    identity_source: project.identitySource,
    index_status: project.indexStatus,
    last_indexed_at: project.lastIndexedAt,
  };
}

const projectConnect = defineTool({
  name: "project_connect",
  title: "Connect project",
  description:
    "Identify the current project from the agent workspace and load its persistent DevMemory intelligence. " +
    "Call this once at the start of a session. Nothing is written into the project folder.",
  permission: "WRITE",
  inputShape: {
    root: z.string().optional().describe("Explicit project root. Defaults to the client workspace or cwd."),
    index: z.boolean().optional().describe("Index the project after connecting. Default true."),
    full: z.boolean().optional().describe("Force a full re-index instead of an incremental pass."),
  },
  async handler(input, context) {
    const roots = await context.clientRoots();
    const result = await context.devmemory.connect({
      ...(typeof input.root === "string" ? { explicitRoot: input.root } : {}),
      clientRoots: roots,
      cwd: context.cwd,
      ...(typeof input.index === "boolean" ? { index: input.index } : {}),
      ...(typeof input.full === "boolean" ? { full: input.full } : {}),
    });

    return {
      ...projectSummary(result.project),
      reconnected: result.reconnected,
      moved_from: result.movedFrom,
      git: result.git,
      index: result.index
        ? {
            added: result.index.added,
            updated: result.index.updated,
            unchanged: result.index.unchanged,
            deleted: result.index.deleted,
            skipped: result.index.skipped,
            files_scanned: result.index.scanned,
            files_parsed: result.index.parsed,
            symbols: result.index.symbols,
            duration_ms: result.index.durationMs,
          }
        : null,
    };
  },
});

const projectStatus = defineTool({
  name: "project_status",
  title: "Project status",
  description: "Current project identity, index health, file statistics and git state.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const status = context.devmemory.status(project.projectId);

    return {
      ...projectSummary(status.project),
      files: status.files.files,
      bytes: status.files.bytes,
      languages_by_files: status.files.byLanguage.slice(0, 8),
      code: {
        symbols: status.code.symbols,
        by_type: status.code.byType.slice(0, 8),
        imports: status.code.imports,
        internal_edges: status.code.internalEdges,
        external_packages: status.code.externalPackages,
        files_parsed: status.code.filesParsed,
        parse_errors: status.code.parseErrors,
      },
      memory: {
        active: status.memory.active,
        by_type: status.memory.byType,
        average_importance: status.memory.averageImportance,
      },
      tasks: { open: status.tasks.open, total: status.tasks.total, blocked: status.tasks.blocked },
      sessions: status.sessions.total,
      context_analytics: {
        requests: status.context.requests,
        cache_hit_rate: status.context.hitRate,
        average_tokens: status.context.averageTokens,
        files_avoided: status.context.filesAvoided,
        estimated_tokens_saved: status.context.estimatedTokensSaved,
      },
      security: { files_with_secrets: status.security.files },
      git: status.git,
      index: {
        status: status.index.status,
        last_indexed_at: status.index.lastIndexedAt,
        incomplete: status.index.incomplete,
      },
      storage: status.storagePath,
    };
  },
});

const projectMap = defineTool({
  name: "project_map",
  title: "Project map",
  description:
    "Compact structural overview of the project: directory rollups, languages and entry points. " +
    "Use this instead of listing files when orienting in an unfamiliar project.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const map = context.devmemory.map(project.projectId, limit ? { limit } : {});

    return {
      project_id: map.projectId,
      name: map.name,
      root: map.root,
      framework: map.framework,
      languages: map.languages,
      files: map.files,
      directories: map.directories,
      entry_points: map.entryPoints,
      truncated: map.truncated,
    };
  },
});

const projectList = defineTool({
  name: "project_list",
  title: "List projects",
  description: "All projects known to this DevMemory installation.",
  permission: "READ",
  inputShape: {},
  handler(_input, context) {
    const projects = context.devmemory.listProjects();
    return {
      count: projects.length,
      projects: projects.map((project) => ({
        project_id: project.projectId,
        name: project.name,
        root: project.rootPath,
        framework: project.framework,
        status: project.status,
        last_seen_at: project.lastSeenAt,
      })),
    };
  },
});

const projectIndex = defineTool({
  name: "project_index",
  title: "Refresh project index",
  description:
    "Bring the file index up to date. Incremental by default: unchanged files are not re-read.",
  permission: "WRITE",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
    full: z.boolean().optional().describe("Rebuild the index from scratch."),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const stats = await context.devmemory.index(project.projectId, { full: input.full === true });

    return {
      project_id: project.projectId,
      full_rebuild: stats.fullRebuild,
      files_scanned: stats.scanned,
      added: stats.added,
      updated: stats.updated,
      unchanged: stats.unchanged,
      deleted: stats.deleted,
      skipped: stats.skipped,
      parsed: stats.parsed,
      symbols: stats.symbols,
      parse_errors: stats.parseErrors,
      duration_ms: stats.durationMs,
    };
  },
});

const projectForget = defineTool({
  name: "project_forget",
  title: "Forget project",
  description:
    "Permanently delete a project's DevMemory intelligence. Requires confirm=true. The project's own files are never touched.",
  permission: "DESTRUCTIVE",
  inputShape: {
    project_id: z.string().describe("Project to forget. Explicit id is required for this destructive operation."),
    confirm: z.boolean().describe("Must be true. Guards against accidental deletion (PRD 38)."),
  },
  handler(input, context) {
    if (input.confirm !== true) {
      return {
        error: {
          code: "PERMISSION_DENIED",
          message: "project_forget requires confirm=true",
        },
      };
    }
    const projectId = String(input.project_id);
    const project = context.devmemory.registry.get(projectId);
    context.devmemory.remove(projectId);
    return { removed: true, project_id: projectId, name: project?.name ?? null };
  },
});

export const PROJECT_TOOLS: ToolDefinition[] = [
  projectConnect,
  projectStatus,
  projectMap,
  projectList,
  projectIndex,
  projectForget,
] as ToolDefinition[];
