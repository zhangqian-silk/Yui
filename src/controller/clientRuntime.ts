import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { callController, readControllerDiscovery } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import type { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import type { TaskWorkflowRuntimePort } from "../commands/taskCommands.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import type { FileSchedulerStoreAdapter } from "./fileSchedulerStoreAdapter.js";
import type { TaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";
import type { MailboxTarget } from "../coordination/workMailbox.js";

const STARTUP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const LIFECYCLE_REQUEST_TIMEOUT_MS = 30_000;

export type FileControllerClientOptions = Readonly<{
  call?: typeof callController;
  spawnController?: (home: string, environment: NodeJS.ProcessEnv) => void;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
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
  spawnController(home, { ...process.env, ...options.environment, YUI_HOME: home });
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
  const timeoutMs = positive(options.startupTimeoutMs, STARTUP_TIMEOUT_MS, "startupTimeoutMs");
  const pollMs = positive(options.pollIntervalMs, POLL_INTERVAL_MS, "pollIntervalMs");
  const current = await readOptionalControllerStatus(home, call);
  const previousPid = controllerPid(current);
  if (controllerRunning(current)) {
    await callFileTaskController(home, "controller.stop", {}, options);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const stillOwned = options.call === undefined
        ? await ownedControllerDiscoveryExists(home, previousPid)
        : controllerPid(await readOptionalControllerStatus(home, call)) === previousPid;
      if (!stillOwned) break;
      if (Date.now() >= deadline) {
        throw new Error(`Controller did not stop within ${timeoutMs} ms.`);
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
    await callFileTaskController(this.home, "runtime.ensure-role-session", {
      scope: "task",
      taskId: input.taskId,
      roleName: input.roleName
    }, {
      ...this.clientOptions,
      requestTimeoutMs: LIFECYCLE_REQUEST_TIMEOUT_MS
    });
  }

  inspectTaskRolePanes(taskId: string) {
    return this.tmux.inspectTaskRolePanes(taskId);
  }

  async prepareGlobalRoleEnter(roleName: string): Promise<void> {
    await callFileTaskController(this.home, "runtime.ensure-role-session", {
      scope: "global",
      roleName
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

function controllerMailboxKey(target: MailboxTarget): string {
  switch (target.kind) {
    case "operator": return "operator";
    case "task": return `task:${encodeURIComponent(target.taskId)}`;
    case "role": return `role:${encodeURIComponent(target.taskId)}/${encodeURIComponent(target.roleName)}`;
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
