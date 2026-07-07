export type TaskStatus = "open" | "active" | "done" | "archived";
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
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export function createTask(id: string, title: string, now: Date, metadata: TaskMetadata = {}): Task {
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
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function updateTaskStatus(task: Task, status: TaskStatus, now: Date): Task {
  return {
    ...task,
    status,
    updatedAt: now.toISOString()
  };
}

export function updateTaskMetadata(task: Task, metadata: Partial<TaskMetadata & { title: string }>, now: Date): Task {
  return {
    ...task,
    ...metadata,
    updatedAt: now.toISOString()
  };
}
