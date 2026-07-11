export type TaskComment = {
  schemaVersion: 1;
  id: string;
  body: string;
  author?: "user" | "operator" | "leader";
  createdAt: string;
};

export function createTaskComment(
  id: string,
  body: string,
  now: Date,
  author?: TaskComment["author"]
): TaskComment {
  const trimmedBody = body.trim();

  if (trimmedBody.length === 0) {
    throw new Error("Comment body is required.");
  }

  return {
    schemaVersion: 1,
    id,
    body: trimmedBody,
    ...(author === undefined ? {} : { author }),
    createdAt: now.toISOString()
  };
}
