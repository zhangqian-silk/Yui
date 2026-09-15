import {
  validateTaskWorkspaceIdentity,
  type TaskWorkspaceIdentity
} from "../repository/taskWorkspaceIdentity.js";
import {
  cancelTaskActivationRequest,
  recordTaskActivationEvidence,
  validateTaskActivationRequest,
  type TaskActivationRequest
} from "./taskActivation.js";

export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskStatus =
  | "draft"
  | "active"
  | "completed"
  | "cancelled"
  | "archived";
export type TaskCompletedBy = "user" | "operator" | "leader";
export type TaskExecutionState = "enabled" | "stopped";

export type TaskProjectBinding = Readonly<{
  projectId: string;
  directory: string;
  /** Declarative development branch captured while the Task is Draft. */
  baseRef: string;
  /** Exact remote commit cloned when the Task was activated. */
  baseCommit?: string;
  /** Exact commit currently checked out by the authoritative Task main. */
  currentCommit?: string;
}>;

export type TaskMetadata = {
  /** Project-defined intent. Software Projects normally use `feature` or `bugfix`. */
  type?: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
  projectBindings?: readonly TaskProjectBinding[];
  cwd?: string;
};

export type TaskMetadataUpdate = Partial<{
  title: string;
  type: string | null;
  description: string | null;
  priority: TaskPriority | null;
  tags: string[] | null;
  dueAt: string | null;
  projectBindings: readonly TaskProjectBinding[];
  cwd: string;
}>;

export type Task = {
  schemaVersion: 7;
  id: string;
  title: string;
  /** Project-defined intent; it describes the request, never its execution topology. */
  type?: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string;
  projectBindings: readonly TaskProjectBinding[];
  cwd?: string;
  /**
   * Durable cross-Home-unique workspace identity, minted once on first workspace
   * preparation and reused forever. Absent only for Tasks that never had a
   * managed Git workspace (or pre-v4 Tasks awaiting the controlled rebuild).
   */
  workspaceIdentity?: TaskWorkspaceIdentity;
  status: TaskStatus;
  /** Independent execution admission gate; semantic Task progress is preserved while stopped. */
  executionGate: Readonly<{ state: TaskExecutionState }>;
  /**
   * Latest explicit activation request. It records the intent to start delivery
   * — never the fact that delivery started, which remains `status` alone. A
   * Draft therefore survives its planning Session with the request intact, and
   * a deferred request is re-checked against current facts before adoption.
   */
  activationRequest?: TaskActivationRequest;
  /**
   * Bounded history of activation requests that already reached a terminal
   * disposition, oldest first, excluding whichever one currently occupies
   * `activationRequest`.
   *
   * This is a bounded display of per-request evidence. The never-compacted
   * activation event ledger is the authority for previously settled request IDs,
   * including entries no longer in this display. `status` remains the only
   * statement about delivery; this is not a scheduling ledger.
   */
  settledActivationRequests?: readonly TaskActivationRequest[];
  completedAt?: string;
  completedBy?: TaskCompletedBy;
  completionSummary?: string;
  completionArtifactRefs?: readonly string[];
  retiredAt?: string;
  retiredBy?: TaskCompletedBy;
  retirementSummary?: string;
  /** Actual isolation was established by explicit retirement, not cancellation. */
  retirementIsolation?: true;
  replacementTaskId?: string;
  archivedAt?: string;
  archivedBy?: "user" | "operator" | "leader";
  archiveReason?: string;
  archiveSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export function createTask(id: string, title: string, now: Date, metadata: TaskMetadata = {}): Task {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 7,
    id: requireSafeIdentity(id, "Task id"),
    title: requireText(title, "Task title"),
    ...cloneMetadata(metadata),
    status: "draft",
    executionGate: { state: "enabled" },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

/**
 * Persist the Task's durable workspace identity. The identity is immutable on
 * the Task: a second binding is rejected so restart/reconcile/attach can never
 * silently adopt a different (foreign or legacy) ref namespace.
 */
export function bindTaskWorkspaceIdentity(
  task: Task,
  identity: TaskWorkspaceIdentity,
  now: Date
): Task {
  validateTask(task);
  const valid = validateTaskWorkspaceIdentity(identity);
  if (valid.taskId !== task.id) {
    throw new Error(`Task workspace identity belongs to another Task: ${valid.taskId}.`);
  }
  if (task.workspaceIdentity !== undefined) {
    const existing = validateTaskWorkspaceIdentity(task.workspaceIdentity);
    if (existing.token !== valid.token
      || existing.generatedAt !== valid.generatedAt
      || existing.homeId !== valid.homeId) {
      throw new Error(`Task workspace identity is already bound and immutable: ${task.id}.`);
    }
    return task;
  }
  return validateTask({
    ...task,
    workspaceIdentity: valid,
    updatedAt: now.toISOString()
  });
}

/**
 * How many terminal activation requests the Task payload *displays* beside its
 * latest one.
 *
 * This is a display bound, not an authority. Whether a requestId was already
 * cancelled or adopted is answered from the durable activation event ledger,
 * which is never compacted, so overflow trims only what the payload shows, never
 * what replay enforcement can see: an evicted entry is still refused. The oldest
 * request is not "least likely to be replayed" — it is simply the oldest, and it
 * keeps its authority exactly like the newest.
 */
export const MAX_SETTLED_ACTIVATION_REQUESTS = 16;

/** Terminal dispositions: the request will never adopt again on its own. */
function isSettledActivationRequest(request: TaskActivationRequest): boolean {
  return request.disposition === "cancelled" || request.disposition === "adopted";
}

/**
 * Persists the Task's latest activation request.
 *
 * The request is intent only, so this never touches `status`: a Draft stays a
 * continuable Draft after a request is recorded, cancelled, or failed. Only
 * `activateTask` inside the adoption transaction moves the lifecycle.
 *
 * A request being displaced from the slot is projected into the bounded settled
 * history when its outcome was terminal, so the recent decisions stay visible on
 * the Task payload. This history is a display projection, not the authority:
 * whether a cancelled or adopted id may be replayed is decided from the durable
 * activation event ledger, so trimming the oldest entries here never lets a
 * decided outcome be replayed away. A `failed` request is deliberately not
 * projected: it stays replayable by contract, and it is still in the slot until
 * something replaces it.
 */
export function setTaskActivationRequest(
  task: Task,
  request: TaskActivationRequest,
  now: Date
): Task {
  validateTask(task);
  const valid = validateTaskActivationRequest(request);
  if (valid.operation.targetId !== task.id) {
    throw new Error(`Activation request belongs to another Task: ${valid.operation.targetId}.`);
  }
  const existing = task.activationRequest;
  if (existing !== undefined
    && existing.operation.requestId === valid.operation.requestId
    && existing.operation.inputDigest !== valid.operation.inputDigest) {
    throw new Error(
      `Activation requestId ${valid.operation.requestId} was already used for different inputs.`
    );
  }
  // Replacing the slot: keep the outgoing terminal outcome as evidence. The
  // incoming request's own id is dropped from the history because it is now the
  // slot's occupant, so exactly one record per id exists.
  const displaced = existing !== undefined
    && existing.operation.requestId !== valid.operation.requestId
    && isSettledActivationRequest(existing)
    ? [existing]
    : [];
  const retained = [
    ...(task.settledActivationRequests ?? []),
    ...displaced
  ].filter(({ operation }) => operation.requestId !== valid.operation.requestId)
    .slice(-MAX_SETTLED_ACTIVATION_REQUESTS);
  return validateTask({
    ...task,
    activationRequest: valid,
    ...(retained.length === 0 ? {} : { settledActivationRequests: retained }),
    updatedAt: now.toISOString()
  });
}

/**
 * Records operation evidence against one activation request by id, wherever the
 * Task still holds it — the live slot or the settled history.
 *
 * Evidence has to survive the request losing the slot: resources adopted for A
 * remain adopted after A is cancelled and B is requested, and that effect must
 * stay attached to A rather than following the slot to B. The underlying ratchet
 * only raises `effect` and adds refs, so this never rewrites an outcome.
 */
export function recordTaskActivationRequestEvidence(
  task: Task,
  requestId: string,
  evidence: Readonly<{
    effect?: TaskActivationRequest["operation"]["effect"];
    receiptRefs?: readonly string[];
    partialResultRefs?: readonly string[];
  }>,
  now: Date
): Task {
  const current = task.activationRequest;
  if (current?.operation.requestId === requestId) {
    const updated = recordTaskActivationEvidence(current, evidence, now);
    if (updated === current) return task;
    return validateTask({ ...task, activationRequest: updated, updatedAt: now.toISOString() });
  }
  const settled = task.settledActivationRequests;
  if (settled?.some(({ operation }) => operation.requestId === requestId) !== true) {
    throw new Error(`Activation request not found on Task ${task.id}: ${requestId}.`);
  }
  return validateTask({
    ...task,
    settledActivationRequests: settled.map((request) => (
      request.operation.requestId === requestId
        ? recordTaskActivationEvidence(request, evidence, now)
        : request
    )),
    updatedAt: now.toISOString()
  });
}

export function activateTask(task: Task, now: Date): Task {
  if (task.status === "archived") throw new Error(`Cannot activate archived Task: ${task.id}.`);
  if (task.status === "completed") throw new Error(`Cannot activate completed Task ${task.id}; reopen it instead.`);
  if (task.status === "cancelled") throw new Error(`Cannot activate cancelled Task ${task.id}; reopen it with user or Operator authority.`);
  if (task.status === "active") return task;
  return { ...task, status: "active", updatedAt: now.toISOString() };
}

/**
 * Freeze the exact remote inputs adopted by activation. Every Project must be
 * present exactly once; Draft metadata remains declarative until this call.
 */
export function bindTaskProjectCommits(
  task: Task,
  commits: readonly Readonly<{ projectId: string; commit: string }>[],
  now: Date
): Task {
  validateTask(task);
  if (task.status !== "draft") {
    throw new Error(`Task Project commits can only be bound during Draft activation: ${task.id}.`);
  }
  const byProject = new Map(commits.map(({ projectId, commit }) => [
    requireSafeIdentity(projectId, "Project id"),
    requireCommit(commit, "Task Project commit")
  ]));
  if (byProject.size !== commits.length
    || byProject.size !== task.projectBindings.length
    || task.projectBindings.some(({ projectId }) => !byProject.has(projectId))) {
    throw new Error(`Task Project commit scope does not match its bindings: ${task.id}.`);
  }
  return validateTask({
    ...task,
    projectBindings: task.projectBindings.map((binding) => {
      const commit = byProject.get(binding.projectId)!;
      return { ...binding, baseCommit: commit, currentCommit: commit };
    }),
    updatedAt: now.toISOString()
  });
}

/** Compare-and-swap one authoritative Task-main Project commit. */
export function advanceTaskProjectCommit(
  task: Task,
  projectId: string,
  expectedCommit: string,
  nextCommit: string,
  now: Date
): Task {
  validateTask(task);
  const expected = requireCommit(expectedCommit, "Expected Task Project commit");
  const next = requireCommit(nextCommit, "Next Task Project commit");
  let found = false;
  const projectBindings = task.projectBindings.map((binding) => {
    if (binding.projectId !== projectId) return binding;
    found = true;
    if (binding.currentCommit !== expected) {
      throw new Error(
        `Task Project current commit moved: ${task.id}/${projectId}; `
        + `expected ${expected}, found ${String(binding.currentCommit)}.`
      );
    }
    return { ...binding, currentCommit: next };
  });
  if (!found) throw new Error(`Task Project binding not found: ${task.id}/${projectId}.`);
  return validateTask({
    ...task,
    projectBindings,
    updatedAt: now.toISOString()
  });
}

/**
 * Refresh Task commit facts from its authoritative main clones. An active
 * Task may persist a newly added Project as pending intent before its first
 * workspace prepare; that first successful prepare adopts the clone's HEAD as
 * both the Project baseline and current result.
 */
export function synchronizeTaskProjectCommits(
  task: Task,
  commits: readonly Readonly<{ projectId: string; commit: string }>[],
  now: Date
): Task {
  validateTask(task);
  const byProject = new Map(commits.map(({ projectId, commit }) => [
    requireSafeIdentity(projectId, "Project id"),
    requireCommit(commit, "Task Project current commit")
  ]));
  if (byProject.size !== commits.length
    || byProject.size !== task.projectBindings.length
    || task.projectBindings.some(({ projectId }) => !byProject.has(projectId))) {
    throw new Error(`Task Project commit scope does not match its bindings: ${task.id}.`);
  }
  const projectBindings = task.projectBindings.map((binding) => {
    const commit = byProject.get(binding.projectId)!;
    if (binding.baseCommit === undefined) {
      return { ...binding, baseCommit: commit, currentCommit: commit };
    }
    return { ...binding, currentCommit: commit };
  });
  if (projectBindings.every((binding, index) => (
    binding.currentCommit === task.projectBindings[index]?.currentCommit
  ))) return task;
  return validateTask({
    ...task,
    projectBindings,
    updatedAt: now.toISOString()
  });
}

export type TaskRetirementInput = Readonly<{
  by: TaskCompletedBy;
  summary: string;
  replacementTaskId?: string;
  isolated?: boolean;
}>;

/** Explicitly retires a stale aggregate while retaining all historical facts. */
export function retireTask(
  task: Task,
  input: TaskRetirementInput,
  now: Date
): Task {
  validateTask(task);
  const summary = requireText(input.summary, "Task retirement summary");
  const by = input.by;
  if (!( ["user", "operator", "leader"] as const).includes(by)) {
    throw new Error(`Task retirement actor is invalid: ${String(by)}.`);
  }
  if (input.replacementTaskId !== undefined) {
    const replacementTaskId = requireSafeIdentity(
      input.replacementTaskId,
      "Replacement Task id"
    );
    if (replacementTaskId === task.id) {
      throw new Error("A Task cannot replace itself.");
    }
  }
  if (task.status === "cancelled") {
    if (
      task.retiredBy === by
      && task.retirementSummary === summary
      && task.replacementTaskId === input.replacementTaskId
    ) {
      return task;
    }
    throw new Error(`Task already has an explicit retirement: ${task.id}.`);
  }
  if (task.status === "archived" || task.status === "completed") {
    throw new Error(`Task cannot be retired from ${task.status}: ${task.id}.`);
  }
  const timestamp = now.toISOString();
  return validateTask({
    ...task,
    status: "cancelled",
    retiredAt: timestamp,
    retiredBy: by,
    retirementSummary: summary,
    ...(input.isolated === true ? { retirementIsolation: true as const } : {}),
    ...(input.replacementTaskId === undefined
      ? {}
      : { replacementTaskId: input.replacementTaskId }),
    updatedAt: timestamp
  });
}

export function completeTask(
  task: Task,
  now: Date,
  completion: { by: TaskCompletedBy; summary: string; artifactRefs?: readonly string[] }
): Task {
  if (task.status === "completed") return task;
  if (task.status !== "active") {
    throw new Error(`Only an active Task can be completed: ${task.id}.`);
  }
  const timestamp = now.toISOString();
  return {
    ...task,
    status: "completed",
    completedAt: timestamp,
    completedBy: completion.by,
    completionSummary: requireText(completion.summary, "Task completion summary"),
    ...(completion.artifactRefs === undefined ? {} : {
      completionArtifactRefs: completion.artifactRefs.map((ref) => requireText(ref, "Artifact ref"))
    }),
    updatedAt: timestamp
  };
}

export function reopenTask(task: Task, now: Date): Task {
  if (task.status === "archived") throw new Error(`Cannot reopen archived Task: ${task.id}.`);
  if (task.status !== "completed" && task.status !== "cancelled") {
    throw new Error(`Only a completed or cancelled Task can be reopened: ${task.id}.`);
  }
  const {
    completedAt: _completedAt,
    completedBy: _completedBy,
    completionSummary: _completionSummary,
    completionArtifactRefs: _completionArtifactRefs,
    retiredAt: _retiredAt,
    retiredBy: _retiredBy,
    retirementSummary: _retirementSummary,
    replacementTaskId: _replacementTaskId,
    retirementIsolation: _retirementIsolation,
    ...reopened
  } = task;
  // A request that never adopted is superseded by the completion it predates:
  // it is cancelled rather than deleted, so it cannot be replayed into the new
  // delivery cycle and the intent stays visible. An adopted request records a
  // real environment and status change and is left exactly as it is.
  const request = reopened.activationRequest;
  return validateTask({
    ...reopened,
    ...(request?.disposition === "pending"
      ? {
          activationRequest: cancelTaskActivationRequest(
            request,
            `Task was completed and reopened at ${now.toISOString()}; request superseded.`,
            now
          )
        }
      : {}),
    status: "active",
    executionGate: { state: "enabled" },
    updatedAt: now.toISOString()
  });
}

export function archiveTask(
  task: Task,
  now: Date,
  archive?: { by: NonNullable<Task["archivedBy"]>; reason?: string; summary?: string }
): Task {
  if (task.status === "archived") return task;
  if (task.status !== "completed"
    && task.status !== "cancelled") {
    throw new Error(`Only a completed or cancelled Task can be archived: ${task.id}.`);
  }
  const timestamp = now.toISOString();
  return validateTask({
    ...task,
    status: "archived",
    archivedAt: timestamp,
    archivedBy: archive?.by ?? "user",
    ...(archive?.reason === undefined ? {} : { archiveReason: archive.reason.trim() }),
    ...(archive?.summary === undefined ? {} : { archiveSummary: archive.summary.trim() }),
    updatedAt: timestamp
  });
}

export function updateTaskArchived(
  task: Task,
  archived: boolean,
  now: Date,
  archive?: { by: NonNullable<Task["archivedBy"]>; reason?: string; summary?: string }
): Task {
  if (archived) return archiveTask(task, now, archive);
  if (task.status === "archived") {
    throw new Error(`Cannot reopen archived Task: ${task.id}.`);
  }
  return { ...task, updatedAt: now.toISOString() };
}

export function updateTaskMetadata(
  task: Task,
  metadata: TaskMetadataUpdate,
  now: Date
): Task {
  const updated: Task = { ...task, updatedAt: now.toISOString() };
  if (metadata.title !== undefined) updated.title = requireText(metadata.title, "Task title");
  applyOptional(updated, "type", metadata.type);
  applyOptional(updated, "description", metadata.description);
  applyOptional(updated, "priority", metadata.priority);
  applyOptional(updated, "tags", metadata.tags === undefined || metadata.tags === null
    ? metadata.tags
    : [...metadata.tags]);
  applyOptional(updated, "dueAt", metadata.dueAt);
  if (metadata.projectBindings !== undefined) {
    updated.projectBindings = normalizeProjectBindings(metadata.projectBindings);
  }
  if (metadata.cwd !== undefined) updated.cwd = requireText(metadata.cwd, "Task workspace");
  return updated;
}

function applyOptional<K extends "type" | "description" | "priority" | "tags" | "dueAt">(
  task: Task,
  key: K,
  value: Task[K] | null | undefined
): void {
  if (value === undefined) return;
  if (value === null) delete task[key];
  else task[key] = value;
}

export function updateTaskWorkspace(task: Task, cwd: string, now: Date): Task {
  return { ...task, cwd: requireText(cwd, "Task workspace"), updatedAt: now.toISOString() };
}

export function isTaskArchived(task: Task): boolean {
  return task.status === "archived";
}

export function isTaskExecutionEnabled(task: Task): boolean {
  return task.executionGate.state === "enabled";
}

/**
 * Whether this Task owns a managed Git workspace at all.
 *
 * A Task activated with an empty environment plan legitimately owns none: it
 * binds no Project and adopted no directory, so there is no worktree to be
 * ready and no cwd to verify. Workspace fences use this to distinguish "not
 * prepared yet" from "correctly owns nothing", instead of creating a workspace
 * only to satisfy the fence.
 */
export function taskOwnsManagedWorkspace(
  task: Readonly<Pick<Task, "projectBindings" | "cwd">>
): boolean {
  return task.projectBindings.length > 0 || task.cwd !== undefined;
}

export function stopTaskExecution(task: Task, now: Date): Task {
  validateTask(task);
  if (task.status !== "active" && task.status !== "draft") {
    throw new Error(`Only an open Task can be stopped: ${task.id}.`);
  }
  if (task.executionGate.state === "stopped") return task;
  return validateTask({
    ...task,
    executionGate: { state: "stopped" },
    updatedAt: now.toISOString()
  });
}

export function startTaskExecution(task: Task, now: Date): Task {
  validateTask(task);
  if (task.status !== "active" && task.status !== "draft") {
    throw new Error(`Only an open Task can be started: ${task.id}.`);
  }
  if (task.executionGate.state === "enabled") return task;
  return validateTask({
    ...task,
    executionGate: { state: "enabled" },
    updatedAt: now.toISOString()
  });
}

export function validateTask(task: Task): Task {
  if (task.schemaVersion !== 7) throw new Error("Task must use schemaVersion 7.");
  requireSafeIdentity(task.id, "Task id");
  requireText(task.title, "Task title");
  if (task.type !== undefined) requireSafeIdentity(task.type, "Task type");
  if (!(["draft", "active", "completed", "cancelled", "archived"] as const).includes(task.status)) {
    throw new Error(`Task status is invalid: ${String(task.status)}.`);
  }
  if (task.executionGate === null
    || typeof task.executionGate !== "object"
    || !(["enabled", "stopped"] as const).includes(task.executionGate.state)) {
    throw new Error(`Task execution state is invalid: ${String(task.executionGate?.state)}.`);
  }
  requireTimestamp(task.createdAt, "Task createdAt");
  requireTimestamp(task.updatedAt, "Task updatedAt");
  if (task.retirementIsolation !== undefined && task.retirementIsolation !== true) {
    throw new Error("Task retirement isolation must represent explicit established evidence.");
  }
  if (task.completionArtifactRefs !== undefined && !Array.isArray(task.completionArtifactRefs)) {
    throw new Error("Task completion artifact refs must be an array.");
  }
  for (const ref of task.completionArtifactRefs ?? []) requireText(ref, "Task completion artifact ref");
  if (Date.parse(task.updatedAt) < Date.parse(task.createdAt)) {
    throw new Error("Task updatedAt cannot precede createdAt.");
  }
  if (task.workspaceIdentity !== undefined) {
    const identity = validateTaskWorkspaceIdentity(task.workspaceIdentity);
    if (identity.taskId !== task.id) {
      throw new Error(`Task workspace identity belongs to another Task: ${identity.taskId}.`);
    }
  }
  if (task.activationRequest !== undefined) {
    const request = validateTaskActivationRequest(task.activationRequest);
    if (request.operation.targetId !== task.id) {
      throw new Error(
        `Task activation request belongs to another Task: ${request.operation.targetId}.`
      );
    }
  }
  if (task.settledActivationRequests !== undefined) {
    const settled = task.settledActivationRequests;
    if (!Array.isArray(settled)) {
      throw new Error("Task settled activation requests are invalid.");
    }
    if (settled.length > MAX_SETTLED_ACTIVATION_REQUESTS) {
      throw new Error("Task settled activation requests exceed the bounded limit.");
    }
    const seen = new Set<string>();
    for (const entry of settled) {
      const request = validateTaskActivationRequest(entry);
      if (request.operation.targetId !== task.id) {
        throw new Error(
          `Task settled activation request belongs to another Task: ${request.operation.targetId}.`
        );
      }
      if (!isSettledActivationRequest(request)) {
        throw new Error(
          "Task settled activation history retains only terminal requests: "
          + `${request.operation.requestId}/${request.disposition}.`
        );
      }
      // One record per id, and never a stale copy of the live slot: the slot is
      // the only place a request that can still change is allowed to live.
      if (seen.has(request.operation.requestId)
        || request.operation.requestId === task.activationRequest?.operation.requestId) {
        throw new Error(
          `Task activation request is duplicated: ${request.operation.requestId}.`
        );
      }
      seen.add(request.operation.requestId);
    }
  }
  if (task.priority !== undefined
    && !(["low", "medium", "high", "urgent"] as const).includes(task.priority)) {
    throw new Error(`Task priority is invalid: ${String(task.priority)}.`);
  }
  if (task.description !== undefined) requireText(task.description, "Task description");
  if (task.tags !== undefined) {
    if (!Array.isArray(task.tags)) throw new Error("Task tags are invalid.");
    for (const tag of task.tags) requireText(tag, "Task tag");
  }
  if (task.dueAt !== undefined) requireTimestamp(task.dueAt, "Task dueAt");
  normalizeProjectBindings(task.projectBindings);
  if (task.cwd !== undefined) requireText(task.cwd, "Task workspace");
  if (Object.hasOwn(task, "legacyDeliveryPath")) {
    throw new Error("Task contains the removed delivery-path field.");
  }
  const completionFields = [task.completedAt, task.completedBy, task.completionSummary];
  const hasAnyCompletion = completionFields.some((value) => value !== undefined);
  const hasAllCompletion = completionFields.every((value) => value !== undefined);
  if (hasAnyCompletion && !hasAllCompletion) {
    throw new Error("Task completion metadata must include completedAt, completedBy, and completionSummary.");
  }
  if (hasAllCompletion) {
    requireTimestamp(task.completedAt!, "Task completedAt");
    if (!(["user", "operator", "leader"] as const).includes(task.completedBy!)) {
      throw new Error(`Task completedBy is invalid: ${String(task.completedBy)}.`);
    }
    requireText(task.completionSummary!, "Task completion summary");
  }
  if (task.status === "completed" && !hasAllCompletion) {
    throw new Error("A completed Task requires completedAt, completedBy, and completionSummary.");
  }
  if (["draft", "active", "cancelled"].includes(task.status)
    && hasAnyCompletion) {
    throw new Error(`Task completion metadata is invalid for ${task.status} status.`);
  }

  const retirementFields = [
    task.retiredAt,
    task.retiredBy,
    task.retirementSummary,
    task.replacementTaskId
  ];
  const hasAnyRetirement = retirementFields.some((value) => value !== undefined);
  const retired = task.status === "cancelled";
  const archivedRetirement = task.status === "archived" && hasAnyRetirement;
  if (retired || archivedRetirement) {
    if (
      task.retiredAt === undefined
      || task.retiredBy === undefined
      || task.retirementSummary === undefined
    ) {
      throw new Error(
        "A retired Task requires retiredAt, retiredBy, and retirementSummary."
      );
    }
    requireTimestamp(task.retiredAt, "Task retiredAt");
    if (!( ["user", "operator", "leader"] as const).includes(task.retiredBy)) {
      throw new Error(`Task retiredBy is invalid: ${String(task.retiredBy)}.`);
    }
    requireText(task.retirementSummary, "Task retirement summary");
    if (task.replacementTaskId !== undefined) {
      const replacementTaskId = requireSafeIdentity(
        task.replacementTaskId,
        "Replacement Task id"
      );
      if (replacementTaskId === task.id) throw new Error("A Task cannot replace itself.");
    }
  } else if (hasAnyRetirement) {
    throw new Error(`Task retirement metadata is invalid for ${task.status} status.`);
  }

  const hasAnyArchive = [task.archivedAt, task.archivedBy, task.archiveReason, task.archiveSummary]
    .some((value) => value !== undefined);
  if (task.status === "archived") {
    if (task.archivedAt === undefined || task.archivedBy === undefined) {
      throw new Error("An archived Task requires archivedAt and archivedBy.");
    }
    requireTimestamp(task.archivedAt, "Task archivedAt");
    if (!(["user", "operator", "leader"] as const).includes(task.archivedBy)) {
      throw new Error(`Task archivedBy is invalid: ${String(task.archivedBy)}.`);
    }
    if (task.archiveReason !== undefined) requireText(task.archiveReason, "Task archive reason");
    if (task.archiveSummary !== undefined) requireText(task.archiveSummary, "Task archive summary");
    if (hasAllCompletion === hasAnyRetirement) {
      throw new Error(
        "An archived Task must preserve exactly one completion or retirement outcome."
      );
    }
  } else if (hasAnyArchive) {
    throw new Error(`Task archive metadata is invalid for ${task.status} status.`);
  }
  return task;
}

function cloneMetadata(
  metadata: TaskMetadata
): TaskMetadata & Readonly<{ projectBindings: readonly TaskProjectBinding[] }> {
  const cloned: TaskMetadata & { projectBindings: readonly TaskProjectBinding[] } = {
    ...(metadata.type === undefined ? {} : { type: requireSafeIdentity(metadata.type, "Task type") }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.priority === undefined ? {} : { priority: metadata.priority }),
    ...(metadata.tags === undefined ? {} : { tags: [...metadata.tags] }),
    ...(metadata.dueAt === undefined ? {} : { dueAt: metadata.dueAt }),
    projectBindings: normalizeProjectBindings(metadata.projectBindings ?? []),
    ...(metadata.cwd === undefined ? {} : { cwd: requireText(metadata.cwd, "Task workspace") })
  };
  return cloned;
}

function normalizeProjectBindings(
  bindings: readonly TaskProjectBinding[]
): readonly TaskProjectBinding[] {
  if (!Array.isArray(bindings)) throw new Error("Task Project bindings are invalid.");
  const projectIds = new Set<string>();
  const directories = new Set<string>();
  return bindings.map((binding) => {
    const projectId = requireSafeIdentity(binding.projectId, "Project id");
    const directory = requireSafeIdentity(binding.directory, "Project directory");
    const baseRef = requireText(binding.baseRef, "Task base ref");
    const baseCommit = binding.baseCommit === undefined
      ? undefined
      : requireCommit(binding.baseCommit, "Task Project base commit");
    const currentCommit = binding.currentCommit === undefined
      ? undefined
      : requireCommit(binding.currentCommit, "Task Project current commit");
    if ((baseCommit === undefined) !== (currentCommit === undefined)) {
      throw new Error(
        `Task Project commit metadata must include both baseCommit and currentCommit: ${projectId}.`
      );
    }
    if (projectIds.has(projectId)) {
      throw new Error(`Task Project is duplicated: ${projectId}.`);
    }
    if (directories.has(directory)) {
      throw new Error(`Task Project directory is duplicated: ${directory}.`);
    }
    projectIds.add(projectId);
    directories.add(directory);
    return {
      projectId,
      directory,
      baseRef,
      ...(baseCommit === undefined ? {} : { baseCommit, currentCommit })
    };
  });
}

function requireCommit(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

export function taskProjectBinding(
  task: Task,
  projectId: string
): TaskProjectBinding | undefined {
  return task.projectBindings.find((binding) => binding.projectId === projectId);
}

export function taskHasProjects(task: Task): boolean {
  return task.projectBindings.length > 0;
}

export function taskProjectIds(task: Task): readonly string[] {
  return task.projectBindings.map(({ projectId }) => projectId);
}

export function addTaskProjectBinding(
  task: Task,
  binding: TaskProjectBinding,
  now: Date
): Task {
  if (taskProjectBinding(task, binding.projectId) !== undefined) {
    throw new Error(`Task already contains Project: ${binding.projectId}.`);
  }
  return validateTask({
    ...task,
    projectBindings: normalizeProjectBindings([...task.projectBindings, binding]),
    updatedAt: now.toISOString()
  });
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}
