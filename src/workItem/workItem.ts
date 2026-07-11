export type WorkItemStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "superseded";

export type WorkItem = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  cycleId?: string;
  title: string;
  assignee: string;
  topics: string[];
  status: WorkItemStatus;
  outcome?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export function createWorkItem(
  id: string,
  taskId: string,
  input: Pick<WorkItem, "title" | "assignee" | "topics" | "cycleId">,
  now: Date
): WorkItem {
  const title = input.title.trim();
  const assignee = input.assignee.trim();

  if (title.length === 0) {
    throw new Error("Work item title is required.");
  }

  if (assignee.length === 0) {
    throw new Error("Work item assignee is required.");
  }

  const timestamp = now.toISOString();

  return {
    schemaVersion: 1,
    id,
    taskId,
    ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
    title,
    assignee,
    topics: [...new Set(input.topics)],
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function updateWorkItemStatus(
  workItem: WorkItem,
  status: WorkItemStatus,
  outcome: string | undefined,
  now: Date
): WorkItem {
  const terminal = ["completed", "failed", "cancelled", "superseded"].includes(status);
  const trimmedOutcome = outcome?.trim();
  if (terminal && (trimmedOutcome === undefined || trimmedOutcome.length === 0)) {
    throw new Error(`Work item outcome is required for ${status}.`);
  }

  const timestamp = now.toISOString();
  return {
    ...workItem,
    status,
    ...(trimmedOutcome === undefined ? {} : { outcome: trimmedOutcome }),
    updatedAt: timestamp,
    ...(terminal ? { endedAt: timestamp } : {})
  };
}
