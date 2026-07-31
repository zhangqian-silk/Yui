export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskStatus = "draft" | "active" | "completed" | "archived";
export type TaskCompletedBy = "user" | "operator" | "leader";

export type TaskProjectBinding = Readonly<{
  projectId: string;
  directory: string;
  baseRef: string;
}>;

export type TaskMetadata = {
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
  projectBindings?: readonly TaskProjectBinding[];
  cwd?: string;
  requireIntegration?: true;
};

export type TaskMetadataUpdate = Partial<{
  title: string;
  description: string | null;
  priority: TaskPriority | null;
  tags: string[] | null;
  dueAt: string | null;
  projectBindings: readonly TaskProjectBinding[];
  cwd: string;
  requireIntegration: true;
}>;

export type Task = {
  schemaVersion: 2;
  id: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
  projectBindings: readonly TaskProjectBinding[];
  cwd?: string;
  requireIntegration?: true;
  status: TaskStatus;
  completedAt?: string;
  completedBy?: TaskCompletedBy;
  completionSummary?: string;
  archivedAt?: string;
  archivedBy?: "user" | "operator" | "leader";
  archiveReason?: string;
  archiveSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export function createTask(id: string, title: string, now: Date, metadata: TaskMetadata = {}): Task {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 2,
    id: requireSafeIdentity(id, "Task id"),
    title: requireText(title, "Task title"),
    ...cloneMetadata(metadata),
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function activateTask(task: Task, now: Date): Task {
  if (task.status === "archived") throw new Error(`Cannot activate archived Task: ${task.id}.`);
  if (task.status === "completed") throw new Error(`Cannot activate completed Task ${task.id}; reopen it instead.`);
  if (task.status === "active") return task;
  return { ...task, status: "active", updatedAt: now.toISOString() };
}

export function completeTask(
  task: Task,
  now: Date,
  completion: { by: TaskCompletedBy; summary: string }
): Task {
  if (task.status === "completed") return task;
  if (task.status !== "active") {
    throw new Error(`Only an active Task can be completed: ${task.id}.`);
  }
  const timestamp = now.toISOString();
  return {
    ...task,
    status: "completed",
    completedAt: timestamp,
    completedBy: completion.by,
    completionSummary: requireText(completion.summary, "Task completion summary"),
    updatedAt: timestamp
  };
}

export function reopenTask(task: Task, now: Date): Task {
  if (task.status === "archived") throw new Error(`Cannot reopen archived Task: ${task.id}.`);
  if (task.status !== "completed") {
    throw new Error(`Only a completed Task can be reopened: ${task.id}.`);
  }
  const {
    completedAt: _completedAt,
    completedBy: _completedBy,
    completionSummary: _completionSummary,
    ...reopened
  } = task;
  return { ...reopened, status: "active", updatedAt: now.toISOString() };
}

export function archiveTask(
  task: Task,
  now: Date,
  archive?: { by: NonNullable<Task["archivedBy"]>; reason?: string; summary?: string }
): Task {
  if (task.status === "archived") return task;
  const timestamp = now.toISOString();
  return {
    ...task,
    status: "archived",
    archivedAt: timestamp,
    archivedBy: archive?.by ?? "user",
    ...(archive?.reason === undefined ? {} : { archiveReason: archive.reason.trim() }),
    ...(archive?.summary === undefined ? {} : { archiveSummary: archive.summary.trim() }),
    updatedAt: timestamp
  };
}

export function updateTaskArchived(
  task: Task,
  archived: boolean,
  now: Date,
  archive?: { by: NonNullable<Task["archivedBy"]>; reason?: string; summary?: string }
): Task {
  if (archived) return archiveTask(task, now, archive);
  if (task.status === "archived") {
    throw new Error(`Cannot reopen archived Task: ${task.id}.`);
  }
  return { ...task, updatedAt: now.toISOString() };
}

export function updateTaskMetadata(
  task: Task,
  metadata: TaskMetadataUpdate,
  now: Date
): Task {
  const updated: Task = { ...task, updatedAt: now.toISOString() };
  if (metadata.title !== undefined) updated.title = requireText(metadata.title, "Task title");
  applyOptional(updated, "description", metadata.description);
  applyOptional(updated, "priority", metadata.priority);
  applyOptional(updated, "tags", metadata.tags === undefined || metadata.tags === null
    ? metadata.tags
    : [...metadata.tags]);
  applyOptional(updated, "dueAt", metadata.dueAt);
  if (metadata.projectBindings !== undefined) {
    updated.projectBindings = normalizeProjectBindings(metadata.projectBindings);
  }
  if (metadata.cwd !== undefined) updated.cwd = requireText(metadata.cwd, "Task workspace");
  if (metadata.requireIntegration === true) updated.requireIntegration = true;
  return updated;
}

function applyOptional<K extends "description" | "priority" | "tags" | "dueAt">(
  task: Task,
  key: K,
  value: Task[K] | null | undefined
): void {
  if (value === undefined) return;
  if (value === null) delete task[key];
  else task[key] = value;
}

export function updateTaskWorkspace(task: Task, cwd: string, now: Date): Task {
  return { ...task, cwd: requireText(cwd, "Task workspace"), updatedAt: now.toISOString() };
}

export function isTaskArchived(task: Task): boolean {
  return task.status === "archived";
}

export function validateTask(task: Task): Task {
  if (task.schemaVersion !== 2) throw new Error("Task must use schemaVersion 2.");
  requireSafeIdentity(task.id, "Task id");
  requireText(task.title, "Task title");
  if (!(["draft", "active", "completed", "archived"] as const).includes(task.status)) {
    throw new Error(`Task status is invalid: ${String(task.status)}.`);
  }
  requireTimestamp(task.createdAt, "Task createdAt");
  requireTimestamp(task.updatedAt, "Task updatedAt");
  if (Date.parse(task.updatedAt) < Date.parse(task.createdAt)) {
    throw new Error("Task updatedAt cannot precede createdAt.");
  }
  if (task.priority !== undefined
    && !(["low", "medium", "high", "urgent"] as const).includes(task.priority)) {
    throw new Error(`Task priority is invalid: ${String(task.priority)}.`);
  }
  if (task.description !== undefined) requireText(task.description, "Task description");
  if (task.tags !== undefined) {
    if (!Array.isArray(task.tags)) throw new Error("Task tags are invalid.");
    for (const tag of task.tags) requireText(tag, "Task tag");
  }
  if (task.dueAt !== undefined) requireTimestamp(task.dueAt, "Task dueAt");
  normalizeProjectBindings(task.projectBindings);
  if (task.cwd !== undefined) requireText(task.cwd, "Task workspace");
  if (task.requireIntegration !== undefined && task.requireIntegration !== true) {
    throw new Error("Task requireIntegration must be true when present.");
  }
  const completionFields = [task.completedAt, task.completedBy, task.completionSummary];
  const hasAnyCompletion = completionFields.some((value) => value !== undefined);
  const hasAllCompletion = completionFields.every((value) => value !== undefined);
  if (hasAnyCompletion && !hasAllCompletion) {
    throw new Error("Task completion metadata must include completedAt, completedBy, and completionSummary.");
  }
  if (hasAllCompletion) {
    requireTimestamp(task.completedAt!, "Task completedAt");
    if (!(["user", "operator", "leader"] as const).includes(task.completedBy!)) {
      throw new Error(`Task completedBy is invalid: ${String(task.completedBy)}.`);
    }
    requireText(task.completionSummary!, "Task completion summary");
  }
  if (task.status === "completed" && !hasAllCompletion) {
    throw new Error("A completed Task requires completedAt, completedBy, and completionSummary.");
  }
  if ((task.status === "draft" || task.status === "active") && hasAnyCompletion) {
    throw new Error(`Task completion metadata is invalid for ${task.status} status.`);
  }

  const hasAnyArchive = [task.archivedAt, task.archivedBy, task.archiveReason, task.archiveSummary]
    .some((value) => value !== undefined);
  if (task.status === "archived") {
    if (task.archivedAt === undefined || task.archivedBy === undefined) {
      throw new Error("An archived Task requires archivedAt and archivedBy.");
    }
    requireTimestamp(task.archivedAt, "Task archivedAt");
    if (!(["user", "operator", "leader"] as const).includes(task.archivedBy)) {
      throw new Error(`Task archivedBy is invalid: ${String(task.archivedBy)}.`);
    }
    if (task.archiveReason !== undefined) requireText(task.archiveReason, "Task archive reason");
    if (task.archiveSummary !== undefined) requireText(task.archiveSummary, "Task archive summary");
  } else if (hasAnyArchive) {
    throw new Error(`Task archive metadata is invalid for ${task.status} status.`);
  }
  return task;
}

function cloneMetadata(
  metadata: TaskMetadata
): TaskMetadata & Readonly<{ projectBindings: readonly TaskProjectBinding[] }> {
  const cloned: TaskMetadata & { projectBindings: readonly TaskProjectBinding[] } = {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.priority === undefined ? {} : { priority: metadata.priority }),
    ...(metadata.tags === undefined ? {} : { tags: [...metadata.tags] }),
    ...(metadata.dueAt === undefined ? {} : { dueAt: metadata.dueAt }),
    projectBindings: normalizeProjectBindings(metadata.projectBindings ?? []),
    ...(metadata.cwd === undefined ? {} : { cwd: requireText(metadata.cwd, "Task workspace") }),
    ...(metadata.requireIntegration === true ? { requireIntegration: true as const } : {})
  };
  return cloned;
}

function normalizeProjectBindings(
  bindings: readonly TaskProjectBinding[]
): readonly TaskProjectBinding[] {
  if (!Array.isArray(bindings)) throw new Error("Task Project bindings are invalid.");
  const projectIds = new Set<string>();
  const directories = new Set<string>();
  return bindings.map((binding) => {
    const projectId = requireSafeIdentity(binding.projectId, "Project id");
    const directory = requireSafeIdentity(binding.directory, "Project directory");
    const baseRef = requireText(binding.baseRef, "Task base ref");
    if (projectIds.has(projectId)) {
      throw new Error(`Task Project is duplicated: ${projectId}.`);
    }
    if (directories.has(directory)) {
      throw new Error(`Task Project directory is duplicated: ${directory}.`);
    }
    projectIds.add(projectId);
    directories.add(directory);
    return { projectId, directory, baseRef };
  });
}

export function taskProjectBinding(
  task: Task,
  projectId: string
): TaskProjectBinding | undefined {
  return task.projectBindings.find((binding) => binding.projectId === projectId);
}

export function taskHasProjects(task: Task): boolean {
  return task.projectBindings.length > 0;
}

export function taskProjectIds(task: Task): readonly string[] {
  return task.projectBindings.map(({ projectId }) => projectId);
}

export function addTaskProjectBinding(
  task: Task,
  binding: TaskProjectBinding,
  now: Date
): Task {
  if (taskProjectBinding(task, binding.projectId) !== undefined) {
    throw new Error(`Task already contains Project: ${binding.projectId}.`);
  }
  return validateTask({
    ...task,
    projectBindings: normalizeProjectBindings([...task.projectBindings, binding]),
    updatedAt: now.toISOString()
  });
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}
