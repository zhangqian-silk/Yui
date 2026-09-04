import type { TaskCompletedBy } from "../task/task.js";
import { usageError } from "../errors/cliError.js";
import type { DurableJobCaller } from "../controller/jobControl.js";
import {
  MANAGED_CALLER_KEY_ENV,
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
    || env[MANAGED_CALLER_KEY_ENV] !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return "user";
}

/**
 * Resolve authority for a recoverable Task-local mutation. A managed Leader
 * does not gain that authority from long-lived process environment alone. Its
 * process proves only that Yui launched it for this Task Role; whether it is
 * still the current runtime, and which Turn is current, are read from durable
 * state at command time. Plain-user and global-Operator behavior is unchanged.
 */
export function taskLocalActor(
  store: ManagedCallerStore,
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string
): TaskCompletedBy {
  const actor = taskActor(environment, taskId);
  if (actor !== "leader") return actor;
  if (taskLeaderActionTurnId(store, taskId, environment) === undefined) {
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
    || env[MANAGED_CALLER_KEY_ENV] !== undefined
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
 * The identity is Controller-verified rather than self-reported. A managed
 * Task Session reports only its immutable self-identity (Task, Role, caller
 * key); the Controller resolves the current Turn from durable state, so no
 * Turn is ever carried across Turns in a long-lived process environment.
 *
 * rr13: A managed Task Session also carries `callerKey` — the
 * `YUI_JOB_CALLER_KEY` injected at its native Session launch. The Controller
 * hashes it and compares against the durable `jobCallerKeyHashes` map, so a
 * client that reads durable state cannot replay the caller. A `user`-scope
 * caller is rejected outright for job.start/job.cancel (fail-closed); a
 * managed global Agent carries its own durable Session identity.
 *
 * A managed Task Session may only start jobs for its own Task. An incomplete
 * managed identity (role/agent/caller-key vars without a scope) is rejected
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
    const callerKey = env[MANAGED_CALLER_KEY_ENV];
    // The Turn is deliberately absent: the Controller reads the current Turn
    // for this Task Role from durable state when it authorizes the request.
    return {
      scope: "task",
      taskId,
      role,
      ...(callerKey === undefined ? {} : { callerKey })
    };
  }
  if (env.YUI_SESSION_SCOPE === "global") {
    return {
      scope: "global",
      role: env.YUI_ROLE,
      agentId: env.YUI_AGENT_ID,
      adapterId: env.YUI_ADAPTER_ID,
      runtimeGenerationId: env.YUI_RUNTIME_GENERATION_ID,
      nativeSessionId: env.YUI_NATIVE_SESSION_ID
    };
  }
  if (
    env.YUI_ROLE !== undefined
    || env.YUI_AGENT_ID !== undefined
    || env[MANAGED_CALLER_KEY_ENV] !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return { scope: "user" };
}

/**
 * Resolve the current Task Leader Turn for event attribution and Task-local
 * Leader authority.
 *
 * A long-lived managed process cannot carry this: its environment is frozen at
 * launch, so any Turn it holds is stale the moment Yui advances the Task. The
 * Turn is therefore read from durable state, and the process only has to prove
 * that it is still the current runtime of the Leader Role through its
 * per-Session caller key. When the Role has no active Turn, or the process has
 * been superseded, there is simply no Leader action window.
 */
export function taskLeaderActionTurnId(
  store: ManagedCallerStore,
  taskId: string,
  environment: NodeJS.ProcessEnv | undefined
): string | undefined {
  return currentManagedRuntime(store, environment, taskId, LEADER_ROLE)?.currentTurnId;
}
