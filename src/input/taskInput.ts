export type TaskInputDraft = {
  schemaVersion: 1;
  taskId: string;
  body: string;
  author: "operator";
  createdAt: string;
  updatedAt: string;
};

export function createTaskInputDraft(
  taskId: string,
  body: string,
  now: Date,
  existing?: TaskInputDraft
): TaskInputDraft {
  const trimmedBody = body.trim();

  if (trimmedBody.length === 0) {
    throw new Error("Input draft body is required.");
  }

  const timestamp = now.toISOString();

  return {
    schemaVersion: 1,
    taskId,
    body: trimmedBody,
    author: "operator",
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}
