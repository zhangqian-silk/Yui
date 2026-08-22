import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  callController,
  readControllerDiscovery,
  stopOrphanedFileTaskController,
  stopPreviousFileTaskController
} from "../core/controllerClient.js";
import {
  FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
  type JsonValue
} from "../core/protocol.js";
import type { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import type { TaskWorkflowRuntimePort } from "../commands/taskCommands.js";
import {
  AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
  nativeAgentEnvironmentNames,
  operationalAgentEnvironment,
  selectEnvironment,
  YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES
} from "../agent/launchEnvironment.js";
import type { TaskStore } from "../storage/taskStore.js";
import { openCompatibleFileTaskStore } from "../storage/compatibleTaskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import type { FileSchedulerStoreAdapter } from "./fileSchedulerStoreAdapter.js";
import type { TaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";
import type { MailboxTarget } from "../coordination/workMailbox.js";
import { hasRuntimeLifecycleWork } from "../runtime/lifecycleReservation.js";
import { assertControllerStatusIdentity } from "../runtime/exactControlPlane.js";
import { EPHEMERAL_DOMAIN_ENVIRONMENT_NAMES } from "./domainIdentity.js";
import { YUI_VERSION, yuiVersionIdentity } from "../version.js";
import { SessionOwnerReconciliation } from "./sessionOwnerReconciliation.js";
import { WorkspaceCleanupBlockedError } from "../repository/taskWorkspacePreparer.js";

const STARTUP_TIMEOUT_MS = 5_000;
// A lifecycle RPC may legitimately occupy the Controller for 30 seconds.
// Restart must allow that request to drain before deciding shutdown is stuck.
const SHUTDOWN_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 50;
const LIFECYCLE_REQUEST_TIMEOUT_MS = 30_000;
const ENVIRONMENT_REFRESH_TIMEOUT_MS = 500;
const CONFIGURATION_REFRESH_TIMEOUT_MS = 500;
const CONTROLLER_OPERATIONAL_ENVIRONMENT = [
  ...AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
  // Issue 01: YUI_STORE_BACKEND/YUI_STORE_WORKER are reserved for tests and
  // explicit recovery commands. A Controller spawned by such a command must
  // inherit the forced backend; otherwise a layout-7 test Home silently opens
  // SQLite, creates yui.db, and diverges from the file store the test writes.
  "YUI_STORE_BACKEND",
  "YUI_STORE_WORKER",
  // rr13/test: Forward the liveness seam so an integration test's Controller
  // subprocess does not reap a saved active Leader Run without a real tmux role.
  "YUI_TEST_ROLE_LIVENESS_PRESENT",
  // Issue 02: agent-signal-driven launch monitoring is Controller-owned.
  "YUI_LAUNCH_INACTIVITY_TIMEOUT_MS",
  ...EPHEMERAL_DOMAIN_ENVIRONMENT_NAMES
] as const;

export type FileControllerClientOptions = Readonly<{
  call?: typeof callController;
  spawnController?: (home: string, environment: NodeJS.ProcessEnv) => void;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Override the expected version for an exact-identity restore handshake. */
  expectedVersion?: string;
  /**
   * Fence a stop request to the exact Controller process observed by the
   * caller.  Used only by update's replacement-mismatch cleanup; ordinary
   * lifecycle callers leave this unset.
   */
  expectedPid?: number;
  onError?: (error: unknown) => void;
}>;

export type ControllerLaunchIdentity = Readonly<{
  executablePath: string;
  args: readonly string[];
  version: string;
}>;

/**
 * Direct FileTaskStore writers must not extend state while an older Controller
 * is still reading the same YUI_HOME.
 */
export async function assertFileTaskControllerStorageCompatible(
  home: string,
  options: Pick<FileControllerClientOptions, "call"> = {}
): Promise<void> {
  const call = options.call ?? callController;
  let status: JsonValue;
  try {
    status = await call(home, "controller.status", {});
  } catch (error) {
    if (isDefinitelyNotRunning(error)) return;
    if (isUnavailable(error)) {
      throw new Error(
        "Controller compatibility could not be verified. Retry or run `yui controller restart`.",
        { cause: error }
      );
    }
    throw error;
  }
  assertCompatibleControllerStatus(status);
}

/** Starts the per-home FileTask Controller on demand and waits until callable. */
export async function ensureFileTaskController(
  home: string,
  options: FileControllerClientOptions = {}
): Promise<JsonValue> {
  const call = options.call ?? callController;
  try {
    const status = await call(home, "controller.status", {});
    assertCompatibleControllerStatus(status, options.expectedVersion);
    return status;
  } catch (error) {
    if (!isUnavailable(error)) throw error;
  }
  const timeoutMs = positive(options.startupTimeoutMs, STARTUP_TIMEOUT_MS, "startupTimeoutMs");
  const pollMs = positive(options.pollIntervalMs, POLL_INTERVAL_MS, "pollIntervalMs");
  const spawnController = options.spawnController ?? spawnDetachedFileTaskController;
  spawnController(home, controllerSpawnEnvironment(home, options.environment ?? process.env));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const status = await call(home, "controller.status", {});
      assertCompatibleControllerStatus(status, options.expectedVersion);
      return status;
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Controller did not become ready within ${timeoutMs} ms.`, { cause: error });
      }
      await delay(pollMs);
    }
  }
}

/** Start and await readiness for a captured Controller identity. */
export async function ensureFileTaskControllerIdentity(
  home: string,
  identity: ControllerLaunchIdentity,
  options: FileControllerClientOptions = {}
): Promise<JsonValue> {
  assertExpectedControllerLaunchIdentity(identity);
  const status = await ensureFileTaskController(home, {
    ...options,
    expectedVersion: identity.version
  });
  // A same-version status is not an identity proof: another Controller binary
  // may own the Home after a restart or a stale discovery race. Authenticate
  // the socket owner and compare the complete launch vector before reporting
  // readiness. This post-readiness check deliberately has no retry or spawn
  // fallback; a mismatch/unavailable/malformed identity is fail-closed.
  const call = options.call ?? callController;
  const actual = await call(home, "controller.identity", {}, {
    timeoutMs: options.requestTimeoutMs
  });
  assertControllerLaunchIdentity(actual, identity);
  return status;
}

function assertExpectedControllerLaunchIdentity(
  identity: ControllerLaunchIdentity
): void {
  if (
    typeof identity.executablePath !== "string"
    || identity.executablePath.length === 0
    || !Array.isArray(identity.args)
    || identity.args.some((arg) => typeof arg !== "string")
    || typeof identity.version !== "string"
    || identity.version.length === 0
  ) {
    throw new Error(
      "Expected Controller launch identity is malformed; refusing to start or accept a Controller."
    );
  }
}

function assertControllerLaunchIdentity(
  actual: JsonValue,
  expected: ControllerLaunchIdentity
): void {
  if (!isJsonRecord(actual)) {
    throw new Error(
      "Authenticated Controller launch identity is malformed; refusing to accept readiness."
    );
  }
  const actualArgs = actual.args;
  if (
    typeof actual.executablePath !== "string"
    || !Array.isArray(actualArgs)
    || actualArgs.some((arg) => typeof arg !== "string")
    || typeof actual.version !== "string"
  ) {
    throw new Error(
      "Authenticated Controller launch identity is malformed; refusing to accept readiness."
    );
  }
  const argsMatch = actualArgs.length === expected.args.length
    && actualArgs.every((arg, index) => arg === expected.args[index]);
  if (
    actual.executablePath !== expected.executablePath
    || !argsMatch
    || actual.version !== expected.version
  ) {
    throw new Error(
      "Authenticated Controller launch identity does not match the captured executable, argv, and version; refusing readiness."
    );
  }
}

function assertCompatibleControllerStatus(
  status: JsonValue,
  expectedVersion?: string
): void {
  const statusRecord = isJsonRecord(status) && status.running === true ? status : null;
  const actual = statusRecord?.protocolVersion;
  if (statusRecord === null || actual !== FILE_TASK_CONTROLLER_PROTOCOL_VERSION) {
    throw new Error(
      `Controller protocol is incompatible (expected ${
        FILE_TASK_CONTROLLER_PROTOCOL_VERSION
      }, found ${typeof actual === "number" ? actual : "unknown"}). `
        + "Run `yui controller restart` before writing new task records."
    );
  }
  const actualVersion = statusRecord.version;
  const expected = expectedVersion ?? YUI_VERSION;
  const versionMismatch = expectedVersion === undefined
    ? typeof actualVersion === "string" && actualVersion !== expected
    : actualVersion !== expected;
  if (versionMismatch) {
    throw new Error(
      `Controller version is incompatible (expected ${expected}, found ${
        typeof actualVersion === "string" ? actualVersion : "unknown"
      }). `
        + "Run `yui controller restart` before writing new task records."
    );
  }
  // Ordinary callers must authenticate the complete control-plane identity.
  // An update/upgrade restore instead targets a previously captured Controller
  // binary, which may predate the current storage-layout status fields; that
  // path authenticates its executable, argv, and version immediately after
  // readiness in ensureFileTaskControllerIdentity.
  if (expectedVersion === undefined) {
    assertControllerStatusIdentity(status, yuiVersionIdentity());
  }
}

function spawnDetachedFileTaskController(
  home: string,
  environment: NodeJS.ProcessEnv
): void {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./controllerMain.js", import.meta.url))],
    {
      env: environment,
      detached: true,
      stdio: "ignore"
    }
  );
  child.unref();
}

export type FileControllerRestartResult = Readonly<{
  restarted: true;
  previousPid?: number;
  pid?: number;
}>;

export type FileControllerStopResult = Readonly<{
  stopped: boolean;
  alreadyStopped?: true;
  pid?: number;
}>;

/** Stops the per-home Controller and waits until its owned discovery is gone. */
export async function stopFileTaskController(
  home: string,
  options: FileControllerClientOptions = {}
): Promise<FileControllerStopResult> {
  const call = options.call ?? callController;
  const shutdownTimeoutMs = positive(
    options.shutdownTimeoutMs,
    SHUTDOWN_TIMEOUT_MS,
    "shutdownTimeoutMs"
  );
  const pollMs = positive(options.pollIntervalMs, POLL_INTERVAL_MS, "pollIntervalMs");
  const expectedPid = options.expectedPid === undefined
    ? undefined
    : positive(options.expectedPid, 0, "expectedPid");
  const current = await readOptionalControllerStatus(home, call);
  const pid = controllerPid(current);
  if (expectedPid !== undefined && pid !== expectedPid) {
    throw new Error(
      `Controller ownership changed before fenced stop (expected PID ${expectedPid}, `
        + `found ${pid === undefined ? "none" : pid}).`
    );
  }
  if (!controllerRunning(current)) {
    return { stopped: false, alreadyStopped: true };
  }
  await callFileTaskController(
    home,
    "controller.stop",
    expectedPid === undefined ? {} : { expectedPid },
    options
  );
  const deadline = Date.now() + shutdownTimeoutMs;
  for (;;) {
    if (options.call === undefined) {
      const discoveryOwned = await ownedControllerDiscoveryExists(home, pid);
      if (!discoveryOwned && expectedPid !== undefined) {
        // A replacement owner appearing during the drain is not equivalent to
        // the fenced process disappearing; fail closed instead of reporting a
        // successful stop against a foreign PID.
        const observed = controllerPid(await readOptionalControllerStatus(home, call));
        if (observed !== undefined && observed !== expectedPid) {
          throw new Error(
            `Controller ownership changed during fenced stop (expected PID ${expectedPid}, `
              + `found ${observed}).`
          );
        }
      }
      if (!discoveryOwned) break;
    } else {
      const observed = controllerPid(await readOptionalControllerStatus(home, call));
      if (observed === undefined) break;
      if (expectedPid !== undefined && observed !== expectedPid) {
        throw new Error(
          `Controller ownership changed during fenced stop (expected PID ${expectedPid}, `
            + `found ${observed}).`
        );
      }
      if (observed !== pid) break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Controller did not stop within ${shutdownTimeoutMs} ms.`);
    }
    await delay(pollMs);
  }
  return {
    stopped: true,
    ...(pid === undefined ? {} : { pid })
  };
}

/** Restarts only the per-home Controller process; managed tmux sessions remain untouched. */
export async function restartFileTaskController(
  home: string,
  options: FileControllerClientOptions = {}
): Promise<FileControllerRestartResult> {
  const call = options.call ?? callController;
  const shutdownTimeoutMs = positive(
    options.shutdownTimeoutMs,
    SHUTDOWN_TIMEOUT_MS,
    "shutdownTimeoutMs"
  );
  const pollMs = positive(options.pollIntervalMs, POLL_INTERVAL_MS, "pollIntervalMs");
  let current: JsonValue | null = null;
  let previousPid: number | undefined;
  try {
    current = await readOptionalControllerStatus(home, call);
    previousPid = controllerPid(current);
  } catch (error) {
    if (options.call !== undefined || !isInvalidDiscovery(error)) throw error;
    // Protocol v3 is the immediately previous released Controller. Keep its
    // parser and transport confined to this explicit replacement operation;
    // no ordinary request can fall back to it.
    const previous = await stopPreviousFileTaskController(home, shutdownTimeoutMs);
    previousPid = previous.pid;
  }
  if (!controllerRunning(current) && options.call === undefined) {
    const orphan = await stopOrphanedFileTaskController(home, shutdownTimeoutMs);
    if (orphan !== undefined) previousPid = orphan.pid;
  }
  if (controllerRunning(current)) {
    await callFileTaskController(home, "controller.stop", {}, options);
    const deadline = Date.now() + shutdownTimeoutMs;
    for (;;) {
      const stillOwned = options.call === undefined
        ? await ownedControllerDiscoveryExists(home, previousPid)
        : controllerPid(await readOptionalControllerStatus(home, call)) === previousPid;
      if (!stillOwned) break;
      if (Date.now() >= deadline) {
        throw new Error(`Controller did not stop within ${shutdownTimeoutMs} ms.`);
      }
      await delay(pollMs);
    }
  }
  const started = await ensureFileTaskController(home, options);
  const pid = controllerPid(started);
  return {
    restarted: true,
    ...(previousPid === undefined ? {} : { previousPid }),
    ...(pid === undefined ? {} : { pid })
  };
}

function controllerSpawnEnvironment(
  home: string,
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const allowed = new Set<string>(CONTROLLER_OPERATIONAL_ENVIRONMENT);
  try {
    for (const agent of openCompatibleFileTaskStore(home).listConfiguredAgents()) {
      for (const name of nativeAgentEnvironmentNames(agent.adapterId)) allowed.add(name);
      for (const binding of agent.environment) allowed.add(binding.sourceName);
    }
  } catch {
    // The Controller remains authoritative for reporting an invalid/unavailable
    // home. Environment filtering must never fall back to forwarding all names.
  }
  // Merge with process.env so a partial source (e.g. a managed-Session env
  // that only carries YUI_SESSION_SCOPE/YUI_TASK_ID) still forwards
  // operational vars like YUI_STORE_BACKEND and PATH. The source wins on
  // conflict; the whitelist still gates every forwarded name.
  const effectiveSource: NodeJS.ProcessEnv = { ...process.env, ...source };
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = effectiveSource[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.YUI_HOME = home;
  return environment;
}

async function ownedControllerDiscoveryExists(
  home: string,
  previousPid: number | undefined
): Promise<boolean> {
  try {
    const discovery = await readControllerDiscovery(home);
    return previousPid === undefined || discovery.pid === previousPid;
  } catch (error) {
    if (isUnavailable(error)) return false;
    throw error;
  }
}

export async function callFileTaskController(
  home: string,
  method: string,
  params: JsonValue = {},
  options: FileControllerClientOptions = {}
): Promise<JsonValue> {
  const call = options.call ?? callController;
  if (method === "controller.status" || method === "controller.stop") {
    try {
      return await call(home, method, params);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      return method === "controller.status"
        ? { running: false }
        : { stopped: false, alreadyStopped: true };
    }
  }
  try {
    return await call(home, method, params, {
      timeoutMs: options.requestTimeoutMs
    });
  } catch (error) {
    if (!isUnavailable(error)) throw error;
  }
  await ensureFileTaskController(home, options);
  return call(home, method, params, {
    timeoutMs: options.requestTimeoutMs
  });
}

/**
 * Best-effort refresh for a Controller that is already running. This path
 * deliberately calls the authenticated socket directly: an Agent config
 * command must not start a background Controller merely to copy secrets.
 */
export async function refreshRunningFileTaskControllerEnvironment(
  home: string,
  store: Pick<TaskStore, "listConfiguredAgents">,
  source: NodeJS.ProcessEnv = process.env,
  options: FileControllerClientOptions & Readonly<{
    sourceNames?: readonly string[];
    nativeNames?: readonly string[];
  }> = {}
): Promise<RunningControllerRefreshResult> {
  const configuredSourceNames = new Set<string>();
  const configuredNativeNames = new Set<string>();
  for (const agent of store.listConfiguredAgents()) {
    for (const name of nativeAgentEnvironmentNames(agent.adapterId)) {
      configuredNativeNames.add(name);
    }
    for (const binding of agent.environment) {
      if (!MANAGED_RUNTIME_ENVIRONMENT.has(binding.sourceName)) {
        configuredSourceNames.add(binding.sourceName);
      }
    }
  }
  const sourceNames = options.sourceNames === undefined
    ? [...configuredSourceNames]
    : [...new Set(options.sourceNames)];
  const nativeNames = options.nativeNames === undefined
    ? [...configuredNativeNames]
    : [...new Set(options.nativeNames)];
  const sources = selectEnvironment(source, sourceNames);
  const nativeSources = selectEnvironment(source, nativeNames);
  try {
    await (options.call ?? callController)(
      home,
      "runtime.replace-agent-environment",
      { sources, sourceNames, nativeSources, nativeNames },
      {
        timeoutMs: options.requestTimeoutMs
          ?? ENVIRONMENT_REFRESH_TIMEOUT_MS
      }
    );
    return { status: "refreshed" };
  } catch (error) {
    return classifyRefreshFailure(error, options);
  }
}

export type RunningControllerRefreshResult =
  | Readonly<{ status: "refreshed" | "not-running" }>
  | Readonly<{ status: "failed"; message: string }>;

/** Reloads durable Controller settings without starting an absent Controller. */
export async function refreshRunningFileTaskControllerConfiguration(
  home: string,
  options: FileControllerClientOptions = {}
): Promise<RunningControllerRefreshResult> {
  try {
    await (options.call ?? callController)(
      home,
      "scheduler.configure",
      {},
      {
        timeoutMs: options.requestTimeoutMs
          ?? CONFIGURATION_REFRESH_TIMEOUT_MS
      }
    );
    return { status: "refreshed" };
  } catch (error) {
    return classifyRefreshFailure(error, options);
  }
}

function classifyRefreshFailure(
  error: unknown,
  options: FileControllerClientOptions
): RunningControllerRefreshResult {
  if (isDefinitelyNotRunning(error)) return { status: "not-running" };
  options.onError?.(error);
  return {
    status: "failed",
    message: error instanceof Error ? error.message : String(error)
  };
}

/** Foreground command bridge. It never reads or writes Agent terminal bytes. */
export class FileTaskWorkflowRuntime implements TaskWorkflowRuntimePort {
  constructor(
    readonly home: string,
    readonly store: TaskStore,
    readonly schedulerStore: FileSchedulerStoreAdapter,
    readonly planner: FileRoleLaunchPlanner,
    readonly tmux: TmuxManager,
    readonly workspacePreparer?: TaskWorkspacePreparer,
    readonly clientOptions: FileControllerClientOptions = {}
  ) {}

  notifyStateChanged(taskId: string): void {
    this.notifyMailboxChanged({ kind: "task", taskId });
  }

  notifyMailboxChanged(target: MailboxTarget): void {
    void callFileTaskController(
      this.home,
      "scheduler.signal",
      { key: controllerMailboxKey(target) },
      this.clientOptions
    ).catch(this.clientOptions.onError ?? (() => {}));
  }

  reconcileTask(taskId: string): void {
    void this.#prepareAndScan(taskId).catch(this.clientOptions.onError ?? (() => {}));
  }

  async stopTaskRoleSessions(taskId: string, roleNames: readonly string[]): Promise<void> {
    const targets = [];
    for (const roleName of [...new Set(roleNames)]) {
      if (this.store.getActiveAgentRun(taskId, roleName) !== null) {
        throw new Error(`Role has an active Run: ${taskId}/${roleName}.`);
      }
      const target = this.schedulerStore.enqueueRuntimeCleanup({
        scope: "task",
        taskId,
        roleName
      });
      if (target === null) throw new Error(`Task not found: ${taskId}.`);
      if (target.kind !== "role-runtime") {
        throw new Error(`Role runtime cleanup target is invalid: ${taskId}/${roleName}.`);
      }
      targets.push(target);
    }
    if (targets.length === 0) return;

    await callFileTaskController(this.home, "scheduler.scan", {}, {
      ...this.clientOptions,
      requestTimeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS
    });

    for (const target of targets) {
      if (hasRuntimeLifecycleWork(this.store.getWorkMailbox(target))) {
        throw new Error(
          `Role runtime did not stop: ${target.taskId}/${target.roleName}.`
        );
      }
      const session = this.store.getRoleSession(target.taskId, target.roleName);
      if (session !== null && session.status !== "stopped") {
        throw new Error(
          `Role runtime session is still active: ${target.taskId}/${target.roleName}.`
        );
      }
    }
  }

  /**
   * Issue 03 archive postcondition. Re-verifies physical absence after the
   * runtime stop and blocks archive while any owned Provider root is still
   * live, preserving the owner records for Operator recovery.
   */
  async assertTaskPhysicalResourcesReleased(taskId: string): Promise<void> {
    const reconciliation = new SessionOwnerReconciliation({
      home: this.home,
      store: this.store,
      environment: this.clientOptions.environment,
      tmux: this.tmux
    });
    const records = this.store.listSessionOwners().filter((record) => (
      record.owner.scope === "task" && record.owner.taskId === taskId
    ));
    if (records.length === 0) return;
    const report = reconciliation.report();
    const blockers = report.entries.filter((entry) => (
      entry.owner.scope === "task"
      && entry.owner.taskId === taskId
      && entry.archiveBlocked
    ));
    if (blockers.length === 0) return;
    throw new WorkspaceCleanupBlockedError(
      "physical-resource-live",
      `task:${taskId}`,
      true,
      `Task archive blocked: ${blockers.length} owned physical resource(s) still live: `
        + blockers.map((entry) => (
          `${entry.owner.roleName}/${entry.launchId}`
            + ` (pid ${entry.physical?.alive === true ? entry.physical.pid : "?"})`
        )).join("; ")
    );
  }

  async stopGlobalRoleSession(roleName: string): Promise<void> {
    if (this.store.getGlobalRole(roleName) === null) {
      throw new Error(`Global Role not found: ${roleName}.`);
    }
    const target = this.schedulerStore.enqueueRuntimeCleanup({
      scope: "global",
      roleName
    });
    if (target?.kind !== "global-role-runtime") {
      throw new Error(`Global Role runtime cleanup target is invalid: ${roleName}.`);
    }
    await callFileTaskController(this.home, "scheduler.scan", {}, {
      ...this.clientOptions,
      requestTimeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS
    });
    if (hasRuntimeLifecycleWork(this.store.getWorkMailbox(target))) {
      throw new Error(`Global Role runtime did not stop: ${roleName}.`);
    }
    const sessions = this.store.getGlobalRoleSessionSet(roleName);
    const active = sessions?.sessions[sessions.activeAgentId];
    if (active !== undefined && active.status !== "stopped") {
      throw new Error(`Global Role runtime session is still active: ${roleName}.`);
    }
  }

  inspectTaskRolePanes(taskId: string) {
    return this.tmux.inspectTaskRolePanes(taskId);
  }

  async prepareGlobalRoleEnter(roleName: string): Promise<void> {
    const environment = foregroundGlobalRoleEnvironment(
      this.store,
      roleName,
      this.clientOptions.environment ?? process.env
    );
    await callFileTaskController(this.home, "runtime.ensure-role-session", {
      scope: "global",
      roleName,
      ...(environment === undefined ? {} : { environment })
    }, {
      ...this.clientOptions,
      requestTimeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS
    });
    if (roleName === "operator") {
      await callFileTaskController(
        this.home,
        "scheduler.signal",
        { key: "operator" },
        this.clientOptions
      );
    }
  }

  async #prepareAndScan(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (
      task !== null
      && (task.status === "draft" || task.status === "active")
      && this.workspacePreparer !== undefined
    ) {
      await this.workspacePreparer.prepareTaskWorkspace(taskId);
    }
    await callFileTaskController(this.home, "scheduler.scan", {}, this.clientOptions);
  }
}

const MANAGED_RUNTIME_ENVIRONMENT = new Set<string>(
  YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES
);

function foregroundGlobalRoleEnvironment(
  store: TaskStore,
  roleName: string,
  source: NodeJS.ProcessEnv
): Readonly<Record<string, string>> | undefined {
  const role = store.getGlobalRole?.(roleName);
  if (role === null || role === undefined) return undefined;
  const agent = store.getConfiguredAgent?.(role.activeAgentId);
  if (agent === null || agent === undefined) return undefined;
  const declaredSources = new Set(
    agent.environment.map((binding) => binding.sourceName)
  );
  for (const name of MANAGED_RUNTIME_ENVIRONMENT) declaredSources.delete(name);
  return {
    ...operationalAgentEnvironment(agent.adapterId, source),
    ...selectEnvironment(source, declaredSources)
  };
}

function controllerMailboxKey(target: MailboxTarget): string {
  switch (target.kind) {
    case "operator": return "operator";
    case "task": return `task:${encodeURIComponent(target.taskId)}`;
    case "role": return `role:${encodeURIComponent(target.taskId)}/${encodeURIComponent(target.roleName)}`;
    case "role-runtime":
      return `role:${encodeURIComponent(target.taskId)}/${encodeURIComponent(target.roleName)}`;
    case "global-role-runtime":
      return `global-role:${encodeURIComponent(target.roleName)}`;
  }
}

function isUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "CONTROLLER_NOT_RUNNING"
    || code === "CONTROLLER_UNAVAILABLE";
}

function isDefinitelyNotRunning(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "CONTROLLER_NOT_RUNNING";
}

function isInvalidDiscovery(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (error as { code?: unknown }).code === "CONTROLLER_DISCOVERY_INVALID";
}

async function readOptionalControllerStatus(
  home: string,
  call: typeof callController
): Promise<JsonValue | null> {
  try {
    return await call(home, "controller.status", {});
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  }
}

function controllerRunning(value: JsonValue | null): boolean {
  return isJsonRecord(value) && value.running === true;
}

function controllerPid(value: JsonValue | null): number | undefined {
  if (!isJsonRecord(value)) return undefined;
  return Number.isSafeInteger(value.pid) && (value.pid as number) > 0
    ? value.pid as number
    : undefined;
}

function isJsonRecord(value: JsonValue | null): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return resolved;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
