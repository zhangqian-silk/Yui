import { createTaskEvent } from "../event/taskEvent.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { createProjectResources, type EnvironmentPlan } from "../resources/projectResourceService.js";
import type { EnvironmentPreparation } from "../resources/projectResource.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  admitTaskActivationRequest,
  adoptTaskActivationRequest,
  cancelTaskActivationRequest,
  canonicalEnvironmentPlan,
  createTaskActivationRequest,
  describeEnvironmentPlan,
  failTaskActivationRequest,
  settledActivationFromEvents,
  taskActivationInputDigest,
  TASK_ACTIVATION_EVENT,
  type SettledActivationRequestFact,
  type TaskActivationRequest,
  type TaskActivationStartMode
} from "./taskActivation.js";
import { setTaskActivationRequest, recordTaskActivationRequestEvidence, type Task } from "./task.js";

/**
 * The terminal outcome already recorded for a requestId, or `undefined` if it
 * was never cancelled or adopted.
 *
 * The authority is the durable activation event ledger, which is never
 * compacted, so a decided outcome survives the bounded display payload evicting
 * its record. The live slot is consulted first only as a fast path for the id
 * that still occupies it; the two always agree, because every terminal
 * transition writes its event in the same transaction that mutates the slot.
 */
function settledActivationRequest(
  reader: Pick<TaskStore, "listEvents">,
  task: Task,
  requestId: string
): SettledActivationRequestFact | undefined {
  const current = task.activationRequest;
  if (current?.operation.requestId === requestId
    && (current.disposition === "cancelled" || current.disposition === "adopted")) {
    return {
      disposition: current.disposition,
      ...(current.outcome === undefined ? {} : { outcome: current.outcome })
    };
  }
  return settledActivationFromEvents(reader.listEvents(task.id), requestId);
}

export type RequestTaskActivationInput = Readonly<{
  taskId: string;
  requestId: string;
  actorId: string;
  authorityRef: string;
  environmentPlan: EnvironmentPlan;
  /**
   * Turn the caller is running inside, when it is this Task's planning Turn.
   * Supplying it is what makes the request deferred instead of immediate; the
   * caller never waits for its own Turn to end.
   */
  callerRunId?: string;
}>;

export type RequestTaskActivationResult = Readonly<{
  /** The stable operation reference; returned immediately in every case. */
  operationRef: string;
  request: TaskActivationRequest;
  startMode: TaskActivationStartMode;
  /** True when this call created the request rather than returning the existing one. */
  created: boolean;
  /** Planning Turn whose termination releases the request, when deferred. */
  afterPlanningRun?: string;
}>;

export function taskActivationOperationRef(taskId: string, requestId: string): string {
  return `task-activation:${taskId}/${requestId}`;
}

/**
 * Records an explicit activation request and returns its operation reference.
 *
 * This never prepares resources and never waits. When the caller is the Task's
 * own running planning Turn, the request is stored with `afterPlanningRun` set
 * to that Turn — expressing the deferral in the same operation facts the
 * request already carries, rather than blocking a synchronous tool on the Turn
 * it is running inside (S40).
 *
 * A repeated requestId with the same inputs returns the existing request
 * unchanged, so a retried tool call cannot produce a second activation.
 */
export function requestTaskActivation(
  store: TaskStore,
  input: RequestTaskActivationInput,
  now: Date
): RequestTaskActivationResult {
  return store.transaction((tx) => recordTaskActivationRequestInTransaction(tx, input, now));
}

/**
 * The transactional core of {@link requestTaskActivation}, callable from inside
 * a caller's own open transaction.
 *
 * The shared submission service (task-32 §2.3) records a develop route's
 * activation request in the very transaction that saves the message, so the
 * message and its activation intent commit together and no "submit then
 * activate" two-command window exists. It reuses this exact logic rather than a
 * second activation queue: the same idempotency, settled-id refusal and
 * pending-collision rules apply whether the request arrives from the explicit
 * boundary or from a develop submission. The caller owns transaction lifetime
 * and any post-commit mailbox notification.
 */
export function recordTaskActivationRequestInTransaction(
  tx: TaskStore,
  input: RequestTaskActivationInput,
  now: Date
): RequestTaskActivationResult {
  const task = requireOpenDraft(tx, input.taskId);
  const plan = canonicalEnvironmentPlan(input.environmentPlan);
  const planningRun = resolveCallerPlanningRun(tx, task.id, input.callerRunId);
  const startMode: TaskActivationStartMode = planningRun === undefined
    ? "immediate"
    : "after-planning-turn";
  const existing = task.activationRequest;
  // A requestId whose outcome was already decided is never re-opened, whether
  // it still holds the slot or a later request displaced it. Cancelling A,
  // requesting B and then retrying A must not resurrect A: the withdrawal is
  // explicit authority, and adoption is exactly the effect it withdrew. An
  // adopted id is equally final — its environment and status change happened.
  // Only `failed` stays replayable, which is its documented contract.
  //
  // The authority is the durable activation event ledger, not the bounded
  // display payload: the payload trims its oldest entries once it overflows,
  // but the terminal events are never compacted, so an evicted cancellation is
  // still refused with its original outcome instead of silently resurrecting.
  const settled = settledActivationRequest(tx, task, input.requestId);
  if (settled !== undefined) {
    throw new Error(
      `Activation request ${input.requestId} was already ${settled.disposition} for ${task.id}`
      + `${settled.outcome === undefined ? "" : ` (${settled.outcome})`}. `
      + "Use a new requestId."
    );
  }
  if (existing?.operation.requestId === input.requestId) {
    const digest = taskActivationInputDigest(task.id, {
      startMode,
      ...(planningRun === undefined ? {} : { afterPlanningRun: planningRun }),
      environmentPlan: plan
    });
    if (existing.operation.inputDigest !== digest) {
      throw new Error(
        `Activation requestId ${input.requestId} was already used for different inputs.`
      );
    }
    return {
      operationRef: taskActivationOperationRef(task.id, existing.operation.requestId),
      request: existing,
      startMode: existing.startMode,
      created: false,
      ...(existing.afterPlanningRun === undefined
        ? {}
        : { afterPlanningRun: existing.afterPlanningRun })
    };
  }
  if (existing?.disposition === "pending") {
    throw new Error(
      `Task already has a pending activation request: ${task.id}/${existing.operation.requestId}. `
      + "Cancel it before requesting different inputs."
    );
  }
  const request = createTaskActivationRequest(task.id, {
    requestId: input.requestId,
    actorId: input.actorId,
    authorityRef: input.authorityRef,
    startMode,
    ...(planningRun === undefined ? {} : { afterPlanningRun: planningRun }),
    environmentPlan: plan
  }, now);
  tx.saveTask(setTaskActivationRequest(task, request, now));
  tx.saveEvent(task.id, createTaskEvent(
    tx.nextEventId(task.id),
    task.id,
    TASK_ACTIVATION_EVENT.requested,
    {
      requestId: request.operation.requestId,
      startMode: request.startMode,
      environmentPlan: describeEnvironmentPlan(request.environmentPlan),
      actor: request.operation.actorId,
      ...(request.afterPlanningRun === undefined
        ? {}
        : { afterPlanningRun: request.afterPlanningRun })
    },
    now
  ));
  return {
    operationRef: taskActivationOperationRef(task.id, request.operation.requestId),
    request,
    startMode,
    created: true,
    ...(planningRun === undefined ? {} : { afterPlanningRun: planningRun })
  };
}

/** Explicit user or Operator cancellation. A cancelled request never adopts. */
export function cancelTaskActivation(
  store: TaskStore,
  taskId: string,
  requestId: string,
  reason: string,
  now: Date
): TaskActivationRequest {
  return store.transaction((tx) => {
    const task = tx.getTask(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}.`);
    const existing = task.activationRequest;
    if (existing === undefined || existing.operation.requestId !== requestId) {
      throw new Error(`Activation request not found: ${taskId}/${requestId}.`);
    }
    if (existing.disposition === "adopted") {
      throw new Error(
        `Activation ${requestId} was already adopted for ${taskId}; its environment and active `
        + "status are established facts. Stop execution or retire the Task instead."
      );
    }
    const cancelled = cancelTaskActivationRequest(existing, reason, now);
    if (cancelled !== existing) {
      tx.saveTask(setTaskActivationRequest(task, cancelled, now));
      tx.saveEvent(taskId, createTaskEvent(
        tx.nextEventId(taskId),
        taskId,
        TASK_ACTIVATION_EVENT.cancelled,
        { requestId, reason: cancelled.outcome ?? reason },
        now
      ));
    }
    return cancelled;
  });
}

export type TaskActivationAdmissionResult =
  | Readonly<{ disposition: "ready"; request: TaskActivationRequest; plan: EnvironmentPlan }>
  | Readonly<{ disposition: "deferred"; request: TaskActivationRequest; afterPlanningRun: string }>
  | Readonly<{ disposition: "absent" }>
  | Readonly<{ disposition: "settled"; request: TaskActivationRequest }>
  | Readonly<{ disposition: "unavailable"; request: TaskActivationRequest; reason: string }>;

/**
 * Re-reads the stored request and decides whether it may be adopted now.
 *
 * Called immediately before the adoption boundary, so a Task retired, stopped,
 * or a request cancelled while the planning Turn was still running is caught
 * here rather than replayed as historical intent.
 */
export function admitStoredTaskActivation(
  store: TaskStore,
  taskId: string
): TaskActivationAdmissionResult {
  const task = store.getTask(taskId);
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  const admission = admitTaskActivationRequest(
    task,
    task.activationRequest,
    (runId) => store.getRun(taskId, runId)?.status === "active"
  );
  if (admission === undefined) return { disposition: "absent" };
  return admission.disposition === "ready"
    ? {
        disposition: "ready",
        request: admission.request,
        plan: admission.request.environmentPlan
      }
    : admission;
}

export type AdoptTaskActivationResourcesResult = Readonly<{
  request: TaskActivationRequest;
  /** Absent for an empty plan: no directory environment is legal (S27). */
  preparation?: EnvironmentPreparation;
}>;

/**
 * Prepares and adopts the request's resource configuration.
 *
 * An empty plan is legal and adopts nothing physical. On failure the request is
 * recorded as failed, the Task remains a continuable Draft, and only resources
 * this call can confirm were never adopted are released — a prepared-but-not
 * adopted scratch directory. Anything whose disposition cannot be proven is
 * retained for its owner to inspect and reported as a `possible` effect.
 *
 * A successful adoption is recorded on the request immediately, against its own
 * requestId. The resources are adopted the moment `adopt` commits, so the effect
 * cannot wait for the Task-status transaction: a cancel or a replacement landing
 * in between must not be able to leave an adopted environment described as
 * `none`, nor attach it to whichever request now holds the slot.
 */
export function adoptTaskActivationResources(
  store: TaskStore,
  taskId: string,
  now: () => Date = () => new Date()
): AdoptTaskActivationResourcesResult {
  const admission = admitStoredTaskActivation(store, taskId);
  if (admission.disposition !== "ready") {
    throw new Error(
      `Task activation is not adoptable: ${taskId}/${admission.disposition}`
      + (admission.disposition === "unavailable" ? ` (${admission.reason})` : "")
      + "."
    );
  }
  const resources = createProjectResources(store, now);
  const plan = admission.plan;
  const requestId = admission.request.operation.requestId;
  if (plan.kind === "empty") {
    // An empty plan owns no physical environment. Nothing is prepared, so
    // nothing can be left half-adopted, and no worktree is created to satisfy
    // the framework's own model.
    return { request: admission.request };
  }
  let prepared: EnvironmentPreparation | undefined;
  try {
    prepared = resources.prepare(taskId, plan);
    const adopted = resources.adopt(taskId, prepared.id);
    // The environment is adopted now. Persist that as a confirmed effect of this
    // requestId before returning, so a cancellation or replacement that races
    // the rest of activation still finds the truth on the request that caused it.
    return {
      request: recordTaskActivationResourceEffect(store, taskId, requestId, adopted.id, now()),
      preparation: adopted
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const released = releaseUnadoptedPreparation(store, taskId, prepared, now);
    recordFailedTaskActivation(store, taskId, admission.request, message, {
      // Preparation that could not be confirmed unadopted is retained, and its
      // possible effect is recorded rather than erased.
      effect: prepared === undefined ? "none" : released ? "none" : "possible",
      ...(prepared === undefined ? {} : { partialResultRefs: [`${taskId}/${prepared.id}`] })
    }, now());
    throw error;
  }
}

/**
 * Attaches the adopted environment to the exact request that adopted it.
 *
 * The request keeps its `pending` disposition: resources are adopted, the Task
 * is not active yet, and only the activation transaction may say otherwise. The
 * effect and the preparation ref are recorded by id, so they stay with this
 * request even if it loses the slot before activation completes.
 */
function recordTaskActivationResourceEffect(
  store: TaskStore,
  taskId: string,
  requestId: string,
  preparationId: string,
  now: Date
): TaskActivationRequest {
  return store.transaction((tx) => {
    const task = tx.getTask(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}.`);
    const updated = recordTaskActivationRequestEvidence(task, requestId, {
      effect: "confirmed",
      partialResultRefs: [`${taskId}/${preparationId}`]
    }, now);
    tx.saveTask(updated);
    const request = updated.activationRequest?.operation.requestId === requestId
      ? updated.activationRequest
      : updated.settledActivationRequests?.find(
          ({ operation }) => operation.requestId === requestId
        );
    if (request === undefined) {
      throw new Error(`Activation request disappeared while adopting it: ${taskId}/${requestId}.`);
    }
    return request;
  });
}

/**
 * Records the adopted request inside the caller's activation transaction, so
 * the confirmed operation effect commits with the Task's active status and its
 * environment facts. A later launch failure is reported separately and never
 * rewrites this record.
 *
 * `expected` is the request identity resource adoption actually ran for. It is
 * re-checked here because the slot can change while the workspace is being
 * prepared: a cancelled or replaced request must fail this transaction rather
 * than have someone else's preparation recorded against it. The plan is compared
 * too, so an `empty` request can never inherit a directory it never asked for.
 *
 * Recording a `preparationId` therefore requires `expected`: a preparation only
 * exists because some specific request produced it, so naming one without saying
 * which request it belongs to is never a legal call. It stays optional only for
 * the no-preparation case, where there is no environment to misattribute.
 */
export function recordAdoptedTaskActivation(
  store: TaskStore,
  task: Task,
  evidence: Readonly<{ preparationId?: string; expected?: TaskActivationRequest }>,
  now: Date
): Task {
  const existing = task.activationRequest;
  if (existing === undefined) return task;
  const expected = evidence.expected;
  if (expected === undefined && evidence.preparationId !== undefined) {
    throw new Error(
      `Activation adoption must name the request its preparation belongs to: `
      + `${task.id}/${evidence.preparationId}.`
    );
  }
  if (expected !== undefined) {
    if (existing.operation.requestId !== expected.operation.requestId) {
      throw new Error(
        `Activation request changed while activating ${task.id}: prepared `
        + `${expected.operation.requestId}, found ${existing.operation.requestId}.`
      );
    }
    if (existing.operation.inputDigest !== expected.operation.inputDigest) {
      throw new Error(
        `Activation request inputs changed while activating ${task.id}: `
        + `${existing.operation.requestId}.`
      );
    }
    if (existing.disposition !== "pending" && existing.disposition !== "adopted") {
      throw new Error(
        `Activation request is no longer adoptable for ${task.id}: `
        + `${existing.operation.requestId}/${existing.disposition}`
        + `${existing.outcome === undefined ? "" : ` (${existing.outcome})`}.`
      );
    }
  }
  const adopted = adoptTaskActivationRequest(existing, {
    ...(evidence.preparationId === undefined
      ? {}
      : { preparationId: evidence.preparationId }),
    receiptRefs: [taskActivationOperationRef(task.id, existing.operation.requestId)]
  }, now);
  store.saveEvent(task.id, createTaskEvent(
    store.nextEventId(task.id),
    task.id,
    TASK_ACTIVATION_EVENT.adopted,
    {
      requestId: adopted.operation.requestId,
      environmentPlan: describeEnvironmentPlan(adopted.environmentPlan),
      ...(adopted.preparationId === undefined
        ? {}
        : { preparationId: adopted.preparationId })
    },
    now
  ));
  return setTaskActivationRequest(task, adopted, now);
}

/**
 * Records that an activation attempt did not adopt. The Task is untouched: it
 * stays a Draft the Leader can keep planning in, with the real preparation
 * evidence preserved.
 */
export function recordFailedTaskActivation(
  store: TaskStore,
  taskId: string,
  request: TaskActivationRequest,
  outcome: string,
  evidence: Readonly<{
    effect?: TaskActivationRequest["operation"]["effect"];
    partialResultRefs?: readonly string[];
  }>,
  now: Date
): TaskActivationRequest {
  return store.transaction((tx) => {
    const task = tx.getTask(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}.`);
    const current = task.activationRequest;
    if (current === undefined
      || current.operation.requestId !== request.operation.requestId
      || current.disposition === "adopted"
      || current.disposition === "cancelled") {
      return current ?? request;
    }
    const failed = failTaskActivationRequest(current, outcome, now, evidence);
    tx.saveTask(setTaskActivationRequest(task, failed, now));
    tx.saveEvent(taskId, createTaskEvent(
      tx.nextEventId(taskId),
      taskId,
      TASK_ACTIVATION_EVENT.failed,
      {
        requestId: failed.operation.requestId,
        outcome: failed.outcome ?? outcome,
        effect: failed.operation.effect
      },
      now
    ));
    if (task.status === "draft") {
      // This is a Core operation result, not a Leader-local planning edit.
      // The Leader must learn the failed disposition and choose a legal next
      // action; merely stopping automatic retries would otherwise strand it.
      enqueueWork(tx, {kind:"role", taskId, roleName:"leader"}, "activation-failed",
        now, [{type:"task", id:taskId}]);
    }
    return failed;
  });
}

/**
 * Releases a preparation only when this process can confirm it was never
 * adopted. Returns false when the disposition is unprovable or release itself
 * failed, so the caller records a `possible` effect instead of claiming the
 * resource is clean.
 */
function releaseUnadoptedPreparation(
  store: TaskStore,
  taskId: string,
  prepared: EnvironmentPreparation | undefined,
  now: () => Date
): boolean {
  if (prepared === undefined) return true;
  const current = store.getEnvironmentPreparation(taskId, prepared.id);
  if (current === null) return false;
  if (current.disposition === "released") return true;
  if (current.disposition !== "prepared") return false;
  try {
    createProjectResources(store, now).release(taskId, prepared.id);
    return true;
  } catch {
    // The directory is retained for its owner to inspect. Never force-remove
    // an environment whose contents or use cannot be proven.
    return false;
  }
}

function requireOpenDraft(store: TaskStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  if (task.status !== "draft") {
    throw new Error(`Only a Draft Task can request activation: ${taskId}/${task.status}.`);
  }
  if (task.executionGate.state !== "enabled") {
    throw new Error(`Task execution is stopped: ${taskId}.`);
  }
  return task;
}

/**
 * Resolves the caller's own planning Turn, which is what turns this request
 * into a deferred one. Any other Turn id is rejected rather than silently
 * treated as immediate: a caller that names a Turn is asserting it runs inside
 * it, and a wrong assertion must not quietly change the start mode.
 */
function resolveCallerPlanningRun(
  store: TaskStore,
  taskId: string,
  callerRunId: string | undefined
): string | undefined {
  if (callerRunId === undefined) return undefined;
  const run = store.getRun(taskId, callerRunId);
  if (run === null) throw new Error(`AgentRun not found: ${taskId}/${callerRunId}.`);
  if (run.purpose !== "planning") {
    throw new Error(
      `Activation deferral requires a planning AgentRun: ${taskId}/${callerRunId}/${run.purpose}.`
    );
  }
  if (run.status !== "active") {
    // A terminated planning Turn no longer needs deferral; the request is
    // adoptable now and says so, rather than waiting for a finished Turn.
    return undefined;
  }
  return run.id;
}
