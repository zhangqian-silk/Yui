import {
  validateTaskRecordReference,
  type TaskRecordKind
} from "../task/taskRecordReference.js";

export type MailboxTarget =
  | Readonly<{ kind: "task"; taskId: string }>
  | Readonly<{ kind: "role"; taskId: string; roleName: string }>
  /** Independent lifecycle-obligation lane for one Task Role runtime. */
  | Readonly<{ kind: "role-runtime"; taskId: string; roleName: string }>
  /** Independent lifecycle-obligation lane for one global Role runtime. */
  | Readonly<{ kind: "global-role-runtime"; roleName: string }>
  | Readonly<{ kind: "operator" }>;

export type MailboxEntityType =
  | "task"
  | "run"
  | "work-item"
  | "input"
  | "session"
  | "message"
  | "event";

export type MailboxEntityRef =
  | Readonly<{ type: "task" | "session"; id: string }>
  | Readonly<{
      type: "run" | "work-item" | "input" | "message" | "event";
      taskId: string;
      id: string;
    }>;

export type WorkSignal = Readonly<{
  reason: string;
  refs: readonly MailboxEntityRef[];
  occurredAt: string;
  source?: string;
  dedupeKey?: string;
  factRevision?: number;
  deliveryMode?: DeliveryMode;
  lane?: MailboxLane;
}>;

export type MailboxLane = "normal" | "user-correction";
export type DeliveryMode = "followup" | "steer-if-safe" | "inject";

export type PendingBatch = Readonly<{
  /** Global mailbox sequence envelope; other batches may occupy gaps inside it. */
  fromSequence: number;
  toSequence: number;
  reasons: readonly string[];
  refs: readonly MailboxEntityRef[];
  /** Number of signals represented; gaps in the sequence envelope are excluded. */
  requestCount: number;
  firstQueuedAt: string;
  lastQueuedAt: string;
  sources: readonly string[];
  dedupeKeys: readonly string[];
  deliveryModes: readonly DeliveryMode[];
  highestFactRevision?: number;
}>;

export type ProcessingBatch = Readonly<{
  batchId: string;
  lane: MailboxLane;
  batch: PendingBatch;
  owner: string;
  startedAt: string;
  executionRef?: MailboxEntityRef;
}>;

export type InputDeliveryStatus = "dispatching" | "delivery-unknown";

export type InputDelivery = Readonly<{
  attemptId: string;
  lane: MailboxLane;
  mode: DeliveryMode;
  batch: PendingBatch;
  owner: string;
  status: InputDeliveryStatus;
  startedAt: string;
  pushedAt?: string;
  unknownReason?: string;
  executionRef: MailboxEntityRef;
  providerFence?: Readonly<{
    conversationId: string;
    activationId: string;
    nativeTurnId?: string;
  }>;
}>;

export type PendingLanes = Readonly<{
  normal: PendingBatch | null;
  userCorrection: PendingBatch | null;
  /** Last provider-accepted/consumed sequence in each independent lane. */
  cursors: Readonly<{ normal: number; userCorrection: number }>;
  /** Bounded replay shield; Task facts remain the long-term authority. */
  recentDedupeKeys: readonly string[];
}>;

const RECENT_DEDUPE_KEY_LIMIT = 256;

export type WorkMailbox = Readonly<{
  schemaVersion: 3;
  target: MailboxTarget;
  nextSequence: number;
  /** Internal controller claims; model input uses inputDelivery exclusively. */
  processing: ProcessingBatch | null;
  pending: PendingLanes;
  inputDelivery: InputDelivery | null;
}>;

export type ClaimOptions = Readonly<{
  batchId: string;
  owner: string;
  startedAt: string;
  lane?: MailboxLane;
}>;

export type InputDeliveryClaimOptions = Readonly<{
  attemptId: string;
  lane: MailboxLane;
  mode: DeliveryMode;
  owner: string;
  startedAt: string;
  executionRef: MailboxEntityRef;
  providerFence?: InputDelivery["providerFence"];
}>;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function requireInteger(value: unknown, minimum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown field: ${unknown}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new Error(`${label} is missing field: ${missing}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return requireText(value, label);
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be a timestamp`);
  return timestamp;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((item, index) => requireString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}

function copyTarget(target: MailboxTarget): MailboxTarget {
  switch (target.kind) {
    case "task":
      return { kind: "task", taskId: requireText(target.taskId, "taskId") };
    case "role":
      return {
        kind: "role",
        taskId: requireText(target.taskId, "taskId"),
        roleName: requireText(target.roleName, "roleName")
      };
    case "role-runtime":
      return {
        kind: "role-runtime",
        taskId: requireText(target.taskId, "taskId"),
        roleName: requireText(target.roleName, "roleName")
      };
    case "global-role-runtime":
      return {
        kind: "global-role-runtime",
        roleName: requireText(target.roleName, "roleName")
      };
    case "operator":
      return { kind: "operator" };
  }
}

export function mailboxTargetKey(target: MailboxTarget): string {
  const copied = copyTarget(target);
  switch (copied.kind) {
    case "operator": return "operator";
    case "task": return `task/${encodeURIComponent(copied.taskId)}`;
    case "role": return `role/${encodeURIComponent(copied.taskId)}/${encodeURIComponent(copied.roleName)}`;
    case "role-runtime":
      return `role-runtime/${encodeURIComponent(copied.taskId)}/${encodeURIComponent(copied.roleName)}`;
    case "global-role-runtime":
      return `global-role-runtime/${encodeURIComponent(copied.roleName)}`;
  }
}

function copyRef(ref: MailboxEntityRef): MailboxEntityRef {
  if (!("taskId" in ref)) {
    if (ref.type !== "task" && ref.type !== "session") {
      throw new Error(`entity reference taskId is required for ${ref.type}`);
    }
    return {
      type: ref.type,
      id: requireText(ref.id, "entity reference id")
    };
  }
  const validated = validateTaskRecordReference({
    taskId: ref.taskId,
    localId: ref.id
  }, mailboxTaskRecordKind(ref.type));
  return {
    type: ref.type,
    taskId: validated.taskId,
    id: validated.localId
  };
}

export function mailboxEntityRefKey(ref: MailboxEntityRef): string {
  return !("taskId" in ref)
    ? `${ref.type}\u0000${ref.id}`
    : `${ref.type}\u0000${ref.taskId}\u0000${ref.id}`;
}

function appendUnique<T>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (value: T) => string
): T[] {
  const result = [...existing];
  const keys = new Set(existing.map(keyOf));
  for (const value of incoming) {
    const key = keyOf(value);
    if (!keys.has(key)) {
      keys.add(key);
      result.push(value);
    }
  }
  return result;
}

function mergeBatches(left: PendingBatch, right: PendingBatch): PendingBatch {
  const merged: PendingBatch = {
    fromSequence: Math.min(left.fromSequence, right.fromSequence),
    toSequence: Math.max(left.toSequence, right.toSequence),
    reasons: appendUnique(left.reasons, right.reasons, (reason) => reason),
    refs: appendUnique(
      left.refs,
      right.refs,
      mailboxEntityRefKey
    ),
    requestCount: left.requestCount + right.requestCount,
    firstQueuedAt: Date.parse(left.firstQueuedAt) <= Date.parse(right.firstQueuedAt)
      ? left.firstQueuedAt
      : right.firstQueuedAt,
    lastQueuedAt: Date.parse(left.lastQueuedAt) >= Date.parse(right.lastQueuedAt)
      ? left.lastQueuedAt
      : right.lastQueuedAt,
    sources: appendUnique(left.sources, right.sources, (source) => source),
    dedupeKeys: appendUnique(left.dedupeKeys, right.dedupeKeys, (key) => key),
    deliveryModes: appendUnique(left.deliveryModes, right.deliveryModes, (mode) => mode),
    ...((left.highestFactRevision ?? right.highestFactRevision) === undefined
      ? {}
      : {
          highestFactRevision: Math.max(
            left.highestFactRevision ?? 0,
            right.highestFactRevision ?? 0
          )
        })
  };
  return merged;
}

function requireProcessing(mailbox: WorkMailbox, batchId: string): ProcessingBatch {
  const normalizedBatchId = requireText(batchId, "batch id");
  if (mailbox.processing === null) {
    throw new Error("Mailbox has no processing batch");
  }
  if (mailbox.processing.batchId !== normalizedBatchId) {
    throw new Error(
      `Mailbox processing batch id does not match ${normalizedBatchId}`
    );
  }
  return mailbox.processing;
}

export function createWorkMailbox(target: MailboxTarget): WorkMailbox {
  return {
    schemaVersion: 3,
    target: copyTarget(target),
    nextSequence: 1,
    processing: null,
    pending: {
      normal: null,
      userCorrection: null,
      cursors: { normal: 0, userCorrection: 0 },
      recentDedupeKeys: []
    },
    inputDelivery: null
  };
}

export function validateWorkMailbox(value: unknown): WorkMailbox {
  const mailbox = record(value, "WorkMailbox");
  exact(
    mailbox,
    ["schemaVersion", "target", "nextSequence", "processing", "pending", "inputDelivery"],
    "WorkMailbox"
  );
  if (mailbox.schemaVersion !== 3) throw new Error("WorkMailbox must use schemaVersion 3");
  const target = parseTarget(mailbox.target);
  const nextSequence = requireInteger(mailbox.nextSequence, 1, "WorkMailbox nextSequence");
  const processing = mailbox.processing === null ? null : parseProcessing(mailbox.processing);
  const pending = parsePendingLanes(mailbox.pending);
  for (const cursor of [pending.cursors.normal, pending.cursors.userCorrection]) {
    if (cursor >= nextSequence) {
      throw new Error("WorkMailbox lane cursor must be lower than nextSequence");
    }
  }
  if (pending.normal !== null && pending.normal.fromSequence <= pending.cursors.normal) {
    throw new Error("WorkMailbox normal pending batch is behind its cursor");
  }
  if (pending.userCorrection !== null
    && pending.userCorrection.fromSequence <= pending.cursors.userCorrection) {
    throw new Error("WorkMailbox user-correction pending batch is behind its cursor");
  }
  const inputDelivery = mailbox.inputDelivery === null
    ? null
    : parseInputDelivery(mailbox.inputDelivery);
  const batches = [
    processing?.batch,
    pending.normal,
    pending.userCorrection,
    inputDelivery?.batch
  ].filter(
    (batch): batch is PendingBatch => batch !== null && batch !== undefined
  );
  const activeDedupeKeys = new Set<string>();
  for (const batch of batches) {
    if (batch.toSequence >= nextSequence) {
      throw new Error("WorkMailbox batch sequence must be lower than nextSequence");
    }
    for (const dedupeKey of batch.dedupeKeys) {
      if (activeDedupeKeys.has(dedupeKey)) {
        throw new Error("WorkMailbox active batches share a dedupe key");
      }
      activeDedupeKeys.add(dedupeKey);
    }
  }
  if (inputDelivery !== null && target.kind !== "role" && target.kind !== "operator") {
    throw new Error("WorkMailbox inputDelivery requires a Role or Operator target");
  }
  return { schemaVersion: 3, target, nextSequence, processing, pending, inputDelivery };
}

function parsePendingLanes(value: unknown): PendingLanes {
  const lanes = record(value, "WorkMailbox pending");
  exact(
    lanes,
    ["normal", "userCorrection", "cursors", "recentDedupeKeys"],
    "WorkMailbox pending"
  );
  const cursors = record(lanes.cursors, "WorkMailbox pending cursors");
  exact(cursors, ["normal", "userCorrection"], "WorkMailbox pending cursors");
  const recentDedupeKeys = requireStringArray(
    lanes.recentDedupeKeys,
    "WorkMailbox recent dedupe keys"
  );
  if (recentDedupeKeys.length > RECENT_DEDUPE_KEY_LIMIT) {
    throw new Error("WorkMailbox recent dedupe keys exceed the bounded limit");
  }
  return {
    normal: lanes.normal === null ? null : parseBatch(lanes.normal, "WorkMailbox pending normal"),
    userCorrection: lanes.userCorrection === null
      ? null
      : parseBatch(lanes.userCorrection, "WorkMailbox pending userCorrection"),
    cursors: {
      normal: requireInteger(cursors.normal, 0, "WorkMailbox normal cursor"),
      userCorrection: requireInteger(
        cursors.userCorrection,
        0,
        "WorkMailbox user-correction cursor"
      )
    },
    recentDedupeKeys
  };
}

function parseTarget(value: unknown): MailboxTarget {
  const target = record(value, "WorkMailbox target");
  switch (target.kind) {
    case "operator":
      exact(target, ["kind"], "WorkMailbox operator target");
      return { kind: "operator" };
    case "task":
      exact(target, ["kind", "taskId"], "WorkMailbox task target");
      return { kind: "task", taskId: requireString(target.taskId, "WorkMailbox target taskId") };
    case "role":
      exact(target, ["kind", "taskId", "roleName"], "WorkMailbox role target");
      return {
        kind: "role",
        taskId: requireString(target.taskId, "WorkMailbox target taskId"),
        roleName: requireString(target.roleName, "WorkMailbox target roleName")
      };
    case "role-runtime":
      exact(target, ["kind", "taskId", "roleName"], "WorkMailbox role runtime target");
      return {
        kind: "role-runtime",
        taskId: requireString(target.taskId, "WorkMailbox target taskId"),
        roleName: requireString(target.roleName, "WorkMailbox target roleName")
      };
    case "global-role-runtime":
      exact(target, ["kind", "roleName"], "WorkMailbox global role runtime target");
      return {
        kind: "global-role-runtime",
        roleName: requireString(target.roleName, "WorkMailbox target roleName")
      };
    default:
      throw new Error("WorkMailbox target kind is invalid");
  }
}

function parseRef(value: unknown, label: string): MailboxEntityRef {
  const ref = record(value, label);
  const types: readonly MailboxEntityType[] = [
    "task", "run", "work-item", "input", "session", "message", "event"
  ];
  if (!types.includes(ref.type as MailboxEntityType)) throw new Error(`${label} type is invalid`);
  if (ref.type === "task" || ref.type === "session") {
    exact(ref, ["type", "id"], label);
    return { type: ref.type, id: requireString(ref.id, `${label} id`) };
  }
  exact(ref, ["type", "taskId", "id"], label);
  return copyRef({
    type: ref.type as "run" | "work-item" | "input" | "message" | "event",
    taskId: requireString(ref.taskId, `${label} taskId`),
    id: requireString(ref.id, `${label} id`)
  });
}

function parseBatch(value: unknown, label: string): PendingBatch {
  const batch = record(value, label);
  const required = [
    "fromSequence",
    "toSequence",
    "reasons",
    "refs",
    "requestCount",
    "firstQueuedAt",
    "lastQueuedAt",
    "sources",
    "dedupeKeys",
    "deliveryModes"
  ];
  exact(
    batch,
    batch.highestFactRevision === undefined ? required : [...required, "highestFactRevision"],
    label
  );
  const fromSequence = requireInteger(batch.fromSequence, 1, `${label} fromSequence`);
  const toSequence = requireInteger(batch.toSequence, fromSequence, `${label} toSequence`);
  const requestCount = requireInteger(batch.requestCount, 1, `${label} requestCount`);
  if (requestCount > toSequence - fromSequence + 1) {
    throw new Error(`${label} requestCount exceeds its sequence envelope`);
  }
  const reasons = requireStringArray(batch.reasons, `${label} reasons`);
  if (reasons.length === 0) throw new Error(`${label} reasons must not be empty`);
  if (!Array.isArray(batch.refs)) throw new Error(`${label} refs must be an array`);
  const refs = batch.refs.map((ref, index) => parseRef(ref, `${label} refs[${index}]`));
  const refKeys = refs.map(mailboxEntityRefKey);
  if (new Set(refKeys).size !== refKeys.length) throw new Error(`${label} refs must not contain duplicates`);
  const result: PendingBatch = {
    fromSequence,
    toSequence,
    reasons,
    refs,
    requestCount,
    firstQueuedAt: requireTimestamp(batch.firstQueuedAt, `${label} firstQueuedAt`),
    lastQueuedAt: requireTimestamp(batch.lastQueuedAt, `${label} lastQueuedAt`),
    sources: requireStringArray(batch.sources, `${label} sources`),
    dedupeKeys: requireStringArray(batch.dedupeKeys, `${label} dedupeKeys`),
    deliveryModes: parseDeliveryModes(batch.deliveryModes, `${label} deliveryModes`),
    ...(batch.highestFactRevision === undefined
      ? {}
      : {
          highestFactRevision: requireInteger(
            batch.highestFactRevision,
            0,
            `${label} highestFactRevision`
          )
        })
  };
  return result;
}

function parseDeliveryModes(value: unknown, label: string): DeliveryMode[] {
  const modes = requireStringArray(value, label);
  for (const mode of modes) {
    if (mode !== "followup" && mode !== "steer-if-safe" && mode !== "inject") {
      throw new Error(`${label} contains an invalid delivery mode`);
    }
  }
  return modes as DeliveryMode[];
}

function parseProcessing(value: unknown): ProcessingBatch {
  const processing = record(value, "WorkMailbox processing");
  const required = ["batchId", "lane", "batch", "owner", "startedAt"];
  exact(
    processing,
    processing.executionRef === undefined ? required : [...required, "executionRef"],
    "WorkMailbox processing"
  );
  const result: ProcessingBatch = {
    batchId: requireString(processing.batchId, "WorkMailbox processing batchId"),
    lane: parseLane(processing.lane, "WorkMailbox processing lane"),
    batch: parseBatch(processing.batch, "WorkMailbox processing batch"),
    owner: requireString(processing.owner, "WorkMailbox processing owner"),
    startedAt: requireTimestamp(processing.startedAt, "WorkMailbox processing startedAt")
  };
  return processing.executionRef === undefined
    ? result
    : { ...result, executionRef: parseRef(processing.executionRef, "WorkMailbox processing executionRef") };
}

function parseInputDelivery(value: unknown): InputDelivery {
  const input = record(value, "WorkMailbox inputDelivery");
  const required = [
    "attemptId",
    "lane",
    "mode",
    "batch",
    "owner",
    "status",
    "startedAt",
    "executionRef"
  ];
  const optional = [
    ...(input.pushedAt === undefined ? [] : ["pushedAt"]),
    ...(input.unknownReason === undefined ? [] : ["unknownReason"]),
    ...(input.providerFence === undefined ? [] : ["providerFence"])
  ];
  exact(input, [...required, ...optional], "WorkMailbox inputDelivery");
  const lane = parseLane(input.lane, "WorkMailbox inputDelivery lane");
  const mode = parseDeliveryMode(input.mode, "WorkMailbox inputDelivery mode");
  if (input.status !== "dispatching" && input.status !== "delivery-unknown") {
    throw new Error("WorkMailbox inputDelivery status is invalid");
  }
  const status = input.status;
  if ((status === "delivery-unknown") !== (input.unknownReason !== undefined)) {
    throw new Error("WorkMailbox delivery-unknown requires exactly one unknownReason");
  }
  const result: InputDelivery = {
    attemptId: requireString(input.attemptId, "WorkMailbox inputDelivery attemptId"),
    lane,
    mode,
    batch: parseBatch(input.batch, "WorkMailbox inputDelivery batch"),
    owner: requireString(input.owner, "WorkMailbox inputDelivery owner"),
    status,
    startedAt: requireTimestamp(input.startedAt, "WorkMailbox inputDelivery startedAt"),
    executionRef: parseRef(input.executionRef, "WorkMailbox inputDelivery executionRef"),
    ...(input.pushedAt === undefined
      ? {}
      : { pushedAt: requireTimestamp(input.pushedAt, "WorkMailbox inputDelivery pushedAt") }),
    ...(input.unknownReason === undefined
      ? {}
      : { unknownReason: requireString(input.unknownReason, "WorkMailbox inputDelivery unknownReason") }),
    ...(input.providerFence === undefined
      ? {}
      : { providerFence: parseProviderFence(input.providerFence) })
  };
  if (result.pushedAt !== undefined
    && Date.parse(result.pushedAt) < Date.parse(result.startedAt)) {
    throw new Error("WorkMailbox inputDelivery pushedAt is earlier than startedAt");
  }
  return result;
}

function parseProviderFence(value: unknown): NonNullable<InputDelivery["providerFence"]> {
  const fence = record(value, "WorkMailbox inputDelivery providerFence");
  exact(
    fence,
    fence.nativeTurnId === undefined
      ? ["conversationId", "activationId"]
      : ["conversationId", "activationId", "nativeTurnId"],
    "WorkMailbox inputDelivery providerFence"
  );
  return {
    conversationId: requireString(fence.conversationId, "Provider Conversation id"),
    activationId: requireString(fence.activationId, "Provider Activation id"),
    ...(fence.nativeTurnId === undefined
      ? {}
      : { nativeTurnId: requireString(fence.nativeTurnId, "Provider Turn id") })
  };
}

function parseLane(value: unknown, label: string): MailboxLane {
  if (value !== "normal" && value !== "user-correction") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseDeliveryMode(value: unknown, label: string): DeliveryMode {
  if (value !== "followup" && value !== "steer-if-safe" && value !== "inject") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function enqueueSignal(
  mailbox: WorkMailbox,
  signal: WorkSignal
): WorkMailbox {
  const reason = requireText(signal.reason, "signal reason");
  const occurredAt = requireText(signal.occurredAt, "signal occurredAt");
  const lane = signal.lane ?? "normal";
  const laneKey = lane === "normal" ? "normal" : "userCorrection";
  const deliveryMode = signal.deliveryMode ?? "followup";
  const source = requireText(signal.source ?? "yui", "signal source");
  const refs = signal.refs.map(copyRef);
  const sequence = mailbox.nextSequence;
  const dedupeKey = signal.dedupeKey === undefined
    ? `sequence:${sequence}`
    : requireText(signal.dedupeKey, "signal dedupeKey");
  if (mailboxContainsDedupeKey(mailbox, dedupeKey)) return mailbox;
  const incoming: PendingBatch = {
    fromSequence: sequence,
    toSequence: sequence,
    reasons: [reason],
    refs: appendUnique([], refs, mailboxEntityRefKey),
    requestCount: 1,
    firstQueuedAt: occurredAt,
    lastQueuedAt: occurredAt,
    sources: [source],
    dedupeKeys: [dedupeKey],
    deliveryModes: [deliveryMode],
    ...(signal.factRevision === undefined
      ? {}
      : { highestFactRevision: requireInteger(signal.factRevision, 0, "signal factRevision") })
  };

  return {
    ...mailbox,
    nextSequence: sequence + 1,
    pending: {
      ...mailbox.pending,
      [laneKey]: mailbox.pending[laneKey] === null
        ? incoming
        : mergeBatches(mailbox.pending[laneKey]!, incoming)
    }
  };
}

function mailboxContainsDedupeKey(mailbox: WorkMailbox, key: string): boolean {
  if (mailbox.pending.recentDedupeKeys.includes(key)) return true;
  return [
    mailbox.pending.normal,
    mailbox.pending.userCorrection,
    mailbox.processing?.batch,
    mailbox.inputDelivery?.batch
  ].some((batch) => batch?.dedupeKeys.includes(key) === true);
}

export function pendingLane(mailbox: WorkMailbox, lane: MailboxLane): PendingBatch | null {
  return lane === "normal" ? mailbox.pending.normal : mailbox.pending.userCorrection;
}

export function mailboxHasPending(mailbox: WorkMailbox): boolean {
  return mailbox.pending.normal !== null || mailbox.pending.userCorrection !== null;
}

export function nextPendingLane(mailbox: WorkMailbox): MailboxLane | null {
  if (mailbox.pending.userCorrection !== null) return "user-correction";
  return mailbox.pending.normal === null ? null : "normal";
}

export function nextPendingBatch(mailbox: WorkMailbox): PendingBatch | null {
  const lane = nextPendingLane(mailbox);
  return lane === null ? null : pendingLane(mailbox, lane);
}

export function mailboxHasWork(mailbox: WorkMailbox): boolean {
  return mailbox.processing !== null
    || mailbox.inputDelivery !== null
    || mailboxHasPending(mailbox);
}

export function mailboxBatches(mailbox: WorkMailbox): readonly PendingBatch[] {
  return [
    mailbox.processing?.batch,
    mailbox.inputDelivery?.batch,
    mailbox.pending.userCorrection,
    mailbox.pending.normal
  ].filter((batch): batch is PendingBatch => batch !== null && batch !== undefined);
}

function mailboxTaskRecordKind(
  type: "run" | "work-item" | "input" | "message" | "event"
): TaskRecordKind {
  switch (type) {
    case "run": return "agentRun";
    case "work-item": return "workItem";
    case "input": return "inputRequest";
    case "message": return "message";
    case "event": return "event";
  }
}

export function claimPending(
  mailbox: WorkMailbox,
  options: ClaimOptions
): WorkMailbox {
  if (mailbox.processing !== null) {
    throw new Error("Mailbox is already processing a batch");
  }
  const lane = options.lane ?? nextPendingLane(mailbox);
  if (lane === null) {
    throw new Error("Mailbox has no pending work to claim");
  }
  const batch = pendingLane(mailbox, lane);
  if (batch === null) throw new Error(`Mailbox has no pending ${lane} work to claim`);

  const processing: ProcessingBatch = {
    batchId: requireText(options.batchId, "batch id"),
    lane,
    batch,
    owner: requireText(options.owner, "claim owner"),
    startedAt: requireText(options.startedAt, "claim startedAt")
  };
  return {
    ...mailbox,
    processing,
    pending: {
      ...mailbox.pending,
      [lane === "normal" ? "normal" : "userCorrection"]: null
    }
  };
}

export function bindExecution(
  mailbox: WorkMailbox,
  batchId: string,
  executionRef: MailboxEntityRef
): WorkMailbox {
  const processing = requireProcessing(mailbox, batchId);
  return {
    ...mailbox,
    processing: { ...processing, executionRef: copyRef(executionRef) }
  };
}

export function completeProcessing(
  mailbox: WorkMailbox,
  batchId: string
): WorkMailbox {
  const processing = requireProcessing(mailbox, batchId);
  const lane = processing.lane;
  return validateWorkMailbox({
    ...mailbox,
    processing: null,
    pending: advanceLaneCursor(mailbox.pending, lane, processing.batch)
  });
}

export function releaseProcessing(
  mailbox: WorkMailbox,
  batchId: string
): WorkMailbox {
  const processing = requireProcessing(mailbox, batchId);
  const lane = processing.lane;
  const key = lane === "normal" ? "normal" : "userCorrection";
  const released = mailbox.pending[key] === null
    ? processing.batch
    : mergeBatches(processing.batch, mailbox.pending[key]!);
  return {
    ...mailbox,
    processing: null,
    pending: { ...mailbox.pending, [key]: released }
  };
}

function requireInputDelivery(mailbox: WorkMailbox, attemptId: string): InputDelivery {
  const id = requireText(attemptId, "input delivery attempt id");
  if (mailbox.inputDelivery === null) throw new Error("Mailbox has no input delivery");
  if (mailbox.inputDelivery.attemptId !== id) {
    throw new Error(`Mailbox input delivery does not match ${id}`);
  }
  return mailbox.inputDelivery;
}

export function claimInputDelivery(
  mailbox: WorkMailbox,
  options: InputDeliveryClaimOptions
): WorkMailbox {
  if (mailbox.inputDelivery !== null) {
    if (mailbox.inputDelivery.attemptId === options.attemptId) return mailbox;
    throw new Error("Mailbox already has an input delivery");
  }
  const batch = pendingLane(mailbox, options.lane);
  if (batch === null) throw new Error(`Mailbox has no pending ${options.lane} input`);
  const inputDelivery: InputDelivery = {
    attemptId: requireText(options.attemptId, "input delivery attempt id"),
    lane: options.lane,
    mode: options.mode,
    batch,
    owner: requireText(options.owner, "input delivery owner"),
    status: "dispatching",
    startedAt: requireTimestamp(options.startedAt, "input delivery startedAt"),
    executionRef: copyRef(options.executionRef),
    ...(options.providerFence === undefined
      ? {}
      : { providerFence: parseProviderFence(options.providerFence) })
  };
  return validateWorkMailbox({
    ...mailbox,
    pending: {
      ...mailbox.pending,
      [options.lane === "normal" ? "normal" : "userCorrection"]: null
    },
    inputDelivery
  });
}

export function markInputDeliveryPushed(
  mailbox: WorkMailbox,
  attemptId: string,
  pushedAt: Date
): WorkMailbox {
  const delivery = requireInputDelivery(mailbox, attemptId);
  if (delivery.pushedAt !== undefined) return mailbox;
  const timestamp = requireTimestamp(pushedAt.toISOString(), "input delivery pushedAt");
  return validateWorkMailbox({
    ...mailbox,
    inputDelivery: { ...delivery, pushedAt: timestamp }
  });
}

export function markInputDeliveryUnknown(
  mailbox: WorkMailbox,
  attemptId: string,
  reason: string,
  observedAt: Date
): WorkMailbox {
  const delivery = requireInputDelivery(mailbox, attemptId);
  const timestamp = requireTimestamp(observedAt.toISOString(), "delivery unknown observedAt");
  return validateWorkMailbox({
    ...mailbox,
    inputDelivery: {
      ...delivery,
      status: "delivery-unknown",
      unknownReason: requireText(reason, "delivery unknown reason"),
      pushedAt: delivery.pushedAt ?? timestamp
    }
  });
}

export function completeInputDelivery(
  mailbox: WorkMailbox,
  attemptId: string,
  _acceptedAt: Date
): WorkMailbox {
  const delivery = requireInputDelivery(mailbox, attemptId);
  return validateWorkMailbox({
    ...mailbox,
    inputDelivery: null,
    pending: advanceLaneCursor(mailbox.pending, delivery.lane, delivery.batch)
  });
}

export function consumePendingBatch(
  mailbox: WorkMailbox,
  lane: MailboxLane
): WorkMailbox {
  const key = lane === "normal" ? "normal" : "userCorrection";
  const batch = mailbox.pending[key];
  if (batch === null) throw new Error(`Mailbox has no pending ${lane} batch`);
  return validateWorkMailbox({
    ...mailbox,
    pending: {
      ...advanceLaneCursor(mailbox.pending, lane, batch),
      [key]: null
    }
  });
}

function advanceLaneCursor(
  pending: PendingLanes,
  lane: MailboxLane,
  batch: PendingBatch
): PendingLanes {
  const key = lane === "normal" ? "normal" : "userCorrection";
  const recentDedupeKeys = appendUnique(
    pending.recentDedupeKeys,
    batch.dedupeKeys,
    (value) => value
  ).slice(-RECENT_DEDUPE_KEY_LIMIT);
  return {
    ...pending,
    cursors: {
      ...pending.cursors,
      [key]: Math.max(pending.cursors[key], batch.toSequence)
    },
    recentDedupeKeys
  };
}

export function releaseInputDelivery(
  mailbox: WorkMailbox,
  attemptId: string
): WorkMailbox {
  const delivery = requireInputDelivery(mailbox, attemptId);
  if (delivery.pushedAt !== undefined || delivery.status === "delivery-unknown") {
    throw new Error("A pushed or delivery-unknown input cannot return to pending");
  }
  const key = delivery.lane === "normal" ? "normal" : "userCorrection";
  return validateWorkMailbox({
    ...mailbox,
    pending: {
      ...mailbox.pending,
      [key]: mailbox.pending[key] === null
        ? delivery.batch
        : mergeBatches(delivery.batch, mailbox.pending[key]!)
    },
    inputDelivery: null
  });
}

/** Exact Provider readback proved that a previously uncertain mutation is absent. */
export function resolveInputDeliveryNotAccepted(
  mailbox: WorkMailbox,
  attemptId: string
): WorkMailbox {
  const delivery = requireInputDelivery(mailbox, attemptId);
  const key = delivery.lane === "normal" ? "normal" : "userCorrection";
  return validateWorkMailbox({
    ...mailbox,
    pending: {
      ...mailbox.pending,
      [key]: mailbox.pending[key] === null
        ? delivery.batch
        : mergeBatches(delivery.batch, mailbox.pending[key]!)
    },
    inputDelivery: null
  });
}
