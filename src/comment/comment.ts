export type TaskComment = {
  schemaVersion: 1;
  id: string;
  body: string;
  topics: string[];
  /** `user`, a system Role, or any task Role name that produced the result. */
  author?: string;
  createdAt: string;
};

export function createTaskComment(
  id: string,
  body: string,
  now: Date,
  author?: TaskComment["author"],
  topics: readonly string[] = []
): TaskComment {
  return {
    schemaVersion: 1,
    id: requireText(id, "Comment id"),
    body: requireText(body, "Comment body"),
    topics: [...new Set(topics.map((topic) => requireText(topic, "Comment topic")))],
    ...(author === undefined ? {} : { author: requireText(author, "Comment author") }),
    createdAt: now.toISOString()
  };
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
