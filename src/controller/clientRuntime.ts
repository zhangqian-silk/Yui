import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { callController, readControllerDiscovery } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import type { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import type { TaskWorkflowRuntimePort } from "../commands/taskCommands.js";
import {
  AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
  nativeAgentEnvironmentNames,
  operationalAgentEnvironment,
  selectEnvironment,
  YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES
} from "../agent/launchEnvironment.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import type { FileSchedulerStoreAdapter } from "./fileSchedulerStoreAdapter.js";
import type { TaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";
import type { MailboxTarget } from "../coordination/workMailbox.js";

const STARTUP_TIMEOUT_MS = 5_000;
// A lifecycle RPC may legitimately occupy the Controller for 30 seconds.
// Restart must allow that request to drain before deciding shutdown is stuck.
const SHUTDOWN_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 50;
const LIFECYCLE_REQUEST_TIMEOUT_MS = 30_000;
const ENVIRONMENT_REFRESH_TIMEOUT_MS = 500;
const CONTROLLER_OPERATIONAL_ENVIRONMENT = [
  ...AGENT_OPERATIONAL_ENVIRONMENT_NAMES,
  "YUI_TMUX_BIN"
] as const;

export type FileControllerClientOptions = Readonly<{
  call?: typeof callController;
  spawnController?: (home: string, environment: NodeJS.ProcessEnv) => void;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  onError?: (error: unknown) => void;
}>;

/** Starts the per-home FileTask Controller on demand and waits until callable. */
export async function ensureFileTaskController(
  home: string,
  options: FileControllerClientOptions = {}
): Promise<JsonValue> {
  const call = options.call ?? callController;
  try {
    return await call(home, "controller.status", {});
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
      return await call(home, "controller.status", {});
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Controller did not become ready within ${timeoutMs} ms.`, { cause: error });
      }
      await delay(pollMs);
    }
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
  const current = await readOptionalControllerStatus(home, call);
  const previousPid = controllerPid(current);
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
    for (const agent of new FileTaskStore(home).listConfiguredAgents()) {
      for (const name of nativeAgentEnvironmentNames(agent.adapterId)) allowed.add(name);
      for (const binding of agent.environment) allowed.add(binding.sourceName);
    }
  } catch {
    // The Controller remains authoritative for reporting an invalid/unavailable
    // home. Environment filtering must never fall back to forwarding all names.
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = source[name];
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
  options: FileControllerClientOptions = {}
): Promise<boolean> {
  const sourceNames = new Set<string>();
  for (const agent of store.listConfiguredAgents()) {
    for (const binding of agent.environment) {
      if (!MANAGED_RUNTIME_ENVIRONMENT.has(binding.sourceName)) {
        sourceNames.add(binding.sourceName);
      }
    }
  }
  const sources = selectEnvironment(source, sourceNames);
  try {
    await (options.call ?? callController)(
      home,
      "runtime.merge-agent-environment",
      { sources },
      {
        timeoutMs: options.requestTimeoutMs
          ?? ENVIRONMENT_REFRESH_TIMEOUT_MS
      }
    );
    return true;
  } catch (error) {
    if (!isUnavailable(error)) options.onError?.(error);
    return false;
  }
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

  async prepareTaskRoleEnter(
    input: Readonly<{ taskId: string; roleName: string }>
  ): Promise<void> {
    const environment = foregroundRoleEnvironment(
      this.store,
      { scope: "task", taskId: input.taskId, roleName: input.roleName },
      this.clientOptions.environment ?? process.env
    );
    await callFileTaskController(this.home, "runtime.ensure-role-session", {
      scope: "task",
      taskId: input.taskId,
      roleName: input.roleName,
      ...(environment === undefined ? {} : { environment })
    }, {
      ...this.clientOptions,
      requestTimeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS
    });
  }

  inspectTaskRolePanes(taskId: string) {
    return this.tmux.inspectTaskRolePanes(taskId);
  }

  async prepareGlobalRoleEnter(roleName: string): Promise<void> {
    const environment = foregroundRoleEnvironment(
      this.store,
      { scope: "global", roleName },
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
      task?.repositoryId !== undefined
      && task.status === "active"
      && this.workspacePreparer !== undefined
    ) {
      await this.workspacePreparer.prepareTaskWorkspace(taskId);
    }
    await callFileTaskController(this.home, "scheduler.scan", {}, this.clientOptions);
  }
}

type ForegroundRoleOwner =
  | Readonly<{ scope: "task"; taskId: string; roleName: string }>
  | Readonly<{ scope: "global"; roleName: string }>;

const MANAGED_RUNTIME_ENVIRONMENT = new Set<string>(
  YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES
);

function foregroundRoleEnvironment(
  store: TaskStore,
  owner: ForegroundRoleOwner,
  source: NodeJS.ProcessEnv
): Readonly<Record<string, string>> | undefined {
  const role = owner.scope === "task"
    ? store.getRole?.(owner.taskId, owner.roleName)
    : store.getGlobalRole?.(owner.roleName);
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
  return code === "CONTROLLER_UNAVAILABLE"
    || code === "CONTROLLER_DISCOVERY_INVALID"
    || code === "INVALID_RESPONSE";
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
