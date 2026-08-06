import { resolve } from "node:path";

/** The durable owner of a managed workspace.  Ownership is deliberately
 * independent from the Role which happens to execute in the workspace. */
export type ManagedWorkspaceOwner =
  | Readonly<{ type: "task"; taskId: string }>
  | Readonly<{ type: "work-item"; taskId: string; workItemId: string }>
  | Readonly<{ type: "review-round"; taskId: string; reviewRoundId: string }>
  | Readonly<{
      type: "integration-attempt";
      taskId: string;
      integrationAttemptId: string;
    }>;

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

export type ManagedWorkspace = Readonly<{
  schemaVersion: 1;
  owner: ManagedWorkspaceOwner;
  root: string;
  entries: readonly WorkspaceProjectEntry[];
  createdAt: string;
  updatedAt: string;
}>;

export type ManagedWorkspaceIdentity = Readonly<Pick<
  ManagedWorkspace,
  "owner" | "root" | "entries"
>>;

export function createManagedWorkspace(
  input: ManagedWorkspaceIdentity,
  now: Date
): ManagedWorkspace {
  const timestamp = now.toISOString();
  return validateManagedWorkspace({
    schemaVersion: 1,
    owner: validateOwner(input.owner),
    root: resolve(requireText(input.root, "Managed workspace root")),
    entries: normalizeEntries(input.entries),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function validateManagedWorkspace(
  workspace: ManagedWorkspace
): ManagedWorkspace {
  if (workspace.schemaVersion !== 1) {
    throw new Error("Managed workspace must use schemaVersion 1.");
  }
  validateOwner(workspace.owner);
  if (
    resolve(requireText(workspace.root, "Managed workspace root")) !==
    workspace.root
  ) {
    throw new Error("Managed workspace root must be absolute and normalized.");
  }
  normalizeEntries(workspace.entries);
  requireTimestamp(workspace.createdAt, "ManagedWorkspace createdAt");
  requireTimestamp(workspace.updatedAt, "ManagedWorkspace updatedAt");
  return workspace;
}

export function workspaceProjectEntry(
  workspace: ManagedWorkspace,
  projectId: string
): WorkspaceProjectEntry | undefined {
  return workspace.entries.find((entry) => entry.projectId === projectId);
}

/** Stable key used by the aggregate's owner-keyed workspace map. */
export function managedWorkspaceKey(owner: ManagedWorkspaceOwner): string {
  const valid = validateOwner(owner);
  switch (valid.type) {
    case "task":
      return `task:${valid.taskId}`;
    case "work-item":
      return `work-item:${valid.taskId}:${valid.workItemId}`;
    case "review-round":
      return `review-round:${valid.taskId}:${valid.reviewRoundId}`;
    case "integration-attempt":
      return `integration-attempt:${valid.taskId}:${valid.integrationAttemptId}`;
  }
}

/** Physical worktree names are owner identities, never Role names. */
export function managedWorktreeName(owner: ManagedWorkspaceOwner): string {
  switch (owner.type) {
    case "task":
      return "main";
    case "work-item":
      return owner.workItemId;
    case "review-round":
      return owner.reviewRoundId;
    case "integration-attempt":
      return `integration-${owner.integrationAttemptId}`;
  }
}

function normalizeEntries(
  entries: readonly WorkspaceProjectEntry[]
): readonly WorkspaceProjectEntry[] {
  if (!Array.isArray(entries)) {
    throw new Error("Workspace Project entries are invalid.");
  }
  const projectIds = new Set<string>();
  const directories = new Set<string>();
  return entries.map((entry) => {
    const projectId = requireIdentity(entry.projectId, "Project id");
    const directory = requireIdentity(entry.directory, "Project directory");
    if (!["read", "write"].includes(entry.access)) {
      throw new Error(
        `Workspace Project access is invalid: ${String(entry.access)}.`
      );
    }
    if (projectIds.has(projectId)) {
      throw new Error(`Workspace Project is duplicated: ${projectId}.`);
    }
    if (directories.has(directory)) {
      throw new Error(`Workspace Project directory is duplicated: ${directory}.`);
    }
    projectIds.add(projectId);
    directories.add(directory);
    const path = resolve(requireText(entry.path, "Workspace Project path"));
    if (path !== entry.path) {
      throw new Error("Workspace Project path must be absolute and normalized.");
    }
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

function validateOwner(owner: ManagedWorkspaceOwner): ManagedWorkspaceOwner {
  if (owner.type === "task") {
    return { type: "task", taskId: requireIdentity(owner.taskId, "Task id") };
  }
  if (owner.type === "work-item") {
    return {
      type: "work-item",
      taskId: requireIdentity(owner.taskId, "Task id"),
      workItemId: requireIdentity(owner.workItemId, "Work item id")
    };
  }
  if (owner.type === "review-round") {
    return {
      type: "review-round",
      taskId: requireIdentity(owner.taskId, "Task id"),
      reviewRoundId: requireIdentity(owner.reviewRoundId, "ReviewRound id")
    };
  }
  if (owner.type === "integration-attempt") {
    return {
      type: "integration-attempt",
      taskId: requireIdentity(owner.taskId, "Task id"),
      integrationAttemptId: requireIdentity(
        owner.integrationAttemptId,
        "Integration Attempt id"
      )
    };
  }
  throw new Error("Managed workspace owner is invalid.");
}

function requireIdentity(value: string, label: string): string {
  const identity = requireText(value, label);
  if (
    [".", "..", "__proto__", "prototype", "constructor"].includes(identity) ||
    /[\/\\\0]/.test(identity)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return identity;
}

function requireCommit(value: string): string {
  const commit = requireText(value, "Managed workspace base commit").toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) {
    throw new Error("Managed workspace base commit is invalid.");
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
