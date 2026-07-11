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
  createdAt: string;
  updatedAt: string;
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
