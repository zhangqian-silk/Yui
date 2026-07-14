import { createHash } from "node:crypto";
import {
  isCanonicalNativeSessionId,
  isCanonicalNativeSessionRoot
} from "../executor/nativeSessionIdentity.js";

export type InputResolutionWakeup = {
  schemaVersion: 1;
  taskId: string;
  roleName: "leader";
  agentId: string;
  requestId: string;
  resolutionId: string;
  agentRunId: string;
  adapterId: string;
  sessionRoot: string;
  nativeSessionId: string;
  deliveryId: string;
  status: "pending" | "claimed" | "accepted" | "completed" | "abandoned";
  createdAt: string;
  updatedAt: string;
  claim?: InputResolutionWakeupClaim;
  receipt?: InputResolutionWakeupReceipt;
  completedAt?: string;
  abandoned?: {
    reason: string;
    abandonedAt: string;
  };
};

export type InputResolutionWakeupClaim = {
  controllerId: string;
  controllerGeneration: string;
  claimId: string;
  claimedAt: string;
  expiresAt: string;
};

export type InputResolutionWakeupReceipt = {
  deliveryId: string;
  transport: "tmux";
  acceptedAt: string;
};

export type InputResolutionWakeupClaimReference = Pick<
  InputResolutionWakeupClaim,
  "controllerId" | "controllerGeneration" | "claimId"
>;

export type CreateInputResolutionWakeup = Omit<
  InputResolutionWakeup,
  | "schemaVersion"
  | "deliveryId"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "claim"
  | "receipt"
  | "completedAt"
  | "abandoned"
>;

const POINTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A typed wakeup points to the exact Leader run and native session that
 * originated a request. The delivery id is deterministic for that immutable
 * origin tuple, so a recovery attempt can ask the native transport to dedupe
 * rather than minting another user-visible instruction.
 */
export function createInputResolutionWakeup(
  input: CreateInputResolutionWakeup,
  now: Date
): InputResolutionWakeup {
  assertPointer(input.taskId, "task id");
  assertLeaderRole(input.roleName);
  assertPointer(input.agentId, "Leader agent id");
  assertPointer(input.requestId, "input request id");
  assertPointer(input.resolutionId, "input resolution id");
  assertPointer(input.agentRunId, "Leader run id");
  assertAdapterId(input.adapterId);
  assertSessionRoot(input.sessionRoot);
  assertNativeSessionId(input.nativeSessionId);
  const timestamp = isoTimestamp(now);
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    roleName: input.roleName,
    agentId: input.agentId,
    requestId: input.requestId,
    resolutionId: input.resolutionId,
    agentRunId: input.agentRunId,
    adapterId: input.adapterId,
    sessionRoot: input.sessionRoot,
    nativeSessionId: input.nativeSessionId,
    deliveryId: resolutionWakeupDeliveryId(input),
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function isInputResolutionWakeup(
  value: unknown,
  expectedTaskId?: string,
  expectedRequestId?: string
): value is InputResolutionWakeup {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (!(value.schemaVersion === 1 &&
    isPointer(value.taskId) &&
    value.roleName === "leader" &&
    isPointer(value.agentId) &&
    isPointer(value.requestId) &&
    isPointer(value.resolutionId) &&
    isPointer(value.agentRunId) &&
    isAdapterId(value.adapterId) &&
    isCanonicalNativeSessionRoot(value.sessionRoot) &&
    isCanonicalNativeSessionId(value.nativeSessionId) &&
    isPointer(value.deliveryId) &&
    value.deliveryId === resolutionWakeupDeliveryId(
      value as unknown as Pick<
        InputResolutionWakeup,
        "taskId" | "roleName" | "agentId" | "requestId" | "resolutionId" | "agentRunId" |
        "adapterId" | "sessionRoot" | "nativeSessionId"
      >
    ) &&
    ["pending", "claimed", "accepted", "completed", "abandoned"].includes(value.status as string) &&
    (expectedTaskId === undefined || value.taskId === expectedTaskId) &&
    (expectedRequestId === undefined || value.requestId === expectedRequestId) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt)) {
    return false;
  }
  const base = [
    "schemaVersion", "taskId", "roleName", "agentId", "requestId", "resolutionId", "agentRunId",
    "adapterId", "sessionRoot", "nativeSessionId", "deliveryId", "status", "createdAt", "updatedAt"
  ];
  if (value.status === "pending") {
    return hasExactKeys(value, base);
  }
  if (value.status === "claimed") {
    return hasExactKeys(value, [...base, "claim"]) &&
      isClaim(value.claim) &&
      value.claim.claimedAt === value.updatedAt;
  }
  if (value.status === "accepted") {
    return hasExactKeys(value, [...base, "receipt"]) &&
      isReceipt(value.receipt, value.deliveryId) &&
      value.receipt.acceptedAt === value.updatedAt;
  }
  if (value.status === "completed") {
    return hasExactKeys(value, [...base, "receipt", "completedAt"]) &&
      isReceipt(value.receipt, value.deliveryId) &&
      isIsoTimestamp(value.completedAt) &&
      value.completedAt === value.updatedAt;
  }
  return value.status === "abandoned" &&
    hasExactKeys(value, [
      ...base,
      ...(value.receipt === undefined ? [] : ["receipt"]),
      "abandoned"
    ]) &&
    (value.receipt === undefined || isReceipt(value.receipt, value.deliveryId)) &&
    isAbandoned(value.abandoned) &&
    value.abandoned.abandonedAt === value.updatedAt;
}

export function claimInputResolutionWakeup(
  wakeup: InputResolutionWakeup,
  claim: Omit<InputResolutionWakeupClaim, "claimedAt">,
  now: Date
): InputResolutionWakeup {
  assertWakeup(wakeup);
  if (wakeup.status !== "pending") {
    throw new InputResolutionWakeupFenceError(`Input resolution wakeup is not pending: ${wakeup.taskId}/${wakeup.requestId}`);
  }
  const timestamp = isoTimestamp(now);
  const normalizedClaim = {
    controllerId: requirePointer(claim.controllerId, "controller id"),
    controllerGeneration: requirePointer(claim.controllerGeneration, "controller generation"),
    claimId: requirePointer(claim.claimId, "claim id"),
    claimedAt: timestamp,
    expiresAt: requireFutureTimestamp(claim.expiresAt, now)
  };
  return {
    ...baseWakeup(wakeup),
    status: "claimed",
    createdAt: wakeup.createdAt,
    updatedAt: timestamp,
    claim: normalizedClaim
  };
}

export function releaseExpiredInputResolutionWakeupClaim(
  wakeup: InputResolutionWakeup,
  now: Date
): InputResolutionWakeup {
  assertWakeup(wakeup);
  if (wakeup.status !== "claimed") {
    throw new InputResolutionWakeupFenceError(`Input resolution wakeup is not claimed: ${wakeup.taskId}/${wakeup.requestId}`);
  }
  const timestamp = isoTimestamp(now);
  if (Date.parse(wakeup.claim!.expiresAt) > now.getTime()) {
    throw new InputResolutionWakeupFenceError(`Input resolution wakeup lease has not expired: ${wakeup.taskId}/${wakeup.requestId}`);
  }
  return pendingWakeup(wakeup, timestamp);
}

export function releaseInputResolutionWakeupClaim(
  wakeup: InputResolutionWakeup,
  claim: InputResolutionWakeupClaimReference,
  now: Date
): InputResolutionWakeup {
  assertInputResolutionWakeupClaim(wakeup, claim, now);
  return pendingWakeup(wakeup, isoTimestamp(now));
}

export function acceptInputResolutionWakeupTransport(
  wakeup: InputResolutionWakeup,
  claim: InputResolutionWakeupClaimReference,
  receipt: Omit<InputResolutionWakeupReceipt, "acceptedAt">,
  now: Date
): InputResolutionWakeup {
  assertInputResolutionWakeupClaim(wakeup, claim, now);
  if (receipt.deliveryId !== wakeup.deliveryId || receipt.transport !== "tmux") {
    throw new InputResolutionWakeupFenceError(
      `Input resolution wakeup transport receipt does not match: ${wakeup.taskId}/${wakeup.requestId}`
    );
  }
  const timestamp = isoTimestamp(now);
  return {
    ...baseWakeup(wakeup),
    status: "accepted",
    createdAt: wakeup.createdAt,
    updatedAt: timestamp,
    receipt: {
      deliveryId: wakeup.deliveryId,
      transport: "tmux",
      acceptedAt: timestamp
    }
  };
}

export function completeAcceptedInputResolutionWakeup(
  wakeup: InputResolutionWakeup,
  now: Date
): InputResolutionWakeup {
  assertWakeup(wakeup);
  if (wakeup.status !== "accepted") {
    throw new InputResolutionWakeupFenceError(
      `Input resolution wakeup has no accepted transport receipt: ${wakeup.taskId}/${wakeup.requestId}`
    );
  }
  const timestamp = isoTimestamp(now);
  return {
    ...baseWakeup(wakeup),
    status: "completed",
    createdAt: wakeup.createdAt,
    updatedAt: timestamp,
    receipt: wakeup.receipt,
    completedAt: timestamp
  };
}

export function abandonInputResolutionWakeup(
  wakeup: InputResolutionWakeup,
  reason: string,
  now: Date
): InputResolutionWakeup {
  assertWakeup(wakeup);
  if (wakeup.status === "completed" || wakeup.status === "abandoned") {
    throw new InputResolutionWakeupFenceError(`Input resolution wakeup is terminal: ${wakeup.taskId}/${wakeup.requestId}`);
  }
  const timestamp = isoTimestamp(now);
  const normalizedReason = requireReason(reason);
  return {
    ...baseWakeup(wakeup),
    status: "abandoned",
    createdAt: wakeup.createdAt,
    updatedAt: timestamp,
    ...(wakeup.status === "accepted" ? { receipt: wakeup.receipt } : {}),
    abandoned: { reason: normalizedReason, abandonedAt: timestamp }
  };
}

export function assertInputResolutionWakeupClaim(
  wakeup: InputResolutionWakeup,
  claim: InputResolutionWakeupClaimReference,
  now: Date
): void {
  assertWakeup(wakeup);
  if (
    wakeup.status !== "claimed" ||
    wakeup.claim!.controllerId !== claim.controllerId ||
    wakeup.claim!.controllerGeneration !== claim.controllerGeneration ||
    wakeup.claim!.claimId !== claim.claimId ||
    Date.parse(wakeup.claim!.expiresAt) <= now.getTime()
  ) {
    throw new InputResolutionWakeupFenceError(`Input resolution wakeup claim is fenced: ${wakeup.taskId}/${wakeup.requestId}`);
  }
}

export class InputResolutionWakeupFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputResolutionWakeupFenceError";
  }
}

function resolutionWakeupDeliveryId(
  value: Pick<
    InputResolutionWakeup,
    "taskId" | "roleName" | "agentId" | "requestId" | "resolutionId" | "agentRunId" |
    "adapterId" | "sessionRoot" | "nativeSessionId"
  >
): string {
  return `input-resolution-${createHash("sha256").update(JSON.stringify([
    value.taskId,
    value.roleName,
    value.agentId,
    value.requestId,
    value.resolutionId,
    value.agentRunId,
    value.adapterId,
    value.sessionRoot,
    value.nativeSessionId
  ])).digest("hex")}`;
}

function baseWakeup(wakeup: InputResolutionWakeup): Pick<
  InputResolutionWakeup,
  | "schemaVersion"
  | "taskId"
  | "roleName"
  | "agentId"
  | "requestId"
  | "resolutionId"
  | "agentRunId"
  | "adapterId"
  | "sessionRoot"
  | "nativeSessionId"
  | "deliveryId"
> {
  return {
    schemaVersion: 1,
    taskId: wakeup.taskId,
    roleName: wakeup.roleName,
    agentId: wakeup.agentId,
    requestId: wakeup.requestId,
    resolutionId: wakeup.resolutionId,
    agentRunId: wakeup.agentRunId,
    adapterId: wakeup.adapterId,
    sessionRoot: wakeup.sessionRoot,
    nativeSessionId: wakeup.nativeSessionId,
    deliveryId: wakeup.deliveryId
  };
}

function assertPointer(value: unknown, label: string): asserts value is string {
  if (!isPointer(value)) {
    throw new Error(`Invalid input resolution wakeup ${label}.`);
  }
}

function requirePointer(value: unknown, label: string): string {
  assertPointer(value, label);
  return value;
}

function isPointer(value: unknown): value is string {
  return typeof value === "string" && POINTER_PATTERN.test(value);
}

function assertLeaderRole(value: unknown): asserts value is "leader" {
  if (value !== "leader") {
    throw new Error("Input resolution wakeup must target the Leader role.");
  }
}

function assertAdapterId(value: unknown): asserts value is string {
  if (!isAdapterId(value)) {
    throw new Error("Invalid input resolution wakeup Leader adapter id.");
  }
}

function isAdapterId(value: unknown): value is string {
  return isPointer(value);
}

function assertSessionRoot(value: unknown): asserts value is string {
  if (!isCanonicalNativeSessionRoot(value)) {
    throw new Error("Invalid input resolution wakeup Leader session root.");
  }
}

function assertNativeSessionId(value: unknown): asserts value is string {
  if (!isCanonicalNativeSessionId(value)) {
    throw new Error("Invalid input resolution wakeup Leader native session id.");
  }
}

function isoTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid input resolution wakeup timestamp.");
  }
  return value.toISOString();
}

function requireFutureTimestamp(value: unknown, now: Date): string {
  if (!isIsoTimestamp(value) || Date.parse(value) <= now.getTime()) {
    throw new Error("Input resolution wakeup claim expiry must be after now.");
  }
  return value;
}

function requireReason(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Input resolution wakeup abandonment reason is invalid.");
  }
  return value;
}

function pendingWakeup(wakeup: InputResolutionWakeup, timestamp: string): InputResolutionWakeup {
  return {
    ...baseWakeup(wakeup),
    status: "pending",
    createdAt: wakeup.createdAt,
    updatedAt: timestamp
  };
}

function assertWakeup(value: InputResolutionWakeup): void {
  if (!isInputResolutionWakeup(value, value?.taskId, value?.requestId)) {
    throw new Error("Invalid input resolution wakeup record.");
  }
}

function isClaim(value: unknown): value is InputResolutionWakeupClaim {
  return isPlainRecord(value) &&
    hasExactKeys(value, ["controllerId", "controllerGeneration", "claimId", "claimedAt", "expiresAt"]) &&
    isPointer(value.controllerId) &&
    isPointer(value.controllerGeneration) &&
    isPointer(value.claimId) &&
    isIsoTimestamp(value.claimedAt) &&
    isIsoTimestamp(value.expiresAt) &&
    value.expiresAt > value.claimedAt;
}

function isReceipt(value: unknown, deliveryId: string): value is InputResolutionWakeupReceipt {
  return isPlainRecord(value) &&
    hasExactKeys(value, ["deliveryId", "transport", "acceptedAt"]) &&
    value.deliveryId === deliveryId &&
    value.transport === "tmux" &&
    isIsoTimestamp(value.acceptedAt);
}

function isAbandoned(value: unknown): value is { reason: string; abandonedAt: string } {
  return isPlainRecord(value) &&
    hasExactKeys(value, ["reason", "abandonedAt"]) &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason === value.reason.trim() &&
    value.reason.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value.reason) &&
    isIsoTimestamp(value.abandonedAt);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
