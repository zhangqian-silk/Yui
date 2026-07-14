export type OfflineResolutionClock = {
  schemaVersion: 1;
  taskId: string;
  requestId: string;
  offlineSince: string;
  updatedAt: string;
};

const POINTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * This is a controller-observed offline interval, not a request deadline.
 * It exists only while an open offline-recommended request remains eligible.
 */
export function createOfflineResolutionClock(
  taskId: string,
  requestId: string,
  now: Date
): OfflineResolutionClock {
  assertPointer(taskId, "task id");
  assertPointer(requestId, "input request id");
  const timestamp = isoTimestamp(now);
  return {
    schemaVersion: 1,
    taskId,
    requestId,
    offlineSince: timestamp,
    updatedAt: timestamp
  };
}

export function isOfflineResolutionClock(
  value: unknown,
  expectedTaskId?: string,
  expectedRequestId?: string
): value is OfflineResolutionClock {
  if (!isPlainRecord(value) || Object.keys(value).length !== 5) {
    return false;
  }
  return value.schemaVersion === 1 &&
    isPointer(value.taskId) &&
    isPointer(value.requestId) &&
    (expectedTaskId === undefined || value.taskId === expectedTaskId) &&
    (expectedRequestId === undefined || value.requestId === expectedRequestId) &&
    isIsoTimestamp(value.offlineSince) &&
    isIsoTimestamp(value.updatedAt) &&
    value.updatedAt >= value.offlineSince;
}

function assertPointer(value: unknown, label: string): asserts value is string {
  if (!isPointer(value)) {
    throw new Error(`Invalid offline resolution clock ${label}.`);
  }
}

function isPointer(value: unknown): value is string {
  return typeof value === "string" && POINTER_PATTERN.test(value);
}

function isoTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid offline resolution clock timestamp.");
  }
  return value.toISOString();
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
