/**
 * Server-side DurableJob control: the only path through which a DurableJob
 * record is created or cancel-requested. The Controller socket layer calls
 * this port for `job.*` requests; nothing else writes queued jobs.
 *
 * Creation is idempotent per authenticated actor and explicit request ID.
 * Repeating that request with identical inputs returns the original Job;
 * changing its input is a conflict. Integration owner identity additionally
 * preserves its admitted Job across authorized Session replacement.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

import type { JsonValue } from "../core/protocol.js";
import { activeLiveRoleAgentSession } from "../executor/agentExecutor.js";
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
import { CallAuthority } from "../kernel/callAuthority.js";
import { redactLaunchText } from "../runtime/launchDiagnostics.js";
import { requireManagedTaskCaller } from "../runtime/managedCaller.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";

/**
 * rr8: The caller identity a `job.start`/`job.cancel` request is bound to.
 * Resolved from the managed Session environment by the CLI/Integration port
 * and verified at the Controller boundary — a declared owner is never trusted
 * on its own.
 *
 * rr12: The identity is now bound to a durable, Controller-verified record
 * rather than trusted as a literal:
 * - A Task caller names its current native Session. Leader management does not
 *   require an active Run; other Task Roles retain their exact Assignment gate.
 *   New delivery Jobs additionally require the Session's captured delivery authority.
 * - A `global` caller is verified against the current global Role, Agent,
 *   and native Session and then has full Task control authority.
 * - A literal `scope: "user"` is never authority on its own.
 */
export type DurableJobCaller = Readonly<{
  scope: "user" | "global" | "task";
  taskId?: string;
  role?: string;
  agentId?: string;
  adapterId?: string;
  nativeSessionId?: string;
  runId?: string;
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
  /** Explicit operation identity; command content never authorizes a new request. */
  requestId: string;
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
  const authority = createJobCallAuthority(store);
  return {
    startJob(params, now) {
      // rr4/finding-3: The entire create path — validation, idempotency
      // lookup, id allocation, and save — must be one transaction. A gap
      // between the idempotency check and the save lets a concurrent
      // startJob with the same key create a duplicate job.
      return store.transaction((tx) => {
        const context = authority.authenticate(Object.freeze({ ...params.caller }), params.taskId);
        assertNonSecretJobInput(params);
        const baseKey = durableJobIdempotencyKey({
          owner: params.owner,
          projectId: params.projectId,
          head: params.head,
          steps: params.steps,
          workspace: params.workspace,
          env: params.env
        });
        const inputDigest = params.retryOf === undefined
          ? baseKey
          : retryDurableJobIdempotencyKey(baseKey, params.retryOf);
        const requestId = requiredId(params.requestId, "job.start requestId");
        // An IntegrationAttempt already is a durable operation identity.
        // Recovery by another authorized Role must find its original Job,
        // including the window before Integration persisted the returned id.
        if (params.owner.kind === "integration-attempt") {
          const integrationId = params.owner.integrationAttemptId;
          const owned = tx.listDurableJobs(params.taskId).filter((job) => (
            job.owner.kind === "integration-attempt"
            && job.owner.integrationAttemptId === integrationId
          ));
          if (owned.length > 1) {
            throw jobDomainError("IntegrationAttempt has multiple Jobs; inspect its existing records.");
          }
          const original = owned[0];
          if (original !== undefined) {
            if (original.operation.inputDigest !== inputDigest
              || original.operation.targetId !== params.workspace) {
              throw jobDomainError(`Integration Job input conflicts with its original request: ${original.id}.`);
            }
            return { job: original, created: false };
          }
        }
        const key = createHash("sha256").update(JSON.stringify([
          context.actorId, requestId
        ])).digest("hex");
        const existing = tx.findDurableJobByIdempotencyKey(params.taskId, key);
        if (existing !== null) {
          if (existing.operation.inputDigest !== inputDigest || existing.operation.targetId !== params.workspace) {
            throw jobDomainError(`Job request identity conflicts with its original input: ${existing.id}.`);
          }
          return { job: existing, created: false };
        }
        authority.authorize(context, params.taskId);
        validateStartParams(tx, params);
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
          operation: {
            requestId, inputDigest, actorId: context.actorId,
            authorityRef: jobAuthorityBinding(tx, params.caller.scope, params.caller.role!, params.taskId)
          },
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

/** T02 ingress adapter. The existing Job boundary remains the authority and
 * semantic writer; this does not authorize arbitrary plugin or resource work.
 */
export function createJobCallAuthority(store: TaskStore): CallAuthority<DurableJobCaller> {
  return new CallAuthority((caller, taskId) => {
    assertCallerAuthorized(store, caller, taskId);
    return caller.scope === "task"
      ? `task:${taskId}/role:${caller.role}`
      : `global:${caller.role}`;
  });
}

/** The collector does not use this gate: late results belong to the original
 * Job even when its management binding is revoked. Only a new spawn checks it.
 */
export function authorizeJobStart(store: TaskStore, job: DurableJob): void {
  const taskPrefix = `task:${job.taskId}/role:`;
  const actor = job.operation.actorId;
  const scope = actor.startsWith(taskPrefix) ? "task" : actor.startsWith("global:") ? "global" : undefined;
  if (scope === undefined) throw jobDomainError("Job caller binding is unavailable; no execution was started.");
  const role = actor.slice(scope === "task" ? taskPrefix.length : "global:".length);
  if (jobAuthorityBinding(store, scope, role, job.taskId) !== job.operation.authorityRef) {
    throw jobDomainError("Job caller binding was revoked; no execution was started.");
  }
  validateJobTarget(store, job);
}

function jobAuthorityBinding(store: TaskStore, scope: string, roleName: string, taskId: string): string {
  // A Host detach/reattach preserves the native Session and its queued work.
  // Authenticate the live launch at ingress, but bind accepted Jobs to the
  // caller's durable Session identity, not its disposable Host generation.
  if (scope === "task") {
    const sessions = store.getTaskRoleSessionSet(taskId, roleName);
    const session = activeLiveRoleAgentSession(sessions);
    if (session === null) {
      throw jobDomainError("Current Job caller Session is unavailable.");
    }
    try {
      requireManagedTaskCaller(store, {
        YUI_SESSION_SCOPE: "task", YUI_TASK_ID: taskId, YUI_ROLE: roleName,
        YUI_NATIVE_SESSION_ID: session.nativeSessionId
      });
    } catch {
      throw jobDomainError("Job caller binding was revoked; no execution was started.");
    }
    return createHash("sha256").update(JSON.stringify([
      session.agentId, session.adapterId, session.nativeSessionId
    ])).digest("hex");
  }
  const role = store.getGlobalRole(roleName);
  const session = activeLiveRoleAgentSession(store.getGlobalRoleSessionSet(roleName));
  if (role === null || session === null) throw jobDomainError("Current Job caller binding is unavailable.");
  return createHash("sha256").update(JSON.stringify([
    role.activeAgentId, session.agentId, session.nativeSessionId
  ])).digest("hex");
}

function assertNonSecretJobInput(params: DurableJobStartParams): void {
  // Existing Jobs persist commands and environments. This boundary accepts
  // non-secret executable specifications only; credential resolution is not a
  // Job feature. Never hash a known secret then call the digest sanitized.
  const secretKey = /api[_-]?key|private[_-]?key|token|secret|password|passwd|cookie|credential|authorization/i;
  for (const env of [params.env, ...params.steps.map((step) => step.env ?? {})]) {
    if (Object.keys(env).some((key) => secretKey.test(key))) {
      throw jobDomainError("Job input cannot persist credentials; use a non-secret specification.");
    }
  }
  const input = JSON.stringify({
    env: params.env, steps: params.steps, requestId: params.requestId
  });
  // Reject recognizable key material regardless of the parameter name, and
  // URL userinfo before either hashing or persisting the specification.
  const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
  const urlCredential = /[a-z][a-z0-9+.-]*:\/\/[^\s/"<>]+:[^\s/"<>]*@/i;
  if (privateKey.test(input) || urlCredential.test(input) || redactLaunchText(input) !== input) {
    throw jobDomainError("Job input cannot persist credentials; use a non-secret specification.");
  }
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
  validateJobTarget(store, params);
  assertCallerAuthorized(store, params.caller, params.taskId);
  if (params.caller.scope === "task") {
    const session = store.getTaskRoleSessionSet(params.taskId, params.caller.role!);
    if (session?.sessions[session.activeAgentId]?.effective.executionAuthority !== "delivery") {
      throw jobControlError("UNAUTHORIZED", "Managed workspace Jobs require a delivery Session; Task activation does not upgrade planning authority.");
    }
  }
}

function validateJobTarget(store: TaskStore, params: Omit<DurableJobStartParams, "caller" | "requestId">): void {
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
    if (attempt.status !== "running") {
      throw jobDomainError(
        `DurableJob owner Integration Attempt must be running: `
        + `${params.taskId}/${params.owner.integrationAttemptId} is ${attempt.status}.`
      );
    }
    if (attempt.candidateCommit !== params.head || attempt.checkInputDigest === undefined
      || attempt.checkInputDigest !== durableJobIdempotencyKey(params)) {
      throw jobDomainError("Integration Job has no matching admitted candidate/check specification.");
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

}

/**
 * rr8/rr12: Bind the declared job owner to the caller's managed identity. The
 * Controller validates the declared owner/workspace and verifies the caller
 * against durable AgentRun/Session state — a self-reported role or scope is never
 * authority on its own. The rules:
 *
 * - `user` (non-managed): rejected because it has no managed Session identity.
 * - `global`: full Task authority after current Role Session verification.
 * - `task` + mismatched taskId: rejected.
 * - A non-Leader Task caller requires its current active Assignment.
 * - A Leader Task caller requires its current, unrevoked native Session.
 * - `task`: authority inside the matching Task after current Session and
 *   native Session verification; Role does not narrow it.
 */
/**
 * Verify the caller's current native Session and Task scope. This local Home
 * identity contract does not defend against another process with the same
 * user's filesystem access. Bare user calls cannot start or cancel Jobs.
 */
function assertCallerAuthorized(
  store: Pick<
    TaskStore,
    "getRun" | "getActiveRun" | "getRole" | "getTaskRoleSessionSet" | "listEventsByType"
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
      "job.start/job.cancel requires a managed native Session; user scope is rejected."
    );
  }
  if (caller.scope === "global") {
    const roleName = caller.role;
    const agentId = roleName === undefined ? undefined : store.getGlobalRole(roleName)?.activeAgentId;
    const role = roleName === undefined ? null : store.getGlobalRole(roleName);
    const binding = role === null || agentId === undefined
      ? undefined
      : role.agentBindings[role.activeAgentId];
    const sessions = roleName === undefined ? null : store.getGlobalRoleSessionSet(roleName);
    const session = activeLiveRoleAgentSession(sessions);
    if (role === null || binding === undefined || agentId === undefined || sessions === null || sessions.activeAgentId !== role.activeAgentId || session === null || binding.agentId !== agentId || session.agentId !== agentId || session.adapterId !== binding.adapterId || caller.nativeSessionId === undefined || session.nativeSessionId !== caller.nativeSessionId) {
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
  // A long-lived Session is the Leader's identity, not its execution
  // occupancy. Non-Leader callers still require their active Assignment.
  const current = (() => {
    try {
      return requireManagedTaskCaller(store, {
        YUI_SESSION_SCOPE: "task", YUI_TASK_ID: taskId, YUI_ROLE: caller.role,
        YUI_NATIVE_SESSION_ID: caller.nativeSessionId
      });
    } catch (error) {
      throw jobControlError("UNAUTHORIZED", error instanceof Error ? error.message : String(error));
    }
  })();
  if (current.roleName !== "leader" && current.currentRunId === undefined) {
    throw jobControlError("UNAUTHORIZED", "A managed Task Session's Role is not bound to an active AgentRun.");
  }
  const sessions = store.getTaskRoleSessionSet(taskId, current.roleName);
  const session = activeLiveRoleAgentSession(sessions);
  if (sessions?.activeAgentId !== current.agentId || session === null
    || session.agentId !== current.agentId || session.adapterId !== current.adapterId
    || caller.nativeSessionId === undefined || session.nativeSessionId !== caller.nativeSessionId) {
    throw jobControlError("UNAUTHORIZED", "DurableJob control requires the current live Task Session.");
  }
}

/**
 * Resolve the managed workspace for the job's owner. Returns null if no
 * managed workspace exists for this owner kind + id.
 */
function resolveManagedWorkspace(
  store: TaskStore,
  params: Pick<DurableJobStartParams, "taskId" | "owner">
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
  return status === "accepted" || status === "retired";
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
    "retryOf", "caller", "requestId"
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
    requestId: requiredId(record.requestId, "job.start requestId"),
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
    const allowed = new Set(["name", "command", "argv", "cwd", "env", "timeoutMs"]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw jobControlError("INVALID_PARAMS", "job.start steps are invalid.");
      }
    }
    const name = requiredId(record.name, "job.start step name");
    const command = requiredId(record.command, "job.start step command");
    const argv = record.argv === undefined ? undefined : record.argv;
    if (argv !== undefined && (!Array.isArray(argv) || argv.length === 0
      || argv.some(value => typeof value !== "string" || value.length === 0 || value.includes("\0")))) {
      throw jobControlError("INVALID_PARAMS", `job.start step argv is invalid: ${name}.`);
    }
    const cwd = record.cwd === undefined ? undefined : requiredId(record.cwd, "job.start step cwd");
    if (cwd !== undefined && !cwd.startsWith("/")) {
      throw jobControlError("INVALID_PARAMS", `job.start step cwd must be absolute: ${name}.`);
    }
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
      ...(argv === undefined ? {} : { argv: argv as string[] }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(record.env === undefined ? {} : { env: parseStringMap(record.env, "job.start step env") }),
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
    "scope", "taskId", "role", "agentId", "adapterId", "nativeSessionId",
    "runId"
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw jobControlError("INVALID_PARAMS", "job caller is invalid.");
    }
  }
  if (record.scope !== "user" && record.scope !== "global" && record.scope !== "task") {
    throw jobControlError("INVALID_PARAMS", "job caller scope is invalid.");
  }
  const optionalId = (key: "taskId" | "role" | "agentId" | "adapterId"
    | "nativeSessionId" | "runId"): string | undefined => {
    const entry = record[key];
    if (entry === undefined) return undefined;
    return requiredId(entry, `job caller ${key}`);
  };
  const taskId = optionalId("taskId");
  const role = optionalId("role");
  const agentId = optionalId("agentId");
  const adapterId = optionalId("adapterId");
  const nativeSessionId = optionalId("nativeSessionId");
  const runId = optionalId("runId");
  return {
    scope: record.scope,
    ...(taskId === undefined ? {} : { taskId }),
    ...(role === undefined ? {} : { role }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(runId === undefined ? {} : { runId })
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
