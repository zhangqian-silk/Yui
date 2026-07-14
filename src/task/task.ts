export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type TaskMetadata = {
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
};

export type Task = {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
  archived: boolean;
  archivedAt?: string;
  archivedBy?: "user" | "operator" | "leader";
  archiveReason?: string;
  archiveSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export function createTask(id: string, title: string, now: Date, metadata: TaskMetadata = {}): Task {
  if (id.length === 0 || ["__proto__", "prototype", "constructor", ".", ".."].includes(id) || /[\/\\\0]/.test(id)) {
    throw new Error("Task id is invalid.");
  }
  const trimmedTitle = title.trim();

  if (trimmedTitle.length === 0) {
    throw new Error("Task title is required.");
  }

  const timestamp = now.toISOString();

  return {
    schemaVersion: 1,
    id,
    title: trimmedTitle,
    ...metadata,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function updateTaskArchived(
  task: Task,
  archived: boolean,
  now: Date,
  archive?: { by: NonNullable<Task["archivedBy"]>; reason?: string; summary?: string }
): Task {
  const { archivedAt: _archivedAt, archivedBy: _archivedBy, archiveReason: _archiveReason,
    archiveSummary: _archiveSummary, ...base } = task;
  const timestamp = now.toISOString();
  return archived
    ? {
        ...base,
        archived: true,
        archivedAt: timestamp,
        archivedBy: archive?.by ?? "user",
        ...(archive?.reason === undefined ? {} : { archiveReason: archive.reason.trim() }),
        ...(archive?.summary === undefined ? {} : { archiveSummary: archive.summary.trim() }),
        updatedAt: timestamp
      }
    : { ...base, archived: false, updatedAt: timestamp };
}

export function updateTaskMetadata(task: Task, metadata: Partial<TaskMetadata & { title: string }>, now: Date): Task {
  return {
    ...task,
    ...metadata,
    updatedAt: now.toISOString()
  };
}
