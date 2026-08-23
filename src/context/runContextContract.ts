import {
  normalizedUniqueIdentities,
  requireIdentity,
  requireText
} from "../domain/validation.js";
import {
  validateContextSnapshotRef,
  type ContextSnapshotRef
} from "./contextSnapshot.js";

export const RUN_CONTEXT_PROTOCOL_VERSION = 1 as const;
export const RUN_BOOTSTRAP_PROTOCOL = "yui-run/v1" as const;
export const RUN_BOOTSTRAP_MAX_BYTES = 4 * 1024;
export const RUN_BOOTSTRAP_MAX_DELTAS = 16;

export type RunPurpose = "execution" | "review" | "global";
export const RUN_ACTIONS = [
  "lead-task",
  "leader-wake",
  "execute-work-item",
  "repair-work-item",
  "review-round",
  "review-delta",
  "global-request"
] as const;
export type RunAction = typeof RUN_ACTIONS[number];
export type RunSubject = Readonly<{
  taskId?: string;
  workItemId?: string;
  reviewRoundId?: string;
  executionGroupId?: string;
  executionLaneId?: string;
}>;

export type RunAssignment = Readonly<{
  schemaVersion: typeof RUN_CONTEXT_PROTOCOL_VERSION;
  runId: string;
  roleName: string;
  purpose: RunPurpose;
  action: RunAction;
  subject: RunSubject;
  directive?: string;
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>;

export type RunBootstrapEnvelope = Readonly<{
  protocol: typeof RUN_BOOTSTRAP_PROTOCOL;
  runId: string;
  roleName: string;
  purpose: RunPurpose;
  action: RunAction;
  subject: RunSubject;
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>;

export function createRunAssignment(
  input: Omit<RunAssignment, "schemaVersion">
): RunAssignment {
  const common = normalizeCommon(input);
  return Object.freeze({
    schemaVersion: RUN_CONTEXT_PROTOCOL_VERSION,
    ...common,
    ...(input.directive === undefined
      ? {}
      : { directive: requireText(input.directive, "Run assignment directive") })
  });
}

export function validateRunAssignment(value: RunAssignment): RunAssignment {
  if (value.schemaVersion !== RUN_CONTEXT_PROTOCOL_VERSION) {
    throw new Error("Run assignment must use schemaVersion 1.");
  }
  const normalized = createRunAssignment(value);
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    throw new Error("Run assignment is not canonical.");
  }
  return value;
}

export function createRunBootstrapEnvelope(
  assignment: RunAssignment
): RunBootstrapEnvelope {
  validateRunAssignment(assignment);
  return Object.freeze({
    protocol: RUN_BOOTSTRAP_PROTOCOL,
    runId: assignment.runId,
    roleName: assignment.roleName,
    purpose: assignment.purpose,
    action: assignment.action,
    subject: assignment.subject,
    ...(assignment.contextSnapshotRef === undefined
      ? {}
      : { contextSnapshotRef: assignment.contextSnapshotRef }),
    deltaRefIds: assignment.deltaRefIds
  });
}

export function validateRunBootstrapEnvelope(
  value: RunBootstrapEnvelope
): RunBootstrapEnvelope {
  if (value.protocol !== RUN_BOOTSTRAP_PROTOCOL) {
    throw new Error("Run bootstrap protocol is unsupported.");
  }
  normalizeCommon(value);
  const serialized = serializeRunBootstrapEnvelope(value);
  if (Buffer.byteLength(serialized, "utf8") > RUN_BOOTSTRAP_MAX_BYTES) {
    throw new Error("Run bootstrap envelope exceeds its protocol byte limit.");
  }
  return value;
}

export function serializeRunBootstrapEnvelope(value: RunBootstrapEnvelope): string {
  if (value.protocol !== RUN_BOOTSTRAP_PROTOCOL) {
    throw new Error("Run bootstrap protocol is unsupported.");
  }
  const normalized = normalizeCommon(value);
  const subject = Object.entries(normalized.subject)
    .map(([key, id]) => `${key}:${id}`)
    .join(",");
  const snapshot = normalized.contextSnapshotRef;
  const lines = [
    "Yui managed Run. Follow the Session Manifest and injected Skills.",
    `${normalized.subject.taskId === undefined ? "" : `task=${normalized.subject.taskId} `}run=${normalized.runId} role=${normalized.roleName} action=${normalized.action}`,
    `purpose=${normalized.purpose} subject=${subject || "global"} snapshot=${snapshot === undefined ? "none" : `${snapshot.id}@${snapshot.digest}`}`,
    normalized.deltaRefIds.length === 0
      ? "delta=none"
      : `delta=${normalized.deltaRefIds.join(",")}`,
    "Load the exact Run context before acting; fail closed if it is unavailable or mismatched."
  ];
  const serialized = lines.join("\n");
  if (Buffer.byteLength(serialized, "utf8") > RUN_BOOTSTRAP_MAX_BYTES) {
    throw new Error("Run bootstrap envelope exceeds its protocol byte limit.");
  }
  return serialized;
}

/**
 * Bounded infrastructure-recovery input for an already-pushed Run. It resumes
 * the provider-native transcript after Host/child replacement and never
 * replays the Assignment or its directive.
 */
export function serializeRunHostRecoveryEnvelope(
  value: RunBootstrapEnvelope
): string {
  const normalized = normalizeCommon(value);
  const serialized = [
    "Yui managed Host recovery for an existing Run.",
    `${normalized.subject.taskId === undefined ? "" : `task=${normalized.subject.taskId} `}run=${normalized.runId} role=${normalized.roleName}`,
    "Resume the same native conversation from its latest durable state. Do not repeat completed work or replay the original Assignment.",
    "Load the exact Run context or delta only if needed, then continue toward the existing workflow outcome."
  ].join("\n");
  if (Buffer.byteLength(serialized, "utf8") > RUN_BOOTSTRAP_MAX_BYTES) {
    throw new Error("Run Host recovery envelope exceeds its protocol byte limit.");
  }
  return serialized;
}

function normalizeCommon(input: Readonly<{
  runId: string;
  roleName: string;
  purpose: RunPurpose;
  action: RunAction;
  subject: RunSubject;
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>): Omit<RunAssignment, "schemaVersion" | "directive"> {
  if (!(["execution", "review", "global"] as const).includes(input.purpose)) {
    throw new Error("Run assignment purpose is invalid.");
  }
  if (!RUN_ACTIONS.includes(input.action)) {
    throw new Error("Run assignment action is invalid.");
  }
  const subject = normalizeSubject(input.subject);
  const snapshot = input.contextSnapshotRef === undefined
    ? undefined
    : validateContextSnapshotRef(input.contextSnapshotRef);
  if (snapshot !== undefined && snapshot.taskId !== subject.taskId) {
    throw new Error("Run assignment Context Snapshot belongs to another Task.");
  }
  if (input.purpose !== "global" && subject.taskId === undefined) {
    throw new Error("A Task Run assignment requires a Task subject.");
  }
  if (input.purpose === "review" && subject.reviewRoundId === undefined) {
    throw new Error("A review Run assignment requires a ReviewRound subject.");
  }
  const deltaRefIds = normalizedUniqueIdentities(
    input.deltaRefIds,
    "Run assignment delta ref"
  );
  if (deltaRefIds.length > RUN_BOOTSTRAP_MAX_DELTAS) {
    throw new Error(`Run assignment supports at most ${RUN_BOOTSTRAP_MAX_DELTAS} delta refs.`);
  }
  return {
    runId: requireIdentity(input.runId, "Run assignment Run id"),
    roleName: requireIdentity(input.roleName, "Run assignment Role name"),
    purpose: input.purpose,
    action: input.action,
    subject,
    ...(snapshot === undefined ? {} : { contextSnapshotRef: snapshot }),
    deltaRefIds
  };
}

function normalizeSubject(subject: RunSubject): RunSubject {
  const normalized = Object.fromEntries(
    Object.entries(subject).map(([key, value]) => [
      key,
      requireIdentity(value, `Run assignment ${key}`)
    ])
  ) as RunSubject;
  const allowed = [
    "taskId",
    "workItemId",
    "reviewRoundId",
    "executionGroupId",
    "executionLaneId"
  ];
  if (Object.keys(normalized).some((key) => !allowed.includes(key))) {
    throw new Error("Run assignment subject contains an unknown field.");
  }
  if ((normalized.executionGroupId === undefined) !== (normalized.executionLaneId === undefined)) {
    throw new Error("Run assignment execution lineage is incomplete.");
  }
  if (normalized.taskId === undefined
    && (normalized.workItemId !== undefined || normalized.reviewRoundId !== undefined
      || normalized.executionGroupId !== undefined)) {
    throw new Error("Run assignment child subject requires a Task id.");
  }
  return Object.freeze(normalized);
}
