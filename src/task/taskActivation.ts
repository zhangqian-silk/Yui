import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { requireIdentity, requireTimestamp } from "../domain/validation.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  recordOperationEvidence,
  validateOperationFacts,
  type OperationFacts
} from "../kernel/operationFacts.js";
import type { EnvironmentPlan } from "../resources/projectResourceService.js";
import type { Task } from "./task.js";

export const TASK_ACTIVATION_IMPLEMENTATION = Object.freeze({
  id: "yui:task-activation",
  generation: "1"
});

export const TASK_ACTIVATION_CAPABILITY = "task.activate";

/**
 * The durable activation event vocabulary.
 *
 * These events are the never-compacted authority for a request's terminal
 * outcome, so the type strings are named constants shared by every emitter and
 * every reader. A rename cannot silently desynchronise what adoption/cancel
 * record from what replay enforcement reads back — which is exactly how the
 * bounded display list used to lose authority once it overflowed.
 */
export const TASK_ACTIVATION_EVENT = Object.freeze({
  requested: "task.activation-requested",
  cancelled: "task.activation-cancelled",
  adopted: "task.activation-adopted",
  failed: "task.activation-failed"
} as const);

/**
 * How the requester expects delivery to start.
 *
 * `immediate` is adopted by whoever holds the request; `afterPlanningTurn`
 * names the planning Turn that must terminate first. A planning Turn that
 * requests its own Task's activation always gets the deferred mode, because a
 * synchronous tool must never wait for the Turn it is running inside.
 */
export type TaskActivationStartMode = "immediate" | "after-planning-turn";

export type TaskActivationDisposition =
  | "pending"
  | "adopted"
  | "cancelled"
  | "failed";

/**
 * One durable activation request, embedded in the Task that owns it.
 *
 * This is not a second lifecycle: `Task.status` remains the only statement
 * about whether delivery started. The request records the intent, the exact
 * operation identity that may be replayed safely, and the resource
 * configuration to adopt — so the request survives the planning Session that
 * created it and can be re-checked against current facts before adoption.
 */
export type TaskActivationRequest = Readonly<{
  schemaVersion: 1;
  operation: OperationFacts;
  startMode: TaskActivationStartMode;
  /** Turn whose termination releases a deferred request. */
  afterPlanningRun?: string;
  /** Explicit resource configuration; an empty plan is legal. */
  environmentPlan: EnvironmentPlan;
  disposition: TaskActivationDisposition;
  /** Preparation actually adopted by this request, once adoption succeeded. */
  preparationId?: string;
  /** Why a pending request stopped being adoptable. Never a fake rollback. */
  outcome?: string;
  requestedAt: string;
  updatedAt: string;
}>;

export type TaskActivationRequestInput = Readonly<{
  requestId: string;
  actorId: string;
  authorityRef: string;
  startMode: TaskActivationStartMode;
  afterPlanningRun?: string;
  environmentPlan: EnvironmentPlan;
}>;

/**
 * The digest that decides whether a repeated requestId is the same request.
 *
 * It covers only what adoption actually consumes: the Task, the start mode and
 * the resource configuration. Ordinary planning progress — a Brief edit, a new
 * Decision, a changed current focus — deliberately does not appear here, so
 * continuing to plan never invalidates an already-issued request.
 */
export function taskActivationInputDigest(
  taskId: string,
  input: Readonly<{
    startMode: TaskActivationStartMode;
    afterPlanningRun?: string;
    environmentPlan: EnvironmentPlan;
  }>
): string {
  return createHash("sha256").update(JSON.stringify([
    taskId,
    input.startMode,
    input.afterPlanningRun ?? null,
    canonicalEnvironmentPlan(input.environmentPlan)
  ])).digest("hex");
}

export function createTaskActivationRequest(
  taskId: string,
  input: TaskActivationRequestInput,
  now: Date
): TaskActivationRequest {
  if (input.startMode === "after-planning-turn") {
    if (input.afterPlanningRun === undefined) {
      throw new Error("A deferred activation request must name its planning Turn.");
    }
  } else if (input.afterPlanningRun !== undefined) {
    throw new Error("An immediate activation request cannot defer to a planning Turn.");
  }
  const timestamp = now.toISOString();
  return validateTaskActivationRequest({
    schemaVersion: 1,
    operation: {
      requestId: input.requestId,
      inputDigest: taskActivationInputDigest(taskId, input),
      actorId: input.actorId,
      authorityRef: input.authorityRef,
      targetId: taskId,
      capability: TASK_ACTIVATION_CAPABILITY,
      implementation: TASK_ACTIVATION_IMPLEMENTATION,
      effect: "none",
      receiptRefs: [],
      partialResultRefs: []
    },
    startMode: input.startMode,
    ...(input.afterPlanningRun === undefined
      ? {}
      : { afterPlanningRun: input.afterPlanningRun }),
    environmentPlan: canonicalEnvironmentPlan(input.environmentPlan),
    disposition: "pending",
    requestedAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * Records that adoption completed. `effect` escalates to `confirmed` and never
 * returns: a later launch failure is reported on the Task, not by erasing the
 * fact that the environment and the active status were adopted.
 */
export function adoptTaskActivationRequest(
  request: TaskActivationRequest,
  evidence: Readonly<{ preparationId?: string; receiptRefs?: readonly string[] }>,
  now: Date
): TaskActivationRequest {
  if (request.disposition === "adopted") return request;
  if (request.disposition !== "pending" && request.disposition !== "failed") {
    throw new Error(`Activation request is not adoptable: ${request.operation.requestId}.`);
  }
  return validateTaskActivationRequest({
    ...request,
    operation: recordOperationEvidence(request.operation, {
      effect: "confirmed",
      ...(evidence.receiptRefs === undefined ? {} : { receiptRefs: evidence.receiptRefs })
    }),
    disposition: "adopted",
    ...(evidence.preparationId === undefined
      ? {}
      : { preparationId: evidence.preparationId }),
    updatedAt: now.toISOString()
  });
}

/**
 * Records an attempt that did not adopt. The request stays replayable and the
 * Task stays a continuable Draft; `effect` rises to `possible` only when the
 * caller could not prove the resources were left untouched.
 */
export function failTaskActivationRequest(
  request: TaskActivationRequest,
  outcome: string,
  now: Date,
  evidence: Readonly<{
    effect?: OperationFacts["effect"];
    partialResultRefs?: readonly string[];
  }> = {}
): TaskActivationRequest {
  if (request.disposition === "adopted") {
    throw new Error(`Adopted activation cannot be reported as failed: ${request.operation.requestId}.`);
  }
  if (request.disposition === "cancelled") return request;
  return validateTaskActivationRequest({
    ...request,
    operation: recordOperationEvidence(request.operation, evidence),
    disposition: "failed",
    outcome: requireOutcome(outcome),
    updatedAt: now.toISOString()
  });
}

/**
 * Records what an attempt really did, without changing its disposition.
 *
 * Adoption of resources and adoption of the request are separate moments, so a
 * request that was cancelled or replaced after its environment was already
 * adopted still has to carry that effect. This is the same monotonic evidence
 * ratchet the other transitions use — it can only add refs and raise `effect`,
 * never lower it and never rewrite the outcome.
 */
export function recordTaskActivationEvidence(
  request: TaskActivationRequest,
  evidence: Readonly<{
    effect?: OperationFacts["effect"];
    receiptRefs?: readonly string[];
    partialResultRefs?: readonly string[];
  }>,
  now: Date
): TaskActivationRequest {
  const operation = recordOperationEvidence(request.operation, evidence);
  if (isDeepStrictEqual(operation, request.operation)) return request;
  return validateTaskActivationRequest({
    ...request,
    operation,
    updatedAt: now.toISOString()
  });
}

/** An explicitly cancelled request is never replayed, even if it is retried. */
export function cancelTaskActivationRequest(
  request: TaskActivationRequest,
  outcome: string,
  now: Date
): TaskActivationRequest {
  if (request.disposition === "adopted") {
    throw new Error(`Adopted activation cannot be cancelled: ${request.operation.requestId}.`);
  }
  if (request.disposition === "cancelled") return request;
  return validateTaskActivationRequest({
    ...request,
    disposition: "cancelled",
    outcome: requireOutcome(outcome),
    updatedAt: now.toISOString()
  });
}

export type TaskActivationAdmission =
  | Readonly<{ disposition: "ready"; request: TaskActivationRequest }>
  | Readonly<{
      disposition: "deferred";
      request: TaskActivationRequest;
      afterPlanningRun: string;
    }>
  | Readonly<{ disposition: "settled"; request: TaskActivationRequest }>
  | Readonly<{
      disposition: "unavailable";
      request: TaskActivationRequest;
      reason: string;
    }>;

/**
 * Re-checks a stored request against current facts immediately before adoption.
 *
 * Everything decided at request time is deliberately re-decided here: the Task
 * may have been retired, execution may have been stopped, the request may have
 * been cancelled while the planning Turn was still running. Resource-level
 * rechecks stay with `prepare`/`adopt`, which own the grant and directory
 * identity fences.
 */
export function admitTaskActivationRequest(
  task: Task,
  request: TaskActivationRequest | undefined,
  planningRunIsActive: (runId: string) => boolean
): TaskActivationAdmission | undefined {
  if (request === undefined) return undefined;
  if (request.disposition === "adopted" || request.disposition === "cancelled") {
    return { disposition: "settled", request };
  }
  if (request.operation.targetId !== task.id) {
    return {
      disposition: "unavailable",
      request,
      reason: `Activation request targets another Task: ${request.operation.targetId}.`
    };
  }
  if (task.status !== "draft") {
    return {
      disposition: "unavailable",
      request,
      reason: `Task is no longer a Draft: ${task.id}/${task.status}.`
    };
  }
  if (task.executionGate.state !== "enabled") {
    return {
      disposition: "unavailable",
      request,
      reason: `Task execution is stopped: ${task.id}.`
    };
  }
  if (request.afterPlanningRun !== undefined
    && planningRunIsActive(request.afterPlanningRun)) {
    return {
      disposition: "deferred",
      request,
      afterPlanningRun: request.afterPlanningRun
    };
  }
  return { disposition: "ready", request };
}

/**
 * A requestId's terminal outcome as an authority fact, independent of whether
 * the bounded display payload still carries the full request record.
 */
export type SettledActivationRequestFact = Readonly<{
  disposition: "cancelled" | "adopted";
  /** The recorded cancellation reason, when the terminal event carried one. */
  outcome?: string;
}>;

/**
 * The durable terminal outcome for a requestId, read from the activation event
 * ledger.
 *
 * `task.activation-cancelled` and `task.activation-adopted` are never compacted
 * — only runtime-observation events are pruned — so this answers "was this id
 * already settled?" for the entire life of the Task, no matter how many later
 * requests displaced it from the bounded display payload. A `failed` request is
 * intentionally absent here: it stays replayable by contract, so replaying it is
 * not a resurrection of a decided outcome.
 *
 * A requestId reaches at most one terminal disposition — adoption and
 * cancellation exclude each other by construction — so the first matching
 * terminal event is authoritative.
 */
export function settledActivationFromEvents(
  events: readonly TaskEvent[],
  requestId: string
): SettledActivationRequestFact | undefined {
  for (const event of events) {
    if (event.payload.requestId !== requestId) continue;
    if (event.type === TASK_ACTIVATION_EVENT.cancelled) {
      return {
        disposition: "cancelled",
        ...(event.payload.reason === undefined ? {} : { outcome: event.payload.reason })
      };
    }
    if (event.type === TASK_ACTIVATION_EVENT.adopted) {
      return { disposition: "adopted" };
    }
  }
  return undefined;
}

export function validateTaskActivationRequest(
  request: TaskActivationRequest
): TaskActivationRequest {
  if (request.schemaVersion !== 1) {
    throw new Error("Activation request must use schemaVersion 1.");
  }
  validateOperationFacts(request.operation);
  if (request.operation.capability !== TASK_ACTIVATION_CAPABILITY) {
    throw new Error("Activation request capability is invalid.");
  }
  if (!["immediate", "after-planning-turn"].includes(request.startMode)) {
    throw new Error(`Activation start mode is invalid: ${String(request.startMode)}.`);
  }
  if (Object.hasOwn(request, "origin")) {
    throw new Error("Activation contains retired origin metadata; use the storage upgrade boundary.");
  }
  if ((request.startMode === "after-planning-turn")
    !== (request.afterPlanningRun !== undefined)) {
    throw new Error("Activation deferral must name exactly the planning Turn it waits for.");
  }
  if (request.afterPlanningRun !== undefined) {
    requireIdentity(request.afterPlanningRun, "Activation planning Turn");
  }
  if (!["pending", "adopted", "cancelled", "failed"].includes(request.disposition)) {
    throw new Error(`Activation disposition is invalid: ${String(request.disposition)}.`);
  }
  if (request.disposition === "adopted" && request.operation.effect !== "confirmed") {
    throw new Error("An adopted activation must record a confirmed effect.");
  }
  if (request.preparationId !== undefined) {
    requireIdentity(request.preparationId, "Activation preparation");
    if (request.disposition !== "adopted") {
      throw new Error("Only an adopted activation records the preparation it consumed.");
    }
  }
  if (request.outcome !== undefined) requireOutcome(request.outcome);
  canonicalEnvironmentPlan(request.environmentPlan);
  requireTimestamp(request.requestedAt, "Activation requestedAt");
  requireTimestamp(request.updatedAt, "Activation updatedAt");
  if (Date.parse(request.updatedAt) < Date.parse(request.requestedAt)) {
    throw new Error("Activation updatedAt cannot precede requestedAt.");
  }
  return request;
}

/** Normalizes the plan so the digest never depends on key order. */
export function canonicalEnvironmentPlan(plan: EnvironmentPlan): EnvironmentPlan {
  const kind = (plan as { kind?: unknown } | null | undefined)?.kind;
  if (kind === "empty") return { kind: "empty" };
  if (kind === "scratch") return { kind: "scratch" };
  if (kind === "local") {
    const local = plan as Extract<EnvironmentPlan, { kind: "local" }>;
    if (!["read", "write"].includes(local.access)) {
      throw new Error(`Environment plan access is invalid: ${String(local.access)}.`);
    }
    return {
      kind: "local",
      resourceId: requireIdentity(local.resourceId, "Environment plan resource"),
      access: local.access
    };
  }
  throw new Error(`Environment plan kind is invalid: ${String(kind)}.`);
}

export function describeEnvironmentPlan(plan: EnvironmentPlan): string {
  return plan.kind === "local"
    ? `local ${plan.resourceId} (${plan.access})`
    : plan.kind;
}

function requireOutcome(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Activation outcome is invalid.");
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("Activation outcome is required.");
  return normalized.slice(0, 2000);
}
