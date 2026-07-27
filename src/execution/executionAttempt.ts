import type { AttemptAccess } from "../profile/agentProfile.js";
import {
  cloneJson,
  optionalText,
  requireIdentity,
  requirePositiveInteger,
  requireText,
  requireTimestamp
} from "../domain/validation.js";

export type ExecutorKind = "fork" | "session";
export type ExecutionAttemptState =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted";
export type CheckOutcome = "passed" | "failed" | "skipped";

export type ProviderRef = Readonly<{
  sessionId: string;
  threadId: string;
  turnId?: string;
}>;

export type CheckResult = Readonly<{
  name: string;
  outcome: CheckOutcome;
  details?: string;
  logPath?: string;
}>;

export type AttemptResult = Readonly<{
  summary: string;
  checks?: readonly CheckResult[];
  changeSetId?: string;
}>;

export type ExecutionAttempt = Readonly<{
  schemaVersion: 1;
  id: string;
  taskId: string;
  workItemId: string;
  profileId: string;
  profileRevision: number;
  executor: ExecutorKind;
  access: AttemptAccess;
  input: string;
  baseCommit?: string;
  sessionReason?: string;
  providerRef?: ProviderRef;
  state: ExecutionAttemptState;
  result?: AttemptResult;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
}>;

export type CreateExecutionAttemptInput = Readonly<Pick<
  ExecutionAttempt,
  | "id"
  | "taskId"
  | "workItemId"
  | "profileId"
  | "profileRevision"
  | "executor"
  | "access"
  | "input"
> & Partial<Pick<
  ExecutionAttempt,
  "baseCommit" | "sessionReason"
>>>;

export function createExecutionAttempt(
  input: CreateExecutionAttemptInput,
  now: Date
): ExecutionAttempt {
  if (input.executor === "session" && optionalText(input.sessionReason, "Session reason") === undefined) {
    throw new Error("A session Attempt requires sessionReason.");
  }
  if (input.executor !== "session" && input.sessionReason !== undefined) {
    throw new Error("sessionReason is only valid for a session Attempt.");
  }
  const timestamp = now.toISOString();
  return validateExecutionAttempt({
    schemaVersion: 1,
    id: requireIdentity(input.id, "Execution Attempt id"),
    taskId: requireIdentity(input.taskId, "Task id"),
    workItemId: requireIdentity(input.workItemId, "Work Item id"),
    profileId: requireIdentity(input.profileId, "Agent Profile id"),
    profileRevision: requirePositiveInteger(input.profileRevision, "Agent Profile revision"),
    executor: input.executor,
    access: input.access,
    input: requireText(input.input, "Execution Attempt input"),
    ...(input.baseCommit === undefined
      ? {}
      : { baseCommit: requireCommit(input.baseCommit, "Execution Attempt base commit") }),
    ...(input.sessionReason === undefined
      ? {}
      : { sessionReason: requireText(input.sessionReason, "Session reason") }),
    state: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp
  });
}

export function attachExecutionProviderRef(
  attempt: ExecutionAttempt,
  providerRef: ProviderRef,
  now: Date
): ExecutionAttempt {
  validateExecutionAttempt(attempt);
  if (attempt.state !== "running") {
    throw new Error(`Execution provider can only attach to a running Attempt: ${attempt.id}.`);
  }
  if (
    attempt.providerRef !== undefined
    && JSON.stringify(attempt.providerRef) !== JSON.stringify(providerRef)
  ) {
    throw new Error(`Execution Attempt provider reference is immutable: ${attempt.id}.`);
  }
  return validateExecutionAttempt({
    ...cloneJson(attempt),
    providerRef: normalizeProviderRef(providerRef),
    updatedAt: now.toISOString()
  });
}

export function completeExecutionAttempt(
  attempt: ExecutionAttempt,
  result: AttemptResult,
  now: Date
): ExecutionAttempt {
  return terminalize(attempt, "succeeded", normalizeResult(result), now);
}

export function failExecutionAttempt(
  attempt: ExecutionAttempt,
  result: string | AttemptResult,
  now: Date
): ExecutionAttempt {
  return terminalize(
    attempt,
    "failed",
    typeof result === "string"
      ? { summary: requireText(result, "Failure summary") }
      : normalizeResult(result),
    now
  );
}

export function interruptExecutionAttempt(
  attempt: ExecutionAttempt,
  summary: string,
  now: Date
): ExecutionAttempt {
  return terminalize(
    attempt,
    "interrupted",
    { summary: requireText(summary, "Interruption summary") },
    now
  );
}

export function validateExecutionAttempt(attempt: ExecutionAttempt): ExecutionAttempt {
  if (attempt.schemaVersion !== 1) {
    throw new Error("ExecutionAttempt must use schemaVersion 1.");
  }
  requireIdentity(attempt.id, "Execution Attempt id");
  requireIdentity(attempt.taskId, "Task id");
  requireIdentity(attempt.workItemId, "Work Item id");
  requireIdentity(attempt.profileId, "Agent Profile id");
  requirePositiveInteger(attempt.profileRevision, "Agent Profile revision");
  validateExecutor(attempt.executor);
  validateAccess(attempt.access);
  requireText(attempt.input, "Execution Attempt input");
  if (attempt.baseCommit !== undefined) {
    requireCommit(attempt.baseCommit, "Execution Attempt base commit");
  }
  if (attempt.executor === "session") {
    requireText(attempt.sessionReason ?? "", "Session reason");
  } else if (attempt.sessionReason !== undefined) {
    throw new Error("Only a session Attempt may have a sessionReason.");
  }
  if (attempt.providerRef !== undefined) normalizeProviderRef(attempt.providerRef);
  validateState(attempt.state);
  requireTimestamp(attempt.createdAt, "Execution Attempt createdAt");
  requireTimestamp(attempt.updatedAt, "Execution Attempt updatedAt");
  requireTimestamp(attempt.startedAt ?? "", "Execution Attempt startedAt");
  if (isTerminal(attempt.state)) {
    requireTimestamp(attempt.endedAt ?? "", "Execution Attempt endedAt");
    normalizeResult(attempt.result ?? { summary: "" });
  } else if (attempt.endedAt !== undefined || attempt.result !== undefined) {
    throw new Error("A non-terminal Execution Attempt cannot have a result.");
  }
  return attempt;
}

function terminalize(
  attempt: ExecutionAttempt,
  state: Extract<ExecutionAttemptState, "succeeded" | "failed" | "interrupted">,
  result: AttemptResult,
  now: Date
): ExecutionAttempt {
  validateExecutionAttempt(attempt);
  if (attempt.state !== "running") {
    throw new Error(`Execution Attempt cannot finish from ${attempt.state}: ${attempt.id}.`);
  }
  const timestamp = now.toISOString();
  return validateExecutionAttempt({
    ...cloneJson(attempt),
    state,
    result: normalizeResult(result),
    updatedAt: timestamp,
    endedAt: timestamp
  });
}

function normalizeResult(result: AttemptResult): AttemptResult {
  const checks = result.checks?.map(normalizeCheckResult);
  return {
    summary: requireText(result.summary, "Attempt result summary"),
    ...(checks === undefined ? {} : { checks }),
    ...(result.changeSetId === undefined
      ? {}
      : { changeSetId: requireIdentity(result.changeSetId, "ChangeSet id") })
  };
}

export function normalizeCheckResult(check: CheckResult): CheckResult {
  if (!["passed", "failed", "skipped"].includes(check.outcome)) {
    throw new Error(`Check outcome is invalid: ${String(check.outcome)}.`);
  }
  return {
    name: requireText(check.name, "Check name"),
    outcome: check.outcome,
    ...(check.details === undefined
      ? {}
      : { details: requireText(check.details, "Check details") }),
    ...(check.logPath === undefined
      ? {}
      : { logPath: requireRelativePath(check.logPath, "Check log path") })
  };
}

function requireRelativePath(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (
    /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(normalized)
    || normalized.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`${label} must be relative.`);
  }
  return normalized.replaceAll("\\", "/");
}

function normalizeProviderRef(ref: ProviderRef): ProviderRef {
  return {
    sessionId: requireIdentity(ref.sessionId, "Provider session id"),
    threadId: requireIdentity(ref.threadId, "Provider thread id"),
    ...(ref.turnId === undefined ? {} : { turnId: requireIdentity(ref.turnId, "Provider turn id") })
  };
}

function validateExecutor(value: ExecutorKind): void {
  if (value !== "fork" && value !== "session") {
    throw new Error(`Execution executor is invalid: ${String(value)}.`);
  }
}

function validateAccess(value: AttemptAccess): void {
  if (value !== "read" && value !== "write") {
    throw new Error(`Execution access is invalid: ${String(value)}.`);
  }
}

function validateState(value: ExecutionAttemptState): void {
  if (![
    "running",
    "succeeded",
    "failed",
    "interrupted"
  ].includes(value)) {
    throw new Error(`Execution Attempt state is invalid: ${String(value)}.`);
  }
}

function isTerminal(state: ExecutionAttemptState): boolean {
  return state === "succeeded" || state === "failed" || state === "interrupted";
}

function requireCommit(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
