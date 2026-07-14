export type OperatorDeliveryStatus = "pending" | "leased" | "accepted" | "revoked";

export type OperatorDeliveryRevocation =
  | "request-terminal"
  | "request-superseded"
  | "task-archived";

export type OperatorDelivery = {
  schemaVersion: 1;
  deliveryId: string;
  sequence: number;
  type: "input-request";
  taskId: string;
  requestId: string;
  status: OperatorDeliveryStatus;
  attemptCount: number;
  leaseGeneration: number;
  createdAt: string;
  updatedAt: string;
  leaseOwnerId?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  transportAcceptedAt?: string;
  revokedReason?: OperatorDeliveryRevocation;
};

export type OperatorDeliveryLease = {
  ownerId: string;
  leaseId: string;
  expiresAt: string;
};

export type OperatorDeliveryLeaseReference = Pick<OperatorDeliveryLease, "ownerId" | "leaseId"> & {
  leaseGeneration: number;
};

export class OperatorDeliveryLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorDeliveryLeaseError";
  }
}

const POINTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Creates a durable outbox entry. It intentionally contains no question,
 * choices, answers, or presentation state: the task-owned InputRequest is the
 * only durable body authority.
 */
export function createOperatorDelivery(
  deliveryId: string,
  sequence: number,
  taskId: string,
  requestId: string,
  now: Date
): OperatorDelivery {
  assertPointer(deliveryId, "delivery id");
  assertPositiveInteger(sequence, "delivery sequence");
  assertPointer(taskId, "task id");
  assertPointer(requestId, "input request id");
  const timestamp = isoTimestamp(now, "delivery timestamp");
  return {
    schemaVersion: 1,
    deliveryId,
    sequence,
    type: "input-request",
    taskId,
    requestId,
    status: "pending",
    attemptCount: 0,
    leaseGeneration: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

/**
 * A lease grants one foreground transport a short-lived opportunity to accept
 * delivery. It is not a display receipt.
 */
export function leaseOperatorDelivery(
  delivery: OperatorDelivery,
  lease: OperatorDeliveryLease,
  now: Date
): OperatorDelivery {
  assertDelivery(delivery);
  if (delivery.status !== "pending") {
    throw new OperatorDeliveryLeaseError(`Operator delivery ${delivery.deliveryId} is not pending.`);
  }
  const ownerId = requirePointer(lease.ownerId, "lease owner id");
  const leaseId = requirePointer(lease.leaseId, "lease id");
  const expiresAt = requireFutureTimestamp(lease.expiresAt, now);
  const timestamp = isoTimestamp(now, "delivery lease timestamp");
  return {
    ...delivery,
    status: "leased",
    leaseOwnerId: ownerId,
    leaseId,
    leaseExpiresAt: expiresAt,
    attemptCount: delivery.attemptCount + 1,
    leaseGeneration: delivery.leaseGeneration + 1,
    updatedAt: timestamp
  };
}

/**
 * Marks only that the selected structured transport accepted the envelope.
 * Acceptance does not claim that a human saw or acted on the input.
 */
export function acknowledgeOperatorTransportAcceptance(
  delivery: OperatorDelivery,
  lease: OperatorDeliveryLeaseReference,
  now: Date
): OperatorDelivery {
  assertDelivery(delivery);
  assertLeaseOwner(delivery, lease);
  const timestamp = isoTimestamp(now, "delivery acceptance timestamp");
  assertLeaseActive(delivery, now);
  return {
    schemaVersion: 1,
    deliveryId: delivery.deliveryId,
    sequence: delivery.sequence,
    type: delivery.type,
    taskId: delivery.taskId,
    requestId: delivery.requestId,
    status: "accepted",
    attemptCount: delivery.attemptCount,
    leaseGeneration: delivery.leaseGeneration,
    createdAt: delivery.createdAt,
    updatedAt: timestamp,
    transportAcceptedAt: timestamp
  };
}

export function releaseOperatorDelivery(
  delivery: OperatorDelivery,
  lease: OperatorDeliveryLeaseReference,
  now: Date
): OperatorDelivery {
  assertDelivery(delivery);
  assertLeaseOwner(delivery, lease);
  assertLeaseActive(delivery, now);
  const timestamp = isoTimestamp(now, "delivery release timestamp");
  return {
    schemaVersion: 1,
    deliveryId: delivery.deliveryId,
    sequence: delivery.sequence,
    type: delivery.type,
    taskId: delivery.taskId,
    requestId: delivery.requestId,
    status: "pending",
    attemptCount: delivery.attemptCount,
    leaseGeneration: delivery.leaseGeneration,
    createdAt: delivery.createdAt,
    updatedAt: timestamp
  };
}

/**
 * Returns a pending record after an expired lease. Callers must prove expiry
 * against their Controller clock before invoking this transition.
 */
export function requeueExpiredOperatorDelivery(
  delivery: OperatorDelivery,
  now: Date
): OperatorDelivery {
  assertDelivery(delivery);
  if (delivery.status !== "leased") {
    throw new OperatorDeliveryLeaseError(`Operator delivery ${delivery.deliveryId} is not leased.`);
  }
  const timestamp = isoTimestamp(now, "delivery requeue timestamp");
  if (Date.parse(delivery.leaseExpiresAt ?? "") > now.getTime()) {
    throw new OperatorDeliveryLeaseError(`Operator delivery ${delivery.deliveryId} lease has not expired.`);
  }
  return {
    schemaVersion: 1,
    deliveryId: delivery.deliveryId,
    sequence: delivery.sequence,
    type: delivery.type,
    taskId: delivery.taskId,
    requestId: delivery.requestId,
    status: "pending",
    attemptCount: delivery.attemptCount,
    leaseGeneration: delivery.leaseGeneration,
    createdAt: delivery.createdAt,
    updatedAt: timestamp
  };
}

export function revokeOperatorDelivery(
  delivery: OperatorDelivery,
  reason: OperatorDeliveryRevocation,
  now: Date
): OperatorDelivery {
  assertDelivery(delivery);
  if (delivery.status === "accepted") {
    throw new OperatorDeliveryLeaseError(
      `Accepted operator delivery ${delivery.deliveryId} is immutable transport history.`
    );
  }
  if (delivery.status === "revoked") {
    return delivery;
  }
  const timestamp = isoTimestamp(now, "delivery revocation timestamp");
  return {
    schemaVersion: 1,
    deliveryId: delivery.deliveryId,
    sequence: delivery.sequence,
    type: delivery.type,
    taskId: delivery.taskId,
    requestId: delivery.requestId,
    status: "revoked",
    attemptCount: delivery.attemptCount,
    leaseGeneration: delivery.leaseGeneration,
    createdAt: delivery.createdAt,
    updatedAt: timestamp,
    revokedReason: reason
  };
}

export function operatorDeliveryKey(
  value: Pick<OperatorDelivery, "taskId" | "requestId">
): string {
  return `${value.taskId}\u0000${value.requestId}`;
}

export function operatorDeliveryPayload(
  delivery: Pick<OperatorDelivery, "type" | "deliveryId" | "taskId" | "requestId">
): Readonly<{
  type: "input-request";
  deliveryId: string;
  taskId: string;
  requestId: string;
}> {
  return Object.freeze({
    type: delivery.type,
    deliveryId: delivery.deliveryId,
    taskId: delivery.taskId,
    requestId: delivery.requestId
  });
}

export function isOperatorDelivery(
  value: unknown,
  expectedDeliveryId?: string
): value is OperatorDelivery {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || value.type !== "input-request") {
    return false;
  }
  if (
    !isPointer(value.deliveryId) ||
    (expectedDeliveryId !== undefined && value.deliveryId !== expectedDeliveryId) ||
    !isPositiveInteger(value.sequence) ||
    !isPointer(value.taskId) ||
    !isPointer(value.requestId) ||
    !isNonnegativeInteger(value.attemptCount) ||
    !isNonnegativeInteger(value.leaseGeneration) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    return false;
  }
  if (value.status === "pending") {
    return hasExactKeys(value, [
      "schemaVersion", "deliveryId", "sequence", "type", "taskId", "requestId",
      "status", "attemptCount", "leaseGeneration", "createdAt", "updatedAt"
    ]);
  }
  if (value.status === "leased") {
    return hasExactKeys(value, [
      "schemaVersion", "deliveryId", "sequence", "type", "taskId", "requestId",
      "status", "attemptCount", "leaseGeneration", "createdAt", "updatedAt",
      "leaseOwnerId", "leaseId", "leaseExpiresAt"
    ]) &&
      isPointer(value.leaseOwnerId) &&
      isPointer(value.leaseId) &&
      value.leaseGeneration >= 1 &&
      isIsoTimestamp(value.leaseExpiresAt) &&
      value.leaseExpiresAt > value.updatedAt;
  }
  if (value.status === "accepted") {
    return hasExactKeys(value, [
      "schemaVersion", "deliveryId", "sequence", "type", "taskId", "requestId",
      "status", "attemptCount", "leaseGeneration", "createdAt", "updatedAt", "transportAcceptedAt"
    ]) &&
      isIsoTimestamp(value.transportAcceptedAt) &&
      value.transportAcceptedAt === value.updatedAt;
  }
  return value.status === "revoked" &&
    hasExactKeys(value, [
      "schemaVersion", "deliveryId", "sequence", "type", "taskId", "requestId",
      "status", "attemptCount", "leaseGeneration", "createdAt", "updatedAt", "revokedReason"
    ]) &&
    (value.revokedReason === "request-terminal" ||
      value.revokedReason === "request-superseded" ||
      value.revokedReason === "task-archived");
}

function assertDelivery(value: OperatorDelivery): void {
  if (!isOperatorDelivery(value, value.deliveryId)) {
    throw new Error("Invalid operator delivery record.");
  }
}

function assertLeaseOwner(
  delivery: OperatorDelivery,
  lease: OperatorDeliveryLeaseReference
): void {
  if (
    delivery.status !== "leased" ||
    delivery.leaseOwnerId !== lease.ownerId ||
    delivery.leaseId !== lease.leaseId ||
    delivery.leaseGeneration !== lease.leaseGeneration
  ) {
    throw new OperatorDeliveryLeaseError(`Operator delivery ${delivery.deliveryId} lease is fenced.`);
  }
}

function assertLeaseActive(delivery: OperatorDelivery, now: Date): void {
  if (Date.parse(delivery.leaseExpiresAt ?? "") <= now.getTime()) {
    throw new OperatorDeliveryLeaseError(`Operator delivery ${delivery.deliveryId} lease has expired.`);
  }
}

function requirePointer(value: unknown, label: string): string {
  if (!isPointer(value)) {
    throw new Error(`Invalid operator ${label}.`);
  }
  return value;
}

function assertPointer(value: unknown, label: string): asserts value is string {
  requirePointer(value, label);
}

function isPointer(value: unknown): value is string {
  return typeof value === "string" && POINTER_PATTERN.test(value);
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (!isPositiveInteger(value)) {
    throw new Error(`Invalid operator ${label}.`);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isoTimestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.toISOString();
}

function requireFutureTimestamp(value: unknown, now: Date): string {
  if (!isIsoTimestamp(value) || Date.parse(value) <= now.getTime()) {
    throw new Error("Operator delivery lease expiry must be after now.");
  }
  return value;
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

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}
