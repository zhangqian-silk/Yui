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

export const MAX_RUNTIME_TURN_SUMMARY_BYTES = 32 * 1024;
export const MAX_RUNTIME_EVENT_FILE_BYTES = 256 * 1024;

const RUNTIME_EVENT_DIRECTORY = join("runtime", "inbox");
const INVALID_RUNTIME_EVENT_DIRECTORY = join("runtime", "inbox-invalid");
const EVENT_ID_PATTERN = /^turn-[a-f0-9]{64}$/;

export type RuntimeTurnCompletedInput = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: "codex";
  nativeSessionId: string;
  turnId: string;
  runId?: string;
  summary: string;
}>;

export type RuntimeTurnCompletedEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "native-turn-completed";
  receivedAt: string;
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  adapterId: "codex";
  nativeSessionId: string;
  turnId: string;
  runId?: string;
  summary: string;
}>;

export type RuntimeEventEnqueueResult = Readonly<{
  event: RuntimeTurnCompletedEvent;
  created: boolean;
}>;

/**
 * Durable ingress for facts emitted by native Agent hooks.
 *
 * This inbox is intentionally independent from FileTaskStore and its lock.
 * Event files are immutable; consumers acknowledge them only after applying
 * the event to the authoritative aggregate.
 */
export class FileRuntimeEventInbox {
  private readonly directory: string;

  constructor(
    readonly home: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.directory = join(home, RUNTIME_EVENT_DIRECTORY);
  }

  enqueueTurnCompleted(input: RuntimeTurnCompletedInput): RuntimeEventEnqueueResult {
    const normalized = normalizeInput(input);
    const event = Object.freeze({
      schemaVersion: 1,
      id: runtimeTurnEventId(normalized),
      type: "native-turn-completed",
      receivedAt: this.now().toISOString(),
      ...normalized
    } satisfies RuntimeTurnCompletedEvent);
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
        // A hard link publishes the fully-written inode atomically and, unlike
        // rename, can never replace an event already published by a retry.
        linkSync(temporary, target);
        unlinkSync(temporary);
        fsyncDirectory(this.directory);
        return { event, created: true };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const existing = this.read(event.id);
        // A consumer may acknowledge the existing file between link(EEXIST)
        // and this read. That is safe: acknowledgement means it was applied.
        if (existing === null) return { event, created: false };
        if (!hasSameIdentity(existing, event)) {
          throw new RuntimeEventInboxError(
            "RUNTIME_EVENT_CONFLICT",
            `Runtime event id conflicts with an existing file: ${event.id}`
          );
        }
        return { event: existing, created: false };
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }

  list(): RuntimeTurnCompletedEvent[] {
    if (!existsSync(this.directory)) return [];
    const events: RuntimeTurnCompletedEvent[] = [];
    for (const name of readdirSync(this.directory).filter((entry) => entry.endsWith(".json"))) {
      try {
        const id = name.slice(0, -".json".length);
        assertEventId(id);
        const event = this.read(id);
        if (event !== null) events.push(event);
      } catch {
        this.quarantine(name);
      }
    }
    return events.sort((left, right) => (
        left.receivedAt.localeCompare(right.receivedAt)
        || left.id.localeCompare(right.id)
    ));
  }

  read(id: string): RuntimeTurnCompletedEvent | null {
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
      throw new RuntimeEventInboxError(
        "RUNTIME_EVENT_INVALID",
        `Runtime event file is invalid: ${id}`
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new RuntimeEventInboxError(
        "RUNTIME_EVENT_INVALID",
        `Runtime event JSON is invalid: ${id}`
      );
    }
    const event = parseRuntimeEvent(value);
    if (event.id !== id || runtimeTurnEventId(event) !== id) {
      throw new RuntimeEventInboxError(
        "RUNTIME_EVENT_INVALID",
        `Runtime event identity is invalid: ${id}`
      );
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

  private eventPath(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private quarantine(name: string): void {
    const invalidDirectory = join(this.home, INVALID_RUNTIME_EVENT_DIRECTORY);
    ensureInboxDirectory(invalidDirectory);
    const source = join(this.directory, name);
    const target = join(invalidDirectory, `${name}.${randomUUID()}`);
    try {
      renameSync(source, target);
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

function runtimeTurnEventId(input: RuntimeTurnCompletedInput): string {
  const identity = JSON.stringify([
    1,
    "native-turn-completed",
    input.scope,
    input.taskId ?? null,
    input.roleName,
    input.agentId,
    input.adapterId,
    input.nativeSessionId,
    input.turnId,
    input.runId ?? null
  ]);
  return `turn-${createHash("sha256").update(identity).digest("hex")}`;
}

function normalizeInput(input: RuntimeTurnCompletedInput): RuntimeTurnCompletedInput {
  const scope = input.scope;
  if (scope !== "task" && scope !== "global") {
    throw new RuntimeEventInboxError("RUNTIME_EVENT_INVALID", "Runtime event scope is invalid.");
  }
  if (typeof input.summary !== "string" || input.summary.includes("\0")) {
    throw new RuntimeEventInboxError("RUNTIME_EVENT_INVALID", "Runtime event summary is invalid.");
  }
  const common = {
    scope,
    roleName: requireText(input.roleName, "Role name"),
    agentId: requireText(input.agentId, "Agent id"),
    adapterId: input.adapterId,
    nativeSessionId: requireText(input.nativeSessionId, "Native session id"),
    turnId: requireText(input.turnId, "Turn id"),
    ...(input.runId === undefined ? {} : { runId: requireText(input.runId, "Run id") }),
    summary: truncateUtf8(input.summary.trim(), MAX_RUNTIME_TURN_SUMMARY_BYTES)
  } as const;
  if (common.adapterId !== "codex" || common.summary.length === 0) {
    throw new RuntimeEventInboxError("RUNTIME_EVENT_INVALID", "Runtime event is invalid.");
  }
  return scope === "task"
    ? { ...common, taskId: requireText(input.taskId, "Task id") }
    : common;
}

function parseRuntimeEvent(value: unknown): RuntimeTurnCompletedEvent {
  if (!isObject(value)) throw invalidEvent();
  const scope = value.scope;
  const expected = scope === "task"
    ? [
        "schemaVersion", "id", "type", "receivedAt", "scope", "taskId",
        "roleName", "agentId", "adapterId", "nativeSessionId", "turnId", "summary",
        ...(value.runId === undefined ? [] : ["runId"])
      ]
    : [
        "schemaVersion", "id", "type", "receivedAt", "scope",
        "roleName", "agentId", "adapterId", "nativeSessionId", "turnId", "summary",
        ...(value.runId === undefined ? [] : ["runId"])
      ];
  if (
    (scope !== "task" && scope !== "global")
    || value.schemaVersion !== 1
    || value.type !== "native-turn-completed"
    || !hasExactKeys(value, expected)
  ) {
    throw invalidEvent();
  }
  const receivedAt = requireText(value.receivedAt, "Received at");
  if (Number.isNaN(Date.parse(receivedAt))) throw invalidEvent();
  const normalized = normalizeInput({
    scope,
    ...(scope === "task" ? { taskId: value.taskId } : {}),
    roleName: value.roleName,
    agentId: value.agentId,
    adapterId: value.adapterId,
    nativeSessionId: value.nativeSessionId,
    turnId: value.turnId,
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    summary: value.summary
  } as RuntimeTurnCompletedInput);
  return Object.freeze({
    schemaVersion: 1,
    id: requireText(value.id, "Event id"),
    type: "native-turn-completed",
    receivedAt,
    ...normalized
  });
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw invalidEvent();
  const text = value.trim();
  if (text.length === 0 || text.length > 1_024) {
    throw new RuntimeEventInboxError("RUNTIME_EVENT_INVALID", `${label} is invalid.`);
  }
  return text;
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
  if (!EVENT_ID_PATTERN.test(id)) {
    throw new RuntimeEventInboxError("RUNTIME_EVENT_INVALID", "Runtime event id is invalid.");
  }
}

function hasSameIdentity(
  left: RuntimeTurnCompletedEvent,
  right: RuntimeTurnCompletedEvent
): boolean {
  return left.id === right.id
    && left.scope === right.scope
    && left.taskId === right.taskId
    && left.roleName === right.roleName
    && left.agentId === right.agentId
    && left.adapterId === right.adapterId
    && left.nativeSessionId === right.nativeSessionId
    && left.turnId === right.turnId
    && left.runId === right.runId;
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

function invalidEvent(): RuntimeEventInboxError {
  return new RuntimeEventInboxError("RUNTIME_EVENT_INVALID", "Runtime event is invalid.");
}
