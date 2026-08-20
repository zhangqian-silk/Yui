import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
    }>
  | Readonly<{
      type: "execution-lane";
      taskId: string;
      executionGroupId: string;
      executionLaneId: string;
      purpose: "execution" | "review";
      workItemId?: string;
      reviewRoundId?: string;
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
  schemaVersion: 2;
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

/**
 * Launch-stable workspace identity. Audit timestamps describe persistence
 * activity, not a change to the workspace a runtime is authorized to use.
 */
export function managedWorkspaceIdentity(
  workspace: ManagedWorkspace
): ManagedWorkspaceIdentity {
  return {
    owner: workspace.owner,
    root: workspace.root,
    entries: workspace.entries
  };
}

export function sameManagedWorkspaceIdentity(
  left: ManagedWorkspace,
  right: ManagedWorkspace
): boolean {
  return isDeepStrictEqual(
    managedWorkspaceIdentity(left),
    managedWorkspaceIdentity(right)
  );
}

/** Stable Project identity required for a Task-owned runtime workspace. */
export type TaskWorkspaceBindingIdentity = Readonly<{
  projectId: string;
  directory: string;
}>;

/** Every active Task launch is fenced by this durable owner. */
export function isTaskOwnedWorkspace(
  workspace: ManagedWorkspace | null | undefined,
  taskId: string,
  taskRoot: string | undefined,
  bindings: readonly TaskWorkspaceBindingIdentity[]
): workspace is ManagedWorkspace {
  if (workspace === null || workspace === undefined
    || workspace.owner.type !== "task"
    || workspace.owner.taskId !== taskId
    || taskRoot === undefined
    || workspace.root !== taskRoot) {
    return false;
  }
  const expected = bindings
    .map(({ projectId, directory }) => `${projectId}\u0000${directory}\u0000write`)
    .sort();
  const actual = workspace.entries
    .map(({ projectId, directory, access }) => `${projectId}\u0000${directory}\u0000${access}`)
    .sort();
  return isDeepStrictEqual(actual, expected);
}

export function createManagedWorkspace(
  input: ManagedWorkspaceIdentity,
  now: Date
): ManagedWorkspace {
  const timestamp = now.toISOString();
  return validateManagedWorkspace({
    schemaVersion: 2,
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
  if (workspace.schemaVersion !== 2) {
    throw new Error("Managed workspace must use schemaVersion 2.");
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
    case "execution-lane":
      return `execution-lane:${valid.taskId}:${valid.executionGroupId}:${valid.executionLaneId}`;
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
    case "execution-lane":
      return `execution-lane-${owner.executionGroupId}-${owner.executionLaneId}`;
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
  if (owner.type === "execution-lane") {
    const purpose = owner.purpose;
    if (purpose !== "execution" && purpose !== "review") {
      throw new Error("Managed execution-lane workspace purpose is invalid.");
    }
    const workItemId = owner.workItemId === undefined
      ? undefined
      : requireIdentity(owner.workItemId, "Work item id");
    const reviewRoundId = owner.reviewRoundId === undefined
      ? undefined
      : requireIdentity(owner.reviewRoundId, "ReviewRound id");
    if (purpose === "execution" && workItemId === undefined) {
      throw new Error("Managed execution-lane workspace requires a Work Item.");
    }
    if (purpose === "execution" && reviewRoundId !== undefined) {
      throw new Error("Managed execution-lane workspace cannot also own a ReviewRound.");
    }
    if (purpose === "review" && reviewRoundId === undefined) {
      throw new Error("Managed execution-lane workspace requires a ReviewRound.");
    }
    if (purpose === "review" && workItemId !== undefined) {
      throw new Error("Managed review-lane workspace cannot also own a Work Item.");
    }
    return {
      type: "execution-lane",
      taskId: requireIdentity(owner.taskId, "Task id"),
      executionGroupId: requireIdentity(owner.executionGroupId, "ExecutionGroup id"),
      executionLaneId: requireIdentity(owner.executionLaneId, "ExecutionLane id"),
      purpose,
      ...(workItemId === undefined ? {} : { workItemId }),
      ...(reviewRoundId === undefined ? {} : { reviewRoundId })
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
