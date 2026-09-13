import type { TaskCompletedBy } from "../task/task.js";
import { usageError } from "../errors/cliError.js";
import type { DurableJobCaller } from "../controller/jobControl.js";
import {
  MANAGED_NATIVE_SESSION_ENV,
  currentManagedRuntime,
  type ManagedCallerStore
} from "../runtime/managedCaller.js";

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
    || env[MANAGED_NATIVE_SESSION_ENV] !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return "user";
}

/**
 * Resolve authority for a recoverable Task-local mutation. A managed Leader
 * does not gain that authority from long-lived process environment alone. Its
 * process proves only that Yui launched it for this Task Role; whether it is
 * still the current Session is read from durable state at command time.
 * Execution occupancy is not management authority.
 */
export function taskLocalActor(
  store: ManagedCallerStore,
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string
): TaskCompletedBy {
  const actor = taskActor(environment, taskId);
  if (actor !== "leader") return actor;
  if (currentManagedRuntime(store, environment, taskId, LEADER_ROLE) === undefined) {
    throw usageError(
      `Task-local Leader authority requires the current native Session: ${taskId}.`
    );
  }
  return actor;
}

/** Planning conversations may save facts; delivery checks the immutable
 * native Session authority, not the Task's newly activated status.
 */
export function assertTaskDeliveryAuthority(
  store: ManagedCallerStore, environment: NodeJS.ProcessEnv | undefined, taskId: string
): TaskCompletedBy {
  const actor = taskLocalActor(store, environment, taskId);
  if (actor !== "leader") return actor;
  const caller = currentManagedRuntime(store, environment, taskId, LEADER_ROLE);
  if (caller?.executionAuthority !== "delivery") {
    throw usageError("This native Session has planning authority, not delivery authority. Use a delivery Session for this operation.");
  }
  return actor;
}

/**
 * Authority for a live steer/interrupt of an exact current native Turn
 * (decision-3 §1/§9, message-5 gap B). The legal evidence is the native
 * Turn/Session, not planning→delivery elevation and not an AgentRun's existence:
 * the resolution proves a present Turn under the caller's own current Session, so
 * a planning (Draft) Leader may legally control its own management/planning Turn.
 *
 * Delivery authority is required only when a managed Leader redirects INTO a
 * Worker/Reviewer execution Assignment (targetRole other than the Leader itself),
 * which is the same boundary the addressed-Message send path enforces — a
 * planning Session must not start or redirect execution work. A user or operator
 * caller, and a Leader controlling its own Turn, need only be the current
 * Session; an incomplete managed identity is refused by {@link taskLocalActor}.
 */
export function assertTaskInputControlAuthority(
  store: ManagedCallerStore, environment: NodeJS.ProcessEnv | undefined,
  taskId: string, targetRole: string
): TaskCompletedBy {
  const actor = taskLocalActor(store, environment, taskId);
  if (actor !== "leader" || targetRole === LEADER_ROLE) return actor;
  const caller = currentManagedRuntime(store, environment, taskId, LEADER_ROLE);
  if (caller?.executionAuthority !== "delivery") {
    throw usageError("This native Session has planning authority, not delivery authority. "
      + "Redirecting a Worker or Reviewer Assignment requires a delivery Session.");
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
    || env[MANAGED_NATIVE_SESSION_ENV] !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return "user";
}

/**
 * Resolve the caller's Task, Role and native Session identity. The Controller
 * verifies it against durable state and supplies the current AgentRun. A Task
 * caller cannot control another Task; an incomplete identity is not a user.
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
    const nativeSessionId = env.CODEX_THREAD_ID ?? env.YUI_NATIVE_SESSION_ID;
    // The AgentRun is deliberately absent: the Controller reads the current AgentRun
    // for this Task Role from durable state when it authorizes the request.
    return {
      scope: "task",
      taskId,
      role,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId })
    };
  }
  if (env.YUI_SESSION_SCOPE === "global") {
    return {
      scope: "global",
      role: env.YUI_ROLE,
      agentId: env.YUI_AGENT_ID,
      adapterId: env.YUI_ADAPTER_ID,
      nativeSessionId: env.CODEX_THREAD_ID ?? env.YUI_NATIVE_SESSION_ID
    };
  }
  if (
    env.YUI_ROLE !== undefined
    || env.YUI_AGENT_ID !== undefined
    || env[MANAGED_NATIVE_SESSION_ENV] !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return { scope: "user" };
}
