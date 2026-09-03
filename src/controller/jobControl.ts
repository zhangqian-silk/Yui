/**
 * Server-side DurableJob control: the only path through which a DurableJob
 * record is created or cancel-requested. The Controller socket layer calls
 * this port for `job.*` requests; nothing else writes queued jobs.
 *
 * Creation is idempotent per (owner, project, head, steps, workspace, env):
 * a repeated `job.start` with the same inputs returns the existing job with
 * `created: false`, so a Leader retry can never spawn duplicate runners.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

import type { JsonValue } from "../core/protocol.js";
import {
  acknowledgeUnknownDurableJob,
  createDurableJob,
  durableJobIdempotencyKey,
  isDurableJobTerminal,
  requestDurableJobCancel,
  retryDurableJobIdempotencyKey,
  type DurableJob,
  type DurableJobOwner,
  type DurableJobStep
} from "../job/durableJob.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import { activeLiveRoleAgentSession } from "../executor/agentExecutor.js";

/**
 * rr8: The caller identity a `job.start`/`job.cancel` request is bound to.
 * Resolved from the managed Session environment by the CLI/Integration port
 * and verified at the Controller boundary — a declared owner is never trusted
 * on its own.
 *
 * rr12: The identity is now bound to a durable, Controller-verified record
 * rather than trusted as a literal:
 * - A `task` caller must carry `turnId`; the Controller looks up that Turn,
 *   requires `turn.roleName === role` and `turn.status === "active"`, and verifies
 *   the per-Session caller key. Role does not narrow authority within the Task.
 * - A `global` caller is verified against the current global Role, Agent,
 *   launch, and native Session and then has full Task control authority.
 * - A literal `scope: "user"` is never authority on its own.
 */
export type DurableJobCaller = Readonly<{
  scope: "user" | "global" | "task";
  taskId?: string;
  role?: string;
  agentId?: string;
  adapterId?: string;
  launchId?: string;
  nativeSessionId?: string;
  turnId?: string;
  /**
   * rr13: task-scope caller — the per-Session job caller key injected at native
   * Session launch as `YUI_JOB_CALLER_KEY`. The Controller verifies its SHA-256
   * hash against the durable `jobCallerKeyHashes` map. The plaintext key is
   * never persisted, so a client that reads durable state cannot replay it.
   */
  callerKey?: string;
}>;

export type DurableJobStartParams = Readonly<{
  taskId: string;
  owner: DurableJobOwner;
  projectId: string;
  head: string;
  workspace: string;
  env: Readonly<Record<string, string>>;
  steps: readonly DurableJobStep[];
  retryOf?: string;
  /** rr8: The caller identity the declared owner is bound to. */
  caller: DurableJobCaller;
}>;

export type DurableJobStartResult = Readonly<{
  job: DurableJob;
  /** False when an existing job with the same idempotency key was returned. */
  created: boolean;
}>;

export type DurableJobControlPort = Readonly<{
  startJob(params: DurableJobStartParams, now: Date): DurableJobStartResult;
  getJob(taskId: string, jobId: string): DurableJob | null;
  cancelJob(
    taskId: string,
    jobId: string,
    now: Date,
    caller: DurableJobCaller
  ): DurableJob | null;
  acknowledgeJob(
    taskId: string,
    jobId: string,
    now: Date,
    caller: DurableJobCaller
  ): DurableJob | null;
}>;

export function createDurableJobControl(store: TaskStore): DurableJobControlPort {
  return {
    startJob(params, now) {
      // rr4/finding-3: The entire create path — validation, idempotency
      // lookup, id allocation, and save — must be one transaction. A gap
      // between the idempotency check and the save lets a concurrent
      // startJob with the same key create a duplicate job.
      return store.transaction((tx) => {
        validateStartParams(tx, params);
        const baseKey = durableJobIdempotencyKey({
          owner: params.owner,
          projectId: params.projectId,
          head: params.head,
          steps: params.steps,
          workspace: params.workspace,
          env: params.env
        });
        const key = params.retryOf === undefined
          ? baseKey
          : retryDurableJobIdempotencyKey(baseKey, params.retryOf);
        const existing = tx.findDurableJobByIdempotencyKey(params.taskId, key);
        if (existing !== null) return { job: existing, created: false };
        const id = tx.nextDurableJobId(params.taskId);
        const job = createDurableJob({
          id,
          taskId: params.taskId,
          owner: params.owner,
          projectId: params.projectId,
          head: params.head,
          workspace: params.workspace,
          env: params.env,
          steps: params.steps,
          artifactsLocator: `artifacts/jobs/${params.taskId}/${id}`,
          ...(params.retryOf === undefined ? {} : { retryOf: params.retryOf })
        }, now);
        tx.saveDurableJob(params.taskId, job);
        return { job, created: true };
      });
    },
    getJob(taskId, jobId) {
      return store.getDurableJob(taskId, jobId);
    },
    cancelJob(taskId, jobId, now, caller) {
      return store.transaction((tx) => {
        const current = tx.getDurableJob(taskId, jobId);
        if (current === null) return null;
        // rr8: Bind the cancel request to the caller's managed identity. The
        // same rules as job.start apply, checked against the job's owner.
        assertCallerAuthorized(tx, caller, taskId);
        const next = requestDurableJobCancel(current, now);
        if (next !== current) tx.saveDurableJob(taskId, next);
        return next;
      });
    },
    acknowledgeJob(taskId, jobId, now, caller) {
      return store.transaction((tx) => {
        const current = tx.getDurableJob(taskId, jobId);
        if (current === null) return null;
        assertCallerAuthorized(tx, caller, taskId);
        const next = acknowledgeUnknownDurableJob(current, now);
        if (next !== current) tx.saveDurableJob(taskId, next);
        return next;
      });
    }
  };
}

/**
 * Persisted-boundary validation for `job.start`. The owner must resolve to a
 * live Task record, the Task must be active, the workspace must be the exact
 * managed workspace for that owner with write access to the Project, and the
 * stable Project checkout is always rejected.
 *
 * f2: Previously this only checked that some records existed and that the
 * workspace was not the stable checkout. Now it binds the job to the exact
 * managed workspace, verifies write access, and requires an active Task.
 */
function validateStartParams(store: TaskStore, params: DurableJobStartParams): void {
  // The Task must be active — a terminal Task cannot run jobs.
  const task = store.getTask(params.taskId);
  if (task === null) {
    throw jobDomainError(`Task not found: ${params.taskId}.`);
  }
  if (task.status !== "active" || task.executionGate.state !== "enabled") {
    throw jobDomainError(
      `DurableJob requires enabled Task execution; ${params.taskId} is `
        + `${task.status}/${task.executionGate.state}.`
    );
  }

  // The owner record must exist and must not be terminal. A terminal owner
  // cannot run new jobs — its workspace is eligible for cleanup.
  if (params.owner.kind === "work-item") {
    const workItem = store.getWorkItem(params.taskId, params.owner.workItemId);
    if (workItem === null) {
      throw jobDomainError(
        `Work Item not found: ${params.taskId}/${params.owner.workItemId}.`
      );
    }
    if (isTerminalWorkItemStatus(workItem.status)) {
      throw jobDomainError(
        `DurableJob owner Work Item is terminal: `
        + `${params.taskId}/${params.owner.workItemId} is ${workItem.status}.`
      );
    }
  } else if (params.owner.kind === "integration-attempt") {
    const attempt = store.getIntegrationAttempt(params.taskId, params.owner.integrationAttemptId);
    if (attempt === null) {
      throw jobDomainError(
        `Integration Attempt not found: ${params.taskId}/${params.owner.integrationAttemptId}.`
      );
    }
    if (attempt.status === "committed" || attempt.status === "failed") {
      throw jobDomainError(
        `DurableJob owner Integration Attempt is terminal: `
        + `${params.taskId}/${params.owner.integrationAttemptId} is ${attempt.status}.`
      );
    }
  }

  const project = store.getProject(params.projectId);
  if (project === null) {
    throw jobDomainError(`Project not found: ${params.projectId}.`);
  }

  // f2: The workspace must be the exact managed workspace for this owner.
  const managedWorkspace = resolveManagedWorkspace(store, params);
  if (managedWorkspace === null) {
    throw jobDomainError(
      `DurableJob workspace is not a registered managed workspace for `
      + `${params.owner.kind} ${params.taskId}: ${params.workspace}.`
    );
  }

  // The workspace path must match the managed workspace root.
  const workspace = resolve(params.workspace);
  if (workspace !== resolve(managedWorkspace.root)) {
    throw jobDomainError(
      `DurableJob workspace must be the managed workspace root `
      + `${managedWorkspace.root}; got ${params.workspace}.`
    );
  }

  // The Project must have write access in this workspace.
  const entry = managedWorkspace.entries.find(
    (e) => e.projectId === params.projectId
  );
  if (entry === undefined) {
    throw jobDomainError(
      `Project ${params.projectId} is not bound to workspace `
      + `${managedWorkspace.root}.`
    );
  }
  if (entry.access !== "write") {
    throw jobDomainError(
      `Project ${params.projectId} has read-only access in workspace `
      + `${managedWorkspace.root}; DurableJob requires write access.`
    );
  }

  // The stable Project checkout is always rejected (belt and suspenders —
  // a managed workspace should never be the checkout, but verify).
  const checkout = resolve(project.path);
  if (workspace === checkout || workspace.startsWith(`${checkout}${sep}`)) {
    throw jobDomainError(
      `DurableJob workspace must be a managed workspace; the stable Project checkout is read-only: ${project.path}.`
    );
  }

  // rr4/finding-2: The declared head must match the repository's physical
  // HEAD. A job that runs against a drifted workspace (checked out at a
  // different commit than declared) produces evidence for the wrong code.
  // This binds the job to the exact Git state of the managed workspace.
  const repoHead = readGitHead(entry.path);
  if (repoHead === null) {
    throw jobDomainError(
      `DurableJob workspace project path is not a git repository: ${entry.path}.`
    );
  }
  if (repoHead !== params.head.toLowerCase()) {
    throw jobDomainError(
      `DurableJob head ${params.head} does not match the workspace HEAD `
      + `${repoHead} at ${entry.path}.`
    );
  }

  // f2: A retry must reference an existing terminal job in the same Task.
  if (params.retryOf !== undefined) {
    const original = store.getDurableJob(params.taskId, params.retryOf);
    if (original === null) {
      throw jobDomainError(
        `Retry original job not found: ${params.taskId}/${params.retryOf}.`
      );
    }
    if (!isDurableJobTerminal(original.status)) {
      throw jobDomainError(
        `Retry original job must be terminal: ${params.retryOf} is ${original.status}.`
      );
    }
  }

  // rr8: Bind the declared owner to the caller's managed identity. A
  // Role is not an authorization boundary. Scope and exact managed Session
  // identity are verified independently below.
  assertCallerAuthorized(store, params.caller, params.taskId);
}

/**
 * rr8/rr12: Bind the declared job owner to the caller's managed identity. The
 * Controller validates the declared owner/workspace and verifies the caller
 * against durable Turn/Session state — a self-reported role or scope is never
 * authority on its own. The rules:
 *
 * - `user` (non-managed): rejected because it has no managed Session identity.
 * - `global`: full Task authority after current Role Session verification.
 * - `task` + mismatched taskId: rejected.
 * - `task` + missing `turnId`: rejected (a managed caller must bind to a Turn).
 * - `task` + Turn not found / not active / `roleName !== role`: rejected — the
 *   claimed Role must be the real Role of an active Turn.
 * - `task`: full authority inside the matching Task after active Turn and
 *   per-Session caller-key verification; Role does not narrow it.
 */
/**
 * rr13: `job.start`/`job.cancel` caller authorization at the Controller
 * boundary. Every identity claim the Controller can verify from durable state
 * (role and turnId) is replayable by any client in the
 * same authoritative Controller. The channel itself is therefore not
 * authenticated by those claims alone. A non-replayable per-Session caller key
 * closes the gap:
 *
 * - `user` scope: **rejected outright** for start/cancel. A bare shell or a
 *   managed Session that sheds its identity has no managed Session binding.
 * - `global` scope: verified against the current global Role Session.
 * - `task` scope: the caller must present `callerKey` — the
 *   `YUI_JOB_CALLER_KEY` injected at its native Session launch. The Controller
 *   hashes it (SHA-256) and compares against the durable `jobCallerKeyHashes`
 *   map for the caller's Role + Agent. An absent hash or a
 *   mismatched key is UNAUTHORIZED.
 *
 * The existing Turn binding checks run after the key check, so a forged
 * identity that also lacks the key is rejected at the channel boundary.
 */
function assertCallerAuthorized(
  store: Pick<
    TaskStore,
    "getTurn" | "getActiveTurn" | "getTaskRoleSessionSet" | "getJobCallerKeyHash"
      | "getGlobalRole" | "getGlobalRoleSessionSet"
  >,
  caller: DurableJobCaller,
  taskId: string
): void {
  if (caller.scope === "user") {
    // rr13: A user-scope caller has no per-Session channel binding. Every
    // durable-state claim it could carry is replayable
    // by any client in the same Home. Reject outright (fail-closed).
    throw jobControlError(
      "UNAUTHORIZED",
      "job.start/job.cancel requires a managed Session caller key; user scope is rejected."
    );
  }
  if (caller.scope === "global") {
    const roleName = caller.role;
    const agentId = caller.agentId;
    const role = roleName === undefined ? null : store.getGlobalRole(roleName);
    const binding = role === null || agentId === undefined
      ? undefined
      : role.agentBindings[role.activeAgentId];
    const sessions = roleName === undefined ? null : store.getGlobalRoleSessionSet(roleName);
    const session = activeLiveRoleAgentSession(sessions);
    if (role === null
      || binding === undefined
      || agentId === undefined
      || caller.adapterId === undefined
      || caller.launchId === undefined
      || sessions === null
      || sessions.activeAgentId !== role.activeAgentId
      || session === null
      || binding.agentId !== agentId
      || binding.adapterId !== caller.adapterId
      || session.agentId !== agentId
      || session.adapterId !== caller.adapterId
      || session.launchId !== caller.launchId
      || (caller.nativeSessionId !== undefined
        && session.nativeSessionId !== caller.nativeSessionId)) {
      throw jobControlError(
        "UNAUTHORIZED",
        "DurableJob control requires the current managed global Agent Session."
      );
    }
    return;
  }
  if (caller.taskId !== taskId) {
    throw jobControlError(
      "UNAUTHORIZED",
      "A managed Task Session may not start or cancel Jobs for a different Task."
    );
  }
  // The Turn is resolved from durable state rather than presented by the
  // caller: a long-lived Session process cannot hold a current Turn in its
  // frozen environment, and its own claim would add nothing the store does
  // not already own.
  const run = caller.role === undefined ? null : store.getActiveTurn(taskId, caller.role);
  if (run === null || run.status !== "active") {
    throw jobControlError(
      "UNAUTHORIZED",
      "A managed Task Session's Role is not bound to an active Turn."
    );
  }
  // rr13: Verify the non-replayable per-Session caller key. The key is injected
  // at native Session launch and never persisted in plaintext; only its SHA-256
  // hash is durable. A client with database read access can see the hash but cannot
  // recover the key.
  if (caller.callerKey === undefined) {
    throw jobControlError(
      "UNAUTHORIZED",
      "job.start/job.cancel requires a managed Session caller key."
    );
  }
  const expectedHash = store.getJobCallerKeyHash(
    taskId,
    caller.role ?? "",
    run.effective.agentId
  );
  if (expectedHash === null) {
    throw jobControlError(
      "UNAUTHORIZED",
      "The managed Session has no durable caller key; it must be relaunched."
    );
  }
  const presentedHash = createHash("sha256").update(caller.callerKey).digest("hex");
  if (presentedHash !== expectedHash) {
    throw jobControlError(
      "UNAUTHORIZED",
      "The managed Session caller key does not match the durable hash."
    );
  }
}

/**
 * Resolve the managed workspace for the job's owner. Returns null if no
 * managed workspace exists for this owner kind + id.
 */
function resolveManagedWorkspace(
  store: TaskStore,
  params: DurableJobStartParams
): ManagedWorkspace | null {
  if (params.owner.kind === "work-item") {
    return store.getManagedWorkspace({
      type: "work-item",
      taskId: params.taskId,
      workItemId: params.owner.workItemId
    });
  }
  if (params.owner.kind === "integration-attempt") {
    return store.getManagedWorkspace({
      type: "integration-attempt",
      taskId: params.taskId,
      integrationAttemptId: params.owner.integrationAttemptId
    });
  }
  // owner.kind === "task"
  return store.getManagedWorkspace({
    type: "task",
    taskId: params.taskId
  });
}

/**
 * Read the physical Git HEAD of a repository path. Returns null if the path
 * is not a git repository or the HEAD cannot be resolved.
 */
function readGitHead(path: string): string | null {
  try {
    const head = execSync("git rev-parse HEAD", {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head) ? head : null;
  } catch {
    return null;
  }
}

function isTerminalWorkItemStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "retired";
}

/**
 * Strict `job.start` params parsing. Throws CoreApplicationError-shaped errors
 * so the socket layer reports INVALID_PARAMS without leaking internals.
 */
export function parseDurableJobStartParams(value: JsonValue): DurableJobStartParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw jobControlError("INVALID_PARAMS", "job.start params are invalid.");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const allowed = new Set([
    "taskId", "owner", "projectId", "head", "workspace", "env", "steps",
    "retryOf", "caller"
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw jobControlError("INVALID_PARAMS", "job.start params are invalid.");
    }
  }
  const taskId = requiredId(record.taskId, "job.start taskId");
  const owner = parseJobOwner(record.owner);
  const projectId = requiredId(record.projectId, "job.start projectId");
  const head = requiredId(record.head, "job.start head");
  const workspace = requiredId(record.workspace, "job.start workspace");
  if (!workspace.startsWith("/")) {
    throw jobControlError("INVALID_PARAMS", "job.start workspace must be an absolute path.");
  }
  const env = parseStringMap(record.env, "job.start env");
  const steps = parseSteps(record.steps);
  const retryOf = record.retryOf === undefined
    ? undefined
    : requiredId(record.retryOf, "job.start retryOf");
  const caller = parseCaller(record.caller);
  return {
    taskId,
    owner,
    projectId,
    head,
    workspace,
    env,
    steps,
    caller,
    ...(retryOf === undefined ? {} : { retryOf })
  };
}

export function parseDurableJobRefParams(value: JsonValue): Readonly<{
  taskId: string;
  jobId: string;
}> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 2
  ) {
    throw jobControlError("INVALID_PARAMS", "DurableJob ref params are invalid.");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return {
    taskId: requiredId(record.taskId, "DurableJob taskId"),
    jobId: requiredId(record.jobId, "DurableJob jobId")
  };
}

/**
 * rr8: `job.cancel` params carry the caller identity so the Controller can
 * bind the cancel request to the caller's managed scope. Distinct from
 * `parseDurableJobRefParams` (used by `job.get`) because cancel requires the
 * third `caller` key.
 */
export function parseDurableJobCancelParams(value: JsonValue): Readonly<{
  taskId: string;
  jobId: string;
  caller: DurableJobCaller;
}> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 3
  ) {
    throw jobControlError("INVALID_PARAMS", "DurableJob cancel params are invalid.");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return {
    taskId: requiredId(record.taskId, "DurableJob taskId"),
    jobId: requiredId(record.jobId, "DurableJob jobId"),
    caller: parseCaller(record.caller)
  };
}

/**
 * rr26: `job.acknowledge` carries the same managed task caller as
 * job.start/job.cancel.
 */
export function parseDurableJobAcknowledgeParams(value: JsonValue): Readonly<{
  taskId: string;
  jobId: string;
  caller: DurableJobCaller;
}> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 3
  ) {
    throw jobControlError("INVALID_PARAMS", "DurableJob acknowledge params are invalid.");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return {
    taskId: requiredId(record.taskId, "DurableJob taskId"),
    jobId: requiredId(record.jobId, "DurableJob jobId"),
    caller: parseCaller(record.caller)
  };
}

function parseJobOwner(value: JsonValue | undefined): DurableJobOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw jobControlError("INVALID_PARAMS", "job.start owner is invalid.");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  if (record.kind === "task" && Object.keys(record).length === 1) {
    return { kind: "task" };
  }
  if (record.kind === "work-item" && Object.keys(record).length === 2) {
    return { kind: "work-item", workItemId: requiredId(record.workItemId, "job.start owner workItemId") };
  }
  if (record.kind === "integration-attempt" && Object.keys(record).length === 2) {
    return {
      kind: "integration-attempt",
      integrationAttemptId: requiredId(record.integrationAttemptId, "job.start owner integrationAttemptId")
    };
  }
  throw jobControlError("INVALID_PARAMS", "job.start owner is invalid.");
}

function parseSteps(value: JsonValue | undefined): readonly DurableJobStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw jobControlError("INVALID_PARAMS", "job.start steps are invalid.");
  }
  const names = new Set<string>();
  const steps: DurableJobStep[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw jobControlError("INVALID_PARAMS", "job.start steps are invalid.");
    }
    const record = entry as Readonly<Record<string, JsonValue>>;
    const allowed = new Set(["name", "command", "timeoutMs"]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw jobControlError("INVALID_PARAMS", "job.start steps are invalid.");
      }
    }
    const name = requiredId(record.name, "job.start step name");
    const command = requiredId(record.command, "job.start step command");
    if (names.has(name)) {
      throw jobControlError("INVALID_PARAMS", `job.start step names must be unique: ${name}.`);
    }
    names.add(name);
    if (
      record.timeoutMs !== undefined
      && (
        typeof record.timeoutMs !== "number"
        || !Number.isSafeInteger(record.timeoutMs)
        || record.timeoutMs < 1
      )
    ) {
      throw jobControlError("INVALID_PARAMS", `job.start step timeoutMs is invalid: ${name}.`);
    }
    const step: DurableJobStep = {
      name,
      command,
      ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs })
    };
    steps.push(step);
  }
  return steps;
}

/**
 * rr9/rr12: Parse the caller identity carried by `job.start`/`job.cancel`. The
 * caller is REQUIRED: a request without one is rejected at the socket
 * boundary (fail-closed). A non-managed caller must explicitly resolve to
 * `{scope: "user"}`; the Controller never defaults a missing identity to
 * user scope. A present caller must carry a valid `scope` and may carry
 * optional managed Session identity fields. The identity is verified against
 * durable state by `assertCallerAuthorized`; parsing only validates the JSON shape.
 */
function parseCaller(value: JsonValue | undefined): DurableJobCaller {
  if (value === undefined) {
    throw jobControlError("INVALID_PARAMS", "job caller is required.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw jobControlError("INVALID_PARAMS", "job caller is invalid.");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const allowed = new Set([
    "scope", "taskId", "role", "agentId", "adapterId", "launchId", "nativeSessionId",
    "turnId", "callerKey"
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw jobControlError("INVALID_PARAMS", "job caller is invalid.");
    }
  }
  if (record.scope !== "user" && record.scope !== "global" && record.scope !== "task") {
    throw jobControlError("INVALID_PARAMS", "job caller scope is invalid.");
  }
  const optionalId = (key: "taskId" | "role" | "agentId" | "adapterId" | "launchId"
    | "nativeSessionId" | "turnId"): string | undefined => {
    const entry = record[key];
    if (entry === undefined) return undefined;
    return requiredId(entry, `job caller ${key}`);
  };
  const taskId = optionalId("taskId");
  const role = optionalId("role");
  const agentId = optionalId("agentId");
  const adapterId = optionalId("adapterId");
  const launchId = optionalId("launchId");
  const nativeSessionId = optionalId("nativeSessionId");
  const turnId = optionalId("turnId");
  const callerKey = record.callerKey === undefined
    ? undefined
    : requiredId(record.callerKey, "job caller callerKey");
  return {
    scope: record.scope,
    ...(taskId === undefined ? {} : { taskId }),
    ...(role === undefined ? {} : { role }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(launchId === undefined ? {} : { launchId }),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(callerKey === undefined ? {} : { callerKey })
  };
}

function parseStringMap(
  value: JsonValue | undefined,
  label: string
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw jobControlError("INVALID_PARAMS", `${label} is invalid.`);
  }
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw jobControlError("INVALID_PARAMS", `${label} is invalid.`);
    }
    map[key] = entry;
  }
  return map;
}

function requiredId(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw jobControlError("INVALID_PARAMS", `${label} is required.`);
  }
  return value;
}

function jobControlError(
  code: "INVALID_PARAMS" | "UNAUTHORIZED",
  message: string
): Error {
  const error = Object.assign(new Error(message), { code });
  error.name = "CoreApplicationError";
  return error;
}

/**
 * rr7: Expected job-domain rejections from `validateStartParams` (unknown or
 * terminal Task/owner, unmanaged or read-only workspace, stable checkout,
 * HEAD mismatch, invalid retry) must cross the Controller socket as
 * JOB_ERROR with their actionable message. The socket only passes
 * CoreApplicationError/CoreServiceError/CoreJobError through; a plain Error
 * collapses to INTERNAL_ERROR, losing the reason the caller needs to act on.
 */
function jobDomainError(message: string): Error {
  const error = new Error(message);
  error.name = "CoreJobError";
  return error;
}
