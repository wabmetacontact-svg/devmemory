import { z } from "zod";
import { assessOperation } from "@samirthakur024/core";
import { defineTool, resolveTarget, type ToolDefinition } from "../tool-context.js";

const checkOperation = defineTool({
  name: "check_operation",
  title: "Check operation",
  description:
    "Classify a shell command, SQL statement or planned action before running it: safe, caution, or dangerous. " +
    "Use it before anything that deletes data, rewrites history, migrates a database or deploys - especially " +
    "when production is involved. DevMemory never executes the operation; it only tells you what it is.",
  permission: "READ",
  inputShape: {
    operation: z.string().min(2).max(4000).describe("The command or statement you are about to run."),
  },
  handler(input) {
    const assessment = assessOperation(String(input.operation));

    return {
      severity: assessment.severity,
      requires_confirmation: assessment.requiresConfirmation,
      production_target: assessment.productionTarget,
      risks: assessment.risks,
      guidance:
        assessment.severity === "dangerous"
          ? "Ask the developer to confirm before running this."
          : assessment.severity === "caution"
            ? "Check that this is intended, and that it is not pointed at production."
            : "No destructive pattern detected.",
    };
  },
});

const securityStatus = defineTool({
  name: "security_status",
  title: "Security status",
  description:
    "What DevMemory is protecting in this project: the operation policy in force, and the indexed files where " +
    "a credential pattern was detected. Secrets themselves are never stored or returned.",
  permission: "READ",
  inputShape: {
    project_id: z.string().optional(),
    root: z.string().optional(),
  },
  async handler(input, context) {
    const project = await resolveTarget(context, input as { project_id?: string; root?: string });
    const status = context.devmemory.status(project.projectId);

    return {
      project_id: project.projectId,
      policy: context.devmemory.permissions.describe(),
      sensitive_files_blocked: context.devmemory.config.security.blockSensitiveFiles,
      redaction_enabled: context.devmemory.config.security.redactSecrets,
      files_with_secrets: status.security.files,
      findings: status.security.findings,
    };
  },
});

export const SECURITY_TOOLS: ToolDefinition[] = [checkOperation, securityStatus] as ToolDefinition[];
