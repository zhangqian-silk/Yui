import type { TaskCompletedBy } from "../task/task.js";
import { usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import { activeRoleAgentBinding } from "../role/role.js";
import type { DurableJobCaller } from "../controller/jobControl.js";
import { managedProviderTurnId } from "../runtime/providerRuntimeIdentity.js";

const LEADER_ROLE = "leader";
const LEADER_ACTION_RUN_ENV = "YUI_LEADER_ACTION_TURN_ID";
const LEADER_ACTION_RECEIPT_ENV = "YUI_LEADER_ACTION_RECEIPT_ID";
/** rr13: Per-Session DurableJob caller key injected at native Session launch. */
const JOB_CALLER_KEY_ENV = "YUI_JOB_CALLER_KEY";

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
    || env.YUI_TURN_ID !== undefined
    || env.YUI_NATIVE_SESSION_ID !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return "user";
}

/**
 * Resolve authority for a recoverable Task-local mutation. A managed Leader
 * does not gain that authority from long-lived process environment alone: the
 * command must carry the exact current Turn assertion and it must still match
 * the durable active Turn, receipt, Role binding, native Session, and Home.
 * Plain-user and global-Operator behavior remains unchanged.
 */
export function taskLocalActor(
  store: Pick<
    TaskStore,
    "getRole" | "getActiveTurn" | "getTaskRoleSessionSet"
  >,
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string,
  yuiHome?: string
): TaskCompletedBy {
  const actor = taskActor(environment, taskId);
  if (actor !== "leader") return actor;
  if (taskLeaderActionTurnId(store, taskId, environment, yuiHome) === undefined) {
    throw usageError(
      `Task-local Leader authority requires the current Provider Turn: ${taskId}.`
    );
  }
  return actor;
}

/**
 * Resolve the caller identity for Project-scoped authority. Project Knowledge
 * is an Operator-level authority: a managed Task Session (Leader/Reviewer/
 * Worker) may propose candidates but must not write the authoritative
 * Knowledge list directly. A managed global Session must be the Operator; a
 * plain terminal is the human Operator.
 */
export type ProjectActor = "user" | "operator" | "agent";

export function projectActor(environment: NodeJS.ProcessEnv | undefined): ProjectActor {
  const env = environment ?? {};
  if (env.YUI_SESSION_SCOPE === "task") return "agent";
  if (env.YUI_SESSION_SCOPE === "global") {
    if (env.YUI_ROLE === "operator") return "operator";
    throw usageError("A managed global Session may manage Project Knowledge only as Operator.");
  }
  if (
    env.YUI_ROLE !== undefined
    || env.YUI_AGENT_ID !== undefined
    || env.YUI_TURN_ID !== undefined
    || env.YUI_NATIVE_SESSION_ID !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return "user";
}

/**
 * rr8: Resolve the caller identity for a `job.start`/`job.cancel` request from
 * the managed Session environment. The Controller verifies the Agent Session
 * and its scope; Role does not narrow Task control authority.
 *
 * rr12: The identity is now Controller-verified rather than self-reported:
 * - A managed Task Session (`YUI_SESSION_SCOPE=task`) returns `scope: "task"`
 *   with its Role and Turn. For a Leader, the explicit current Turn id is
 *   preferred over a possibly stale `YUI_TURN_ID`.
 *
 * rr13: A managed Task Session also carries `callerKey` — the
 * `YUI_JOB_CALLER_KEY` injected at its native Session launch. The Controller
 * hashes it and compares against the durable `jobCallerKeyHashes` map, so a
 * client that reads durable state cannot replay the caller. A `user`-scope
 * caller is rejected outright for job.start/job.cancel (fail-closed); a
 * managed global Agent carries its own durable Session identity.
 *
 * A managed Task Session may only start jobs for its own Task. An incomplete
 * managed identity (role/agent/Turn/Session vars without a scope) is rejected
 * rather than silently downgraded to user authority.
 */
export function resolveJobCaller(
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string
): DurableJobCaller {
  const env = environment ?? {};
  if (env.YUI_SESSION_SCOPE === "task") {
    if (env.YUI_TASK_ID !== taskId) {
      throw usageError(
        "A managed Task Session may not start Jobs for a different Task."
      );
    }
    const role = env.YUI_ROLE;
    // rr13: Carry the per-Session caller key so the Controller can verify the
    // channel binding. Absent on a managed Session = fail-closed at the
    // Controller boundary.
    const callerKey = env[JOB_CALLER_KEY_ENV];
    if (role === LEADER_ROLE) {
      // Prefer the explicit current Turn over a possibly stale YUI_TURN_ID.
      const assertion = leaderActionAssertion(env);
      if (assertion !== undefined && assertion !== "invalid") {
        return {
          scope: "task",
          taskId,
          role,
          turnId: assertion.turnId,
          ...(callerKey === undefined ? {} : { callerKey })
        };
      }
    }
    return {
      scope: "task",
      taskId,
      role,
      ...(env.YUI_TURN_ID === undefined ? {} : { turnId: env.YUI_TURN_ID }),
      ...(callerKey === undefined ? {} : { callerKey })
    };
  }
  if (env.YUI_SESSION_SCOPE === "global") {
    return {
      scope: "global",
      role: env.YUI_ROLE,
      agentId: env.YUI_AGENT_ID,
      adapterId: env.YUI_ADAPTER_ID,
      launchId: env.YUI_LAUNCH_ID,
      nativeSessionId: env.YUI_NATIVE_SESSION_ID
    };
  }
  if (
    env.YUI_ROLE !== undefined
    || env.YUI_AGENT_ID !== undefined
    || env.YUI_TURN_ID !== undefined
    || env.YUI_NATIVE_SESSION_ID !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return { scope: "user" };
}

/**
 * Resolve an exact current Task Leader Turn for event attribution.
 *
 * Task commands may be invoked by a managed process whose environment is
 * stale, incomplete, or copied from another Turn. A bare YUI_TURN_ID is never
 * enough: the active durable Turn, Role, in-flight receipt, native Session,
 * launch generation, and (when supplied) Home must all agree before an
 * allowlisted lifecycle event can buy a Leader action window.  A fixed native
 * Session may keep an earlier Turn/launch in its process environment; in that
 * case the current Leader turn must explicitly carry the exact durable
 * Turn/receipt pair through the two command-only assertion variables below.
 */
export function taskLeaderActionTurnId(
  store: Pick<
    TaskStore,
    "getRole" | "getActiveTurn" | "getTaskRoleSessionSet"
  >,
  taskId: string,
  environment: NodeJS.ProcessEnv | undefined,
  yuiHome?: string
): string | undefined {
  const env = environment ?? {};
  if (env.YUI_SESSION_SCOPE !== "task" || env.YUI_ROLE !== LEADER_ROLE) return undefined;
  if (identity(env.YUI_TASK_ID) !== taskId) return undefined;
  const environmentAssertion = leaderActionAssertion(env);
  if (environmentAssertion === "invalid") return undefined;
  const explicitAssertion = environmentAssertion === undefined ? undefined : environmentAssertion;
  const observedTurnTurnId = managedProviderTurnId(
    store.getTaskRoleSessionSet(taskId, LEADER_ROLE)?.providerBinding?.turn
  ) ?? undefined;
  const turnId = explicitAssertion?.turnId ?? observedTurnTurnId ?? identity(env.YUI_TURN_ID);
  const agentId = identity(env.YUI_AGENT_ID);
  const adapterId = identity(env.YUI_ADAPTER_ID);
  const launchId = identity(env.YUI_LAUNCH_ID);
  const home = identity(env.YUI_HOME);
  if (
    turnId === undefined
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
  const run = store.getActiveTurn(taskId, LEADER_ROLE);
  const sessions = store.getTaskRoleSessionSet(taskId, LEADER_ROLE);
  if (
    role === null
    || run === null
    || run.status !== "active"
    || run.id !== turnId
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
    || managedProviderTurnId(sessions.providerBinding?.turn) !== turnId
  ) return undefined;

  const session = sessions.sessions[agentId];
  if (
    session === undefined
    || identity(session.nativeSessionId) === undefined
    || identity(session.launchId) === undefined
    || session.status === "ended"
    || session.adapterId !== adapterId
    || (explicitAssertion === undefined && session.launchId !== launchId)
  ) return undefined;
  if (
    env.YUI_NATIVE_SESSION_ID !== undefined
    && env.YUI_NATIVE_SESSION_ID !== session.nativeSessionId
  ) return undefined;
  return run.id;
}

function leaderActionAssertion(
  environment: NodeJS.ProcessEnv
): Readonly<{ turnId: string; receiptId: string }> | undefined | "invalid" {
  const turnId = environment[LEADER_ACTION_RUN_ENV];
  const receiptId = environment[LEADER_ACTION_RECEIPT_ENV];
  if (turnId === undefined && receiptId === undefined) return undefined;
  const normalizedTurnId = identity(turnId);
  const normalizedReceiptId = identity(receiptId);
  return normalizedTurnId === undefined || normalizedReceiptId === undefined
    ? "invalid"
    : { turnId: normalizedTurnId, receiptId: normalizedReceiptId };
}

function identity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 || normalized !== value ? undefined : normalized;
}
