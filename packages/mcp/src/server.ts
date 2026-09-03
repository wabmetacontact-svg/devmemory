import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "@samirthakur024/shared";
import type { DevMemory } from "@samirthakur024/core";
import { ALL_TOOLS } from "./tools/index.js";
import { toToolError, type ToolContext, type ToolDefinition } from "./tool-context.js";
import { describeCall, describeResult } from "./activity-summary.js";

export const SERVER_NAME = "devmemory";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  devmemory: DevMemory;
  cwd?: string;
  logger?: Logger;
  tools?: ToolDefinition[];
}

export interface CreatedServer {
  server: McpServer;
  context: ToolContext;
}

/**
 * Builds the MCP surface. Tool results are returned as compact JSON text so that
 * every MCP client, not just those supporting structured output, can consume them (PRD 40).
 */
export function createDevMemoryServer(options: CreateServerOptions): CreatedServer {
  const tools = options.tools ?? ALL_TOOLS;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "DevMemory is this project's persistent development intelligence, shared by every agent that works " +
        "on it. Start a session with project_connect then handoff - that returns the current task, what the " +
        "last session did, the decisions that bind you and the recommended next step, so you never need the " +
        "developer to re-explain the project. Use get_context before reading files, remember for knowledge " +
        "worth keeping, task_update as work progresses, and session_end to leave the next agent a summary.",
    },
  );

  let cachedRoots: string[] | null = null;

  const context: ToolContext = {
    devmemory: options.devmemory,
    cwd: options.cwd ?? process.cwd(),
    async clientRoots(): Promise<string[]> {
      if (cachedRoots) return cachedRoots;
      try {
        // Only clients that advertise the roots capability can answer this.
        const capabilities = server.server.getClientCapabilities();
        if (!capabilities?.roots) {
          cachedRoots = [];
          return cachedRoots;
        }
        const result = await server.server.listRoots();
        cachedRoots = result.roots
          .map((root) => root.uri)
          .filter((uri) => uri.startsWith("file://"))
          .map((uri) => fileUriToPath(uri));
      } catch (error) {
        options.logger?.debug({ err: String(error) }, "client did not provide roots");
        cachedRoots = [];
      }
      return cachedRoots;
    },
  };

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: {
          readOnlyHint: tool.permission === "READ",
          destructiveHint: tool.permission === "DESTRUCTIVE",
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        try {
          // One policy point for every tool call (PRD 38). A guarded class is
          // refused unless the call carries an explicit confirm.
          const decision = options.devmemory.permissions.check({
            tool: tool.name,
            permission: tool.permission,
            confirmed: (args ?? {}).confirm === true,
          });
          if (!decision.allowed) {
            record(options.devmemory, context, tool.name, args ?? {}, "denied", Date.now() - started, decision.reason);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: {
                      code: "PERMISSION_DENIED",
                      message: decision.reason,
                      details: { requires_confirmation: decision.requiresConfirmation, rule: decision.rule },
                    },
                  }),
                },
              ],
              isError: true,
            };
          }

          context.resolved = undefined;
          const payload = await tool.handler(args ?? {}, context);
          options.logger?.debug({ tool: tool.name, ms: Date.now() - started }, "tool ok");
          record(options.devmemory, context, tool.name, args ?? {}, "ok", Date.now() - started, describeResult(tool.name, payload));
          return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
        } catch (error) {
          const payload = toToolError(error);
          options.logger?.warn({ tool: tool.name, err: payload.error.message }, "tool failed");
          record(options.devmemory, context, tool.name, args ?? {}, "error", Date.now() - started, payload.error.message);
          return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
        }
      },
    );
  }

  return { server, context };
}

/**
 * Writes one feed row for a tool call (PRD 41).
 *
 * Every call already passes through this wrapper, which is the only place that
 * sees the tool, its timing and its outcome together - so it is the only place
 * the dashboard can learn what an instruction actually did. Nothing here is
 * allowed to throw: a feed row is never worth failing a tool call for.
 */
function record(
  devmemory: DevMemory,
  context: ToolContext,
  tool: string,
  args: Record<string, unknown>,
  outcome: "ok" | "error" | "denied",
  durationMs: number,
  detail: string | null,
): void {
  try {
    const { summary } = describeCall(tool, args);
    // The resolver leaves the project it settled on; an explicit id is the fallback.
    const resolved = context.resolved;
    const projectId = resolved?.projectId ?? (typeof args.project_id === "string" ? args.project_id : null);
    const project = resolved ?? (projectId ? devmemory.registry.get(projectId) : null);

    devmemory.activity.record({
      source: "tool",
      tool,
      summary: summary || tool,
      outcome,
      durationMs,
      ...(detail ? { detail } : {}),
      ...(project ? { projectId: project.projectId, projectName: project.name } : {}),
    });
  } catch {
    // Ignored on purpose - see the doc comment.
  }
}

/** file:///C:/path and file:///home/u/path both need to become native paths. */
export function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch {
    return uri;
  }
}
