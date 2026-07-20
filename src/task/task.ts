export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskStatus = "draft" | "active" | "archived";

export type TaskMetadata = {
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
  repositoryId?: string;
  baseRef?: string;
  cwd?: string;
};

export type Task = {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
  repositoryId?: string;
  baseRef?: string;
  cwd?: string;
  status: TaskStatus;
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
    schemaVersion: 1,
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
  return { ...task, status: "active", updatedAt: now.toISOString() };
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
  metadata: Partial<TaskMetadata & { title: string }>,
  now: Date
): Task {
  const updated: Task = {
    ...task,
    ...(metadata.title === undefined ? {} : { title: requireText(metadata.title, "Task title") }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.priority === undefined ? {} : { priority: metadata.priority }),
    ...(metadata.tags === undefined ? {} : { tags: [...metadata.tags] }),
    ...(metadata.dueAt === undefined ? {} : { dueAt: metadata.dueAt }),
    ...(metadata.repositoryId === undefined
      ? {}
      : { repositoryId: requireSafeIdentity(metadata.repositoryId, "Repository id") }),
    ...(metadata.baseRef === undefined ? {} : { baseRef: requireText(metadata.baseRef, "Task base ref") }),
    ...(metadata.cwd === undefined ? {} : { cwd: requireText(metadata.cwd, "Task workspace") }),
    updatedAt: now.toISOString()
  };
  validateRepositorySelection(updated);
  return updated;
}

export function updateTaskWorkspace(task: Task, cwd: string, now: Date): Task {
  return { ...task, cwd: requireText(cwd, "Task workspace"), updatedAt: now.toISOString() };
}

export function isTaskArchived(task: Task): boolean {
  return task.status === "archived";
}

function cloneMetadata(metadata: TaskMetadata): TaskMetadata {
  const cloned: TaskMetadata = {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.priority === undefined ? {} : { priority: metadata.priority }),
    ...(metadata.tags === undefined ? {} : { tags: [...metadata.tags] }),
    ...(metadata.dueAt === undefined ? {} : { dueAt: metadata.dueAt }),
    ...(metadata.repositoryId === undefined
      ? {}
      : { repositoryId: requireSafeIdentity(metadata.repositoryId, "Repository id") }),
    ...(metadata.baseRef === undefined ? {} : { baseRef: requireText(metadata.baseRef, "Task base ref") }),
    ...(metadata.cwd === undefined ? {} : { cwd: requireText(metadata.cwd, "Task workspace") })
  };
  validateRepositorySelection(cloned);
  return cloned;
}

function validateRepositorySelection(value: Pick<TaskMetadata, "repositoryId" | "baseRef">): void {
  if (value.baseRef !== undefined && value.repositoryId === undefined) {
    throw new Error("Task base ref requires a repository.");
  }
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
