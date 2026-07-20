import {
  processLeaderWakeups,
  type LeaderWakeupProcessingResult
} from "../scheduler/leaderWakeupProcessor.js";
import {
  processActiveRoleRunDeliveries,
  type ActiveRoleRunDeliveryResult
} from "../scheduler/activeRoleRunDelivery.js";
import { stopArchivedTaskRuntimes } from "../scheduler/archivedTaskRuntime.js";
import type { SchedulerStorePort, TmuxDeliveryPort } from "../scheduler/ports.js";
import { reconcileExitedRoleRuns } from "../scheduler/roleRunLiveness.js";
import {
  startControllerServer,
  type ControllerDispatcher,
  type RunningControllerServer
} from "../core/controllerServer.js";
import type { JsonValue } from "../core/protocol.js";
import type { TaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";

const DEFAULT_SCAN_INTERVAL_MS = 1_000;

export type ControllerSchedulerResult = Readonly<{
  stoppedArchivedTaskIds: readonly string[];
  activeRunDeliveries: readonly ActiveRoleRunDeliveryResult[];
  failedRunIds: readonly string[];
  wakeups: readonly LeaderWakeupProcessingResult[];
}>;

export type ControllerRuntimeOptions = Readonly<{
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  workspacePreparer?: Pick<
    TaskWorkspacePreparer,
    "prepareActiveTaskWorkspaces" | "cleanupArchivedTaskWorkspaces"
  >;
}>;

export type RunningFileTaskController = Readonly<{
  runtime: FileTaskController;
  server: RunningControllerServer;
  closed: Promise<void>;
  close(): Promise<void>;
}>;

/**
 * Runs one lean scheduler pass. Liveness always precedes wakeup processing so
 * an exited busy Leader is cleared and reconsidered in the same pass.
 */
export async function runControllerSchedulerPass(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  workspacePreparer?: Pick<
    TaskWorkspacePreparer,
    "prepareActiveTaskWorkspaces" | "cleanupArchivedTaskWorkspaces"
  >
): Promise<ControllerSchedulerResult> {
  await workspacePreparer?.prepareActiveTaskWorkspaces();
  const stoppedArchivedTaskIds = await stopArchivedTaskRuntimes(store, delivery, now);
  await workspacePreparer?.cleanupArchivedTaskWorkspaces();
  const activeRunDeliveries = await processActiveRoleRunDeliveries(store, delivery, now);
  const failedRunIds = await reconcileExitedRoleRuns(store, delivery, now);
  const wakeups = await processLeaderWakeups(store, delivery, now);
  return { stoppedArchivedTaskIds, activeRunDeliveries, failedRunIds, wakeups };
}

/**
 * Single-owner periodic runtime for FileTaskStore-backed scheduling. Concurrent
 * pump requests coalesce into one follow-up pass; scheduler effects never
 * overlap. There are deliberately no filesystem watchers or derived indexes.
 */
export class FileTaskController {
  readonly #intervalMs: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #workspacePreparer: Pick<
    TaskWorkspacePreparer,
    "prepareActiveTaskWorkspaces" | "cleanupArchivedTaskWorkspaces"
  > | undefined;
  #timer: NodeJS.Timeout | undefined;
  #current: Promise<ControllerSchedulerResult> | undefined;
  #rerunRequested = false;
  #stopped = false;

  constructor(
    readonly store: SchedulerStorePort,
    readonly delivery: TmuxDeliveryPort,
    options: ControllerRuntimeOptions = {}
  ) {
    this.#intervalMs = positiveInteger(
      options.intervalMs,
      DEFAULT_SCAN_INTERVAL_MS,
      "Controller scan interval"
    );
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => {});
    this.#workspacePreparer = options.workspacePreparer;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#stopped = false;
    void this.pump().catch(this.#onError);
    this.#timer = setInterval(() => {
      void this.pump().catch(this.#onError);
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  pump(): Promise<ControllerSchedulerResult> {
    if (this.#stopped) {
      return Promise.reject(new Error("Controller runtime is stopped."));
    }
    if (this.#current !== undefined) {
      this.#rerunRequested = true;
      return this.#current;
    }

    const running = this.#runCoalesced();
    this.#current = running;
    void running.finally(() => {
      if (this.#current === running) this.#current = undefined;
    }).catch(() => {});
    return running;
  }

  async #runCoalesced(): Promise<ControllerSchedulerResult> {
    let result: ControllerSchedulerResult = {
      stoppedArchivedTaskIds: [], activeRunDeliveries: [], failedRunIds: [], wakeups: []
    };
    do {
      this.#rerunRequested = false;
      result = await runControllerSchedulerPass(
        this.store,
        this.delivery,
        this.#now(),
        this.#workspacePreparer
      );
    } while (this.#rerunRequested && !this.#stopped);
    return result;
  }
}

/**
 * Starts the single private Unix-socket Controller for one TASKMUX_HOME. The
 * shared server owns status/stop and rejects a second live instance; this
 * layer adds only scheduler.scan plus an optional command dispatcher.
 */
export async function startFileTaskController(
  home: string,
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  dispatcher?: ControllerDispatcher,
  options: ControllerRuntimeOptions = {}
): Promise<RunningFileTaskController> {
  const runtime = new FileTaskController(store, delivery, options);
  const server = await startControllerServer(home, async (method, params) => {
    if (method === "scheduler.scan") {
      if (!isEmptyJsonObject(params)) {
        throw controllerApplicationError("INVALID_PARAMS", "scheduler.scan params are invalid.");
      }
      return schedulerResultJson(await runtime.pump());
    }
    if (dispatcher === undefined) {
      throw controllerApplicationError("METHOD_NOT_FOUND", "Controller method was not found.");
    }
    return dispatcher(method, params);
  });
  runtime.start();
  const closed = server.closed.finally(() => runtime.stop());
  return {
    runtime,
    server,
    closed,
    close: async () => {
      runtime.stop();
      await server.close();
    }
  };
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return resolved;
}

function schedulerResultJson(result: ControllerSchedulerResult): JsonValue {
  return JSON.parse(JSON.stringify(result)) as JsonValue;
}

function isEmptyJsonObject(value: JsonValue): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

function controllerApplicationError(
  code: "INVALID_PARAMS" | "METHOD_NOT_FOUND",
  message: string
): Error {
  const error = Object.assign(new Error(message), { code });
  error.name = "CoreApplicationError";
  return error;
}
