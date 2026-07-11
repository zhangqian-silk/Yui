export type TaskComment = {
  schemaVersion: 1;
  id: string;
  body: string;
  topics: string[];
  author?: "user" | "operator" | "leader";
  createdAt: string;
};

export function createTaskComment(
  id: string,
  body: string,
  now: Date,
  author?: TaskComment["author"],
  topics: string[] = []
): TaskComment {
  const trimmedBody = body.trim();

  if (trimmedBody.length === 0) {
    throw new Error("Comment body is required.");
  }

  return {
    schemaVersion: 1,
    id,
    body: trimmedBody,
    topics: [...new Set(topics)],
    ...(author === undefined ? {} : { author }),
    createdAt: now.toISOString()
  };
}
