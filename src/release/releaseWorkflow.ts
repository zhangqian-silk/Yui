import {
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export const RELEASE_WORKFLOW_SCHEMA_VERSION = 1 as const;

export type ReleaseStepKind =
  | "pr-create-or-reuse" | "ci-confirm" | "merge" | "version-tag"
  | "npm-publish" | "fresh-install-smoke" | "cli-update"
  | "controller-replace" | "project-migrate" | "post-verify";

export type ReleaseStepStatus =
  | "pending" | "running" | "succeeded" | "failed" | "unknown" | "skipped";

export type ReleaseWorkflowSource = Readonly<{
  repository: { owner: string; name: string };
  /** Exact pinned commit sha. */
  commit: string;
  artifact?: { name: string; integrity: string };
}>;

export type ReleaseStepPlan = Readonly<{
  /** Unique within the workflow, e.g. "pr", "publish". */
  id: string;
  kind: ReleaseStepKind;
  /** Predeclared idempotency key; derived at create time, never changes. */
  idempotencyKey: string;
  params?: Readonly<Record<string, string>>;
  irreversibility?: "none" | "reversible" | "irreversible";
}>;

export type ReleaseStepRecord = Readonly<{
  planId: string;
  status: ReleaseStepStatus;
  attempts: number;
  /** Authoritative external identity once known: PR number, commit, tag, package version, Controller identity. */
  externalId?: string;
  /** Structured identity for authoritative re-query after a timeout. */
  externalIdentity?: Readonly<{ kind: string; value: string }>;
  logs: readonly string[];
  lastAttemptAt?: string;
  terminalAt?: string;
}>;

export type ReleaseWorkflow = Readonly<{
  schemaVersion: typeof RELEASE_WORKFLOW_SCHEMA_VERSION;
  id: string;
  taskId: string;
  /** capability-grant-N reference. */
  grantId: string;
  source: ReleaseWorkflowSource;
  /** Predeclared, immutable after create. */
  plan: readonly ReleaseStepPlan[];
  /** Keyed by plan id. */
  steps: Readonly<Record<string, ReleaseStepRecord>>;
  createdAt: string;
  updatedAt: string;
}>;

const RELEASE_STEP_KINDS: ReadonlySet<string> = new Set([
  "pr-create-or-reuse", "ci-confirm", "merge", "version-tag",
  "npm-publish", "fresh-install-smoke", "cli-update",
  "controller-replace", "project-migrate", "post-verify"
]);

const RELEASE_STEP_STATUSES: ReadonlySet<string> = new Set([
  "pending", "running", "succeeded", "failed", "unknown", "skipped"
]);

const IRREVERSIBILITY_LEVELS: ReadonlySet<string> = new Set([
  "none", "reversible", "irreversible"
]);

/** The terminal set for resume purposes: succeeded and skipped never resume. */
const TERMINAL_STEP_STATUSES: ReadonlySet<ReleaseStepStatus> = new Set([
  "succeeded", "skipped"
]);

export type ReleaseWorkflowPlanInput = Readonly<{
  id: string;
  kind: ReleaseStepKind;
  params?: Readonly<Record<string, string>>;
  irreversibility?: "none" | "reversible" | "irreversible";
}>;

export function createReleaseWorkflow(
  id: string,
  taskId: string,
  input: Readonly<{
    grantId: string;
    source: ReleaseWorkflowSource;
    plan: readonly ReleaseWorkflowPlanInput[];
  }>,
  now: Date
): ReleaseWorkflow {
  const timestamp = now.toISOString();
  const reference = validateTaskRecordReference({ taskId, localId: id }, "releaseWorkflow");
  const grantId = requireText(input.grantId, "Release workflow grantId");
  const source = normalizeSource(input.source);
  const plan = normalizePlan(input.plan, reference.taskId, reference.localId);
  const steps: Record<string, ReleaseStepRecord> = {};
  for (const entry of plan) {
    steps[entry.id] = Object.freeze({
      planId: entry.id,
      status: "pending",
      attempts: 0,
      logs: Object.freeze([])
    });
  }
  return validateReleaseWorkflow({
    schemaVersion: RELEASE_WORKFLOW_SCHEMA_VERSION,
    id: reference.localId,
    taskId: reference.taskId,
    grantId,
    source,
    plan,
    steps: Object.freeze(steps),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function validateReleaseWorkflow(workflow: ReleaseWorkflow): ReleaseWorkflow {
  if (workflow.schemaVersion !== RELEASE_WORKFLOW_SCHEMA_VERSION) {
    throw new Error("Release workflow must use schemaVersion 1.");
  }
  validateTaskRecordReference(
    { taskId: workflow.taskId, localId: workflow.id },
    "releaseWorkflow"
  );
  requireIdentity(workflow.taskId, "Task id");
  requireText(workflow.grantId, "Release workflow grantId");
  normalizeSource(workflow.source);
  const plan = normalizePlan(workflow.plan, workflow.taskId, workflow.id);
  // An npm-publish step is unrecoverable without a content-addressed source
  // artifact: the immutable workflow source can never gain one later, and
  // each resume would consume another grant use before the adapter fails.
  // Reject such plans at creation (and on every load) rather than at run time.
  if (plan.some((entry) => entry.kind === "npm-publish")
    && workflow.source.artifact === undefined) {
    throw new Error("Release workflow npm-publish step requires a source artifact.");
  }
  for (const entry of plan) {
    const stored = workflow.plan.find((candidate) => candidate.id === entry.id);
    if (stored?.idempotencyKey !== entry.idempotencyKey) {
      throw new Error(`Release step idempotencyKey is invalid: ${entry.id}.`);
    }
  }
  if (typeof workflow.steps !== "object" || workflow.steps === null || Array.isArray(workflow.steps)) {
    throw new Error("Release workflow steps must be an object.");
  }
  const planIds = new Set(plan.map((entry) => entry.id));
  const stepKeys = Object.keys(workflow.steps);
  for (const planId of planIds) {
    if (!Object.hasOwn(workflow.steps, planId)) {
      throw new Error(`Release workflow step record is missing: ${planId}.`);
    }
  }
  for (const key of stepKeys) {
    if (!planIds.has(key)) {
      throw new Error(`Release workflow step record has no plan entry: ${key}.`);
    }
  }
  for (const entry of plan) {
    validateStepRecord(workflow.steps[entry.id]!, entry);
  }
  requireTimestamp(workflow.createdAt, "Release workflow createdAt");
  requireTimestamp(workflow.updatedAt, "Release workflow updatedAt");
  return workflow;
}

/**
 * The first plan-index step whose status is not terminal (succeeded/skipped);
 * null when every step is terminal.
 */
export function resumeCursor(workflow: ReleaseWorkflow): string | null {
  validateReleaseWorkflow(workflow);
  for (const entry of workflow.plan) {
    const step = workflow.steps[entry.id]!;
    if (!TERMINAL_STEP_STATUSES.has(step.status)) {
      return entry.id;
    }
  }
  return null;
}

/** The derived workflow status from its step statuses. */
export function workflowStatus(
  workflow: ReleaseWorkflow
): "pending" | "running" | "failed" | "unknown" | "succeeded" {
  validateReleaseWorkflow(workflow);
  let running = false;
  for (const entry of workflow.plan) {
    const status = workflow.steps[entry.id]!.status;
    if (status === "failed") return "failed";
    if (status === "unknown") return "unknown";
    if (status === "running") running = true;
  }
  if (running) return "running";
  const allTerminal = workflow.plan.every((entry) =>
    TERMINAL_STEP_STATUSES.has(workflow.steps[entry.id]!.status));
  return allTerminal ? "succeeded" : "pending";
}

/** pending|failed|unknown -> running; attempts+1; lastAttemptAt. Illegal otherwise. */
export function startStep(
  workflow: ReleaseWorkflow,
  stepId: string,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (!["pending", "failed", "unknown"].includes(step.status)) {
    throw new Error(`Release step cannot start from status ${step.status}: ${stepId}.`);
  }
  // Clear attempt-scoped effect/terminal evidence: a new attempt must not
  // inherit the previous attempt's externalIdentity, or the engine would
  // treat the retry as already-paid and skip the maxUses check.
  const { externalId: _oldExternalId, externalIdentity: _oldIdentity, terminalAt: _oldTerminalAt, ...rest } = step;
  return replaceStep(workflow, stepId, {
    ...rest,
    status: "running",
    attempts: step.attempts + 1,
    lastAttemptAt: now.toISOString()
  }, now);
}

/** running -> succeeded; terminalAt; appends logs. */
export function completeStep(
  workflow: ReleaseWorkflow,
  stepId: string,
  result: Readonly<{ externalId?: string; logs?: readonly string[] }>,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (step.status !== "running") {
    throw new Error(`Release step cannot complete from status ${step.status}: ${stepId}.`);
  }
  const externalId = result.externalId === undefined
    ? undefined
    : requireText(result.externalId, "Release step externalId");
  return replaceStep(workflow, stepId, {
    ...step,
    status: "succeeded",
    ...(externalId === undefined ? {} : { externalId }),
    logs: appendLogs(step.logs, result.logs),
    terminalAt: now.toISOString()
  }, now);
}

/** running -> failed; terminalAt; appends logs. An ambiguous failure may carry the externalIdentity for a later authoritative query. */
export function failStep(
  workflow: ReleaseWorkflow,
  stepId: string,
  result: Readonly<{
    logs?: readonly string[];
    externalIdentity?: { kind: string; value: string };
  }>,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (step.status !== "running") {
    throw new Error(`Release step cannot fail from status ${step.status}: ${stepId}.`);
  }
  const externalIdentity = result.externalIdentity === undefined
    ? undefined
    : normalizeExternalIdentity(result.externalIdentity);
  return replaceStep(workflow, stepId, {
    ...step,
    status: "failed",
    ...(externalIdentity === undefined ? {} : { externalIdentity }),
    logs: appendLogs(step.logs, result.logs),
    terminalAt: now.toISOString()
  }, now);
}

/** running -> unknown; terminalAt NOT set (unknown is not terminal). An
 * externalIdentity is recorded when known; without one this is a crash-recovery
 * state (the effect may have landed but cannot be queried), and the engine
 * fails closed (unconfirmed) on resume. */
export function markStepUnknown(
  workflow: ReleaseWorkflow,
  stepId: string,
  result: Readonly<{
    externalIdentity?: { kind: string; value: string };
    logs?: readonly string[];
  }>,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (step.status !== "running") {
    throw new Error(`Release step cannot be unknown from status ${step.status}: ${stepId}.`);
  }
  const externalIdentity = result.externalIdentity === undefined
    ? undefined
    : normalizeExternalIdentity(result.externalIdentity);
  return replaceStep(workflow, stepId, {
    ...step,
    status: "unknown",
    ...(externalIdentity === undefined ? {} : { externalIdentity }),
    logs: appendLogs(step.logs, result.logs)
  }, now);
}

/** pending -> skipped; terminalAt; appends a log line with the reason. */
export function skipStep(
  workflow: ReleaseWorkflow,
  stepId: string,
  result: Readonly<{ reason: string }>,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (step.status !== "pending") {
    throw new Error(`Release step cannot skip from status ${step.status}: ${stepId}.`);
  }
  const reason = requireText(result.reason, "Release step skip reason");
  return replaceStep(workflow, stepId, {
    ...step,
    status: "skipped",
    logs: appendLogs(step.logs, [`Skipped: ${reason}`]),
    terminalAt: now.toISOString()
  }, now);
}

/**
 * Authoritative confirmation after a timeout: an external query proved the
 * effect exists, so an unknown step reaches terminal success WITHOUT a second
 * submission. unknown -> succeeded; terminalAt; appends logs.
 */
export function confirmStep(
  workflow: ReleaseWorkflow,
  stepId: string,
  result: Readonly<{ externalId?: string; logs?: readonly string[] }>,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (step.status !== "unknown") {
    throw new Error(`Release step can only confirm from unknown: ${stepId} (${step.status}).`);
  }
  const externalId = result.externalId === undefined
    ? step.externalId
    : requireText(result.externalId, "Release step externalId");
  return replaceStep(workflow, stepId, {
    ...step,
    status: "succeeded",
    ...(externalId === undefined ? {} : { externalId }),
    logs: appendLogs(step.logs, result.logs),
    terminalAt: now.toISOString()
  }, now);
}

/**
 * Authoritative confirmation of an ambiguously failed step: a transport error
 * left the step `failed` with an externalIdentity, and a later query proved the
 * effect landed. failed -> succeeded; terminalAt; appends logs. This is the
 * only transition out of `failed` that does not re-submit.
 */
export function confirmFailedStep(
  workflow: ReleaseWorkflow,
  stepId: string,
  result: Readonly<{ externalId?: string; logs?: readonly string[] }>,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (step.status !== "failed") {
    throw new Error(`Release step can only confirm-failed from failed: ${stepId} (${step.status}).`);
  }
  if (step.externalIdentity === undefined) {
    throw new Error(`Release step confirm-failed requires an externalIdentity: ${stepId}.`);
  }
  const externalId = result.externalId === undefined
    ? step.externalId
    : requireText(result.externalId, "Release step externalId");
  return replaceStep(workflow, stepId, {
    ...step,
    status: "succeeded",
    ...(externalId === undefined ? {} : { externalId }),
    logs: appendLogs(step.logs, result.logs),
    terminalAt: now.toISOString()
  }, now);
}

/**
 * Crash recovery for a step left `running` by a dead process: the attempt may
 * have landed, so the engine queries authoritatively first; only when the
 * effect is confirmed absent does it re-attempt via this transition.
 * running -> running; attempts+1; fresh lastAttemptAt.
 */
export function recoverRunningStep(
  workflow: ReleaseWorkflow,
  stepId: string,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (step.status !== "running") {
    throw new Error(`Release step can only recover from running: ${stepId} (${step.status}).`);
  }
  // Clear attempt-scoped effect/terminal evidence: a recovery attempt must not
  // inherit the previous attempt's externalIdentity, or the engine would treat
  // the retry as already-paid and skip the maxUses check.
  const { externalId: _oldExternalId, externalIdentity: _oldIdentity, terminalAt: _oldTerminalAt, ...rest } = step;
  return replaceStep(workflow, stepId, {
    ...rest,
    status: "running",
    attempts: step.attempts + 1,
    lastAttemptAt: now.toISOString()
  }, now);
}

/**
 * Supersede the grant binding (the old grant was revoked or exhausted, or a
 * broader grant was issued). The plan, source, and step evidence are immutable.
 */
export function rebindGrant(
  workflow: ReleaseWorkflow,
  grantId: string,
  now: Date
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const next = requireText(grantId, "Release workflow grantId");
  return validateReleaseWorkflow({
    ...workflow,
    grantId: next,
    updatedAt: now.toISOString()
  });
}

/** Appends a log line to any non-terminal step. */
export function appendStepLog(
  workflow: ReleaseWorkflow,
  stepId: string,
  line: string
): ReleaseWorkflow {
  validateReleaseWorkflow(workflow);
  const step = requireStep(workflow, stepId);
  if (TERMINAL_STEP_STATUSES.has(step.status)) {
    throw new Error(`Release step is terminal and cannot log: ${stepId}.`);
  }
  const entry = requireText(line, "Release step log line");
  return replaceStep(workflow, stepId, {
    ...step,
    logs: appendLogs(step.logs, [entry])
  }, undefined);
}

function replaceStep(
  workflow: ReleaseWorkflow,
  stepId: string,
  next: ReleaseStepRecord,
  now: Date | undefined
): ReleaseWorkflow {
  const steps = Object.freeze({
    ...workflow.steps,
    [stepId]: Object.freeze({ ...next, logs: Object.freeze([...next.logs]) })
  });
  return validateReleaseWorkflow({
    ...workflow,
    steps,
    ...(now === undefined ? {} : { updatedAt: now.toISOString() })
  });
}

function requireStep(workflow: ReleaseWorkflow, stepId: string): ReleaseStepRecord {
  const step = workflow.steps[stepId];
  if (step === undefined) {
    throw new Error(`Release step is not part of the workflow plan: ${stepId}.`);
  }
  return step;
}

function appendLogs(logs: readonly string[], extra: readonly string[] | undefined): readonly string[] {
  if (extra === undefined) return logs;
  if (!Array.isArray(extra)) {
    throw new Error("Release step logs must be an array.");
  }
  const lines = extra.map((line) => requireText(line, "Release step log line"));
  return Object.freeze([...logs, ...lines]);
}

function normalizeSource(source: ReleaseWorkflowSource): ReleaseWorkflowSource {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new Error("Release workflow source must be an object.");
  }
  if (typeof source.repository !== "object" || source.repository === null || Array.isArray(source.repository)) {
    throw new Error("Release workflow source repository must be an object.");
  }
  const repository = Object.freeze({
    owner: requireText(source.repository.owner, "Release workflow source repository owner"),
    name: requireText(source.repository.name, "Release workflow source repository name")
  });
  const commit = requireText(source.commit, "Release workflow source commit");
  if (!/^[0-9a-fA-F]{40}$/.test(commit)) {
    throw new Error(
      `Release workflow source commit must be a full 40-hex commit sha: ${commit}`
    );
  }
  if (source.artifact === undefined) {
    return Object.freeze({ repository, commit });
  }
  if (typeof source.artifact !== "object" || source.artifact === null || Array.isArray(source.artifact)) {
    throw new Error("Release workflow source artifact must be an object.");
  }
  return Object.freeze({
    repository,
    commit,
    artifact: Object.freeze({
      name: requireText(source.artifact.name, "Release workflow source artifact name"),
      integrity: requireText(source.artifact.integrity, "Release workflow source artifact integrity")
    })
  });
}

type ReleaseStepPlanLike = Readonly<{
  id: string;
  kind: ReleaseStepKind;
  idempotencyKey?: string;
  params?: Readonly<Record<string, string>>;
  irreversibility?: "none" | "reversible" | "irreversible";
}>;

function normalizePlan(
  plan: readonly ReleaseStepPlanLike[],
  taskId: string,
  workflowId: string
): readonly ReleaseStepPlan[] {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("Release workflow plan must be a non-empty array.");
  }
  const normalized = plan.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Release workflow plan entry must be an object.");
    }
    const id = requireIdentity(entry.id, "Release step id");
    if (!RELEASE_STEP_KINDS.has(entry.kind)) {
      throw new Error(`Release step kind is invalid: ${String(entry.kind)}.`);
    }
    const params = normalizeParams(entry.params);
    if (entry.irreversibility !== undefined && !IRREVERSIBILITY_LEVELS.has(entry.irreversibility)) {
      throw new Error(`Release step irreversibility is invalid: ${String(entry.irreversibility)}.`);
    }
    const frozen: ReleaseStepPlan = Object.freeze({
      id,
      kind: entry.kind,
      idempotencyKey: `${taskId}/${workflowId}/${id}`,
      ...(params === undefined ? {} : { params }),
      ...(entry.irreversibility === undefined ? {} : { irreversibility: entry.irreversibility })
    });
    return frozen;
  });
  const ids = new Set(normalized.map((entry) => entry.id));
  if (ids.size !== normalized.length) {
    throw new Error("Release workflow plan ids must be unique.");
  }
  return Object.freeze(normalized);
}

function normalizeParams(
  params: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  if (params === undefined) return undefined;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Release step params must be an object.");
  }
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    const key = requireIdentity(name, "Release step param");
    normalized[key] = requireText(value, `Release step param ${name}`);
  }
  return Object.freeze(normalized);
}

function validateStepRecord(step: ReleaseStepRecord, plan: ReleaseStepPlan): void {
  if (typeof step !== "object" || step === null || Array.isArray(step)) {
    throw new Error(`Release step record must be an object: ${plan.id}.`);
  }
  if (step.planId !== plan.id) {
    throw new Error(
      `Release step record planId ${step.planId} does not match its key: ${plan.id}.`
    );
  }
  if (!RELEASE_STEP_STATUSES.has(step.status)) {
    throw new Error(`Release step status is invalid: ${String(step.status)}.`);
  }
  if (!Number.isSafeInteger(step.attempts) || step.attempts < 0) {
    throw new Error(`Release step attempts must be a non-negative integer: ${plan.id}.`);
  }
  if (step.externalId !== undefined) {
    requireText(step.externalId, `Release step externalId ${plan.id}`);
  }
  if (step.externalIdentity !== undefined) {
    normalizeExternalIdentity(step.externalIdentity);
  }
  // An unknown step without an externalIdentity is a crash-recovery state:
  // the step may have produced an external effect, but we can't query it.
  // The engine fails closed (unconfirmed) in this case.
  if (!Array.isArray(step.logs)) {
    throw new Error(`Release step logs must be an array: ${plan.id}.`);
  }
  for (const line of step.logs) {
    requireText(line, `Release step log ${plan.id}`);
  }
  if (step.lastAttemptAt !== undefined) {
    requireTimestamp(step.lastAttemptAt, `Release step lastAttemptAt ${plan.id}`);
  }
  if (step.status === "running" && step.lastAttemptAt === undefined) {
    throw new Error(`Release step running status requires lastAttemptAt: ${plan.id}.`);
  }
  if (step.terminalAt !== undefined) {
    requireTimestamp(step.terminalAt, `Release step terminalAt ${plan.id}`);
  }
  if (TERMINAL_STEP_STATUSES.has(step.status) && step.terminalAt === undefined) {
    throw new Error(`Release step ${step.status} status requires terminalAt: ${plan.id}.`);
  }
}

function normalizeExternalIdentity(
  value: Readonly<{ kind: string; value: string }>
): Readonly<{ kind: string; value: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Release step externalIdentity must be an object.");
  }
  return Object.freeze({
    kind: requireText(value.kind, "Release step externalIdentity kind"),
    value: requireText(value.value, "Release step externalIdentity value")
  });
}
