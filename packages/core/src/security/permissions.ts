import { DevMemoryError } from "@samirthakur024/shared";

/** Operation classes from PRD 38. */
export const PERMISSIONS = ["READ", "WRITE", "EXECUTE", "DESTRUCTIVE"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** What the policy says about a class of operation. */
export type PermissionRule = "allow" | "confirm" | "deny";

export type PermissionPolicy = Record<Permission, PermissionRule>;

export interface PermissionRequest {
  tool: string;
  permission: Permission;
  /** True when the caller has explicitly confirmed a guarded operation. */
  confirmed?: boolean;
}

export interface PermissionDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  rule: PermissionRule;
  reason: string;
}

/** PRD 38 defaults: read, write, test and build are allowed; destruction is not. */
export const DEFAULT_POLICY: PermissionPolicy = {
  READ: "allow",
  WRITE: "allow",
  EXECUTE: "allow",
  DESTRUCTIVE: "confirm",
};

/**
 * Enforces the operation classes in PRD 38. Every MCP tool declares its class, and
 * this decides whether a call proceeds, needs an explicit confirmation, or is
 * refused outright - one place to reason about, and one place to change.
 */
export class PermissionEngine {
  private readonly policy: PermissionPolicy;

  constructor(policy: Partial<PermissionPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  ruleFor(permission: Permission): PermissionRule {
    return this.policy[permission] ?? "allow";
  }

  check(request: PermissionRequest): PermissionDecision {
    const rule = this.ruleFor(request.permission);

    if (rule === "deny") {
      return {
        allowed: false,
        requiresConfirmation: false,
        rule,
        reason: `${request.permission} operations are disabled by policy`,
      };
    }

    if (rule === "confirm" && request.confirmed !== true) {
      return {
        allowed: false,
        requiresConfirmation: true,
        rule,
        reason: `${request.tool} is a ${request.permission} operation and needs confirm=true`,
      };
    }

    return { allowed: true, requiresConfirmation: false, rule, reason: "allowed by policy" };
  }

  /** Throws a structured error rather than returning a decision. */
  enforce(request: PermissionRequest): void {
    const decision = this.check(request);
    if (decision.allowed) return;

    throw new DevMemoryError("PERMISSION_DENIED", decision.reason, {
      tool: request.tool,
      permission: request.permission,
      rule: decision.rule,
      requiresConfirmation: decision.requiresConfirmation,
    });
  }

  describe(): PermissionPolicy {
    return { ...this.policy };
  }
}
