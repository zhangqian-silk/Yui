import type { TaskCompletedBy } from "../task/task.js";
import { usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import { activeRoleAgentBinding } from "../role/role.js";

const LEADER_ROLE = "leader";

export function taskActor(
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string
): TaskCompletedBy {
  const env = environment ?? {};
  if (
    env.YUI_SESSION_SCOPE === "task"
    && env.YUI_TASK_ID === taskId
    && env.YUI_ROLE === "leader"
  ) {
    return "leader";
  }
  if (env.YUI_SESSION_SCOPE === "task") {
    throw usageError(
      `A managed Task Session may perform this action only as the matching Leader: ${taskId}.`
    );
  }
  if (env.YUI_SESSION_SCOPE === "global") {
    if (env.YUI_ROLE === "operator") return "operator";
    throw usageError("A managed global Session may perform this action only as Operator.");
  }
  if (
    env.YUI_ROLE !== undefined
    || env.YUI_AGENT_ID !== undefined
    || env.YUI_RUN_ID !== undefined
    || env.YUI_NATIVE_SESSION_ID !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return "user";
}

/**
 * Resolve an exact current Task Leader Run for event attribution.
 *
 * Task commands may be invoked by a managed process whose environment is
 * stale, incomplete, or copied from another Run.  A bare YUI_RUN_ID is never
 * enough: the active durable Run, Role, in-flight receipt, native Session,
 * launch generation, and (when supplied) Home must all agree before an
 * allowlisted lifecycle event can buy a Leader action window.
 */
export function taskLeaderActionRunId(
  store: Pick<
    TaskStore,
    "getRole" | "getActiveAgentRun" | "getTaskRoleSessionSet"
  >,
  taskId: string,
  environment: NodeJS.ProcessEnv | undefined,
  yuiHome?: string
): string | undefined {
  const env = environment ?? {};
  if (env.YUI_SESSION_SCOPE !== "task" || env.YUI_ROLE !== LEADER_ROLE) return undefined;
  if (identity(env.YUI_TASK_ID) !== taskId) return undefined;
  const runId = identity(env.YUI_RUN_ID);
  const agentId = identity(env.YUI_AGENT_ID);
  const adapterId = identity(env.YUI_ADAPTER_ID);
  const launchId = identity(env.YUI_LAUNCH_ID);
  const home = identity(env.YUI_HOME);
  if (
    runId === undefined
    || agentId === undefined
    || adapterId === undefined
    || launchId === undefined
    || home === undefined
  ) {
    return undefined;
  }
  const storeHome = typeof (store as { rootDirectory?: unknown }).rootDirectory === "function"
    ? (store as unknown as { rootDirectory(): string }).rootDirectory()
    : undefined;
  if (yuiHome !== undefined && home !== yuiHome) return undefined;
  if (yuiHome === undefined && storeHome !== undefined && home !== storeHome) return undefined;

  const role = store.getRole(taskId, LEADER_ROLE);
  const run = store.getActiveAgentRun(taskId, LEADER_ROLE);
  const sessions = store.getTaskRoleSessionSet(taskId, LEADER_ROLE);
  if (
    role === null
    || run === null
    || run.status !== "active"
    || run.id !== runId
    || run.taskId !== taskId
    || run.roleName !== LEADER_ROLE
    || run.effective.agentId !== agentId
    || run.effective.adapterId !== adapterId
    || role.activeAgentId !== agentId
    || activeRoleAgentBinding(role).adapterId !== adapterId
    || sessions === null
    || sessions.owner.scope !== "task"
    || sessions.owner.taskId !== taskId
    || sessions.owner.roleName !== LEADER_ROLE
    || sessions.activeAgentId !== agentId
    || sessions.inFlight === null
    || sessions.inFlight.runId !== runId
    || sessions.inFlight.agentId !== agentId
  ) return undefined;

  const session = sessions.sessions[agentId];
  if (
    session === undefined
    || session.status === "stopped"
    || session.status === "broken"
    || session.adapterId !== adapterId
    || session.launchId !== launchId
  ) return undefined;
  if (
    env.YUI_NATIVE_SESSION_ID !== undefined
    && env.YUI_NATIVE_SESSION_ID !== session.nativeSessionId
  ) return undefined;
  return run.id;
}

function identity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 || normalized !== value ? undefined : normalized;
}
