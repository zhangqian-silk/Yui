import { resolve } from "node:path";

export type WorktreeOwner =
  | Readonly<{ type: "task" }>
  | Readonly<{ type: "work-item"; workItemId: string }>;

/**
 * A managed worktree is owned by a Task or WorkItem. roleName only records
 * which Role currently launches there; it is not the lifecycle owner.
 */
export type RoleWorkspace = Readonly<{
  schemaVersion: 2;
  taskId: string;
  roleName: string;
  owner: WorktreeOwner;
  projectId: string;
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
}>;

export type RoleWorkspaceIdentity = Readonly<Pick<
  RoleWorkspace,
  "taskId" | "roleName" | "owner" | "projectId" | "path" | "branch" | "baseRef" | "baseCommit"
>>;

export function createRoleWorkspace(
  input: RoleWorkspaceIdentity,
  now: Date
): RoleWorkspace {
  const timestamp = now.toISOString();
  return validateRoleWorkspace({
    schemaVersion: 2,
    taskId: requireIdentity(input.taskId, "Task id"),
    roleName: requireIdentity(input.roleName, "Role name"),
    owner: validateOwner(input.owner),
    projectId: requireIdentity(input.projectId, "Project id"),
    path: resolve(requireText(input.path, "Role workspace path")),
    branch: requireText(input.branch, "Role workspace branch"),
    baseRef: requireText(input.baseRef, "Role workspace base ref"),
    baseCommit: requireCommit(input.baseCommit),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function validateRoleWorkspace(workspace: RoleWorkspace): RoleWorkspace {
  if (workspace.schemaVersion !== 2) {
    throw new Error("Managed worktree must use schemaVersion 2.");
  }
  requireIdentity(workspace.taskId, "Task id");
  requireIdentity(workspace.roleName, "Role name");
  validateOwner(workspace.owner);
  requireIdentity(workspace.projectId, "Project id");
  if (resolve(requireText(workspace.path, "Role workspace path")) !== workspace.path) {
    throw new Error("Role workspace path must be absolute and normalized.");
  }
  requireText(workspace.branch, "Role workspace branch");
  requireText(workspace.baseRef, "Role workspace base ref");
  requireCommit(workspace.baseCommit);
  requireTimestamp(workspace.createdAt, "RoleWorkspace createdAt");
  requireTimestamp(workspace.updatedAt, "RoleWorkspace updatedAt");
  return workspace;
}

export function managedWorktreeName(owner: WorktreeOwner): string {
  return owner.type === "task" ? "main" : owner.workItemId;
}

function validateOwner(owner: WorktreeOwner): WorktreeOwner {
  if (owner.type === "task") return { type: "task" };
  if (owner.type === "work-item") {
    return { type: "work-item", workItemId: requireIdentity(owner.workItemId, "Work item id") };
  }
  throw new Error("Managed worktree owner is invalid.");
}

function requireIdentity(value: string, label: string): string {
  const identity = requireText(value, label);
  if ([".", "..", "__proto__", "prototype", "constructor"].includes(identity)
    || /[\/\\\0]/.test(identity)) {
    throw new Error(`${label} is invalid.`);
  }
  return identity;
}

function requireCommit(value: string): string {
  const commit = requireText(value, "Role workspace base commit").toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) {
    throw new Error("Role workspace base commit is invalid.");
  }
  return commit;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}
