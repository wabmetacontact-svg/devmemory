import type { ZodRawShape } from "zod";
import { DevMemoryError, toDevMemoryError } from "@samirthakur024/shared";
import type { DevMemory } from "@samirthakur024/core";

/** Operation classes from PRD 38. v1 ships READ and WRITE tools plus one guarded DESTRUCTIVE tool. */
export type ToolPermission = "READ" | "WRITE" | "EXECUTE" | "DESTRUCTIVE";

export interface ToolContext {
  devmemory: DevMemory;
  /** Working directory reported by the agent process. */
  cwd: string;
  /** Workspace roots advertised by the MCP client, if any (PRD 8, fallback 1). */
  clientRoots(): Promise<string[]>;
  /**
   * The project the call in flight resolved to, for the activity feed.
   *
   * Most tools take a root or fall back to the cwd rather than an explicit id, so
   * the wrapper that logs the call cannot work out which project it touched. The
   * resolver knows, and this is where it leaves the answer.
   */
  resolved?: { projectId: string; name: string } | undefined;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  permission: ToolPermission;
  inputShape: Shape;
  handler(input: Record<string, unknown>, context: ToolContext): Promise<unknown> | unknown;
}

export function defineTool<Shape extends ZodRawShape>(definition: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return definition;
}

/**
 * Shared plumbing for resolving which project a call is about: an explicit
 * project_id, else the client's workspace roots, else the server's cwd (PRD 8).
 */
export async function resolveTarget(
  context: ToolContext,
  input: { project_id?: string; root?: string; auto_connect?: boolean },
) {
  const roots = await context.clientRoots();
  const project = await context.devmemory.requireProject({
    ...(input.project_id ? { projectId: input.project_id } : {}),
    ...(input.root ? { explicitRoot: input.root } : {}),
    clientRoots: roots,
    cwd: context.cwd,
    ...(input.auto_connect === false ? { autoConnect: false } : {}),
  });

  context.resolved = { projectId: project.projectId, name: project.name };
  return project;
}

export interface ToolErrorPayload {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function toToolError(error: unknown): ToolErrorPayload {
  const devMemoryError: DevMemoryError = toDevMemoryError(error);
  return devMemoryError.toJSON();
}
