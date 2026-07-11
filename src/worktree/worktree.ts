export type RoleWorktree = {
  schemaVersion: 1;
  taskId: string;
  roleName: string;
  repository: string;
  path: string;
  branch: string;
  base?: string;
  createdAt: string;
};

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
    taskId,
    roleName,
    repository,
    path,
    branch,
    ...(base === undefined ? {} : { base }),
    createdAt: now.toISOString()
  };
}
