import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { withUpgradeCoordinationLock } from "../storage/upgradeCoordination.js";
import {
  createRuntimeObservation,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";

export const MAX_RUNTIME_TURN_SUMMARY_BYTES = 32 * 1024;
export const MAX_RUNTIME_EVENT_FILE_BYTES = 16 * 1024 * 1024;

const RUNTIME_EVENT_DIRECTORY = join("runtime", "inbox");
const INVALID_RUNTIME_EVENT_DIRECTORY = join("runtime", "inbox-invalid");
const EVENT_ID_PATTERN = /^turn-[a-f0-9]{64}$/;

export type RuntimeObservationInboxEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "runtime-observation";
  receivedAt: string;
  scope: "task" | "global";
  taskId?: string;
  observation: RuntimeObservation;
}>;

export type RuntimeTurnCompletedInput = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: "codex";
  launchId?: string;
  nativeSessionId: string;
  turnId: string;
  runId?: string;
  title?: string;
  summary: string;
}>;

export type RuntimeTurnCompletedEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "native-turn-completed";
  receivedAt: string;
}> & RuntimeTurnCompletedInput;

/**
 * f7/rr5: A DurableJob reached a terminal state. The supervisor delivers
 * this to the runtime inbox so the Controller wakes immediately instead of
 * waiting for the next poll. The state change already committed; this event
 * is the durable terminal channel (dual-channel with the Leader wakeup).
 */
export type RuntimeDurableJobTerminalInput = Readonly<{
  scope: "task";
  taskId: string;
  jobId: string;
  status: "succeeded" | "failed" | "timed-out" | "cancelled" | "unknown-needs-attention";
  outcome: string;
}>;

export type RuntimeDurableJobTerminalEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "durable-job-terminal";
  receivedAt: string;
}> & RuntimeDurableJobTerminalInput;

export type RuntimeLifecycleEvent =
  | RuntimeObservationInboxEvent
  | RuntimeTurnCompletedEvent
  | RuntimeDurableJobTerminalEvent;

export type RuntimeEventEnqueueResult<TEvent extends RuntimeLifecycleEvent = RuntimeLifecycleEvent> =
  Readonly<{
    event: TEvent;
    created: boolean;
  }>;

/** Test-only synchronization seam; production callers leave it unset. */
export type RuntimeEventInboxHooks = Readonly<{
  /** Called after admission is checked while the coordination lock is held. */
  afterAdmission?: () => void;
}>;

/**
 * Durable ingress for facts emitted by native Agent hooks. It deliberately
 * owns no FileTaskStore lock: immutable files are acknowledged only after the
 * Controller commits their authoritative aggregate effect.
 */
export class FileRuntimeEventInbox {
  private readonly directory: string;

  constructor(
    readonly home: string,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: RuntimeEventInboxHooks = {}
  ) {
    this.directory = join(home, RUNTIME_EVENT_DIRECTORY);
  }

  enqueueObservation(
    input: RuntimeObservation
  ): RuntimeEventEnqueueResult<RuntimeObservationInboxEvent> {
    const observation = createRuntimeObservation(input);
    const scope = observation.fence.taskId === undefined ? "global" : "task";
    const event = Object.freeze({
      schemaVersion: 1 as const,
      id: runtimeEventId("runtime-observation", { observation }),
      type: "runtime-observation" as const,
      receivedAt: observation.receivedAt,
      scope,
      ...(observation.fence.taskId === undefined
        ? {}
        : { taskId: observation.fence.taskId }),
      observation
    });
    return this.publish(event);
  }

  enqueueTurnCompleted(
    input: RuntimeTurnCompletedInput
  ): RuntimeEventEnqueueResult<RuntimeTurnCompletedEvent> {
    const normalized = normalizeCodexInput(input);
    return this.publish(Object.freeze({
      schemaVersion: 1,
      id: runtimeEventId("native-turn-completed", normalized),
      type: "native-turn-completed",
      receivedAt: this.now().toISOString(),
      ...normalized
    }));
  }

  enqueueDurableJobTerminal(
    input: RuntimeDurableJobTerminalInput
  ): RuntimeEventEnqueueResult<RuntimeDurableJobTerminalEvent> {
    const normalized = normalizeDurableJobTerminalInput(input);
    return this.publish(Object.freeze({
      schemaVersion: 1,
      id: runtimeEventId("durable-job-terminal", normalized),
      type: "durable-job-terminal",
      receivedAt: this.now().toISOString(),
      ...normalized
    }));
  }

  list(): RuntimeLifecycleEvent[] {
    if (!existsSync(this.directory)) return [];
    const events: RuntimeLifecycleEvent[] = [];
    for (const name of readdirSync(this.directory).filter((entry) => entry.endsWith(".json"))) {
      try {
        const id = name.slice(0, -".json".length);
        assertEventId(id);
        const event = this.read(id);
        if (event !== null) events.push(event);
      } catch (error) {
        if (!(error instanceof RuntimeEventInboxError)
          || error.code !== "RUNTIME_EVENT_INVALID") {
          throw error;
        }
        try {
          this.quarantine(name);
        } catch {
          // One unreadable entry must not block independent durable events.
        }
      }
    }
    return events.sort(compareRuntimeEvents);
  }

  read(id: string): RuntimeLifecycleEvent | null {
    assertEventId(id);
    const path = this.eventPath(id);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    if (
      !metadata.isFile()
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size > MAX_RUNTIME_EVENT_FILE_BYTES
    ) {
      throw invalidEvent(`Runtime event file is invalid: ${id}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw invalidEvent(`Runtime event JSON is invalid: ${id}`);
    }
    const event = parseRuntimeEvent(value);
    if (event.id !== id || runtimeEventId(event.type, event) !== id) {
      throw invalidEvent(`Runtime event identity is invalid: ${id}`);
    }
    return event;
  }

  acknowledge(id: string): boolean {
    assertEventId(id);
    try {
      unlinkSync(this.eventPath(id));
      fsyncDirectory(this.directory);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  acknowledgeMany(ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    const acknowledged: string[] = [];
    try {
      for (const id of ids) {
        assertEventId(id);
        try {
          unlinkSync(this.eventPath(id));
          acknowledged.push(id);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }
    } finally {
      // Preserve the old per-event durability guarantee even when a later
      // unlink in the batch fails after earlier entries were removed.
      if (acknowledged.length > 0) fsyncDirectory(this.directory);
    }
    return acknowledged;
  }

  private publish<TEvent extends RuntimeLifecycleEvent>(
    event: TEvent
  ): RuntimeEventEnqueueResult<TEvent> {
    // The fence check and the complete durable write share one sibling
    // coordination lock with upgrade's final inbox scan/copy/two-step switch.
    // A hook that passed admission before the fence was placed either finishes
    // under this lock (so its event is copied) or waits and receives an
    // UpgradeFenceError after the cutover holder releases the lock.
    return withUpgradeCoordinationLock(this.home, () => {
      this.hooks.afterAdmission?.();
      if (event.type === "runtime-observation"
        && event.observation.kind === "activity.observed"
        && event.observation.payload.usage !== undefined) {
        const existing = this.list().find((candidate) => (
          candidate.type === "runtime-observation"
          && candidate.taskId === event.taskId
          && candidate.observation.eventId === event.observation.eventId
        ));
        if (existing !== undefined) {
          return { event: existing as TEvent, created: false };
        }
      }
      return this.publishUnlocked(event);
    });
  }

  private publishUnlocked<TEvent extends RuntimeLifecycleEvent>(
    event: TEvent
  ): RuntimeEventEnqueueResult<TEvent> {
    const content = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_RUNTIME_EVENT_FILE_BYTES) {
      throw new RuntimeEventInboxError(
        "RUNTIME_EVENT_TOO_LARGE",
        "Runtime event exceeds the durable inbox limit."
      );
    }
    ensureInboxDirectory(this.directory);
    const target = this.eventPath(event.id);
    const temporary = join(
      this.directory,
      `.${event.id}.tmp-${process.pid}-${randomUUID()}`
    );
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
      writeFileSync(descriptor, content, "utf8");
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      try {
        linkSync(temporary, target);
        unlinkSync(temporary);
        fsyncDirectory(this.directory);
        return { event, created: true };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = this.read(event.id);
        if (existing === null) return { event, created: false };
        if (!hasSameIdentity(existing, event)) {
          throw new RuntimeEventInboxError(
            "RUNTIME_EVENT_CONFLICT",
            `Runtime event id conflicts with an existing file: ${event.id}`
          );
        }
        return { event: existing as TEvent, created: false };
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }

  private eventPath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private quarantine(name: string): void {
    const invalidDirectory = join(this.home, INVALID_RUNTIME_EVENT_DIRECTORY);
    ensureInboxDirectory(invalidDirectory);
    const source = join(this.directory, name);
    // One semantic ingress identity owns one quarantine slot. Repeated poison
    // entries replace neither the first diagnostic nor create an event storm.
    const target = join(invalidDirectory, name);
    try {
      try {
        linkSync(source, target);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      unlinkSync(source);
      fsyncDirectory(this.directory);
      fsyncDirectory(invalidDirectory);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

export class RuntimeEventInboxError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_EVENT_CONFLICT"
      | "RUNTIME_EVENT_INVALID"
      | "RUNTIME_EVENT_MISSING"
      | "RUNTIME_EVENT_TOO_LARGE",
    message: string
  ) {
    super(message);
    this.name = "RuntimeEventInboxError";
  }
}

function runtimeEventId(
  type: RuntimeLifecycleEvent["type"],
  input: RuntimeTurnCompletedInput
    | RuntimeDurableJobTerminalInput
    | Readonly<{ observation: RuntimeObservation }>
): string {
  if (type === "runtime-observation") {
    const observation = (input as Readonly<{ observation: RuntimeObservation }>).observation;
    return `turn-${createHash("sha256").update(JSON.stringify([
      2,
      type,
      observation.fence.taskId ?? null,
      observation.fence.roleName,
      observation.semanticKey
    ])).digest("hex")}`;
  }
  if (type === "durable-job-terminal") {
    const job = input as RuntimeDurableJobTerminalInput;
    return `turn-${createHash("sha256").update(JSON.stringify([
      1,
      type,
      job.scope,
      job.taskId,
      job.jobId,
      job.status,
      job.outcome
    ])).digest("hex")}`;
  }
  const provider = input as RuntimeTurnCompletedInput;
  const common = [
    1,
    type,
    provider.scope,
    provider.taskId ?? null,
    provider.roleName,
    provider.agentId,
    provider.adapterId,
    provider.launchId ?? null,
    provider.nativeSessionId,
    "turnId" in provider ? provider.turnId : null,
    provider.runId ?? null
  ];
  return `turn-${createHash("sha256").update(JSON.stringify(common)).digest("hex")}`;
}

function normalizeCodexInput(input: RuntimeTurnCompletedInput): RuntimeTurnCompletedInput {
  const scope = input.scope;
  if (scope !== "task" && scope !== "global") throw invalidEvent();
  if (typeof input.summary !== "string" || input.summary.includes("\0")) throw invalidEvent();
  const common = {
    scope,
    roleName: requireIdentityText(input.roleName, "Role name"),
    agentId: requireIdentityText(input.agentId, "Agent id"),
    adapterId: input.adapterId,
    ...(input.launchId === undefined
      ? {}
      : { launchId: requireIdentityText(input.launchId, "Launch id") }),
    nativeSessionId: requireIdentityText(input.nativeSessionId, "Native session id"),
    turnId: requireIdentityText(input.turnId, "Turn id"),
    ...(input.runId === undefined
      ? {}
      : { runId: requireIdentityText(input.runId, "Run id") }),
    ...(input.title === undefined
      ? {}
      : { title: requireIdentityText(input.title, "Session title") }),
    summary: truncateUtf8(input.summary.trim(), MAX_RUNTIME_TURN_SUMMARY_BYTES)
  } as const;
  if (common.adapterId !== "codex" || common.summary.length === 0) throw invalidEvent();
  return scope === "task"
    ? { ...common, taskId: requireIdentityText(input.taskId, "Task id") }
    : common;
}

function normalizeDurableJobTerminalInput(
  input: RuntimeDurableJobTerminalInput
): RuntimeDurableJobTerminalInput {
  if (input.scope !== "task") throw invalidEvent();
  const terminalStatuses = [
    "succeeded", "failed", "timed-out", "cancelled", "unknown-needs-attention"
  ] as const;
  if (!terminalStatuses.includes(input.status as typeof terminalStatuses[number])) {
    throw invalidEvent();
  }
  return {
    scope: "task",
    taskId: requireIdentityText(input.taskId, "Task id"),
    jobId: requireIdentityText(input.jobId, "Job id"),
    status: input.status,
    outcome: requireIdentityText(input.outcome, "Job outcome")
  };
}

function parseRuntimeEvent(value: unknown): RuntimeLifecycleEvent {
  if (!isObject(value)) throw invalidEvent();
  switch (value.type) {
    case "runtime-observation": return parseRuntimeObservationEvent(value);
    case "native-turn-completed": return parseCodexEvent(value);
    case "durable-job-terminal": return parseDurableJobTerminalEvent(value);
    default: throw invalidEvent();
  }
}

function parseRuntimeObservationEvent(
  value: Record<string, any>
): RuntimeObservationInboxEvent {
  const expected = [
    "schemaVersion", "id", "type", "receivedAt", "scope", "observation",
    ...(value.taskId === undefined ? [] : ["taskId"])
  ];
  if (value.schemaVersion !== 1 || !hasExactKeys(value, expected)) throw invalidEvent();
  const observation = createRuntimeObservation(value.observation as RuntimeObservation);
  const scope = observation.fence.taskId === undefined ? "global" : "task";
  if (value.scope !== scope
    || (scope === "task" && value.taskId !== observation.fence.taskId)
    || value.receivedAt !== observation.receivedAt) {
    throw invalidEvent("Runtime observation envelope does not match its canonical fence.");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "runtime-observation",
    receivedAt: observation.receivedAt,
    scope,
    ...(scope === "task" ? { taskId: observation.fence.taskId! } : {}),
    observation
  });
}

function parseDurableJobTerminalEvent(
  value: Record<string, any>
): RuntimeDurableJobTerminalEvent {
  const expected = [
    "schemaVersion", "id", "type", "receivedAt", "scope", "taskId",
    "jobId", "status", "outcome"
  ];
  if (value.schemaVersion !== 1 || !hasExactKeys(value, expected)) throw invalidEvent();
  const normalized = normalizeDurableJobTerminalInput(
    value as RuntimeDurableJobTerminalInput
  );
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "durable-job-terminal",
    receivedAt: requireTimestamp(value.receivedAt),
    ...normalized
  });
}

function parseCodexEvent(value: Record<string, any>): RuntimeTurnCompletedEvent {
  const scope = value.scope;
  const expected = scope === "task"
    ? [
        "schemaVersion", "id", "type", "receivedAt", "scope", "taskId",
        "roleName", "agentId", "adapterId", "nativeSessionId", "turnId", "summary",
        ...(value.launchId === undefined ? [] : ["launchId"]),
        ...(value.runId === undefined ? [] : ["runId"]),
        ...(value.title === undefined ? [] : ["title"])
      ]
    : [
        "schemaVersion", "id", "type", "receivedAt", "scope",
        "roleName", "agentId", "adapterId", "nativeSessionId", "turnId", "summary",
        ...(value.launchId === undefined ? [] : ["launchId"]),
        ...(value.runId === undefined ? [] : ["runId"]),
        ...(value.title === undefined ? [] : ["title"])
      ];
  if ((scope !== "task" && scope !== "global")
    || value.schemaVersion !== 1
    || !hasExactKeys(value, expected)) throw invalidEvent();
  const receivedAt = requireTimestamp(value.receivedAt);
  const normalized = normalizeCodexInput({
    scope,
    ...(scope === "task" ? { taskId: value.taskId } : {}),
    roleName: value.roleName,
    agentId: value.agentId,
    adapterId: value.adapterId,
    ...(value.launchId === undefined ? {} : { launchId: value.launchId }),
    nativeSessionId: value.nativeSessionId,
    turnId: value.turnId,
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.title === undefined ? {} : { title: value.title }),
    summary: value.summary
  });
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "native-turn-completed",
    receivedAt,
    ...normalized
  });
}

function requireIdentityText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw invalidEvent();
  const text = value.trim();
  if (text.length === 0 || text.length > 1_024) {
    throw invalidEvent(`${label} is invalid.`);
  }
  return text;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireIdentityText(value, "Received at");
  if (!Number.isFinite(Date.parse(timestamp))) throw invalidEvent();
  return timestamp;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function ensureInboxDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertEventId(id: string): void {
  if (!EVENT_ID_PATTERN.test(id)) throw invalidEvent("Runtime event id is invalid.");
}

function hasSameIdentity(left: RuntimeLifecycleEvent, right: RuntimeLifecycleEvent): boolean {
  return left.id === right.id
    && left.type === right.type
    && left.scope === right.scope
    && left.taskId === right.taskId
    && (!("roleName" in left) || !("roleName" in right) || left.roleName === right.roleName)
    && (!("agentId" in left) || !("agentId" in right) || left.agentId === right.agentId)
    && (!("adapterId" in left) || !("adapterId" in right) || left.adapterId === right.adapterId)
    && (!("launchId" in left) || !("launchId" in right) || left.launchId === right.launchId)
    && (!("nativeSessionId" in left)
      || !("nativeSessionId" in right)
      || left.nativeSessionId === right.nativeSessionId)
    && (!("runId" in left) || !("runId" in right) || left.runId === right.runId)
    && (!("turnId" in left) || !("turnId" in right) || left.turnId === right.turnId)
    && (!("jobId" in left) || !("jobId" in right) || left.jobId === right.jobId);
}

type RuntimeEventOrderKey = Pick<RuntimeLifecycleEvent, "receivedAt" | "id"> & Readonly<{
  observation?: RuntimeObservation;
}>;

function compareRuntimeEvents(
  left: RuntimeEventOrderKey,
  right: RuntimeEventOrderKey
): number {
  const receivedAt = left.receivedAt.localeCompare(right.receivedAt);
  if (receivedAt !== 0) return receivedAt;
  const sequence = (left.observation?.sequence ?? -1) - (right.observation?.sequence ?? -1);
  if (sequence !== 0) return sequence;
  const ordinal = (left.observation?.ordinal ?? -1) - (right.observation?.ordinal ?? -1);
  if (ordinal !== 0) return ordinal;
  return left.id.localeCompare(right.id);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function invalidEvent(message = "Runtime event is invalid."): RuntimeEventInboxError {
  return new RuntimeEventInboxError("RUNTIME_EVENT_INVALID", message);
}
