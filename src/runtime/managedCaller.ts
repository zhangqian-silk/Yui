import { createHash } from "node:crypto";

import { activeRoleAgentBinding } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";

/** Per-process credential injected at native Session launch. */
export const MANAGED_CALLER_KEY_ENV = "YUI_JOB_CALLER_KEY";

/**
 * One authority for "is this process the current runtime of a Task Role?".
 *
 * A managed Session process carries only immutable self-identity in its
 * environment: its Home, scope, Task, Role, workspace, and a non-replayable
 * caller key. Everything volatile - the active Agent, adapter, launch
 * generation, native Session, and Turn - is read from durable state at command
 * time, because a live process environment can never be updated in place and
 * therefore must never carry cross-Turn state.
 *
 * The caller key already has the exact staleness semantics this needs: Yui
 * commits a fresh durable hash whenever it starts a new Host or replaces the
 * native Conversation, and keeps the old hash for a same-Conversation resume.
 * A superseded process therefore fails this check on its own, with no side
 * files, no republication, and nothing to orphan.
 */
export type ManagedTaskCaller = Readonly<{
  taskId: string;
  roleName: string;
  /** Durable active Agent of the Role this process belongs to. */
  agentId: string;
  adapterId: string;
  /** Workspace the process was launched into. */
  workspace?: string;
  /** Durable active Turn of this Task/Role when the command ran, if any. */
  currentTurnId?: string;
}>;

export type ManagedCallerStore = Pick<
  TaskStore,
  "getRole" | "getActiveTurn" | "getJobCallerKeyHash"
>;

/** Immutable self-identity a managed Task Session asserts about its own process. */
export type ManagedTaskSessionIdentity = Readonly<{
  taskId: string;
  roleName: string;
  workspace?: string;
  callerKey?: string;
}>;

/**
 * A managed Session presented valid self-identity but is no longer the current
 * runtime of its Task Role. This is a bounded diagnosis rather than a bare
 * denial: the Agent can still read current state and decide whether to re-read,
 * hand back, or stop.
 */
export class ManagedRuntimeDriftError extends Error {
  readonly name = "ManagedRuntimeDriftError";

  constructor(message: string) {
    super(message);
  }
}

/** Reads the process's own immutable managed identity, or undefined when unmanaged. */
export function managedTaskSessionIdentity(
  environment: NodeJS.ProcessEnv | undefined
): ManagedTaskSessionIdentity | undefined {
  const env = environment ?? {};
  if (env.YUI_SESSION_SCOPE !== "task") return undefined;
  const taskId = identity(env.YUI_TASK_ID);
  const roleName = identity(env.YUI_ROLE);
  if (taskId === undefined || roleName === undefined) {
    throw new ManagedRuntimeDriftError(
      "Managed Task Session identity is incomplete: YUI_TASK_ID and YUI_ROLE are required."
    );
  }
  const workspace = identity(env.YUI_WORKSPACE);
  const callerKey = identity(env[MANAGED_CALLER_KEY_ENV]);
  return Object.freeze({
    taskId,
    roleName,
    ...(workspace === undefined ? {} : { workspace }),
    ...(callerKey === undefined ? {} : { callerKey })
  });
}

/**
 * Resolves the current runtime authority for a managed Task Session, or
 * undefined for an unmanaged (plain user) invocation. Throws only when the
 * process claims managed identity that durable state no longer recognizes.
 */
export function resolveManagedTaskCaller(
  store: ManagedCallerStore,
  environment: NodeJS.ProcessEnv | undefined
): ManagedTaskCaller | undefined {
  const self = managedTaskSessionIdentity(environment);
  if (self === undefined) return undefined;
  return requireCurrentRuntime(store, self);
}

/** Same as resolveManagedTaskCaller, but requires a managed Task Session. */
export function requireManagedTaskCaller(
  store: ManagedCallerStore,
  environment: NodeJS.ProcessEnv | undefined
): ManagedTaskCaller {
  const caller = resolveManagedTaskCaller(store, environment);
  if (caller === undefined) {
    throw new ManagedRuntimeDriftError("This command requires a managed Task Session.");
  }
  return caller;
}

/**
 * The current runtime authority for one Task Role, or undefined. Used by
 * command authorization that must not fail the whole invocation, only decline
 * one privileged effect.
 */
export function currentManagedRuntime(
  store: ManagedCallerStore,
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string,
  roleName?: string
): ManagedTaskCaller | undefined {
  let caller: ManagedTaskCaller | undefined;
  try {
    caller = resolveManagedTaskCaller(store, environment);
  } catch {
    return undefined;
  }
  if (caller === undefined || caller.taskId !== taskId) return undefined;
  if (roleName !== undefined && caller.roleName !== roleName) return undefined;
  return caller;
}

function requireCurrentRuntime(
  store: ManagedCallerStore,
  self: ManagedTaskSessionIdentity
): ManagedTaskCaller {
  const role = store.getRole(self.taskId, self.roleName);
  if (role === null) {
    throw new ManagedRuntimeDriftError(
      `This managed Session belongs to ${self.taskId}/${self.roleName}, which no longer exists. `
        + "A new Session must be launched to act on this Task."
    );
  }
  const agentId = role.activeAgentId;
  if (self.callerKey === undefined) {
    throw new ManagedRuntimeDriftError(
      `This managed Session carries no ${MANAGED_CALLER_KEY_ENV}, so it cannot be recognized `
        + `as the current runtime of ${self.taskId}/${self.roleName}.`
    );
  }
  const expectedHash = store.getJobCallerKeyHash(self.taskId, self.roleName, agentId);
  if (expectedHash === null
    || createHash("sha256").update(self.callerKey).digest("hex") !== expectedHash) {
    throw new ManagedRuntimeDriftError(
      `This managed Session is no longer the current runtime of ${self.taskId}/${self.roleName} `
        + `(the Role now runs Agent ${agentId}). Its native Session was replaced or its Role was `
        + "rebound, so its durable caller key no longer matches. Nothing was changed. Read the "
        + `current state with \`yui task show ${self.taskId}\`; acting requires the Session Yui `
        + "launched for the current runtime."
    );
  }
  const activeTurn = store.getActiveTurn(self.taskId, self.roleName);
  return Object.freeze({
    taskId: self.taskId,
    roleName: self.roleName,
    agentId,
    adapterId: activeRoleAgentBinding(role).adapterId,
    ...(self.workspace === undefined ? {} : { workspace: self.workspace }),
    ...(activeTurn === null || activeTurn.status !== "active"
      ? {}
      : { currentTurnId: activeTurn.id })
  });
}

function identity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 || normalized !== value ? undefined : normalized;
}
