import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "@samirthakur024/shared";
import type { DevMemory } from "@samirthakur024/core";
import { ALL_TOOLS } from "./tools/index.js";
import { toToolError, type ToolContext, type ToolDefinition } from "./tool-context.js";

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

          const payload = await tool.handler(args ?? {}, context);
          options.logger?.debug({ tool: tool.name, ms: Date.now() - started }, "tool ok");
          return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
        } catch (error) {
          const payload = toToolError(error);
          options.logger?.warn({ tool: tool.name, err: payload.error.message }, "tool failed");
          return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
        }
      },
    );
  }

  return { server, context };
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
