import { reconciliationIntervalMilliseconds } from "../config/yuiConfig.js";
import {
  processLeaderWakeups,
  type LeaderWakeupProcessingResult
} from "../scheduler/leaderWakeupProcessor.js";
import {
  processActiveRoleRunDeliveries,
  type ActiveRoleRunDeliveryResult
} from "../scheduler/activeRoleRunDelivery.js";
import { stopArchivedTaskRuntimes } from "../scheduler/archivedTaskRuntime.js";
import type {
  AutoResolvedInput,
  SchedulerReconcileSelection,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "../scheduler/ports.js";
import { reconcileExitedRoleRuns } from "../scheduler/roleRunLiveness.js";
import {
  processOperatorInputNotifications,
  type OperatorInputNotificationResult
} from "../scheduler/operatorInputNotificationProcessor.js";
import {
  startControllerServer,
  type ControllerDispatcher,
  type RunningControllerServer
} from "../core/controllerServer.js";
import type { JsonValue } from "../core/protocol.js";
import type { TaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";
import { MailboxScheduler } from "../coordination/mailboxScheduler.js";
import { nearestDeadlineBatch } from "../coordination/deadlineScheduler.js";
import type { MailboxTarget, ProcessingBatch } from "../coordination/workMailbox.js";

const DEFAULT_RECONCILIATION_INTERVAL_MS = reconciliationIntervalMilliseconds();
const DEFAULT_SIGNAL_WINDOW_MS = 100;
const DEFAULT_DELIVERY_RETRY_MS = 250;
const DEFAULT_DELIVERY_RETRY_LIMIT = 60;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ControllerSchedulerResult = Readonly<{
  stoppedArchivedTaskIds: readonly string[];
  activeRunDeliveries: readonly ActiveRoleRunDeliveryResult[];
  failedRunIds: readonly string[];
  wakeups: readonly LeaderWakeupProcessingResult[];
  inputNotifications: readonly OperatorInputNotificationResult[];
  autoResolvedInputs: readonly AutoResolvedInput[];
}>;

export type ControllerRuntimeOptions = Readonly<{
  intervalMs?: number;
  signalWindowMs?: number;
  deliveryRetryMs?: number;
  deliveryRetryLimit?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  workspacePreparer?: Pick<
    TaskWorkspacePreparer,
    "prepareTaskWorkspace" | "prepareActiveTaskWorkspaces" | "cleanupArchivedTaskWorkspaces"
  >;
}>;

export type MailboxKey = `task:${string}` | `role:${string}/${string}` | "operator";

export type ReconcileScope =
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "dirty"; keys: readonly MailboxKey[] }>;

export type ReconcileSelection = SchedulerReconcileSelection;

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
    "prepareTaskWorkspace" | "prepareActiveTaskWorkspaces" | "cleanupArchivedTaskWorkspaces"
  >,
  scope: ReconcileScope = { kind: "full" }
): Promise<ControllerSchedulerResult> {
  const selection = compileReconcileSelection(scope);
  const claimedTaskMailboxes = claimSelectedTaskMailboxes(store, selection, now);
  try {
    const failedTaskMailboxes = await prepareActiveWorkspaces(
      store, workspacePreparer, selection
    );
    const taskWorkSelection = selection.full
      ? taskMailboxReconcileSelection(store)
      : selection;
    const stoppedArchivedTaskIds = await stopArchivedTaskRuntimes(
      store, delivery, now, taskWorkSelection
    );
    for (const taskId of await cleanupArchivedWorkspaces(store, workspacePreparer, selection)) {
      failedTaskMailboxes.add(taskId);
    }
    const activeRunDeliveries = await processActiveRoleRunDeliveries(
      store, delivery, now, selection
    );
    const failedRunIds = await reconcileExitedRoleRuns(store, delivery, now, selection);
    if (typeof store.resolveDueRuntimeTurnCompletions === "function") {
      if (selection.full) store.resolveDueRuntimeTurnCompletions(now);
      else if (selection.taskIds.size > 0) {
        store.resolveDueRuntimeTurnCompletions(now, selection.taskIds);
      }
    }
    const autoResolvedInputs = selection.full
      ? store.resolveExpiredInputRecommendations(now)
      : selection.taskIds.size === 0
        ? []
        : store.resolveExpiredInputRecommendations(now, selection.taskIds);
    const wakeups = await processLeaderWakeups(store, delivery, now, selection);
    const inputNotifications = await processOperatorInputNotifications(
      store, delivery, selection, now
    );
    for (const claim of claimedTaskMailboxes) {
      if (failedTaskMailboxes.has(claim.target.taskId)) {
        store.releaseWorkMailbox(claim.target, claim.processing.batchId);
      } else {
        store.completeWorkMailbox(claim.target, claim.processing.batchId);
      }
    }
    return {
      stoppedArchivedTaskIds,
      activeRunDeliveries,
      failedRunIds,
      wakeups,
      inputNotifications,
      autoResolvedInputs
    };
  } catch (error) {
    for (const claim of claimedTaskMailboxes) {
      store.releaseWorkMailbox(claim.target, claim.processing.batchId);
    }
    throw error;
  }
}

type ClaimedTaskMailbox = Readonly<{
  target: Extract<MailboxTarget, { kind: "task" }>;
  processing: ProcessingBatch;
}>;

function taskMailboxReconcileSelection(
  store: SchedulerStorePort
): ReconcileSelection {
  const taskIds = new Set(store.listWorkMailboxes().flatMap((mailbox) => (
    mailbox.target.kind === "task"
    && (mailbox.pending !== null || mailbox.processing !== null)
      ? [mailbox.target.taskId]
      : []
  )));
  return {
    full: false,
    taskIds,
    allRoleTaskIds: taskIds,
    rolesByTask: new Map(),
    operator: false
  };
}

function claimSelectedTaskMailboxes(
  store: SchedulerStorePort,
  selection: ReconcileSelection,
  now: Date
): ClaimedTaskMailbox[] {
  const targets = selection.full
    ? store.listWorkMailboxes().flatMap((mailbox) => (
        mailbox.target.kind === "task" ? [mailbox.target] : []
      ))
    : [...selection.allRoleTaskIds].map((taskId) => ({ kind: "task", taskId } as const));
  const claims: ClaimedTaskMailbox[] = [];
  for (const target of targets) {
    const mailbox = store.getWorkMailbox(target);
    if (mailbox === null || (mailbox.processing === null && mailbox.pending === null)) continue;
    const batchId = mailbox.processing?.batchId
      ?? `task:${encodeURIComponent(target.taskId)}:${mailbox.pending!.fromSequence}-${mailbox.pending!.toSequence}`;
    const claim = store.claimWorkMailbox({
      target,
      batchId,
      owner: "controller",
      now
    });
    if (claim.status !== "empty") claims.push({ target, processing: claim.processing });
  }
  return claims;
}

export function compileReconcileSelection(scope: ReconcileScope): ReconcileSelection {
  if (scope.kind === "full") {
    return {
      full: true,
      taskIds: new Set(),
      allRoleTaskIds: new Set(),
      rolesByTask: new Map(),
      operator: true
    };
  }
  const taskIds = new Set<string>();
  const allRoleTaskIds = new Set<string>();
  const mutableRoles = new Map<string, Set<string>>();
  let operator = false;
  for (const key of scope.keys) {
    const target = parseMailboxKey(key);
    if (target.kind === "operator") {
      operator = true;
    } else if (target.kind === "task") {
      taskIds.add(target.taskId);
      allRoleTaskIds.add(target.taskId);
    } else {
      taskIds.add(target.taskId);
      const roles = mutableRoles.get(target.taskId) ?? new Set<string>();
      roles.add(target.roleName);
      mutableRoles.set(target.taskId, roles);
    }
  }
  return {
    full: false,
    taskIds,
    allRoleTaskIds,
    rolesByTask: mutableRoles,
    operator
  };
}

async function prepareActiveWorkspaces(
  store: SchedulerStorePort,
  workspace: ControllerRuntimeOptions["workspacePreparer"],
  selection: ReconcileSelection
): Promise<Set<string>> {
  if (workspace === undefined) return new Set();
  const taskIds = selection.full
    ? new Set(store.listWorkMailboxes().flatMap((mailbox) => (
        mailbox.target.kind === "task"
        && (mailbox.pending !== null || mailbox.processing !== null)
          ? [mailbox.target.taskId]
          : []
      )))
    : selection.allRoleTaskIds;
  const failed = new Set<string>();
  for (const taskId of taskIds) {
    if (store.getTask(taskId)?.status === "active") {
      const result = await workspace.prepareTaskWorkspace(taskId);
      if (result.status === "failed") failed.add(taskId);
    }
  }
  return failed;
}

async function cleanupArchivedWorkspaces(
  store: SchedulerStorePort,
  workspace: ControllerRuntimeOptions["workspacePreparer"],
  selection: ReconcileSelection
): Promise<Set<string>> {
  if (workspace === undefined) return new Set();
  const taskIds = selection.full
    ? new Set(store.listWorkMailboxes().flatMap((mailbox) => (
        mailbox.target.kind === "task"
        && (mailbox.pending !== null || mailbox.processing !== null)
          ? [mailbox.target.taskId]
          : []
      )))
    : selection.taskIds;
  const failed = new Set<string>();
  for (const taskId of taskIds) {
    if (store.getTask(taskId)?.status === "archived") {
      const result = await workspace.prepareTaskWorkspace(taskId);
      if (result.status === "failed") failed.add(taskId);
    }
  }
  return failed;
}

function parseMailboxKey(key: string):
  | Readonly<{ kind: "task"; taskId: string }>
  | Readonly<{ kind: "role"; taskId: string; roleName: string }>
  | Readonly<{ kind: "operator" }> {
  if (key === "operator") return { kind: "operator" };
  if (key.startsWith("task:")) {
    return { kind: "task", taskId: mailboxPart(key.slice("task:".length), key) };
  }
  if (key.startsWith("role:")) {
    const value = key.slice("role:".length);
    const separator = value.indexOf("/");
    if (separator > 0 && separator < value.length - 1 && value.indexOf("/", separator + 1) < 0) {
      return {
        kind: "role",
        taskId: mailboxPart(value.slice(0, separator), key),
        roleName: mailboxPart(value.slice(separator + 1), key)
      };
    }
  }
  throw new TypeError(`Controller mailbox key is invalid: ${key}.`);
}

function mailboxPart(value: string, key: string): string {
  if (value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new TypeError(`Controller mailbox key is invalid: ${key}.`);
  }
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0 || decoded.includes("\0") || encodeURIComponent(decoded) !== value) {
      throw new Error("not canonical");
    }
    return decoded;
  } catch {
    throw new TypeError(`Controller mailbox key is invalid: ${key}.`);
  }
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
    "prepareTaskWorkspace" | "prepareActiveTaskWorkspaces" | "cleanupArchivedTaskWorkspaces"
  > | undefined;
  readonly #deliveryRetryMs: number;
  readonly #deliveryRetryLimit: number;
  readonly #deliveryRetryAttempts = new Map<MailboxKey, Readonly<{
    identity: string;
    attempts: number;
  }>>();
  readonly #deliveryRetryTimers = new Map<MailboxKey, NodeJS.Timeout>();
  #timer: NodeJS.Timeout | undefined;
  #deadlineTimer: NodeJS.Timeout | undefined;
  readonly #signalScheduler: MailboxScheduler<MailboxKey>;
  readonly #operatorSignalScheduler: MailboxScheduler<MailboxKey>;
  #current: Promise<ControllerSchedulerResult> | undefined;
  #pendingFull = false;
  readonly #pendingKeys = new Set<MailboxKey>();
  #stopped = false;

  constructor(
    readonly store: SchedulerStorePort,
    readonly delivery: TmuxDeliveryPort,
    options: ControllerRuntimeOptions = {}
  ) {
    this.#intervalMs = positiveInteger(
      options.intervalMs,
      DEFAULT_RECONCILIATION_INTERVAL_MS,
      "Controller reconciliation interval"
    );
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => {});
    this.#workspacePreparer = options.workspacePreparer;
    this.#deliveryRetryMs = positiveInteger(
      options.deliveryRetryMs,
      DEFAULT_DELIVERY_RETRY_MS,
      "Controller delivery retry delay"
    );
    this.#deliveryRetryLimit = positiveInteger(
      options.deliveryRetryLimit,
      DEFAULT_DELIVERY_RETRY_LIMIT,
      "Controller delivery retry limit"
    );
    this.#signalScheduler = new MailboxScheduler(
      async (keys) => { await this.#requestPass({ kind: "dirty", keys }); },
      {
        windowMs: options.signalWindowMs ?? DEFAULT_SIGNAL_WINDOW_MS,
        onError: this.#onError,
        setTimer: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          timer.unref();
          return timer;
        }
      }
    );
    this.#operatorSignalScheduler = new MailboxScheduler(
      async () => {
        await runControllerSchedulerPass(
          this.store,
          this.delivery,
          this.#now(),
          undefined,
          { kind: "dirty", keys: ["operator"] }
        );
        this.#scheduleNextInputDeadline();
      },
      {
        windowMs: options.signalWindowMs ?? DEFAULT_SIGNAL_WINDOW_MS,
        onError: this.#onError,
        setTimer: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          timer.unref();
          return timer;
        }
      }
    );
  }

  get reconciliationIntervalMs(): number {
    return this.#intervalMs;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    if (this.#stopped) throw new Error("Controller runtime is stopped.");
    this.#requestBackgroundPump();
    this.#timer = setInterval(() => {
      this.#requestBackgroundPump();
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    this.#signalScheduler.stop();
    this.#operatorSignalScheduler.stop();
    if (this.#deadlineTimer !== undefined) {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    for (const timer of this.#deliveryRetryTimers.values()) clearTimeout(timer);
    this.#deliveryRetryTimers.clear();
    this.#deliveryRetryAttempts.clear();
  }

  /** Adds one dirty Task key to the fixed-window wake queue and returns immediately. */
  signal(key: string): void {
    if (this.#stopped) throw new Error("Controller runtime is stopped.");
    parseMailboxKey(key);
    if (key === "operator") this.#operatorSignalScheduler.signal("operator");
    else this.#signalScheduler.signal(key as MailboxKey);
  }

  pump(): Promise<ControllerSchedulerResult> {
    return this.#requestPass({ kind: "full" });
  }

  #requestPass(scope: ReconcileScope): Promise<ControllerSchedulerResult> {
    if (this.#stopped) {
      return Promise.reject(new Error("Controller runtime is stopped."));
    }
    if (scope.kind === "full") {
      this.#pendingFull = true;
      this.#pendingKeys.clear();
    } else if (!this.#pendingFull) {
      for (const key of scope.keys) this.#pendingKeys.add(key);
    }
    if (this.#current !== undefined) {
      return this.#current;
    }

    const running = this.#runCoalesced();
    this.#current = running;
    void running.finally(() => {
      if (this.#current === running) this.#current = undefined;
    }).catch(() => {});
    return running;
  }

  #requestBackgroundPump(): void {
    void this.pump().catch(this.#onError);
  }

  async #runCoalesced(): Promise<ControllerSchedulerResult> {
    let result: ControllerSchedulerResult = {
      stoppedArchivedTaskIds: [],
      activeRunDeliveries: [],
      failedRunIds: [],
      wakeups: [],
      inputNotifications: [],
      autoResolvedInputs: []
    };
    let failed = false;
    try {
      while (this.#pendingFull || this.#pendingKeys.size > 0) {
      const scope: ReconcileScope = this.#pendingFull
        ? { kind: "full" }
        : { kind: "dirty", keys: [...this.#pendingKeys] };
      this.#pendingFull = false;
      this.#pendingKeys.clear();
        try {
          result = await runControllerSchedulerPass(
            this.store,
            this.delivery,
            this.#now(),
            this.#workspacePreparer,
            scope
          );
          this.#scheduleDeliveryRetries(result);
        } catch (error) {
          failed = true;
          if (scope.kind === "full") {
            this.#pendingFull = true;
            this.#pendingKeys.clear();
          } else if (!this.#pendingFull) {
            for (const key of scope.keys) this.#pendingKeys.add(key);
          }
          throw error;
        }
        if (this.#stopped) break;
      }
      return result;
    } finally {
      this.#scheduleNextInputDeadline(failed ? this.#intervalMs : 0);
    }
  }

  #scheduleNextInputDeadline(minimumDelayMs = 0): void {
    if (this.#deadlineTimer !== undefined) {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
    if (this.#stopped) return;
    const deadlines = [
      ...this.store.listOpenInputRequests()
      .flatMap((request) => request.policy.kind === "recommended"
        ? [{
            key: `task:${encodeURIComponent(request.taskId)}` as MailboxKey,
            at: Date.parse(request.policy.timeoutAt)
          }]
        : []),
      ...(typeof this.store.listPendingRuntimeTurnCompletions === "function"
        ? this.store.listPendingRuntimeTurnCompletions()
        : []).map((completion) => ({
        key: `role:${encodeURIComponent(completion.taskId)}/${encodeURIComponent(completion.roleName)}` as MailboxKey,
        at: Date.parse(completion.dueAt)
      }))
    ];
    const nearest = nearestDeadlineBatch(deadlines);
    if (nearest === null) return;
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(minimumDelayMs, nearest.at - this.#now().getTime())
    );
    this.#deadlineTimer = setTimeout(() => {
      this.#deadlineTimer = undefined;
      for (const key of nearest.keys) this.#signalScheduler.signal(key);
      void this.#signalScheduler.drain().catch(this.#onError);
    }, delayMs);
    this.#deadlineTimer.unref();
  }

  #scheduleDeliveryRetries(result: ControllerSchedulerResult): void {
    const retry = new Map<MailboxKey, string>();
    const settled = new Set<MailboxKey>();
    for (const delivery of result.activeRunDeliveries) {
      const key = `role:${encodeURIComponent(delivery.taskId)}/${encodeURIComponent(delivery.roleName)}` as const;
      if (delivery.reason === "not-ready"
        || delivery.reason === "runtime-unavailable"
        || delivery.reason === "delivery-uncertain") {
        retry.set(key, delivery.runId);
      }
      else if (delivery.status === "delivered" || delivery.status === "already-delivered") settled.add(key);
    }
    for (const wakeup of result.wakeups) {
      const key = `role:${encodeURIComponent(wakeup.taskId)}/leader` as const;
      if (wakeup.reason === "not-ready" || wakeup.reason === "delivery-uncertain") {
        retry.set(key, wakeup.runId ?? key);
      }
      else if (wakeup.status === "dispatched") settled.add(key);
    }
    for (const key of settled) this.#clearDeliveryRetry(key);
    for (const [key, identity] of retry) {
      const previous = this.#deliveryRetryAttempts.get(key);
      if (previous !== undefined && previous.identity !== identity) this.#clearDeliveryRetry(key);
      if (this.#deliveryRetryTimers.has(key)) continue;
      const attempts = this.#deliveryRetryAttempts.get(key)?.attempts ?? 0;
      if (attempts >= this.#deliveryRetryLimit) continue;
      this.#deliveryRetryAttempts.set(key, { identity, attempts: attempts + 1 });
      const timer = setTimeout(() => {
        this.#deliveryRetryTimers.delete(key);
        if (!this.#stopped) this.#signalScheduler.signal(key);
      }, this.#deliveryRetryMs);
      timer.unref();
      this.#deliveryRetryTimers.set(key, timer);
    }
  }

  #clearDeliveryRetry(key: MailboxKey): void {
    const timer = this.#deliveryRetryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#deliveryRetryTimers.delete(key);
    this.#deliveryRetryAttempts.delete(key);
  }
}

/**
 * Starts the single private Unix-socket Controller for one YUI_HOME. The
 * shared server owns status/stop and rejects a second live instance; this
 * layer adds scheduler.signal/scheduler.scan plus an optional command dispatcher.
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
    if (method === "scheduler.signal") {
      runtime.signal(signalMailboxKey(params));
      return { accepted: true };
    }
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

function signalMailboxKey(value: JsonValue): MailboxKey {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw controllerApplicationError("INVALID_PARAMS", "scheduler.signal params are invalid.");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  if (
    Object.keys(record).length !== 1
    || typeof record.key !== "string"
  ) {
    throw controllerApplicationError("INVALID_PARAMS", "scheduler.signal params are invalid.");
  }
  try {
    parseMailboxKey(record.key);
    return record.key as MailboxKey;
  } catch {
    throw controllerApplicationError("INVALID_PARAMS", "scheduler.signal params are invalid.");
  }
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
