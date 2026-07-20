export type RoleWorktree = Readonly<{
  schemaVersion: 1;
  taskId: string;
  roleName: string;
  repository: string;
  path: string;
  branch: string;
  base?: string;
  createdAt: string;
}>;

export function createRoleWorktree(
  taskId: string,
  roleName: string,
  repository: string,
  path: string,
  branch: string,
  base: string | undefined,
  now: Date
): RoleWorktree {
  return {
    schemaVersion: 1,
    taskId: requireText(taskId, "Task id"),
    roleName: requireText(roleName, "Role name"),
    repository: requireText(repository, "repository"),
    path: requireText(path, "worktree path"),
    branch: requireText(branch, "worktree branch"),
    ...(base === undefined ? {} : { base: requireText(base, "worktree base") }),
    createdAt: now.toISOString()
  };
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
