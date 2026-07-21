import type { RoleAgentSession } from "../executor/agentExecutor.js";
import type { AgentRun } from "../run/agentRun.js";
import type { TaskRole } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxRolePaneState } from "../tmux/tmuxManager.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { RoleWorkspace } from "../worktree/roleWorkspace.js";

export type TaskRoleHealth =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "blocked-input"
  | "needs-attention"
  | "failed";

export type TaskRoleTmuxStatus = Readonly<{
  state: "missing" | "running" | "exited";
  target?: string;
  dead?: boolean;
  pid?: number;
  currentCommand?: string;
}>;

export type TaskRoleWorkspaceStatus =
  | Readonly<{ managed: false; path: string }>
  | Readonly<{ managed: true } & RoleWorkspace>;

export type TaskRoleRuntimeStatus = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  health: TaskRoleHealth;
  healthReason: string;
  openInputRequestCount: number;
  role: TaskRole;
  activeRun: AgentRun | null;
  activeWork: WorkItem | null;
  nativeSession: RoleAgentSession | null;
  tmux: TaskRoleTmuxStatus;
  workspace: TaskRoleWorkspaceStatus;
}>;

export function inspectTaskRoleRuntimeStatuses(
  taskId: string,
  roles: readonly TaskRole[],
  store: TaskStore,
  panes: readonly TmuxRolePaneState[]
): TaskRoleRuntimeStatus[] {
  const taskOpenInputRequestCount = store.listInputRequests(taskId)
    .filter((request) => request.status === "open").length;
  const panesByRole = new Map<string, TmuxRolePaneState>();
  for (const pane of panes) {
    const current = panesByRole.get(pane.roleName);
    if (current === undefined || current.dead && !pane.dead) panesByRole.set(pane.roleName, pane);
  }
  return roles.map((role) => inspectTaskRoleRuntimeStatus(
    taskId,
    role,
    store,
    panesByRole.get(role.name),
    role.name === "leader" ? taskOpenInputRequestCount : 0
  ));
}

export function renderTaskRoleRuntimeStatus(status: TaskRoleRuntimeStatus): string {
  const activeRun = status.activeRun === null
    ? "-"
    : `${status.activeRun.id} (${status.activeRun.deliveredAt === undefined ? "queued" : "delivered"})`;
  const activeWork = status.activeWork === null
    ? "-"
    : `${status.activeWork.id} (${status.activeWork.status}) ${status.activeWork.title}`;
  const nativeSession = status.nativeSession === null
    ? "not recorded"
    : `${status.nativeSession.nativeSessionId} (${status.nativeSession.status}, ${status.nativeSession.adapterId})`;
  const tmux = status.tmux.state === "missing"
    ? "missing"
    : [
        status.tmux.state,
        status.tmux.currentCommand === undefined ? undefined : `command=${status.tmux.currentCommand}`,
        status.tmux.pid === undefined ? undefined : `pid=${status.tmux.pid}`,
        status.tmux.target
      ].filter((value): value is string => value !== undefined).join(", ");
  const workspaceDetails = status.workspace.managed
    ? [
        `  Repository       ${status.workspace.repositoryId}`,
        `  Branch           ${status.workspace.branch}`,
        `  Base             ${status.workspace.baseRef} (${status.workspace.baseCommit})`
      ]
    : [];
  return [
    `Task Role status: ${status.taskId}/${status.roleName}`,
    "",
    `  Health           ${status.health}`,
    `  Reason           ${status.healthReason}`,
    `  Open inputs      ${status.openInputRequestCount}`,
    `  Agent            ${status.agentId}`,
    `  Role state       ${status.role.status}`,
    `  Active work      ${activeWork}`,
    `  Active run       ${activeRun}`,
    `  Native session   ${nativeSession}`,
    `  tmux pane        ${tmux}`,
    `  Workspace        ${status.workspace.path}`,
    ...workspaceDetails
  ].join("\n").concat("\n");
}

export function taskRoleActiveWorkLabel(status: TaskRoleRuntimeStatus): string {
  if (status.activeWork !== null) return `${status.activeWork.id}: ${status.activeWork.title}`;
  return status.activeRun === null ? "-" : status.activeRun.id;
}

export function taskRoleNativeSessionLabel(status: TaskRoleRuntimeStatus): string {
  return status.nativeSession?.status ?? "unbound";
}

export function taskRoleOpenInputLabel(status: TaskRoleRuntimeStatus): string {
  return status.roleName === "leader" && status.openInputRequestCount > 0
    ? String(status.openInputRequestCount)
    : "-";
}

export function taskRoleTmuxLabel(status: TaskRoleRuntimeStatus): string {
  if (status.tmux.state !== "running") return status.tmux.state;
  return status.tmux.currentCommand === undefined
    ? "running"
    : `running (${status.tmux.currentCommand})`;
}

function inspectTaskRoleRuntimeStatus(
  taskId: string,
  role: TaskRole,
  store: TaskStore,
  pane: TmuxRolePaneState | undefined,
  openInputRequestCount: number
): TaskRoleRuntimeStatus {
  const activeRun = store.getActiveAgentRun(taskId, role.name);
  const activeWork = activeRun?.workItemId === undefined
    ? null
    : store.getWorkItem(taskId, activeRun.workItemId);
  const sessions = store.getTaskRoleSessionSet(taskId, role.name);
  const nativeSession = sessions?.sessions[role.activeAgentId] ?? null;
  const tmux: TaskRoleTmuxStatus = pane === undefined
    ? { state: "missing" }
    : {
        state: pane.dead ? "exited" : "running",
        target: pane.target,
        dead: pane.dead,
        ...(pane.pid === undefined ? {} : { pid: pane.pid }),
        currentCommand: pane.currentCommand
      };
  const managedWorkspace = store.getRoleWorkspace(taskId, role.name);
  const workspace: TaskRoleWorkspaceStatus = managedWorkspace === null
    ? { managed: false, path: role.workspace }
    : { ...managedWorkspace, managed: true };
  const health = calculateHealth(
    role,
    activeRun,
    nativeSession,
    tmux,
    openInputRequestCount
  );
  return {
    taskId,
    roleName: role.name,
    agentId: role.activeAgentId,
    ...health,
    openInputRequestCount,
    role,
    activeRun,
    activeWork,
    nativeSession,
    tmux,
    workspace
  };
}

function calculateHealth(
  role: TaskRole,
  activeRun: AgentRun | null,
  nativeSession: RoleAgentSession | null,
  tmux: TaskRoleTmuxStatus,
  openInputRequestCount: number
): Pick<TaskRoleRuntimeStatus, "health" | "healthReason"> {
  if (role.status === "failed" || role.status === "exited") {
    return { health: "failed", healthReason: `persisted Role state is ${role.status}` };
  }
  if (nativeSession?.status === "broken") {
    return { health: "failed", healthReason: "the active native session is broken" };
  }
  if (tmux.state === "exited") {
    return { health: "failed", healthReason: "the tmux pane has exited" };
  }
  if (activeRun !== null) {
    if (role.status !== "running") {
      return {
        health: "needs-attention",
        healthReason: `the active Run conflicts with persisted Role state ${role.status}`
      };
    }
    if (activeRun.deliveredAt !== undefined && tmux.state !== "running") {
      return { health: "needs-attention", healthReason: "the delivered active Run has no live tmux pane" };
    }
  }
  if (activeRun === null && role.status === "running") {
    return { health: "needs-attention", healthReason: "the Role is running without an active Run" };
  }
  if (nativeSession?.status === "running" && tmux.state !== "running") {
    return { health: "needs-attention", healthReason: "the native session is running without a live tmux pane" };
  }
  if (nativeSession?.status === "stopped" && tmux.state === "running") {
    return { health: "needs-attention", healthReason: "a stopped native session has a live tmux pane" };
  }
  if (role.name === "leader" && openInputRequestCount > 0) {
    return {
      health: "blocked-input",
      healthReason: `${openInputRequestCount} open InputRequest${openInputRequestCount === 1 ? "" : "s"} require user input`
    };
  }
  if (activeRun !== null) {
    return activeRun.deliveredAt === undefined
      ? { health: "starting", healthReason: "the active Run is awaiting tmux delivery" }
      : { health: "running", healthReason: "the active Run has a live tmux pane" };
  }
  return tmux.state === "running"
    ? { health: "ready", healthReason: "the native Agent pane is ready without active work" }
    : { health: "idle", healthReason: "there is no active work or live tmux pane" };
}
