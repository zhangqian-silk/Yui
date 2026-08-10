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

export const MAX_RUNTIME_TURN_SUMMARY_BYTES = 32 * 1024;
export const MAX_CLAUDE_HOOK_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_RUNTIME_EVENT_FILE_BYTES = 16 * 1024 * 1024;

const RUNTIME_EVENT_DIRECTORY = join("runtime", "inbox");
const INVALID_RUNTIME_EVENT_DIRECTORY = join("runtime", "inbox-invalid");
const EVENT_ID_PATTERN = /^turn-[a-f0-9]{64}$/;

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

type ClaudeEventEnvelope = Readonly<{
  scope: "task";
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "claude";
  launchId: string;
  nativeSessionId: string;
  runId: string;
}>;

export type RuntimeClaudeStopFailureInput = ClaudeEventEnvelope & Readonly<{
  error: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
}>;

export type RuntimeClaudeStopFailureEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "claude-stop-failure";
  receivedAt: string;
}> & RuntimeClaudeStopFailureInput;

/**
 * A provider session-lifecycle fact (Claude or Codex SessionStart).
 * `sessionSource` carries the exact provider-native discriminator (Claude's
 * SessionStart `source`) so the adapter mapping can decide whether it proves
 * pre-input readiness. Provider-neutral: the ingress captures the fact and exact
 * fences; the canonical mapping owns its meaning.
 */
export type RuntimeSessionLifecycleInput = Readonly<{
  scope: "task";
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "codex" | "claude";
  launchId: string;
  nativeSessionId: string;
  runId?: string;
  sessionSource?: string;
}>;

export type RuntimeSessionLifecycleEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "native-session-lifecycle";
  receivedAt: string;
}> & RuntimeSessionLifecycleInput;

/**
 * A provider prompt-acceptance fact (Claude or Codex UserPromptSubmit). This is
 * the only native signal that may advance a Run to
 * accepted/delivered, and only under an exact identity-matched fold.
 */
export type RuntimePromptAcceptedInput = Readonly<{
  scope: "task";
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "codex" | "claude";
  launchId: string;
  nativeSessionId: string;
  runId: string;
  receiptId: string;
}>;

export type RuntimePromptAcceptedEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "native-prompt-accepted";
  receivedAt: string;
}> & RuntimePromptAcceptedInput;

/** A provider-native progress fact emitted during an accepted turn. */
export type RuntimeProviderProgressInput = Readonly<{
  scope: "task";
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "codex" | "claude";
  launchId: string;
  nativeSessionId: string;
  runId: string;
  /** Provider-native event identity (for example Claude tool_use_id). */
  progressId: string;
  sequence?: number;
}>;

export type RuntimeProviderProgressEvent = Readonly<{
  schemaVersion: 1;
  id: string;
  type: "native-turn-progress";
  receivedAt: string;
}> & RuntimeProviderProgressInput;

export type RuntimeLifecycleEvent =
  | RuntimeTurnCompletedEvent
  | RuntimeClaudeStopFailureEvent
  | RuntimeSessionLifecycleEvent
  | RuntimePromptAcceptedEvent
  | RuntimeProviderProgressEvent;

export type RuntimeEventEnqueueResult<TEvent extends RuntimeLifecycleEvent = RuntimeLifecycleEvent> =
  Readonly<{ event: TEvent; created: boolean }>;

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

  enqueueClaudeStopFailure(
    input: RuntimeClaudeStopFailureInput
  ): RuntimeEventEnqueueResult<RuntimeClaudeStopFailureEvent> {
    const normalized = normalizeClaudeStopFailureInput(input);
    return this.publish(Object.freeze({
      schemaVersion: 1,
      id: runtimeEventId("claude-stop-failure", normalized),
      type: "claude-stop-failure",
      receivedAt: this.now().toISOString(),
      ...normalized
    }));
  }

  enqueueSessionLifecycle(
    input: RuntimeSessionLifecycleInput
  ): RuntimeEventEnqueueResult<RuntimeSessionLifecycleEvent> {
    const normalized = normalizeSessionLifecycleInput(input);
    return this.publish(Object.freeze({
      schemaVersion: 1,
      id: runtimeEventId("native-session-lifecycle", normalized),
      type: "native-session-lifecycle",
      receivedAt: this.now().toISOString(),
      ...normalized
    }));
  }

  enqueuePromptAccepted(
    input: RuntimePromptAcceptedInput
  ): RuntimeEventEnqueueResult<RuntimePromptAcceptedEvent> {
    const normalized = normalizePromptAcceptedInput(input);
    return this.publish(Object.freeze({
      schemaVersion: 1,
      id: runtimeEventId("native-prompt-accepted", normalized),
      type: "native-prompt-accepted",
      receivedAt: this.now().toISOString(),
      ...normalized
    }));
  }

  enqueueProviderProgress(
    input: RuntimeProviderProgressInput
  ): RuntimeEventEnqueueResult<RuntimeProviderProgressEvent> {
    const normalized = normalizeProviderProgressInput(input);
    return this.publish(Object.freeze({
      schemaVersion: 1,
      id: runtimeEventId("native-turn-progress", normalized),
      type: "native-turn-progress",
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
    return events.sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || left.id.localeCompare(right.id)
    ));
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
    });
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

function runtimeEventId(
  type: RuntimeLifecycleEvent["type"],
  input: RuntimeTurnCompletedInput
    | RuntimeClaudeStopFailureInput
    | RuntimeSessionLifecycleInput
    | RuntimePromptAcceptedInput
    | RuntimeProviderProgressInput
): string {
  const common = [
    1,
    type,
    input.scope,
    input.taskId ?? null,
    input.roleName,
    input.agentId,
    input.adapterId,
    input.launchId ?? null,
    input.nativeSessionId,
    "turnId" in input ? input.turnId : null,
    input.runId ?? null,
    "progressId" in input ? input.progressId : null,
    "sequence" in input ? input.sequence ?? null : null,
    "sessionSource" in input ? input.sessionSource ?? null : null,
    "receiptId" in input ? input.receiptId ?? null : null
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

function normalizeClaudeEnvelope(input: ClaudeEventEnvelope): ClaudeEventEnvelope {
  if (input.scope !== "task" || input.adapterId !== "claude") throw invalidEvent();
  return {
    scope: "task",
    taskId: requireIdentityText(input.taskId, "Task id"),
    roleName: requireIdentityText(input.roleName, "Role name"),
    agentId: requireIdentityText(input.agentId, "Agent id"),
    adapterId: "claude",
    launchId: requireIdentityText(input.launchId, "Launch id"),
    nativeSessionId: requireIdentityText(input.nativeSessionId, "Native session id"),
    runId: requireIdentityText(input.runId, "Run id")
  };
}

function normalizeClaudeStopFailureInput(
  input: RuntimeClaudeStopFailureInput
): RuntimeClaudeStopFailureInput {
  return {
    ...normalizeClaudeEnvelope(input),
    error: requireLongText(input.error, "Claude failure error"),
    ...(input.errorDetails === undefined
      ? {}
      : { errorDetails: requireLongText(input.errorDetails, "Claude failure details") }),
    ...(input.lastAssistantMessage === undefined
      ? {}
      : {
          lastAssistantMessage: requireLongText(
            input.lastAssistantMessage,
            "Claude failure last assistant message"
          )
        })
  };
}

function normalizeSessionLifecycleInput(
  input: RuntimeSessionLifecycleInput
): RuntimeSessionLifecycleInput {
  if (input.scope !== "task") throw invalidEvent();
  if (input.adapterId !== "codex" && input.adapterId !== "claude") throw invalidEvent();
  return {
    scope: "task",
    taskId: requireIdentityText(input.taskId, "Task id"),
    roleName: requireIdentityText(input.roleName, "Role name"),
    agentId: requireIdentityText(input.agentId, "Agent id"),
    adapterId: input.adapterId,
    launchId: requireIdentityText(input.launchId, "Launch id"),
    nativeSessionId: requireIdentityText(input.nativeSessionId, "Native session id"),
    ...(input.runId === undefined
      ? {}
      : { runId: requireIdentityText(input.runId, "Run id") }),
    ...(input.sessionSource === undefined
      ? {}
      : { sessionSource: requireIdentityText(input.sessionSource, "Session source") })
  };
}

function normalizePromptAcceptedInput(
  input: RuntimePromptAcceptedInput
): RuntimePromptAcceptedInput {
  if (input.scope !== "task") throw invalidEvent();
  if (input.adapterId !== "codex" && input.adapterId !== "claude") throw invalidEvent();
  return {
    scope: "task",
    taskId: requireIdentityText(input.taskId, "Task id"),
    roleName: requireIdentityText(input.roleName, "Role name"),
    agentId: requireIdentityText(input.agentId, "Agent id"),
    adapterId: input.adapterId,
    launchId: requireIdentityText(input.launchId, "Launch id"),
    nativeSessionId: requireIdentityText(input.nativeSessionId, "Native session id"),
    runId: requireIdentityText(input.runId, "Run id"),
    receiptId: requireIdentityText(input.receiptId, "Receipt id")
  };
}

function normalizeProviderProgressInput(
  input: RuntimeProviderProgressInput
): RuntimeProviderProgressInput {
  if (input.scope !== "task") throw invalidEvent();
  if (input.adapterId !== "codex" && input.adapterId !== "claude") throw invalidEvent();
  if (input.sequence !== undefined && !Number.isSafeInteger(input.sequence)) {
    throw invalidEvent();
  }
  return {
    scope: "task",
    taskId: requireIdentityText(input.taskId, "Task id"),
    roleName: requireIdentityText(input.roleName, "Role name"),
    agentId: requireIdentityText(input.agentId, "Agent id"),
    adapterId: input.adapterId,
    launchId: requireIdentityText(input.launchId, "Launch id"),
    nativeSessionId: requireIdentityText(input.nativeSessionId, "Native session id"),
    runId: requireIdentityText(input.runId, "Run id"),
    progressId: requireIdentityText(input.progressId, "Provider progress id"),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence })
  };
}

function parseRuntimeEvent(value: unknown): RuntimeLifecycleEvent {
  if (!isObject(value)) throw invalidEvent();
  switch (value.type) {
    case "native-turn-completed": return parseCodexEvent(value);
    case "claude-stop-failure": return parseClaudeStopFailureEvent(value);
    case "native-session-lifecycle": return parseSessionLifecycleEvent(value);
    case "native-prompt-accepted": return parsePromptAcceptedEvent(value);
    case "native-turn-progress": return parseProviderProgressEvent(value);
    default: throw invalidEvent();
  }
}

function parseSessionLifecycleEvent(
  value: Record<string, any>
): RuntimeSessionLifecycleEvent {
  const expected = [
    "schemaVersion", "id", "type", "receivedAt", "scope", "taskId", "roleName",
    "agentId", "adapterId", "launchId", "nativeSessionId",
    ...(value.runId === undefined ? [] : ["runId"]),
    ...(value.sessionSource === undefined ? [] : ["sessionSource"])
  ];
  if (value.schemaVersion !== 1 || !hasExactKeys(value, expected)) throw invalidEvent();
  const normalized = normalizeSessionLifecycleInput(value as RuntimeSessionLifecycleInput);
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "native-session-lifecycle",
    receivedAt: requireTimestamp(value.receivedAt),
    ...normalized
  });
}

function parsePromptAcceptedEvent(
  value: Record<string, any>
): RuntimePromptAcceptedEvent {
  const expected = [
    "schemaVersion", "id", "type", "receivedAt", "scope", "taskId", "roleName",
    "agentId", "adapterId", "launchId", "nativeSessionId", "runId", "receiptId"
  ];
  if (value.schemaVersion !== 1 || !hasExactKeys(value, expected)) throw invalidEvent();
  const normalized = normalizePromptAcceptedInput(value as RuntimePromptAcceptedInput);
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "native-prompt-accepted",
    receivedAt: requireTimestamp(value.receivedAt),
    ...normalized
  });
}

function parseProviderProgressEvent(
  value: Record<string, any>
): RuntimeProviderProgressEvent {
  const expected = [
    "schemaVersion", "id", "type", "receivedAt", "scope", "taskId", "roleName",
    "agentId", "adapterId", "launchId", "nativeSessionId", "runId", "progressId",
    ...(value.sequence === undefined ? [] : ["sequence"])
  ];
  if (value.schemaVersion !== 1 || !hasExactKeys(value, expected)) throw invalidEvent();
  const normalized = normalizeProviderProgressInput(value as RuntimeProviderProgressInput);
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "native-turn-progress",
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

function parseClaudeStopFailureEvent(
  value: Record<string, any>
): RuntimeClaudeStopFailureEvent {
  const expected = [
    "schemaVersion", "id", "type", "receivedAt", "scope", "taskId", "roleName",
    "agentId", "adapterId", "launchId", "nativeSessionId", "runId", "error",
    ...(value.errorDetails === undefined ? [] : ["errorDetails"]),
    ...(value.lastAssistantMessage === undefined ? [] : ["lastAssistantMessage"])
  ];
  if (value.schemaVersion !== 1 || !hasExactKeys(value, expected)) throw invalidEvent();
  const normalized = normalizeClaudeStopFailureInput(value as RuntimeClaudeStopFailureInput);
  return Object.freeze({
    schemaVersion: 1,
    id: requireIdentityText(value.id, "Event id"),
    type: "claude-stop-failure",
    receivedAt: requireTimestamp(value.receivedAt),
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

function requireLongText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.trim().length === 0) {
    throw invalidEvent(`${label} is required.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CLAUDE_HOOK_TEXT_BYTES) {
    throw new RuntimeEventInboxError(
      "RUNTIME_EVENT_TOO_LARGE",
      `${label} exceeds the durable inbox limit.`
    );
  }
  return value;
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
    && left.roleName === right.roleName
    && left.agentId === right.agentId
    && left.adapterId === right.adapterId
    && left.launchId === right.launchId
    && left.nativeSessionId === right.nativeSessionId
    && left.runId === right.runId
    && (!("turnId" in left) || !("turnId" in right) || left.turnId === right.turnId)
    && (!("progressId" in left)
      || !("progressId" in right)
      || left.progressId === right.progressId)
    && (!("sequence" in left) || !("sequence" in right) || left.sequence === right.sequence);
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
