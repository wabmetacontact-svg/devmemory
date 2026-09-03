/**
 * Turns a tool call into one readable line for the activity feed.
 *
 * Deliberately a per-tool allowlist rather than a dump of the arguments: a call
 * to `remember` carries whatever the agent decided to write down, and a search
 * carries whatever the developer typed. Only the one field that makes the row
 * meaningful is taken, and the log redacts what it stores on top of that.
 */

type Args = Record<string, unknown>;

function text(args: Args, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** The tools whose first argument is the developer's own description of the work. */
const INSTRUCTION_TOOLS = new Set(["get_context", "refresh_context", "task_context"]);

export function describeCall(tool: string, args: Args): { summary: string; instruction: boolean } {
  const instruction = INSTRUCTION_TOOLS.has(tool);

  switch (tool) {
    case "get_context":
    case "refresh_context":
      return { summary: text(args, "task") ?? "(no task given)", instruction };
    case "search_context":
      return { summary: text(args, "query") ?? "", instruction: false };
    case "task_context":
      return { summary: text(args, "task", "id") ?? "", instruction };

    case "find_symbol":
    case "get_definition":
    case "find_references":
      return { summary: text(args, "name", "symbol") ?? "", instruction: false };

    case "impact_analysis":
    case "affected_tests":
    case "get_related_code":
    case "find_file":
      return { summary: text(args, "path", "query") ?? "", instruction: false };

    case "remember":
      return { summary: text(args, "title") ?? "", instruction: false };
    case "recall":
      return { summary: text(args, "query") ?? "(recent)", instruction: false };
    case "forget":
      return { summary: text(args, "id", "title") ?? "", instruction: false };

    case "task_create":
      return { summary: text(args, "title") ?? "", instruction: false };
    case "task_update": {
      const status = text(args, "status");
      return { summary: [text(args, "task", "id"), status].filter(Boolean).join(" -> "), instruction: false };
    }

    case "session_start":
      return { summary: text(args, "agent") ?? "", instruction: false };
    case "session_end":
      return { summary: text(args, "summary") ?? "session ended", instruction: false };

    case "api_contracts":
      return { summary: [text(args, "scope"), text(args, "path")].filter(Boolean).join(" "), instruction: false };
    case "workspace_status":
      return { summary: text(args, "workspace") ?? "(all)", instruction: false };

    case "project_connect":
    case "project_index":
    case "project_status":
      return { summary: text(args, "root", "project_id") ?? "", instruction: false };

    case "changes_since":
    case "git_diff":
    case "git_history":
      return { summary: text(args, "path", "since", "ref") ?? "", instruction: false };

    default:
      return { summary: "", instruction: false };
  }
}

/**
 * A short note about what came back, for the rows where the answer is the point.
 * Only counts and flags - never the payload.
 */
export function describeResult(tool: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const result = payload as Record<string, unknown>;

  switch (tool) {
    case "get_context": {
      const files = asNumber(result.files_selected) ?? countOf(result.files);
      const tokens = asNumber(result.token_estimate);
      const cache = typeof result.cache === "string" ? result.cache : null;
      return [files === null ? null : `${files} files`, tokens === null ? null : `~${tokens} tokens`, cache]
        .filter(Boolean)
        .join(", ") || null;
    }

    case "impact_analysis": {
      const callers = countOf(result.http_callers);
      const direct = countOf(result.direct_dependents);
      const parts = [direct === null ? null : `${direct} importers`];
      // The reason this tool exists: callers no import edge reaches.
      if (callers) parts.push(`${callers} route(s) called from other projects`);
      return parts.filter(Boolean).join(", ") || null;
    }

    case "api_contracts": {
      const unmatched = countOf(result.calls_with_no_route);
      if (unmatched === null) return null;
      return unmatched > 0 ? `${unmatched} call(s) with no route` : "every call reaches a route";
    }

    case "search_context":
    case "find_symbol":
    case "find_references":
    case "recall":
      return describeCount(result);

    default:
      return null;
  }
}

function describeCount(result: Record<string, unknown>): string | null {
  for (const key of ["results", "symbols", "references", "memories", "matches"]) {
    const count = countOf(result[key]);
    if (count !== null) return `${count} result(s)`;
  }
  return null;
}

function countOf(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
