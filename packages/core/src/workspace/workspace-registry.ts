import { DevMemoryError, nowIso, shortId } from "@samirthakur024/shared";
import type { ProjectRecord } from "@samirthakur024/shared";
import type { DatabaseManager } from "@samirthakur024/storage";

export interface WorkspaceMember {
  projectId: string;
  /** Free-text label such as "backend" or "mobile"; purely descriptive. */
  role: string | null;
  addedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  members: WorkspaceMember[];
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Groups of projects that are worked on together - a mobile app and the backend it
 * calls, for instance. Isolation remains the default everywhere: nothing spans a
 * workspace unless the caller names one, so a project can never leak into another
 * project's answers by accident (PRD 11).
 */
export class WorkspaceRegistry {
  constructor(private readonly databases: DatabaseManager) {}

  private get db() {
    return this.databases.openRegistry();
  }

  create(name: string, options: { description?: string; projectIds?: string[] } = {}): Workspace {
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new DevMemoryError("INVALID_INPUT", "workspace name is too short");
    if (this.find(trimmed)) throw new DevMemoryError("INVALID_INPUT", `workspace already exists: ${trimmed}`);

    const id = shortId("ws", 5);
    const timestamp = nowIso();

    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, trimmed, options.description ?? null, timestamp, timestamp);

      for (const projectId of options.projectIds ?? []) this.addProject(id, projectId);
    });

    return this.require(id);
  }

  /** Accepts a workspace id or its name, so the CLI and tools can use either. */
  find(idOrName: string): Workspace | null {
    const row =
      this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get<WorkspaceRow>(idOrName) ??
      this.db.prepare("SELECT * FROM workspaces WHERE name = ? COLLATE NOCASE").get<WorkspaceRow>(idOrName);
    return row ? this.hydrate(row) : null;
  }

  require(idOrName: string): Workspace {
    const workspace = this.find(idOrName);
    if (!workspace) throw new DevMemoryError("INVALID_INPUT", `unknown workspace: ${idOrName}`);
    return workspace;
  }

  list(): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces ORDER BY updated_at DESC")
      .all<WorkspaceRow>()
      .map((row) => this.hydrate(row));
  }

  /** Workspaces a project belongs to - used to suggest a group when one exists. */
  forProject(projectId: string): Workspace[] {
    return this.db
      .prepare(
        `SELECT w.* FROM workspaces w
           JOIN workspace_projects wp ON wp.workspace_id = w.id
          WHERE wp.project_id = ?
          ORDER BY w.updated_at DESC`,
      )
      .all<WorkspaceRow>(projectId)
      .map((row) => this.hydrate(row));
  }

  addProject(idOrName: string, projectId: string, role?: string): Workspace {
    const workspace = this.require(idOrName);
    const project = this.db
      .prepare("SELECT project_id FROM projects WHERE project_id = ?")
      .get<{ project_id: string }>(projectId);
    if (!project) throw new DevMemoryError("PROJECT_NOT_FOUND", `unknown project: ${projectId}`);

    this.db
      .prepare(
        `INSERT INTO workspace_projects (workspace_id, project_id, role, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, project_id) DO UPDATE SET role = COALESCE(excluded.role, role)`,
      )
      .run(workspace.id, projectId, role ?? null, nowIso());

    this.touch(workspace.id);
    return this.require(workspace.id);
  }

  removeProject(idOrName: string, projectId: string): Workspace {
    const workspace = this.require(idOrName);
    this.db
      .prepare("DELETE FROM workspace_projects WHERE workspace_id = ? AND project_id = ?")
      .run(workspace.id, projectId);
    this.touch(workspace.id);
    return this.require(workspace.id);
  }

  rename(idOrName: string, name: string): Workspace {
    const workspace = this.require(idOrName);
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new DevMemoryError("INVALID_INPUT", "workspace name is too short");

    this.db.prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?").run(trimmed, nowIso(), workspace.id);
    return this.require(workspace.id);
  }

  remove(idOrName: string): void {
    const workspace = this.require(idOrName);
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
  }

  /** Members that still exist and are active, in the order they were added. */
  projects(idOrName: string, all: ProjectRecord[]): ProjectRecord[] {
    const workspace = this.require(idOrName);
    const byId = new Map(all.map((project) => [project.projectId, project]));

    return workspace.members
      .map((member) => byId.get(member.projectId))
      .filter((project): project is ProjectRecord => project !== undefined && project.status === "active");
  }

  private touch(id: string): void {
    this.db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  private hydrate(row: WorkspaceRow): Workspace {
    const members = this.db
      .prepare("SELECT project_id, role, added_at FROM workspace_projects WHERE workspace_id = ? ORDER BY added_at")
      .all<{ project_id: string; role: string | null; added_at: string }>(row.id)
      .map((member) => ({ projectId: member.project_id, role: member.role, addedAt: member.added_at }));

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      members,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
