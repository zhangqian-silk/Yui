import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { callController } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import type { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import type { TaskWorkflowRuntimePort } from "../commands/taskCommands.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import type { FileSchedulerStoreAdapter } from "./fileSchedulerStoreAdapter.js";
import type { TaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";

const STARTUP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

export type FileControllerClientOptions = Readonly<{
  call?: typeof callController;
  spawnController?: (home: string, environment: NodeJS.ProcessEnv) => void;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
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
  spawnController(home, { ...process.env, ...options.environment, TASKMUX_HOME: home });
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
      const status = await readOptionalControllerStatus(home, call);
      if (!controllerRunning(status)) break;
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
  await ensureFileTaskController(home, options);
  return call(home, method, params);
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
    void this.#prepareAndScan(taskId).catch(this.clientOptions.onError ?? (() => {}));
  }

  reconcileTask(taskId: string): void {
    void this.#prepareAndScan(taskId).catch(this.clientOptions.onError ?? (() => {}));
  }

  prepareTaskRoleEnter(input: Readonly<{ taskId: string; roleName: string }>): void {
    const role = this.store.getRole(input.taskId, input.roleName);
    if (role === null) throw new Error(`Role not found: ${input.taskId}/${input.roleName}.`);
    const session = this.store.getRoleSession(input.taskId, input.roleName);
    const mode = session?.nativeSessionId === undefined ? "new" : "resume";
    const planned = this.planner.plan({
      taskId: input.taskId,
      roleName: input.roleName,
      agentId: role.activeAgentId,
      adapterId: role.agentBindings[role.activeAgentId]!.adapterId,
      mode,
      ...(mode === "resume" ? { nativeSessionId: session!.nativeSessionId } : {})
    });
    this.tmux.ensureRoleWindow(input.taskId, planned.role, planned.launch);
    if (planned.session?.nativeSessionId !== undefined) {
      this.schedulerStore.recordRuntimeNativeSession({
        taskId: input.taskId,
        roleName: input.roleName,
        agentId: planned.session.agentId,
        adapterId: planned.session.adapterId,
        nativeSessionId: planned.session.nativeSessionId
      });
    }
  }

  prepareGlobalRoleEnter(roleName: string, tmuxTaskId = "operator"): void {
    const role = this.store.getGlobalRole(roleName);
    if (role === null) throw new Error(`Global Role not found: ${roleName}.`);
    const sessionSet = this.store.getGlobalRoleSessionSet(roleName);
    const session = sessionSet?.sessions[role.activeAgentId];
    const binding = role.agentBindings[role.activeAgentId]!;
    const mode = session?.nativeSessionId === undefined ? "new" : "resume";
    const planned = this.planner.planGlobalRole({
      roleName,
      agentId: role.activeAgentId,
      adapterId: binding.adapterId,
      mode,
      ...(mode === "resume" ? { nativeSessionId: session!.nativeSessionId } : {})
    });
    this.tmux.ensureRoleWindow(tmuxTaskId, planned.role, planned.launch);
    if (planned.session?.nativeSessionId !== undefined) {
      this.schedulerStore.recordGlobalRuntimeNativeSession({
        roleName,
        agentId: planned.session.agentId,
        adapterId: planned.session.adapterId,
        nativeSessionId: planned.session.nativeSessionId
      });
    }
  }

  async #prepareAndScan(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (
      task?.repositoryId !== undefined
      && task.cwd === undefined
      && this.workspacePreparer !== undefined
    ) {
      await this.workspacePreparer.prepareTaskWorkspace(taskId);
    }
    await callFileTaskController(this.home, "scheduler.scan", {}, this.clientOptions);
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
