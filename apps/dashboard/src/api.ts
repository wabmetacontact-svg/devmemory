import { DevMemoryError, loadConfig } from "@samirthakur024/shared";
import type { DevMemory, MemoryType, TaskStatus } from "@samirthakur024/core";

export interface ApiRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

type Handler = (devmemory: DevMemory, request: ApiRequest) => ApiResponse | Promise<ApiResponse>;

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const notFound = (message: string): ApiResponse => ({ status: 404, body: { error: { code: "NOT_FOUND", message } } });

/**
 * The dashboard's JSON API. Every route reads the same DevMemory facade the MCP
 * server and CLI use, so the three surfaces can never drift apart (PRD 41).
 */
export async function handleApi(devmemory: DevMemory, request: ApiRequest): Promise<ApiResponse> {
  const [head, ...rest] = request.segments;

  try {
    if (head === "overview" && request.method === "GET") return overview(devmemory);
    if (head === "settings" && request.method === "GET") return settings(devmemory);

    if (head === "workspaces") {
      const [name, section] = rest;
      if (!name) return request.method === "GET" ? workspaces(devmemory) : notFound("unknown route");
      if (request.method !== "GET") return notFound("unknown route");

      if (section === "api") return ok(devmemory.apiContracts(name));
      if (section === "context") {
        const task = request.query.get("task") ?? "";
        if (!task) return { status: 400, body: { error: { code: "INVALID_INPUT", message: "task is required" } } };
        return ok(devmemory.workspaceContext(name, { task, maxTokens: Number(request.query.get("tokens") ?? 6000) }));
      }
      if (section === "search") {
        const query = request.query.get("q") ?? "";
        return ok({ results: query ? devmemory.workspaceSearch(name, query, 30) : [] });
      }
      if (!section) return ok(devmemory.workspaceStatus(name));
      return notFound(`unknown route: /api/workspaces/${name}/${section}`);
    }

    if (head === "projects") {
      const [projectId, section, itemId] = rest;
      if (!projectId) {
        if (request.method === "GET") return projects(devmemory);
        return notFound("unknown route");
      }

      const project = devmemory.registry.get(projectId);
      if (!project) return notFound(`unknown project: ${projectId}`);

      const route = `${request.method} ${section ?? ""}`;
      const handler = PROJECT_ROUTES[route];
      if (!handler) return notFound(`unknown route: ${request.method} /api/projects/:id/${section ?? ""}`);

      return await handler(devmemory, { ...request, segments: [projectId, section ?? "", itemId ?? ""] });
    }

    return notFound("unknown route");
  } catch (error) {
    if (error instanceof DevMemoryError) {
      return { status: error.code === "PERMISSION_DENIED" ? 403 : 400, body: error.toJSON() };
    }
    return {
      status: 500,
      body: { error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } },
    };
  }
}

/** PRD 43: the numbers a developer wants on opening the dashboard. */
function overview(devmemory: DevMemory): ApiResponse {
  const projects = devmemory.listProjects();
  let files = 0;
  let symbols = 0;
  let memories = 0;
  let openTasks = 0;
  let knownIssues = 0;
  let sessions = 0;

  for (const project of projects) {
    if (project.status !== "active") continue;
    try {
      files += devmemory.filesFor(project.projectId).stats(project.projectId).files;
      symbols += devmemory.codeFor(project.projectId).stats(project.projectId).symbols;
      memories += devmemory.memoryFor(project.projectId).stats().active;
      const taskStats = devmemory.tasksFor(project.projectId).stats();
      openTasks += taskStats.open;
      knownIssues += taskStats.blocked + devmemory.memoryFor(project.projectId).list({ type: "BUG" }).length;
      sessions += devmemory.sessionsFor(project.projectId).stats().total;
    } catch {
      // A project whose storage is unavailable must not break the overview.
    }
  }

  return ok({
    projects: projects.length,
    active_projects: projects.filter((project) => project.status === "active").length,
    files,
    symbols,
    memories,
    open_tasks: openTasks,
    known_issues: knownIssues,
    sessions,
    recent: projects.slice(0, 5).map(summary),
  });
}

function projects(devmemory: DevMemory): ApiResponse {
  return ok({ projects: devmemory.listProjects().map(summary) });
}

function workspaces(devmemory: DevMemory): ApiResponse {
  const known = devmemory.listProjects();
  return ok({
    workspaces: devmemory.workspaces.list().map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      projects: workspace.members.map((member) => {
        const project = known.find((candidate) => candidate.projectId === member.projectId);
        return project
          ? { role: member.role, ...summary(project) }
          : { role: member.role, projectId: member.projectId, name: member.projectId };
      }),
    })),
  });
}

const PROJECT_ROUTES: Record<string, Handler> = {
  "GET ": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const status = devmemory.status(projectId);
    return ok({
      ...summary(status.project),
      files: status.files,
      code: status.code,
      memory: status.memory,
      tasks: status.tasks,
      sessions: status.sessions,
      context: status.context,
      security: status.security,
      git: status.git,
      index: status.index,
      storage: status.storagePath,
    });
  },

  "POST index": async (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const full = request.body?.full === true;
    return ok({ stats: await devmemory.index(projectId, { full }) });
  },

  "GET memory": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const type = request.query.get("type");
    const query = request.query.get("q");
    const memories = query
      ? devmemory.memoryFor(projectId).recall({ query, limit: 50 })
      : devmemory.memoryFor(projectId).list({
          ...(type ? { type: type as MemoryType } : {}),
          ...(request.query.get("archived") === "true" ? { status: "archived" as const } : {}),
          limit: 100,
        });
    return ok({ memories });
  },

  "POST memory": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const body = request.body ?? {};
    const result = devmemory.memoryFor(projectId).remember({
      type: String(body.type ?? "FACT") as MemoryType,
      title: String(body.title ?? ""),
      content: String(body.content ?? ""),
      ...(typeof body.importance === "number" ? { importance: body.importance } : {}),
      ...(Array.isArray(body.paths) ? { paths: body.paths as string[] } : {}),
      ...(typeof body.reason === "string" ? { decision: { reason: body.reason } } : {}),
      source: "dashboard",
    });
    return ok({ memory: result.memory, reinforced: result.deduplicated });
  },

  "DELETE memory": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const memoryId = request.segments[2];
    if (!memoryId) return notFound("memory id is required");
    return ok(devmemory.memoryFor(projectId).forget(memoryId, { hard: request.query.get("hard") === "true" }));
  },

  "GET tasks": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const status = request.query.get("status");
    const tasks = devmemory.tasksFor(projectId);
    return ok({
      current: tasks.current(),
      stats: tasks.stats(),
      tasks: status ? tasks.list({ status: status as TaskStatus, limit: 100 }) : tasks.list({ limit: 100 }),
    });
  },

  "POST tasks": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const body = request.body ?? {};
    const task = devmemory.tasksFor(projectId).create({
      title: String(body.title ?? ""),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(Array.isArray(body.requirements) ? { requirements: body.requirements as string[] } : {}),
      ...(typeof body.status === "string" ? { status: body.status as TaskStatus } : {}),
      agent: "dashboard",
    });
    return ok({ task });
  },

  "PATCH tasks": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const taskKey = request.segments[2];
    if (!taskKey) return notFound("task key is required");
    const body = request.body ?? {};

    const task = devmemory.tasksFor(projectId).update(taskKey, {
      ...(typeof body.status === "string" ? { status: body.status as TaskStatus } : {}),
      ...(Array.isArray(body.complete_requirements) ? { completeRequirements: body.complete_requirements as string[] } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
      agent: "dashboard",
    });
    return ok({ task });
  },

  "GET sessions": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    return ok({ sessions: devmemory.sessionsFor(projectId).list(30) });
  },

  "GET handoff": (devmemory, request) => ok(devmemory.handoff(request.segments[0] as string)),

  /** PRD 47: what changed, from git plus the index. */
  "GET changes": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const project = devmemory.registry.get(projectId);
    if (!project) return notFound(`unknown project: ${projectId}`);

    const isGit = project.repositoryType === "git" && devmemory.git.isAvailable();
    return ok({
      git: isGit ? devmemory.gitSummary(project) : null,
      status: isGit ? devmemory.git.status(project.rootPath).files : [],
      commits: isGit ? devmemory.git.log(project.rootPath, { limit: 20 }) : [],
      recent_files: devmemory
        .filesFor(projectId)
        .recentlyModified(projectId, 20)
        .map((file) => ({ path: file.relativePath, modified: new Date(file.lastModified).toISOString() })),
    });
  },

  "GET search": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const query = request.query.get("q") ?? "";
    if (query.trim().length < 2) return ok({ query, results: [], memories: [], tasks: [] });

    return ok({
      query,
      results: devmemory.contextEngine(projectId).searchContext(query, 20),
      memories: devmemory.memoryFor(projectId).recall({ query, limit: 5 }),
      tasks: devmemory.tasksFor(projectId).search(query, 5),
    });
  },

  "GET analytics": (devmemory, request) => ok(devmemory.contextCacheFor(request.segments[0] as string).analytics()),

  /** PRD 48: the dependency neighbourhood of one file. */
  "GET graph": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const filePath = request.query.get("path");
    const code = devmemory.codeFor(projectId);

    if (!filePath) {
      const files = devmemory.filesFor(projectId).list(projectId, { limit: 400 });
      return ok({
        files: files
          .filter((file) => file.language !== null)
          .map((file) => ({
            path: file.relativePath,
            language: file.language,
            dependencies: code.dependencies(projectId, file.relativePath).length,
            dependents: code.dependents(projectId, file.relativePath).length,
          }))
          .sort((a, b) => b.dependents - a.dependents)
          .slice(0, 60),
      });
    }

    return ok({
      path: filePath,
      symbols: code.symbolsInFile(projectId, filePath, 100),
      dependencies: code.dependencies(projectId, filePath),
      dependents: code.dependents(projectId, filePath),
      imports: code.importsOf(projectId, filePath),
    });
  },

  /**
   * Everything known about one file, in a single request: what it defines, what it
   * depends on, who depends on it, what breaks if it changes, and its git history.
   * This is what the dashboard's file view is built from.
   */
  "GET file": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const filePath = request.query.get("path");
    if (!filePath) return notFound("path query parameter is required");

    const project = devmemory.registry.get(projectId);
    const record = devmemory.filesFor(projectId).get(projectId, filePath);
    if (!project || !record || record.status !== "active") return notFound(`file is not indexed: ${filePath}`);

    const code = devmemory.codeFor(projectId);
    const intelligence = devmemory.codeIntelligence(projectId);

    let impact: ReturnType<typeof intelligence.impact> | null = null;
    try {
      impact = intelligence.impact(filePath, { depth: 3 });
    } catch {
      impact = null;
    }

    const isGit = project.repositoryType === "git" && devmemory.git.isAvailable();
    const history = isGit ? devmemory.git.log(project.rootPath, { limit: 10, file: filePath }) : [];

    return ok({
      path: record.relativePath,
      // Forward-slashed: editor URIs (vscode://file/...) need it on every platform.
      absolute_path: record.path.replace(/\\/g, "/"),
      language: record.language,
      size: record.size,
      last_modified: new Date(record.lastModified).toISOString(),
      indexed_at: record.indexedAt,
      symbols: code.symbolsInFile(projectId, filePath, 200),
      imports: code.importsOf(projectId, filePath),
      dependencies: code.dependencies(projectId, filePath),
      dependents: code.dependents(projectId, filePath),
      impact: impact
        ? {
            direct: impact.direct,
            transitive: impact.transitive,
            tests: impact.tests,
            exported_symbols: impact.exportedSymbols.map((symbol) => symbol.name),
            total: impact.direct.length + impact.transitive.length,
          }
        : null,
      history: history.map((commit) => ({
        hash: commit.shortHash,
        subject: commit.subject,
        author: commit.author,
        date: commit.date,
      })),
      memories: devmemory.memoryFor(projectId).recall({ path: filePath, limit: 5 }),
    });
  },

  /** PRD 52: the stack, as detected. */
  "GET architecture": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    const project = devmemory.registry.get(projectId);
    const code = devmemory.codeFor(projectId);

    // Languages measured from the index beat languages inferred from manifests: a
    // project full of .ts files is TypeScript whether or not it has a tsconfig.
    const measured = devmemory
      .filesFor(projectId)
      .stats(projectId)
      .byLanguage.filter((entry) => entry.language !== "other")
      .map((entry) => languageLabel(entry.language));

    return ok({
      framework: project?.framework ?? null,
      languages: measured.length > 0 ? measured : (project?.languages ?? []),
      declared_languages: project?.languages ?? [],
      package_manager: project?.packageManager ?? null,
      external_packages: code.externalPackages(projectId, 30),
      routes: code.findSymbols(projectId, { type: "route", limit: 50 }),
      components: code.findSymbols(projectId, { type: "component", limit: 30 }),
      by_type: code.stats(projectId).byType,
    });
  },

  /** PRD 49: known issues, assembled from the stores that actually hold them. */
  "GET issues": (devmemory, request) => {
    const projectId = request.segments[0] as string;
    return ok({
      bugs: devmemory.memoryFor(projectId).list({ type: "BUG", limit: 50 }),
      blocked_tasks: devmemory.tasksFor(projectId).list({ status: "BLOCKED", limit: 20 }),
      security: devmemory.status(projectId).security,
    });
  },
};

/** Indexer language ids are lowercase; the dashboard shows the names people use. */
const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  csharp: "C#",
  cpp: "C++",
  php: "PHP",
  json: "JSON",
  yaml: "YAML",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
};

function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

function settings(devmemory: DevMemory): ApiResponse {
  const config = loadConfig(devmemory.home);
  return ok({
    home: devmemory.home,
    driver: devmemory.databases.driver.name,
    indexing: config.indexing,
    security: { ...config.security, permissions: devmemory.permissions.describe() },
    git: config.git,
    dashboard: config.dashboard,
    log_level: config.logLevel,
  });
}

function summary(project: { projectId: string; name: string; rootPath: string; framework: string | null; languages: string[]; status: string; indexStatus: string; lastSeenAt: string; repositoryUrl: string | null }) {
  return {
    project_id: project.projectId,
    name: project.name,
    root: project.rootPath,
    framework: project.framework,
    languages: project.languages,
    status: project.status,
    index_status: project.indexStatus,
    last_seen_at: project.lastSeenAt,
    repository: project.repositoryUrl,
  };
}
