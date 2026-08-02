import { resolve } from "node:path";

export type WorktreeOwner =
  | Readonly<{ type: "task" }>
  | Readonly<{ type: "work-item"; workItemId: string }>
  | Readonly<{ type: "review-round"; reviewRoundId: string }>;

export type WorkspaceProjectAccess = "read" | "write";

export type WorkspaceProjectEntry = Readonly<{
  projectId: string;
  directory: string;
  access: WorkspaceProjectAccess;
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
}>;

export type RoleWorkspace = Readonly<{
  schemaVersion: 3;
  taskId: string;
  roleName: string;
  owner: WorktreeOwner;
  root: string;
  entries: readonly WorkspaceProjectEntry[];
  createdAt: string;
  updatedAt: string;
}>;

export type RoleWorkspaceIdentity = Readonly<Pick<
  RoleWorkspace,
  "taskId" | "roleName" | "owner" | "root" | "entries"
>>;

export function createRoleWorkspace(
  input: RoleWorkspaceIdentity,
  now: Date
): RoleWorkspace {
  const timestamp = now.toISOString();
  return validateRoleWorkspace({
    schemaVersion: 3,
    taskId: requireIdentity(input.taskId, "Task id"),
    roleName: requireIdentity(input.roleName, "Role name"),
    owner: validateOwner(input.owner),
    root: resolve(requireText(input.root, "Role workspace root")),
    entries: normalizeEntries(input.entries),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function validateRoleWorkspace(workspace: RoleWorkspace): RoleWorkspace {
  if (workspace.schemaVersion !== 3) {
    throw new Error("Managed workspace must use schemaVersion 3.");
  }
  requireIdentity(workspace.taskId, "Task id");
  requireIdentity(workspace.roleName, "Role name");
  validateOwner(workspace.owner);
  if (resolve(requireText(workspace.root, "Role workspace root")) !== workspace.root) {
    throw new Error("Role workspace root must be absolute and normalized.");
  }
  normalizeEntries(workspace.entries);
  requireTimestamp(workspace.createdAt, "RoleWorkspace createdAt");
  requireTimestamp(workspace.updatedAt, "RoleWorkspace updatedAt");
  return workspace;
}

export function workspaceProjectEntry(
  workspace: RoleWorkspace,
  projectId: string
): WorkspaceProjectEntry | undefined {
  return workspace.entries.find((entry) => entry.projectId === projectId);
}

function normalizeEntries(
  entries: readonly WorkspaceProjectEntry[]
): readonly WorkspaceProjectEntry[] {
  if (!Array.isArray(entries)) throw new Error("Workspace Project entries are invalid.");
  const projectIds = new Set<string>();
  const directories = new Set<string>();
  return entries.map((entry) => {
    const projectId = requireIdentity(entry.projectId, "Project id");
    const directory = requireIdentity(entry.directory, "Project directory");
    if (!["read", "write"].includes(entry.access)) {
      throw new Error(`Workspace Project access is invalid: ${String(entry.access)}.`);
    }
    if (projectIds.has(projectId)) throw new Error(`Workspace Project is duplicated: ${projectId}.`);
    if (directories.has(directory)) {
      throw new Error(`Workspace Project directory is duplicated: ${directory}.`);
    }
    projectIds.add(projectId);
    directories.add(directory);
    const path = resolve(requireText(entry.path, "Workspace Project path"));
    if (path !== entry.path) throw new Error("Workspace Project path must be absolute and normalized.");
    return {
      projectId,
      directory,
      access: entry.access,
      path,
      branch: requireText(entry.branch, "Workspace Project branch"),
      baseRef: requireText(entry.baseRef, "Workspace Project base ref"),
      baseCommit: requireCommit(entry.baseCommit)
    };
  });
}

export function managedWorktreeName(owner: WorktreeOwner): string {
  if (owner.type === "task") return "main";
  return owner.type === "work-item" ? owner.workItemId : owner.reviewRoundId;
}

function validateOwner(owner: WorktreeOwner): WorktreeOwner {
  if (owner.type === "task") return { type: "task" };
  if (owner.type === "work-item") {
    return { type: "work-item", workItemId: requireIdentity(owner.workItemId, "Work item id") };
  }
  if (owner.type === "review-round") {
    return {
      type: "review-round",
      reviewRoundId: requireIdentity(owner.reviewRoundId, "ReviewRound id")
    };
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
