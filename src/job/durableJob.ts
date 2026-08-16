import { createHash } from "node:crypto";
import {
  requireIdentity,
  requirePositiveInteger,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export const CURRENT_DURABLE_JOB_SCHEMA_VERSION = 1 as const;

export type DurableJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "unknown-needs-attention";

export const DURABLE_JOB_TERMINAL_STATUSES: readonly DurableJobStatus[] = [
  "succeeded",
  "failed",
  "timed-out",
  "cancelled",
  "unknown-needs-attention"
];

export type DurableJobOwner =
  | Readonly<{ kind: "integration-attempt"; integrationAttemptId: string }>
  | Readonly<{ kind: "work-item"; workItemId: string }>
  | Readonly<{ kind: "task" }>;

export type DurableJobStep = Readonly<{
  name: string;
  command: string;
  timeoutMs?: number;
}>;

export type DurableJobStepResult = Readonly<{
  name: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  logPath: string;
  head: string;
}>;

export type DurableJobCheckpoint = Readonly<{
  completedSteps: readonly DurableJobStepResult[];
  updatedAt: string;
}>;

export type DurableJobOutcome =
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "unknown-needs-attention";

export type DurableJobResult = Readonly<{
  outcome: DurableJobOutcome;
  exitCode: number | null;
  signal: string | null;
  failedStep?: string;
  unknownReason?: string;
  /**
   * Where the terminal evidence came from. "exit-artifact" is the runner's
   * own exit.json; "checkpoint" means the runner died without exit.json but
   * its step checkpoint covered every planned step, so the outcome is still
   * provable. Absent on older records; unknown results never carry it.
   */
  evidenceSource?: "exit-artifact" | "checkpoint";
  steps: readonly DurableJobStepResult[];
}>;

export type DurableJobProcess = Readonly<{
  pid: number;
  startIdentity: string;
}>;

export type DurableJob = Readonly<{
  schemaVersion: typeof CURRENT_DURABLE_JOB_SCHEMA_VERSION;
  id: string;
  taskId: string;
  owner: DurableJobOwner;
  projectId: string;
  head: string;
  workspace: string;
  env: Readonly<Record<string, string>>;
  steps: readonly DurableJobStep[];
  idempotencyKey: string;
  status: DurableJobStatus;
  artifactsLocator: string;
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  terminalAt?: string;
  process?: DurableJobProcess;
  checkpoint?: DurableJobCheckpoint;
  result?: DurableJobResult;
  retryOf?: string;
  cancelRequestedAt?: string;
  wakeupNotified?: boolean;
  /**
   * Set when a Leader acknowledges an unknown-needs-attention job. An
   * acknowledged unknown job no longer blocks Task complete/archive/retire;
   * the Leader owns the follow-up (retry or manual resolution).
   */
  acknowledgedAt?: string;
  updatedAt: string;
}>;

/** The spec the Controller writes for the runner to consume. */
export type DurableJobSpec = Readonly<{
  jobId: string;
  taskId: string;
  workspace: string;
  env: Readonly<Record<string, string>>;
  steps: readonly DurableJobStep[];
  defaultStepTimeoutMs: number;
  artifactDir: string;
  head: string;
}>;

/** The terminal exit artifact the runner writes. */
export type DurableJobExit = Readonly<{
  outcome: "succeeded" | "failed" | "timed-out" | "cancelled";
  exitCode: number | null;
  signal: string | null;
  failedStep?: string;
  steps: readonly DurableJobStepResult[];
  finishedAt: string;
}>;

export function isDurableJobTerminal(status: DurableJobStatus): boolean {
  return (DURABLE_JOB_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function createDurableJob(
  input: Readonly<{
    id: string;
    taskId: string;
    owner: DurableJobOwner;
    projectId: string;
    head: string;
    workspace: string;
    env: Readonly<Record<string, string>>;
    steps: readonly DurableJobStep[];
    artifactsLocator: string;
    retryOf?: string;
  }>,
  now: Date
): DurableJob {
  const timestamp = now.toISOString();
  const idempotencyKey = input.retryOf === undefined
    ? durableJobIdempotencyKey({
        owner: input.owner,
        projectId: input.projectId,
        head: input.head,
        steps: input.steps,
        workspace: input.workspace,
        env: input.env
      })
    : retryDurableJobIdempotencyKey(
        durableJobIdempotencyKey({
          owner: input.owner,
          projectId: input.projectId,
          head: input.head,
          steps: input.steps,
          workspace: input.workspace,
          env: input.env
        }),
        input.retryOf
      );
  return validateDurableJob({
    schemaVersion: CURRENT_DURABLE_JOB_SCHEMA_VERSION,
    id: input.id,
    taskId: input.taskId,
    owner: input.owner,
    projectId: input.projectId,
    head: input.head,
    workspace: input.workspace,
    env: { ...input.env },
    steps: input.steps.map((step) => ({ ...step })),
    idempotencyKey,
    status: "queued",
    artifactsLocator: input.artifactsLocator,
    createdAt: timestamp,
    ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
    updatedAt: timestamp
  });
}

export function startDurableJob(
  job: DurableJob,
  process: DurableJobProcess,
  now: Date
): DurableJob {
  validateDurableJob(job);
  if (job.status !== "queued") {
    throw new Error(`DurableJob can only start from queued: ${job.status}.`);
  }
  const timestamp = now.toISOString();
  return validateDurableJob({
    ...job,
    status: "running",
    process: { ...process },
    startedAt: timestamp,
    heartbeatAt: timestamp,
    updatedAt: timestamp
  });
}

export function touchDurableJobHeartbeat(
  job: DurableJob,
  now: Date
): DurableJob {
  validateDurableJob(job);
  if (job.status !== "running") {
    throw new Error(`DurableJob heartbeat only applies to running jobs: ${job.status}.`);
  }
  return validateDurableJob({
    ...job,
    heartbeatAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
}

export function completeDurableJob(
  job: DurableJob,
  result: DurableJobResult,
  now: Date
): DurableJob {
  validateDurableJob(job);
  if (job.status !== "running") {
    throw new Error(`DurableJob can only complete from running: ${job.status}.`);
  }
  if (!isDurableJobTerminal(result.outcome)) {
    throw new Error(`DurableJob result outcome must be terminal: ${result.outcome}.`);
  }
  const timestamp = now.toISOString();
  return validateDurableJob({
    ...job,
    status: result.outcome,
    result: normalizeDurableJobResult(result),
    terminalAt: timestamp,
    updatedAt: timestamp
  });
}

export function markDurableJobUnknown(
  job: DurableJob,
  unknownReason: string,
  completedSteps: readonly DurableJobStepResult[],
  now: Date
): DurableJob {
  validateDurableJob(job);
  if (job.status !== "running") {
    throw new Error(`DurableJob can only be marked unknown from running: ${job.status}.`);
  }
  const timestamp = now.toISOString();
  return validateDurableJob({
    ...job,
    status: "unknown-needs-attention",
    result: {
      outcome: "unknown-needs-attention",
      exitCode: null,
      signal: null,
      unknownReason: requireText(unknownReason, "DurableJob unknown reason"),
      steps: completedSteps.map((step) => ({ ...step }))
    },
    terminalAt: timestamp,
    updatedAt: timestamp
  });
}

export function requestDurableJobCancel(
  job: DurableJob,
  now: Date
): DurableJob {
  validateDurableJob(job);
  // A terminal job is already past cancellation: return it unchanged so the
  // caller (e.g. `task integration abort` after the job finished but before
  // `integration continue`) gets an idempotent no-op instead of an error.
  if (isDurableJobTerminal(job.status)) return job;
  if (job.cancelRequestedAt !== undefined) return job;
  const timestamp = now.toISOString();
  return validateDurableJob({
    ...job,
    cancelRequestedAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * Cancel a queued job that never started. The supervisor calls this when a
 * queued job has `cancelRequestedAt` so it converges to `cancelled` without
 * spawning a runner. A queued job has no steps to prove, so the result is
 * an empty cancelled outcome.
 */
export function cancelQueuedDurableJob(
  job: DurableJob,
  now: Date
): DurableJob {
  validateDurableJob(job);
  if (job.status !== "queued") {
    throw new Error(`DurableJob can only cancel-queued from queued: ${job.status}.`);
  }
  const timestamp = now.toISOString();
  return validateDurableJob({
    ...job,
    status: "cancelled",
    result: {
      outcome: "cancelled",
      exitCode: null,
      signal: null,
      steps: []
    },
    terminalAt: timestamp,
    updatedAt: timestamp
  });
}

export function markDurableJobWakeupNotified(
  job: DurableJob,
  now: Date
): DurableJob {
  validateDurableJob(job);
  if (!isDurableJobTerminal(job.status)) {
    throw new Error("DurableJob wakeup notification requires a terminal job.");
  }
  if (job.wakeupNotified === true) return job;
  return validateDurableJob({
    ...job,
    wakeupNotified: true,
    updatedAt: now.toISOString()
  });
}

/**
 * Acknowledge an unknown-needs-attention job. The Leader has inspected the
 * runner's evidence and accepts responsibility for follow-up; the job no
 * longer blocks Task lifecycle gates. Only unknown jobs can be acknowledged,
 * and the flag is one-way (a terminal job stays terminal).
 */
export function acknowledgeUnknownDurableJob(
  job: DurableJob,
  now: Date
): DurableJob {
  validateDurableJob(job);
  if (job.status !== "unknown-needs-attention") {
    throw new Error(
      `DurableJob can only acknowledge from unknown-needs-attention: ${job.status}.`
    );
  }
  if (job.acknowledgedAt !== undefined) return job;
  return validateDurableJob({
    ...job,
    acknowledgedAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
}

export function durableJobIdempotencyKey(input: Readonly<{
  owner: DurableJobOwner;
  projectId: string;
  head: string;
  steps: readonly DurableJobStep[];
  workspace: string;
  env: Readonly<Record<string, string>>;
}>): string {
  const canonical = canonicalJson({
    owner: input.owner,
    projectId: input.projectId,
    head: input.head,
    steps: input.steps,
    workspace: input.workspace,
    env: input.env
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function retryDurableJobIdempotencyKey(
  previousKey: string,
  previousJobId: string
): string {
  return createHash("sha256")
    .update(`${previousKey}|retry-of|${previousJobId}`)
    .digest("hex");
}

export function validateDurableJob(job: DurableJob): DurableJob {
  if (job.schemaVersion !== CURRENT_DURABLE_JOB_SCHEMA_VERSION) {
    throw new Error(
      `DurableJob must use schemaVersion ${CURRENT_DURABLE_JOB_SCHEMA_VERSION}.`
    );
  }
  validateTaskRecordReference({
    taskId: job.taskId,
    localId: job.id
  }, "durableJob");
  validateDurableJobOwner(job.owner, job.taskId);
  requireIdentity(job.projectId, "DurableJob project id");
  requireCommit(job.head, "DurableJob head");
  requireText(job.workspace, "DurableJob workspace");
  if (!job.workspace.startsWith("/")) {
    throw new Error("DurableJob workspace must be an absolute path.");
  }
  validateEnvMap(job.env);
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    throw new Error("DurableJob requires at least one step.");
  }
  const stepNames = new Set<string>();
  for (const step of job.steps) {
    const name = requireText(step.name, "DurableJob step name");
    if (stepNames.has(name)) {
      throw new Error(`DurableJob step names must be unique: ${name}.`);
    }
    stepNames.add(name);
    requireText(step.command, `DurableJob step command (${name})`);
    if (step.timeoutMs !== undefined) {
      requirePositiveInteger(step.timeoutMs, `DurableJob step timeout (${name})`);
    }
  }
  requireText(job.idempotencyKey, "DurableJob idempotency key");
  if (!/^[a-f0-9]{64}$/u.test(job.idempotencyKey)) {
    throw new Error("DurableJob idempotency key is invalid.");
  }
  if (![
    "queued",
    "running",
    "succeeded",
    "failed",
    "timed-out",
    "cancelled",
    "unknown-needs-attention"
  ].includes(job.status)) {
    throw new Error(`DurableJob status is invalid: ${String(job.status)}.`);
  }
  requireText(job.artifactsLocator, "DurableJob artifacts locator");
  if (job.artifactsLocator.startsWith("/") || job.artifactsLocator.includes("..")) {
    throw new Error("DurableJob artifacts locator must be a home-relative path.");
  }
  requireTimestamp(job.createdAt, "DurableJob createdAt");
  requireTimestamp(job.updatedAt, "DurableJob updatedAt");
  if (job.startedAt !== undefined) {
    requireTimestamp(job.startedAt, "DurableJob startedAt");
  }
  if (job.heartbeatAt !== undefined) {
    requireTimestamp(job.heartbeatAt, "DurableJob heartbeatAt");
  }
  if (job.terminalAt !== undefined) {
    requireTimestamp(job.terminalAt, "DurableJob terminalAt");
  }
  if (job.process !== undefined) {
    requirePositiveInteger(job.process.pid, "DurableJob process pid");
    requireText(job.process.startIdentity, "DurableJob process startIdentity");
  }
  if (job.checkpoint !== undefined) {
    requireTimestamp(job.checkpoint.updatedAt, "DurableJob checkpoint updatedAt");
    for (const step of job.checkpoint.completedSteps) {
      validateStepResult(step);
    }
  }
  if (job.result !== undefined) {
    normalizeDurableJobResult(job.result);
  }
  if (job.retryOf !== undefined) {
    validateTaskRecordReference(
      { taskId: job.taskId, localId: job.retryOf },
      "durableJob"
    );
  }
  if (job.cancelRequestedAt !== undefined) {
    requireTimestamp(job.cancelRequestedAt, "DurableJob cancelRequestedAt");
  }
  if (job.wakeupNotified !== undefined && typeof job.wakeupNotified !== "boolean") {
    throw new Error("DurableJob wakeupNotified must be a boolean.");
  }
  if (job.acknowledgedAt !== undefined) {
    requireTimestamp(job.acknowledgedAt, "DurableJob acknowledgedAt");
  }
  if (isDurableJobTerminal(job.status)) {
    requireTimestamp(job.terminalAt ?? "", "DurableJob terminalAt");
  }
  if (job.status === "queued" && job.startedAt !== undefined) {
    throw new Error("A queued DurableJob must not have startedAt.");
  }
  if (job.status === "running" && job.startedAt === undefined) {
    throw new Error("A running DurableJob must have startedAt.");
  }
  return job;
}

export function validDurableJobTransition(
  before: DurableJob,
  after: DurableJob
): boolean {
  if (
    before.id !== after.id
    || before.taskId !== after.taskId
    || before.projectId !== after.projectId
    || before.head !== after.head
    || before.workspace !== after.workspace
    || before.idempotencyKey !== after.idempotencyKey
    || before.artifactsLocator !== after.artifactsLocator
    || before.createdAt !== after.createdAt
    || !isDeepStrictEqual(before.owner, after.owner)
    || !isDeepStrictEqual(before.env, after.env)
    || !isDeepStrictEqual(before.steps, after.steps)
  ) return false;
  if (isDurableJobTerminal(before.status)) {
    // A terminal job is immutable except for two one-way flags:
    // wakeupNotified (set by the supervisor after enqueuing the Leader
    // wakeup) and acknowledgedAt (set by the Leader on an unknown job so
    // Task lifecycle gates can proceed). Without these exceptions the
    // flags could never be recorded and every terminal/unknown job would
    // block forever.
    const wakeupFlip = before.wakeupNotified !== true && after.wakeupNotified === true;
    const acknowledgeFlip = before.acknowledgedAt === undefined
      && after.acknowledgedAt !== undefined;
    return before.status === after.status
      && isDeepStrictEqual(before.result, after.result)
      && before.terminalAt === after.terminalAt
      && (before.wakeupNotified === after.wakeupNotified || wakeupFlip)
      && (before.acknowledgedAt === after.acknowledgedAt || acknowledgeFlip);
  }
  const allowed: Readonly<Record<string, readonly DurableJobStatus[]>> = {
    queued: ["queued", "running", "cancelled"],
    running: [
      "running",
      "succeeded",
      "failed",
      "timed-out",
      "cancelled",
      "unknown-needs-attention"
    ]
  };
  return (allowed[before.status] ?? []).includes(after.status);
}

function validateDurableJobOwner(owner: DurableJobOwner, taskId: string): void {
  if (owner.kind === "integration-attempt") {
    validateTaskRecordReference(
      { taskId, localId: owner.integrationAttemptId },
      "integrationAttempt"
    );
  } else if (owner.kind === "work-item") {
    validateTaskRecordReference(
      { taskId, localId: owner.workItemId },
      "workItem"
    );
  } else if (owner.kind !== "task") {
    throw new Error(`DurableJob owner kind is invalid: ${String((owner as { kind?: string }).kind)}.`);
  }
}

function validateEnvMap(env: Readonly<Record<string, string>>): void {
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error("DurableJob env must be a map.");
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== "string" || key.length === 0 || key.includes("=") || key.includes("\0")) {
      throw new Error(`DurableJob env key is invalid: ${key}.`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(`DurableJob env value is invalid: ${key}.`);
    }
  }
}

function validateStepResult(step: DurableJobStepResult): void {
  requireText(step.name, "DurableJob step result name");
  if (step.exitCode !== null && (!Number.isSafeInteger(step.exitCode) || step.exitCode < 0)) {
    throw new Error(`DurableJob step exitCode is invalid: ${step.name}.`);
  }
  if (step.signal !== null && typeof step.signal !== "string") {
    throw new Error(`DurableJob step signal is invalid: ${step.name}.`);
  }
  if (typeof step.timedOut !== "boolean") {
    throw new Error(`DurableJob step timedOut must be boolean: ${step.name}.`);
  }
  requirePositiveInteger(step.durationMs, `DurableJob step durationMs (${step.name})`);
  requireText(step.logPath, `DurableJob step logPath (${step.name})`);
  requireCommit(step.head, `DurableJob step head (${step.name})`);
}

function normalizeDurableJobResult(result: DurableJobResult): DurableJobResult {
  if (!isDurableJobTerminal(result.outcome)) {
    throw new Error(`DurableJob result outcome must be terminal: ${result.outcome}.`);
  }
  if (result.exitCode !== null && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0)) {
    throw new Error("DurableJob result exitCode is invalid.");
  }
  if (result.signal !== null && typeof result.signal !== "string") {
    throw new Error("DurableJob result signal is invalid.");
  }
  if (result.failedStep !== undefined) {
    requireText(result.failedStep, "DurableJob result failedStep");
  }
  if (result.unknownReason !== undefined) {
    requireText(result.unknownReason, "DurableJob result unknownReason");
  }
  if (result.evidenceSource !== undefined
    && result.evidenceSource !== "exit-artifact"
    && result.evidenceSource !== "checkpoint") {
    throw new Error(`DurableJob result evidenceSource is invalid: ${String(result.evidenceSource)}.`);
  }
  if (!Array.isArray(result.steps)) {
    throw new Error("DurableJob result steps must be an array.");
  }
  for (const step of result.steps) validateStepResult(step);
  return result;
}

function requireCommit(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function isDeepStrictEqual(
  left: unknown,
  right: unknown
): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}
