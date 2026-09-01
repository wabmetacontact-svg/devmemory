import type { ToolDefinition } from "../tool-context.js";
import { PROJECT_TOOLS } from "./project-tools.js";
import { CONTEXT_TOOLS } from "./context-tools.js";
import { MEMORY_TOOLS } from "./memory-tools.js";
import { TASK_TOOLS } from "./task-tools.js";
import { SESSION_TOOLS } from "./session-tools.js";
import { CODE_TOOLS } from "./code-tools.js";
import { SECURITY_TOOLS } from "./security-tools.js";
import { GIT_TOOLS } from "./git-tools.js";
import { FILE_TOOLS } from "./file-tools.js";

export { PROJECT_TOOLS, CONTEXT_TOOLS, MEMORY_TOOLS, TASK_TOOLS, SESSION_TOOLS, CODE_TOOLS, SECURITY_TOOLS, GIT_TOOLS, FILE_TOOLS };

/** The complete MCP surface for this build. Kept deliberately small (PRD 39). */
export const ALL_TOOLS: ToolDefinition[] = [
  ...PROJECT_TOOLS,
  ...CONTEXT_TOOLS,
  ...MEMORY_TOOLS,
  ...TASK_TOOLS,
  ...SESSION_TOOLS,
  ...CODE_TOOLS,
  ...SECURITY_TOOLS,
  ...FILE_TOOLS,
  ...GIT_TOOLS,
];
