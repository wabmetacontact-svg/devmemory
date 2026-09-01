import type { ZodRawShape } from "zod";
import { DevMemoryError, toDevMemoryError } from "@devmemory/shared";
import type { DevMemory } from "@devmemory/core";

/** Operation classes from PRD 38. v1 ships READ and WRITE tools plus one guarded DESTRUCTIVE tool. */
export type ToolPermission = "READ" | "WRITE" | "EXECUTE" | "DESTRUCTIVE";

export interface ToolContext {
  devmemory: DevMemory;
  /** Working directory reported by the agent process. */
  cwd: string;
  /** Workspace roots advertised by the MCP client, if any (PRD 8, fallback 1). */
  clientRoots(): Promise<string[]>;
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
  return context.devmemory.requireProject({
    ...(input.project_id ? { projectId: input.project_id } : {}),
    ...(input.root ? { explicitRoot: input.root } : {}),
    clientRoots: roots,
    cwd: context.cwd,
    ...(input.auto_connect === false ? { autoConnect: false } : {}),
  });
}

export interface ToolErrorPayload {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function toToolError(error: unknown): ToolErrorPayload {
  const devMemoryError: DevMemoryError = toDevMemoryError(error);
  return devMemoryError.toJSON();
}
