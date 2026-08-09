import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import { callController as defaultCallController } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import {
  inspectStorageSchema,
  type StorageSchemaState
} from "../storage/storageSchema.js";
import {
  yuiVersionIdentity,
  type YuiVersionIdentity
} from "../version.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "./lifecycleReservation.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";

export const EXACT_CONTROL_ARGUMENT = "--yui-control";
export const YUI_CONTROL_PLANE_DESCRIPTOR = "YUI_CONTROL_PLANE_DESCRIPTOR";
export const YUI_TASK_RUNTIME_DESCRIPTOR = "YUI_TASK_RUNTIME_DESCRIPTOR";

export type ExactControlPlaneDescriptor = Readonly<{
  schemaVersion: 1;
  kind: "yui-control-plane";
  executable: string;
  cliEntry: string;
  yuiHome: string;
  identity: YuiVersionIdentity;
}>;

export type ExactTaskRuntimeDescriptor = Readonly<{
  schemaVersion: 1;
  kind: "yui-task-runtime";
  controlPlaneDigest: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: AgentAdapterId;
  workspace: string;
  runId?: string;
  launchId?: string;
  nativeSessionId?: string;
}>;

export type ExactControlPlanePreflightInput = Readonly<{
  serializedDescriptor: string;
  digest: string;
  actualExecutable: string;
  actualCliEntry: string;
  actualHome: string;
}>;

export type ExactControlPlanePreflightOptions = Readonly<{
  identity?: YuiVersionIdentity;
  inspectStorage?: (home: string) => StorageSchemaState | Readonly<{
    status: string;
    currentLayoutVersion?: number;
    currentAggregateSchemaVersion?: number;
  }>;
  callController?: (
    home: string,
    method: string,
    params: JsonValue
  ) => Promise<JsonValue>;
  checkController?: boolean;
}>;

export function createExactControlPlaneDescriptor(input: Readonly<{
  executable: string;
  cliEntry: string;
  yuiHome: string;
  identity?: YuiVersionIdentity;
}>): ExactControlPlaneDescriptor {
  const identity = validateVersionIdentity(input.identity ?? yuiVersionIdentity());
  return Object.freeze({
    schemaVersion: 1,
    kind: "yui-control-plane",
    executable: canonicalPath(input.executable),
    cliEntry: canonicalPath(input.cliEntry),
    yuiHome: canonicalPath(input.yuiHome),
    identity: Object.freeze({ ...identity })
  });
}

export function createExactTaskRuntimeDescriptor(input: Readonly<{
  controlPlaneDigest: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: AgentAdapterId;
  workspace: string;
  runId?: string;
  launchId?: string;
  nativeSessionId?: string;
}>): ExactTaskRuntimeDescriptor {
  return Object.freeze({
    schemaVersion: 1,
    kind: "yui-task-runtime",
    controlPlaneDigest: requireDigest(input.controlPlaneDigest),
    taskId: requireIdentity(input.taskId, "Task id"),
    roleName: requireIdentity(input.roleName, "Role name"),
    agentId: requireIdentity(input.agentId, "Agent id"),
    adapterId: requireAdapter(input.adapterId),
    workspace: canonicalPath(input.workspace),
    ...(input.runId === undefined ? {} : { runId: requireIdentity(input.runId, "Run id") }),
    ...(input.launchId === undefined
      ? {}
      : { launchId: requireIdentity(input.launchId, "Launch id") }),
    ...(input.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireIdentity(input.nativeSessionId, "Native session id") })
  });
}

export function serializeExactDescriptor(
  descriptor: ExactControlPlaneDescriptor | ExactTaskRuntimeDescriptor
): string {
  return JSON.stringify(descriptor);
}

export function parseExactControlPlaneDescriptor(value: string): ExactControlPlaneDescriptor {
  const record = parseDescriptorRecord(value);
  assertDescriptorKind(record, "yui-control-plane");
  if (record.schemaVersion !== 1) {
    throw new Error("Exact control-plane descriptor schema version is invalid.");
  }
  return createExactControlPlaneDescriptor({
    executable: requireText(record.executable, "Control-plane executable"),
    cliEntry: requireText(record.cliEntry, "Control-plane CLI entry"),
    yuiHome: requireText(record.yuiHome, "Control-plane YUI_HOME"),
    identity: validateVersionIdentity(record.identity)
  });
}

export function parseExactTaskRuntimeDescriptor(value: string): ExactTaskRuntimeDescriptor {
  const record = parseDescriptorRecord(value);
  assertDescriptorKind(record, "yui-task-runtime");
  if (record.schemaVersion !== 1) {
    throw new Error("Exact Task runtime descriptor schema version is invalid.");
  }
  return createExactTaskRuntimeDescriptor({
    controlPlaneDigest: requireText(record.controlPlaneDigest, "Control-plane digest"),
    taskId: requireText(record.taskId, "Task id"),
    roleName: requireText(record.roleName, "Role name"),
    agentId: requireText(record.agentId, "Agent id"),
    adapterId: requireAdapter(record.adapterId),
    workspace: requireText(record.workspace, "Task runtime workspace"),
    ...(record.runId === undefined ? {} : { runId: requireText(record.runId, "Run id") }),
    ...(record.launchId === undefined
      ? {}
      : { launchId: requireText(record.launchId, "Launch id") }),
    ...(record.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireText(record.nativeSessionId, "Native session id") })
  });
}

export function exactControlPlaneDigest(descriptor: ExactControlPlaneDescriptor): string {
  return createHash("sha256").update(serializeExactDescriptor(descriptor)).digest("hex");
}

/** Stable per Task/Role/Agent location; volatile Run/launch/native fields are content. */
export function exactTaskRuntimeDescriptorPath(
  home: string,
  descriptor: ExactTaskRuntimeDescriptor
): string {
  const validated = createExactTaskRuntimeDescriptor(descriptor);
  const digest = createHash("sha256").update(JSON.stringify([
    validated.controlPlaneDigest,
    validated.taskId,
    validated.roleName,
    validated.agentId,
    validated.adapterId,
    validated.workspace
  ])).digest("hex");
  return join(
    canonicalPath(home),
    "runtime",
    "exact-task-runtime",
    `${digest}.json`
  );
}

export function readExactTaskRuntimeDescriptorSource(
  source: string,
  home: string
): ExactTaskRuntimeDescriptor {
  return readTaskRuntimeSource(source, home).descriptor;
}

export function exactControlPlaneCommandPrefix(
  descriptor: ExactControlPlaneDescriptor
): string {
  return [
    descriptor.executable,
    descriptor.cliEntry,
    EXACT_CONTROL_ARGUMENT,
    exactControlPlaneDigest(descriptor)
  ].map(shellQuote).join(" ");
}

export function extractExactControlArgument(args: readonly string[]): Readonly<{
  digest?: string;
  args: readonly string[];
  error?: string;
}> {
  const later = args.indexOf(EXACT_CONTROL_ARGUMENT);
  if (later < 0) return { args: [...args] };
  if (later !== 0) {
    return {
      args: [...args],
      error: `${EXACT_CONTROL_ARGUMENT} must be the first CLI argument.`
    };
  }
  const digest = args[1];
  if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) {
    return {
      args: args.slice(2),
      error: "Exact control-plane digest is invalid."
    };
  }
  return { digest, args: args.slice(2) };
}

/**
 * One read-only gate shared by every managed Task control command. It verifies
 * the frozen executable/CLI/Home/build identity, on-disk schema, and any live
 * Controller before command routing may construct a writable store.
 */
export async function assertExactControlPlanePreflight(
  input: ExactControlPlanePreflightInput,
  options: ExactControlPlanePreflightOptions = {}
): Promise<ExactControlPlaneDescriptor> {
  const descriptor = parseExactControlPlaneDescriptor(input.serializedDescriptor);
  if (exactControlPlaneDigest(descriptor) !== requireDigest(input.digest)) {
    throw new Error("Exact control-plane digest does not match its frozen descriptor.");
  }
  assertSamePath(
    descriptor.executable,
    input.actualExecutable,
    "Control-plane executable"
  );
  assertSamePath(descriptor.cliEntry, input.actualCliEntry, "Control-plane CLI entry");
  assertSamePath(descriptor.yuiHome, input.actualHome, "Control-plane YUI_HOME");

  const localIdentity = validateVersionIdentity(options.identity ?? yuiVersionIdentity());
  assertVersionIdentity("Local CLI", descriptor.identity, localIdentity);
  const storage = (options.inspectStorage ?? inspectStorageSchema)(descriptor.yuiHome);
  if (storage.status !== "current") {
    throw new Error(`Exact control-plane storage is not current: ${storage.status}.`);
  }
  if (storage.currentLayoutVersion !== descriptor.identity.storageLayoutVersion) {
    throw new Error(
      "Exact control-plane storage layout does not match its frozen descriptor "
        + `(expected ${descriptor.identity.storageLayoutVersion}, found `
        + `${storage.currentLayoutVersion ?? "unknown"}).`
    );
  }
  if (storage.currentAggregateSchemaVersion !== descriptor.identity.aggregateSchemaVersion) {
    throw new Error(
      "Exact control-plane aggregate schema does not match its frozen descriptor "
        + `(expected ${descriptor.identity.aggregateSchemaVersion}, found `
        + `${storage.currentAggregateSchemaVersion ?? "unknown"}).`
    );
  }

  if (options.checkController !== false) {
    const call = options.callController ?? defaultCallController;
    try {
      const status = await call(descriptor.yuiHome, "controller.status", {});
      assertControllerStatusIdentity(status, descriptor.identity);
    } catch (error) {
      if (!isDefinitelyNotRunning(error)) throw error;
    }
  }
  return descriptor;
}

export function assertControllerStatusIdentity(
  status: JsonValue,
  expected: YuiVersionIdentity = yuiVersionIdentity()
): void {
  if (!isRecord(status) || status.running !== true) {
    throw new Error("Controller status does not describe a running Controller.");
  }
  assertControllerField(
    status.protocolVersion,
    expected.controllerProtocolVersion,
    "protocol"
  );
  assertControllerField(status.version, expected.version, "version");
  assertControllerField(
    status.storageLayoutVersion,
    expected.storageLayoutVersion,
    "storage layout"
  );
  assertControllerField(
    status.aggregateSchemaVersion,
    expected.aggregateSchemaVersion,
    "aggregate schema"
  );
}

export function assertExactTaskRuntimeEnvironment(
  runtimeSource: string,
  environment: NodeJS.ProcessEnv,
  expectedControlDigest: string,
  expectedHome = requireText(environment.YUI_HOME, "YUI_HOME")
): ExactTaskRuntimeDescriptor {
  const resolved = readTaskRuntimeSource(runtimeSource, expectedHome);
  const runtime = resolved.descriptor;
  if (runtime.controlPlaneDigest !== requireDigest(expectedControlDigest)) {
    throw new Error("Task runtime descriptor belongs to another exact control plane.");
  }
  assertEnvironment(runtime.taskId, environment.YUI_TASK_ID, "Task id");
  assertEnvironment(runtime.roleName, environment.YUI_ROLE, "Role name");
  assertEnvironment(runtime.agentId, environment.YUI_AGENT_ID, "Agent id");
  assertEnvironment(runtime.adapterId, environment.YUI_ADAPTER_ID, "Agent adapter id");
  assertSamePath(
    runtime.workspace,
    requireText(environment.YUI_WORKSPACE, "YUI_WORKSPACE"),
    "Task runtime workspace"
  );
  // A reused native pane retains its original process environment. Volatile
  // identity therefore comes only from the atomically published descriptor
  // plus durable state, never from stale ambient Run/launch/native variables.
  if (!resolved.fromFile) {
    assertOptionalEnvironment(runtime.runId, environment.YUI_RUN_ID, "Run id");
    assertOptionalEnvironment(runtime.launchId, environment.YUI_LAUNCH_ID, "Launch id");
    assertOptionalEnvironment(
      runtime.nativeSessionId,
      environment.YUI_NATIVE_SESSION_ID,
      "Native session id"
    );
  }
  return runtime;
}

export type ExactTaskRuntimeStatePort = Pick<
  TaskStore,
  | "getTask"
  | "getRole"
  | "getActiveAgentRun"
  | "getTaskRoleSessionSet"
  | "getWorkMailbox"
>;

/** Fences a descriptor to the one currently active durable Task runtime. */
export function assertExactTaskRuntimeState(
  runtime: ExactTaskRuntimeDescriptor,
  store: ExactTaskRuntimeStatePort
): void {
  const task = store.getTask(runtime.taskId);
  if (task === null || task.status !== "active") {
    throw new Error("Exact Task runtime Task is not current and active.");
  }
  const role = store.getRole(runtime.taskId, runtime.roleName);
  if (role === null || role.activeAgentId !== runtime.agentId) {
    throw new Error("Exact Task runtime Role or Agent is not current.");
  }
  const run = store.getActiveAgentRun(runtime.taskId, runtime.roleName);
  if (runtime.runId === undefined) {
    if (run !== null) throw new Error("Exact Task runtime Run is not current.");
  } else if (
    run === null
    || run.id !== runtime.runId
    || run.status !== "active"
    || run.effective.agentId !== runtime.agentId
    || run.effective.adapterId !== runtime.adapterId
    || canonicalPath(run.effective.workspace.root) !== runtime.workspace
  ) {
    throw new Error("Exact Task runtime Run is not current.");
  }

  const sessions = store.getTaskRoleSessionSet(runtime.taskId, runtime.roleName);
  const session = sessions?.sessions[runtime.agentId];
  if (sessions !== null && sessions.activeAgentId !== runtime.agentId) {
    throw new Error("Exact Task runtime Session Agent is not current.");
  }
  if (runtime.runId !== undefined && (
    sessions?.inFlight?.agentId !== runtime.agentId
    || sessions.inFlight.runId !== runtime.runId
    || sessions.inFlight.receiptId !== formatAgentRunReceiptId(
      runtime.taskId,
      runtime.runId
    )
  )) {
    throw new Error("Exact Task runtime in-flight Run fence is not current.");
  }

  const reservation = runtime.launchId === undefined
    ? false
    : isRuntimeLaunchReservation(
        store.getWorkMailbox(runtimeLifecycleTarget({
          scope: "task",
          taskId: runtime.taskId,
          roleName: runtime.roleName
        }))?.processing,
        runtime.launchId
      );
  const sessionLaunch = runtime.launchId !== undefined
    && session?.launchId === runtime.launchId;
  if (runtime.launchId === undefined || (!reservation && !sessionLaunch)) {
    throw new Error("Exact Task runtime launch fence is not current.");
  }
  if (runtime.nativeSessionId === undefined) {
    if (session !== undefined) {
      throw new Error("Exact Task runtime native Session fence is missing.");
    }
  } else if (
    session === undefined
    || session.agentId !== runtime.agentId
    || session.adapterId !== runtime.adapterId
    || session.nativeSessionId !== runtime.nativeSessionId
    || session.launchId !== runtime.launchId
    || session.status === "stopped"
    || session.status === "broken"
    || session.effective.agentId !== runtime.agentId
    || session.effective.adapterId !== runtime.adapterId
    || canonicalPath(session.effective.workspace.root) !== runtime.workspace
  ) {
    throw new Error("Exact Task runtime native Session fence is not current.");
  }
}

/** Publishes provider-discovered native identity without changing the stable source path. */
export function refreshExactTaskRuntimeDescriptorSource(
  source: string,
  home: string,
  store: ExactTaskRuntimeStatePort
): ExactTaskRuntimeDescriptor {
  const resolved = readTaskRuntimeSource(source, home);
  if (!resolved.fromFile) {
    throw new Error("A managed Task runtime descriptor must use its stable file source.");
  }
  const current = resolved.descriptor;
  const session = store.getTaskRoleSessionSet(current.taskId, current.roleName)
    ?.sessions[current.agentId];
  if (session === undefined) {
    throw new Error("Exact Task runtime native Session is not available for refresh.");
  }
  const refreshed = createExactTaskRuntimeDescriptor({
    ...current,
    nativeSessionId: session.nativeSessionId
  });
  if (exactTaskRuntimeDescriptorPath(home, refreshed) !== resolve(source)) {
    throw new Error("Refreshed Task runtime descriptor changed its stable identity.");
  }
  assertExactTaskRuntimeState(refreshed, store);
  writeTextFileAtomically(resolve(source), `${serializeExactDescriptor(refreshed)}\n`);
  return refreshed;
}

function readTaskRuntimeSource(
  source: string,
  home: string
): Readonly<{ descriptor: ExactTaskRuntimeDescriptor; fromFile: boolean }> {
  const value = requireText(source, "Exact Task runtime descriptor source");
  if (value.trimStart().startsWith("{")) {
    return { descriptor: parseExactTaskRuntimeDescriptor(value), fromFile: false };
  }
  const requested = resolve(value);
  const root = resolve(canonicalPath(home), "runtime", "exact-task-runtime");
  if (dirname(requested) !== root) {
    throw new Error("Exact Task runtime descriptor path is outside its control plane.");
  }
  let actual: string;
  try {
    actual = realpathSync(requested);
  } catch (error) {
    throw new Error("Exact Task runtime descriptor file is unavailable.", { cause: error });
  }
  if (actual !== requested) {
    throw new Error("Exact Task runtime descriptor file must not be a symbolic link.");
  }
  const descriptor = parseExactTaskRuntimeDescriptor(readFileSync(actual, "utf8"));
  if (exactTaskRuntimeDescriptorPath(home, descriptor) !== requested) {
    throw new Error("Exact Task runtime descriptor path does not match its stable identity.");
  }
  return { descriptor, fromFile: true };
}

function validateVersionIdentity(value: unknown): YuiVersionIdentity {
  if (!isRecord(value)) throw new Error("Yui version identity is invalid.");
  const version = requireText(value.version, "Yui version");
  const controllerProtocolVersion = requireVersion(
    value.controllerProtocolVersion,
    "Controller protocol version"
  );
  const storageLayoutVersion = requireVersion(
    value.storageLayoutVersion,
    "Storage layout version"
  );
  const aggregateSchemaVersion = requireVersion(
    value.aggregateSchemaVersion,
    "Aggregate schema version"
  );
  return {
    version,
    controllerProtocolVersion,
    storageLayoutVersion,
    aggregateSchemaVersion
  };
}

function assertVersionIdentity(
  label: string,
  expected: YuiVersionIdentity,
  actual: YuiVersionIdentity
): void {
  for (const field of [
    "version",
    "controllerProtocolVersion",
    "storageLayoutVersion",
    "aggregateSchemaVersion"
  ] as const) {
    if (expected[field] !== actual[field]) {
      throw new Error(
        `${label} ${field} does not match the frozen control plane `
          + `(expected ${expected[field]}, found ${actual[field]}).`
      );
    }
  }
}

function assertControllerField(
  actual: unknown,
  expected: string | number,
  label: string
): void {
  if (actual !== expected) {
    throw new Error(
      `Controller ${label} is incompatible with the exact control plane `
        + `(expected ${expected}, found ${typeof actual === "string" || typeof actual === "number" ? actual : "unknown"}). `
        + "Run controller restart through the matching exact control-plane invocation "
        + "before writing new Task records."
    );
  }
}

function assertSamePath(expected: string, actual: string, label: string): void {
  const normalized = canonicalPath(actual);
  if (expected !== normalized) {
    throw new Error(`${label} does not match the frozen control plane (expected ${expected}, found ${normalized}).`);
  }
}

function assertEnvironment(expected: string, actual: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} does not match the exact Task runtime descriptor.`);
  }
}

function assertOptionalEnvironment(
  expected: string | undefined,
  actual: string | undefined,
  label: string
): void {
  if (actual !== expected) {
    throw new Error(`${label} does not match the exact Task runtime descriptor.`);
  }
}

function parseDescriptorRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireText(value, "Exact descriptor"));
  } catch (error) {
    throw new Error("Exact descriptor is not valid JSON.", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("Exact descriptor must be an object.");
  return parsed;
}

function assertDescriptorKind(
  value: Record<string, unknown>,
  expected: ExactControlPlaneDescriptor["kind"] | ExactTaskRuntimeDescriptor["kind"]
): void {
  if (value.kind !== expected) {
    throw new Error(
      `Exact descriptor kind is invalid: expected ${expected}, found `
        + `${typeof value.kind === "string" ? value.kind : "unknown"}.`
    );
  }
}

function requireAdapter(value: unknown): AgentAdapterId {
  if (value !== "codex" && value !== "claude") {
    throw new Error("Agent adapter id is invalid.");
  }
  return value;
}

function requireIdentity(value: unknown, label: string): string {
  const text = requireText(value, label).trim();
  if (text.length === 0 || text.length > 1_024 || text.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireDigest(value: unknown): string {
  const digest = requireText(value, "Control-plane digest");
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("Control-plane digest is invalid.");
  }
  return digest;
}

function requireVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function canonicalPath(value: string): string {
  const absolute = resolve(requireText(value, "Path"));
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefinitelyNotRunning(error: unknown): boolean {
  return isRecord(error) && error.code === "CONTROLLER_NOT_RUNNING";
}
