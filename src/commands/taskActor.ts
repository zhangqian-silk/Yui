import type { TaskCompletedBy } from "../task/task.js";
import { usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import { activeRoleAgentBinding } from "../role/role.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import { agentRunDeliveryReceiptId } from "../run/agentRun.js";
import type { DurableJobCaller } from "../controller/jobControl.js";

const LEADER_ROLE = "leader";
const LEADER_ACTION_RUN_ENV = "YUI_LEADER_ACTION_RUN_ID";
const LEADER_ACTION_RECEIPT_ENV = "YUI_LEADER_ACTION_RECEIPT_ID";
/** rr13: Per-Session DurableJob caller key injected at native Session launch. */
const JOB_CALLER_KEY_ENV = "YUI_JOB_CALLER_KEY";

/**
 * rr12: The store subset `resolveJobCaller` needs to resolve a user-scope
 * caller's Leader assertion. Kept structural so the Controller client layer
 * does not take a hard dependency on the full TaskStore type.
 */
export type JobCallerStore = Pick<
  TaskStore,
  "getRole" | "getActiveAgentRun" | "getTaskRoleSessionSet"
>;

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
 * Resolve authority for a recoverable Task-local mutation. A managed Leader
 * does not gain that authority from long-lived process environment alone: the
 * command must carry the exact current Turn assertion and it must still match
 * the durable active Run, receipt, Role binding, native Session, and Home.
 * Plain-user and global-Operator behavior remains unchanged.
 */
export function taskLocalActor(
  store: Pick<
    TaskStore,
    "getRole" | "getActiveAgentRun" | "getTaskRoleSessionSet"
  >,
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string,
  yuiHome?: string
): TaskCompletedBy {
  const actor = taskActor(environment, taskId);
  if (actor !== "leader") return actor;
  const assertion = leaderActionAssertion(environment ?? {});
  if (assertion === undefined || assertion === "invalid"
    || taskLeaderActionRunId(store, taskId, environment, yuiHome) === undefined) {
    throw usageError(
      `Task-local Leader authority requires the exact current-Turn assertion: ${taskId}.`
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
    || env.YUI_RUN_ID !== undefined
    || env.YUI_NATIVE_SESSION_ID !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return "user";
}

/**
 * rr8: Resolve the caller identity for a `job.start`/`job.cancel` request from
 * the managed Session environment. The Controller binds the declared job owner
 * to this identity — a Reviewer is rejected outright, a Worker can only touch
 * its own Work Item's jobs, and a Leader or plain user retains full access.
 *
 * rr12: The identity is now Controller-verified rather than self-reported:
 * - A managed Task Session (`YUI_SESSION_SCOPE=task`) returns `scope: "task"`
 *   with its Role and Run. A Leader additionally carries the current in-flight
 *   Turn receipt (preferring the explicit `YUI_LEADER_ACTION_*` assertion over
 *   a possibly-stale `YUI_RUN_ID`), which the Controller verifies through the
 *   same active-Run + in-flight + Session check as `job.acknowledge`.
 *
 * rr13: A managed Task Session also carries `callerKey` — the
 * `YUI_JOB_CALLER_KEY` injected at its native Session launch. The Controller
 * hashes it and compares against the durable `jobCallerKeyHashes` map, so a
 * client that reads durable state cannot replay the caller. A `user`-scope
 * caller is rejected outright for job.start/job.cancel (fail-closed); the
 * human operator acts through the Leader Session.
 *
 * A managed Task Session may only start jobs for its own Task. An incomplete
 * managed identity (role/agent/run/session vars without a scope) is rejected
 * rather than silently downgraded to user authority.
 */
export function resolveJobCaller(
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string,
  store?: JobCallerStore
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
      // Prefer the explicit current-turn Leader assertion over a possibly
      // stale YUI_RUN_ID/launch. The Controller verifies it against the
      // active in-flight Leader Run.
      const assertion = leaderActionAssertion(env);
      if (assertion !== undefined && assertion !== "invalid") {
        return {
          scope: "task",
          taskId,
          role,
          runId: assertion.runId,
          receiptId: assertion.receiptId,
          ...(callerKey === undefined ? {} : { callerKey })
        };
      }
    }
    return {
      scope: "task",
      taskId,
      role,
      ...(env.YUI_RUN_ID === undefined ? {} : { runId: env.YUI_RUN_ID }),
      ...(callerKey === undefined ? {} : { callerKey })
    };
  }
  if (env.YUI_SESSION_SCOPE === "global") {
    return userCaller(store, taskId);
  }
  if (
    env.YUI_ROLE !== undefined
    || env.YUI_AGENT_ID !== undefined
    || env.YUI_RUN_ID !== undefined
    || env.YUI_NATIVE_SESSION_ID !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return userCaller(store, taskId);
}

/**
 * rr12: Build a `scope: "user"` caller. When a store is available, attach the
 * active in-flight Leader assertion so the Controller can verify the request
 * acts under real Leader authority. Without a store, return the bare
 * `{scope: "user"}` which the Controller rejects (fail-closed).
 */
function userCaller(
  store: JobCallerStore | undefined,
  taskId: string
): DurableJobCaller {
  if (store === undefined) return { scope: "user" };
  const runId = activeLeaderRunId(store, taskId);
  if (runId === undefined) {
    throw usageError(
      "job.start/job.cancel user scope requires an active in-flight Task Leader: "
      + `${taskId}.`
    );
  }
  return {
    scope: "user",
    leaderAssertion: {
      runId,
      receiptId: formatAgentRunReceiptId(taskId, runId)
    }
  };
}

/**
 * rr12: Resolve the current in-flight Task Leader Run for a non-managed
 * (operator/bare-shell) caller. Unlike `taskLeaderActionRunId`, this does not
 * require managed Leader environment variables — it verifies the durable
 * state directly: an active Leader Run whose Role Session is currently
 * in-flight with the matching receipt. Returns undefined when no Leader is
 * active or in flight.
 */
function activeLeaderRunId(
  store: JobCallerStore,
  taskId: string
): string | undefined {
  const run = store.getActiveAgentRun(taskId, LEADER_ROLE);
  if (run === null || run.status !== "active" || run.roleName !== LEADER_ROLE) {
    return undefined;
  }
  const sessions = store.getTaskRoleSessionSet(taskId, LEADER_ROLE);
  const expectedReceipt = agentRunDeliveryReceiptId(run);
  if (
    sessions === null
    || sessions.inFlight === null
    || sessions.inFlight.runId !== run.id
    || sessions.inFlight.receiptId !== expectedReceipt
  ) {
    return undefined;
  }
  return run.id;
}

/**
 * Resolve an exact current Task Leader Run for event attribution.
 *
 * Task commands may be invoked by a managed process whose environment is
 * stale, incomplete, or copied from another Run.  A bare YUI_RUN_ID is never
 * enough: the active durable Run, Role, in-flight receipt, native Session,
 * launch generation, and (when supplied) Home must all agree before an
 * allowlisted lifecycle event can buy a Leader action window.  A fixed native
 * Session may keep an earlier Run/launch in its process environment; in that
 * case the current Leader turn must explicitly carry the exact durable
 * Run/receipt pair through the two command-only assertion variables below.
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
  const environmentAssertion = leaderActionAssertion(env);
  if (environmentAssertion === "invalid") return undefined;
  const explicitAssertion = environmentAssertion === undefined ? undefined : environmentAssertion;
  const runId = explicitAssertion?.runId ?? identity(env.YUI_RUN_ID);
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
    || sessions.inFlight.receiptId !== agentRunDeliveryReceiptId(run)
  ) return undefined;
  if (
    explicitAssertion !== undefined
    && explicitAssertion.receiptId !== formatAgentRunReceiptId(taskId, runId)
  ) return undefined;

  const session = sessions.sessions[agentId];
  if (
    session === undefined
    || identity(session.nativeSessionId) === undefined
    || identity(session.launchId) === undefined
    || session.status === "stopped"
    || session.status === "broken"
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
): Readonly<{ runId: string; receiptId: string }> | undefined | "invalid" {
  const runId = environment[LEADER_ACTION_RUN_ENV];
  const receiptId = environment[LEADER_ACTION_RECEIPT_ENV];
  if (runId === undefined && receiptId === undefined) return undefined;
  const normalizedRunId = identity(runId);
  const normalizedReceiptId = identity(receiptId);
  return normalizedRunId === undefined || normalizedReceiptId === undefined
    ? "invalid"
    : { runId: normalizedRunId, receiptId: normalizedReceiptId };
}

function identity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 || normalized !== value ? undefined : normalized;
}
