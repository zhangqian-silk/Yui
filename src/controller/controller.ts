import { reconciliationIntervalMilliseconds } from "../config/yuiConfig.js";
import {
  processLeaderWakeups,
  type LeaderWakeupProcessingResult
} from "../scheduler/leaderWakeupProcessor.js";
import {
  processActiveRoleRunDeliveries,
  type ActiveRoleRunDeliveryResult
} from "../scheduler/activeRoleRunDelivery.js";
import type {
  AutoResolvedInput,
  RoleRunDeliveryFailurePersistence,
  SchedulerReconcileSelection,
  SchedulerStorePort,
  TmuxDeliveryPort
} from "../scheduler/ports.js";
import { reconcileExitedRoleRuns } from "../scheduler/roleRunLiveness.js";
import {
  DEFAULT_STALL_WINDOW_MS,
  reconcileStalledRoleRuns,
  type RoleRunResourceEvidence
} from "../scheduler/roleRunStall.js";
import { repairOrphanedActiveTasks } from "../scheduler/activeTaskProgress.js";
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
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  type RuntimeLifecycleTarget,
  type RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import type { SessionHostPort } from "../runtime/ports.js";
import { formatTaskRecordReference } from "../task/taskRecordReference.js";
import type { RuntimeEventProcessorPort } from "./runtimeEventProcessor.js";

const DEFAULT_RECONCILIATION_INTERVAL_MS = reconciliationIntervalMilliseconds();
const DEFAULT_SIGNAL_WINDOW_MS = 100;
const DEFAULT_DELIVERY_RETRY_MS = 250;
const DEFAULT_DELIVERY_RETRY_LIMIT = 60;
const RUNTIME_RESERVATION_RECOVERY_AGE_MS = 120_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

class RuntimeEventApplyError extends AggregateError {}

type RuntimeLifecycleHost = Pick<
  SessionHostPort,
  "inspectOwner" | "inspectOwners" | "stopOwner"
>;

type RoleRunDeliveryFailureIdentity = Omit<
  RoleRunDeliveryFailurePersistence,
  "now"
>;

export type ControllerSchedulerResult = Readonly<{
  activeRunDeliveries: readonly ActiveRoleRunDeliveryResult[];
  failedRunRefs: readonly string[];
  wakeups: readonly LeaderWakeupProcessingResult[];
  inputNotifications: readonly OperatorInputNotificationResult[];
  autoResolvedInputs: readonly AutoResolvedInput[];
}>;

export type ControllerRuntimeOptions = Readonly<{
  intervalMs?: number;
  signalWindowMs?: number;
  deliveryRetryMs?: number;
  deliveryRetryLimit?: number;
  stallWindowMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  workspacePreparer?: Pick<TaskWorkspacePreparer, "prepareTaskWorkspace">;
  runtimeEventProcessor?: RuntimeEventProcessorPort;
  lifecycleHost?: RuntimeLifecycleHost;
  configuration?: ControllerConfigurationPort;
}>;

export interface ControllerConfigurationPort {
  reconciliationIntervalMs(): number;
}

export type MailboxKey =
  | `task:${string}`
  | `role:${string}/${string}`
  | `global-role:${string}`
  | "operator";

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
 * Runs one lean scheduler pass. Due native Turn completions are folded before
 * liveness, so a valid Hook boundary fences destructive process reconciliation.
 */
export async function runControllerSchedulerPass(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  now: Date,
  workspacePreparer?: Pick<TaskWorkspacePreparer, "prepareTaskWorkspace">,
  scope: ReconcileScope = { kind: "full" },
  includeOperator = true,
  runtimeCleanupOutcomes: RuntimeCleanupOutcome[] = [],
  lifecycleHost?: RuntimeLifecycleHost,
  stallWindowMs = DEFAULT_STALL_WINDOW_MS,
  resourceSuppressionKeys: Set<string> = new Set()
): Promise<ControllerSchedulerResult> {
  const compiledSelection = compileReconcileSelection(scope);
  const selection = includeOperator
    ? compiledSelection
    : { ...compiledSelection, operator: false };
  const failedCleanupRoles = await processSelectedRoleRuntimeCleanups(
    store,
    delivery,
    lifecycleHost,
    scope,
    now,
    runtimeCleanupOutcomes
  );
  const roleSelection = selectionWithoutFailedCleanupRoles(
    store,
    selection,
    failedCleanupRoles
  );
  const wakeupSelection = selectionWithoutFailedLeaderCleanupTasks(
    store,
    selection,
    failedCleanupRoles
  );
  if (selection.full) repairOrphanedActiveTasks(store, now, selection);
  const claimedTaskMailboxes = claimSelectedTaskMailboxes(store, selection, now);
  try {
    const failedTaskMailboxes = await prepareActiveWorkspaces(
      store, workspacePreparer, selection
    );
    const activeRunDeliveries = await processActiveRoleRunDeliveries(
      store, delivery, now, roleSelection
    );
    const unsettledRunRefs = new Set(activeRunDeliveries.flatMap((result) => (
      result.reason === "delivery-uncertain" || result.terminalFailure !== undefined
        ? [formatTaskRecordReference(result.taskId, result.runId, "agentRun")]
        : []
    )));
    resolveDueRuntimeTurnCompletions(store, delivery, selection, now);
    const liveStatuses = new Map<string, "present" | "absent">();
    const resourceEvidence = new Map<string, RoleRunResourceEvidence>();
    const failedRunRefs = await reconcileExitedRoleRuns(
      store,
      delivery,
      now,
      roleSelection,
      unsettledRunRefs,
      liveStatuses,
      resourceEvidence
    );
    await reconcileStalledRoleRuns(
      store,
      delivery,
      now,
      roleSelection,
      stallWindowMs,
      liveStatuses,
      resourceEvidence,
      resourceSuppressionKeys
    );
    await reconcileDormantRuntimeOwners(
      store,
      delivery,
      lifecycleHost,
      scope,
      now
    );
    const autoResolvedInputs = selection.full
      ? store.resolveExpiredInputRecommendations(now)
      : selection.taskIds.size === 0
        ? []
        : store.resolveExpiredInputRecommendations(now, selection.taskIds);
    const wakeups = await processLeaderWakeups(store, delivery, now, wakeupSelection);
    const inputNotifications = includeOperator
      ? await processOperatorInputNotifications(store, delivery, selection, now)
      : [];
    for (const claim of claimedTaskMailboxes) {
      if (failedTaskMailboxes.has(claim.target.taskId)) {
        store.releaseWorkMailbox(claim.target, claim.processing.batchId);
      } else {
        store.completeWorkMailbox(claim.target, claim.processing.batchId);
      }
    }
    return {
      activeRunDeliveries,
      failedRunRefs,
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

type RuntimeCleanupOutcome = Readonly<{
  target: RuntimeLifecycleTarget;
  batchId: string;
  status: "completed" | "failed";
  error?: unknown;
}>;

async function processSelectedRoleRuntimeCleanups(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  lifecycleHost: RuntimeLifecycleHost | undefined,
  scope: ReconcileScope,
  now: Date,
  outcomes: RuntimeCleanupOutcome[]
): Promise<ReadonlySet<string>> {
  const targets = selectedRuntimeLifecycleTargets(store, scope);
  const failedRoles = new Set<string>();
  for (const target of targets) {
    const mailbox = store.getWorkMailbox(target);
    if (mailbox === null) continue;
    const owner = runtimeOwner(target);
    const batchId = runtimeLifecycleBatchIdentity(target, mailbox);
    if (hasRuntimeCleanupObligation(mailbox)) {
      try {
        if (lifecycleHost === undefined) {
          throw new Error("Role runtime cleanup host is unavailable.");
        }
        if (!await lifecycleHost.stopOwner(owner)) {
          throw new Error(
            `Role runtime cleanup could not confirm the host stopped: ${runtimeOwnerLabel(owner)}.`
          );
        }
        if (
          store.completeRuntimeCleanup === undefined
          || !store.completeRuntimeCleanup(target, now)
        ) {
          throw new Error(
            `Role runtime cleanup mailbox changed: ${runtimeOwnerLabel(owner)}.`
          );
        }
        forgetPreparedRuntimeOwner(delivery, owner);
        outcomes.push({ target, batchId, status: "completed" });
      } catch (error) {
        markFailedRuntimeTarget(failedRoles, target);
        outcomes.push({ target, batchId, status: "failed", error });
      }
      continue;
    }
    const reservation = mailbox.processing;
    if (
      reservation === null
      || !isRuntimeLaunchReservation(reservation)
      || now.getTime() - Date.parse(reservation.startedAt)
        < RUNTIME_RESERVATION_RECOVERY_AGE_MS
    ) {
      continue;
    }
    try {
      if (lifecycleHost === undefined) {
        throw new Error("Role runtime reservation inspection is unavailable.");
      }
      const inspection = await lifecycleHost.inspectOwner(owner);
      if (inspection.state === "running" || inspection.state === "starting") {
        continue;
      }
      if (inspection.state === "unavailable") {
        throw new Error(
          `Role runtime reservation could not inspect the host: ${runtimeOwnerLabel(owner)}.`
        );
      }
      const completed = store.completeStoppedRuntimeReservation === undefined
        ? store.completeWorkMailbox(target, reservation.batchId)
        : store.completeStoppedRuntimeReservation(
            target,
            reservation.batchId,
            now
          );
      if (!completed) {
        throw new Error(
          `Role runtime reservation mailbox changed: ${runtimeOwnerLabel(owner)}.`
        );
      }
      forgetPreparedRuntimeOwner(delivery, owner);
      outcomes.push({ target, batchId, status: "completed" });
    } catch (error) {
      markFailedRuntimeTarget(failedRoles, target);
      outcomes.push({ target, batchId, status: "failed", error });
    }
  }
  return failedRoles;
}

async function reconcileDormantRuntimeOwners(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  lifecycleHost: RuntimeLifecycleHost | undefined,
  scope: ReconcileScope,
  now: Date
): Promise<void> {
  if (
    scope.kind !== "full"
    || lifecycleHost === undefined
    || store.listDormantRuntimeOwners === undefined
    || store.markRuntimeOwnerStopped === undefined
  ) {
    return;
  }
  const candidates = store.listDormantRuntimeOwners();
  if (candidates.length === 0) return;
  const owners = candidates.map((candidate) => candidate.owner);
  let inspections: readonly Readonly<{
    owner: RuntimeRoleOwner;
    inspection: Awaited<ReturnType<SessionHostPort["inspectOwner"]>>;
  }>[];
  try {
    inspections = lifecycleHost.inspectOwners === undefined
      ? await Promise.all(owners.map(async (owner) => ({
          owner,
          inspection: await lifecycleHost.inspectOwner(owner)
        })))
      : await lifecycleHost.inspectOwners(owners);
  } catch {
    // Host inventory is an advisory safety scan. Unknown state must never
    // mutate persisted session facts; the next full pass will retry.
    return;
  }
  const requested = new Set(owners.map(runtimeOwnerIdentity));
  const byOwner = new Map<string, (typeof inspections)[number]["inspection"]>();
  for (const result of inspections) {
    const identity = runtimeOwnerIdentity(result.owner);
    if (
      !requested.has(identity)
      || byOwner.has(identity)
    ) {
      return;
    }
    byOwner.set(identity, result.inspection);
  }
  if (byOwner.size !== requested.size) return;
  for (const candidate of candidates) {
    if (
      byOwner.get(runtimeOwnerIdentity(candidate.owner))?.state
      === "stopped"
    ) {
      if (store.markRuntimeOwnerStopped(candidate, now)) {
        forgetPreparedRuntimeOwner(delivery, candidate.owner);
      }
    }
  }
}

function forgetPreparedRuntimeOwner(
  delivery: TmuxDeliveryPort,
  owner: RuntimeRoleOwner
): void {
  if (owner.scope !== "task") return;
  delivery.forgetPrepared?.({
    taskId: owner.taskId,
    roleName: owner.roleName
  });
}

function runtimeOwnerIdentity(owner: RuntimeRoleOwner): string {
  return owner.scope === "task"
    ? `task\0${owner.taskId}\0${owner.roleName}`
    : `global\0${owner.roleName}`;
}

function resolveDueRuntimeTurnCompletions(
  store: SchedulerStorePort,
  delivery: TmuxDeliveryPort,
  selection: ReconcileSelection,
  now: Date
): void {
  if (typeof store.resolveDueRuntimeTurnCompletions !== "function") return;
  const selectedTaskIds = selection.full ? undefined : selection.taskIds;
  if (selectedTaskIds?.size === 0) return;
  const candidates = store.listPendingRuntimeTurnCompletions().filter(
    (completion) => (
      selectedTaskIds === undefined
      || selectedTaskIds.has(completion.taskId)
    )
  );
  const finalized = new Set(
    store.resolveDueRuntimeTurnCompletions(now, selectedTaskIds)
  );
  if (finalized.size === 0) return;
  for (const completion of candidates) {
    if (!finalized.has(formatTaskRecordReference(
      completion.taskId,
      completion.runId,
      "agentRun"
    ))) continue;
    delivery.forgetPrepared?.({
      taskId: completion.taskId,
      roleName: completion.roleName,
      runId: completion.runId
    });
  }
}

function selectedRuntimeLifecycleTargets(
  store: SchedulerStorePort,
  scope: ReconcileScope
): RuntimeLifecycleTarget[] {
  if (scope.kind === "full") {
    return store.listWorkMailboxes().flatMap((mailbox) => (
      mailbox.target.kind === "role-runtime"
      || mailbox.target.kind === "global-role-runtime"
        ? [mailbox.target]
        : []
    ));
  }
  const targets = new Map<string, RuntimeLifecycleTarget>();
  for (const key of scope.keys) {
    const parsed = parseMailboxKey(key);
    if (parsed.kind === "task") {
      for (const role of store.listRoles(parsed.taskId)) {
        const target = {
          kind: "role-runtime",
          taskId: parsed.taskId,
          roleName: role.name
        } as const;
        targets.set(runtimeTargetIdentity(target), target);
      }
    } else if (parsed.kind === "role") {
      const target = {
        kind: "role-runtime",
        taskId: parsed.taskId,
        roleName: parsed.roleName
      } as const;
      targets.set(runtimeTargetIdentity(target), target);
    } else if (parsed.kind === "global-role") {
      const target = {
        kind: "global-role-runtime",
        roleName: parsed.roleName
      } as const;
      targets.set(runtimeTargetIdentity(target), target);
    }
  }
  return [...targets.values()];
}

function runtimeOwner(target: RuntimeLifecycleTarget): RuntimeRoleOwner {
  return target.kind === "role-runtime"
    ? {
        scope: "task",
        taskId: target.taskId,
        roleName: target.roleName
      }
    : { scope: "global", roleName: target.roleName };
}

function runtimeOwnerLabel(owner: RuntimeRoleOwner): string {
  return owner.scope === "task"
    ? `${owner.taskId}/${owner.roleName}`
    : `global/${owner.roleName}`;
}

function runtimeTargetIdentity(target: RuntimeLifecycleTarget): string {
  return target.kind === "role-runtime"
    ? `task\0${target.taskId}\0${target.roleName}`
    : `global\0${target.roleName}`;
}

function runtimeCleanupMailboxKey(target: RuntimeLifecycleTarget): MailboxKey {
  return target.kind === "role-runtime"
    ? `role:${encodeURIComponent(target.taskId)}/${encodeURIComponent(target.roleName)}`
    : `global-role:${encodeURIComponent(target.roleName)}`;
}

function runtimeLifecycleBatchIdentity(
  target: RuntimeLifecycleTarget,
  mailbox: NonNullable<ReturnType<SchedulerStorePort["getWorkMailbox"]>>
): string {
  if (mailbox.processing !== null) return mailbox.processing.batchId;
  const pending = mailbox.pending;
  return pending === null
    ? runtimeTargetIdentity(target)
    : `${runtimeTargetIdentity(target)}:${pending.fromSequence}-${pending.toSequence}`;
}

function markFailedRuntimeTarget(
  failedRoles: Set<string>,
  target: RuntimeLifecycleTarget
): void {
  if (target.kind === "role-runtime") {
    failedRoles.add(roleIdentity(target.taskId, target.roleName));
  }
}

function selectionWithoutFailedCleanupRoles(
  store: SchedulerStorePort,
  selection: ReconcileSelection,
  failedRoles: ReadonlySet<string>
): ReconcileSelection {
  if (failedRoles.size === 0) return selection;
  const taskIds = selection.full
    ? new Set(store.listTasks().map((task) => task.id))
    : new Set(selection.taskIds);
  const rolesByTask = new Map<string, ReadonlySet<string>>();
  for (const taskId of taskIds) {
    const roleNames = selection.full || selection.allRoleTaskIds.has(taskId)
      ? store.listRoles(taskId).map((role) => role.name)
      : [...(selection.rolesByTask.get(taskId) ?? [])];
    rolesByTask.set(taskId, new Set(roleNames.filter((roleName) => (
      !failedRoles.has(roleIdentity(taskId, roleName))
    ))));
  }
  return {
    full: false,
    taskIds,
    allRoleTaskIds: new Set(),
    rolesByTask,
    operator: selection.operator
  };
}

function selectionWithoutFailedLeaderCleanupTasks(
  store: SchedulerStorePort,
  selection: ReconcileSelection,
  failedRoles: ReadonlySet<string>
): ReconcileSelection {
  if (![...failedRoles].some((identity) => identity.endsWith("\0leader"))) {
    return selection;
  }
  const taskIds = selection.full
    ? new Set(store.listTasks().map((task) => task.id))
    : new Set(selection.taskIds);
  for (const taskId of taskIds) {
    if (failedRoles.has(roleIdentity(taskId, "leader"))) taskIds.delete(taskId);
  }
  return {
    full: false,
    taskIds,
    allRoleTaskIds: new Set(),
    rolesByTask: new Map(),
    operator: selection.operator
  };
}

function roleIdentity(taskId: string, roleName: string): string {
  return `${taskId}\0${roleName}`;
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
    } else if (target.kind === "role") {
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
      try {
        const result = await workspace.prepareTaskWorkspace(taskId);
        if (result.status === "failed") failed.add(taskId);
      } catch {
        failed.add(taskId);
      }
    }
  }
  return failed;
}

function parseMailboxKey(key: string):
  | Readonly<{ kind: "task"; taskId: string }>
  | Readonly<{ kind: "role"; taskId: string; roleName: string }>
  | Readonly<{ kind: "global-role"; roleName: string }>
  | Readonly<{ kind: "operator" }> {
  if (key === "operator") return { kind: "operator" };
  if (key.startsWith("task:")) {
    return { kind: "task", taskId: mailboxPart(key.slice("task:".length), key) };
  }
  if (key.startsWith("global-role:")) {
    return {
      kind: "global-role",
      roleName: mailboxPart(key.slice("global-role:".length), key)
    };
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
  #intervalMs: number;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #workspacePreparer:
    | Pick<TaskWorkspacePreparer, "prepareTaskWorkspace">
    | undefined;
  readonly #deliveryRetryMs: number;
  readonly #deliveryRetryLimit: number;
  readonly #stallWindowMs: number;
  /** Narrow-port fallback; FileSchedulerStoreAdapter durably records these keys. */
  readonly #resourceSuppressionKeys = new Set<string>();
  readonly #runtimeEventProcessor: RuntimeEventProcessorPort | undefined;
  readonly #lifecycleHost:
    | RuntimeLifecycleHost
    | undefined;
  readonly #deliveryRetryAttempts = new Map<MailboxKey, Readonly<{
    identity: string;
    attempts: number;
    terminalFailure?: RoleRunDeliveryFailureIdentity;
  }>>();
  readonly #deliveryRetryTimers = new Map<MailboxKey, NodeJS.Timeout>();
  #passRetryTimer: NodeJS.Timeout | undefined;
  #passRetryAttempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #deadlineTimer: NodeJS.Timeout | undefined;
  readonly #signalScheduler: MailboxScheduler<MailboxKey>;
  readonly #operatorSignalScheduler: MailboxScheduler<MailboxKey>;
  readonly #configuration: ControllerConfigurationPort | undefined;
  #current: Promise<ControllerSchedulerResult> | undefined;
  #operatorCurrent: Promise<void> | undefined;
  #pendingFull = false;
  readonly #pendingKeys = new Set<MailboxKey>();
  #operatorStartupRetryArmed = false;
  #lastOperatorSignalIdentity: string | undefined;
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
    this.#stallWindowMs = positiveInteger(
      options.stallWindowMs,
      DEFAULT_STALL_WINDOW_MS,
      "Controller Run stall window"
    );
    this.#runtimeEventProcessor = options.runtimeEventProcessor;
    this.#lifecycleHost = options.lifecycleHost;
    this.#configuration = options.configuration;
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
        const running = this.#runOperatorPass();
        this.#operatorCurrent = running;
        try {
          await running;
        } finally {
          if (this.#operatorCurrent === running) this.#operatorCurrent = undefined;
        }
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

  updateReconciliationInterval(intervalMs: number): void {
    const next = positiveInteger(
      intervalMs,
      DEFAULT_RECONCILIATION_INTERVAL_MS,
      "Controller reconciliation interval"
    );
    if (this.#stopped) throw new Error("Controller runtime is stopped.");
    if (next === this.#intervalMs) return;
    this.#intervalMs = next;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = setInterval(() => {
        this.#requestBackgroundPump();
      }, this.#intervalMs);
      this.#timer.unref();
    }
  }

  reloadReconciliationInterval(): number {
    if (this.#configuration !== undefined) {
      this.updateReconciliationInterval(
        this.#configuration.reconciliationIntervalMs()
      );
    }
    return this.#intervalMs;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    if (this.#stopped) throw new Error("Controller runtime is stopped.");
    this.#requestBackgroundPump();
    // Arm the Operator lane once for work that was already pending when the
    // Controller started. Subsequent main-lane passes signal it only when a
    // new Operator batch is durably queued; an unchanged pending batch must
    // not keep an unavailable Operator lane in a zero-delay drain loop.
    this.#signalOperatorMailbox();
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
    if (this.#passRetryTimer !== undefined) {
      clearTimeout(this.#passRetryTimer);
      this.#passRetryTimer = undefined;
    }
  }

  async shutdownAndDrain(): Promise<void> {
    this.stop();
    await Promise.allSettled([
      this.#current ?? Promise.resolve(),
      this.#operatorCurrent ?? Promise.resolve()
    ]);
  }

  /** Adds one dirty Task key to the fixed-window wake queue and returns immediately. */
  signal(key: string): void {
    if (this.#stopped) throw new Error("Controller runtime is stopped.");
    parseMailboxKey(key);
    if (key === "operator") {
      // Main lane owns durable Hook folding; the Operator lane is the sole
      // consumer of the Operator delivery mailbox.
      this.#signalScheduler.signal("operator");
      this.#operatorSignalScheduler.signal("operator");
    }
    else this.#signalScheduler.signal(key as MailboxKey);
  }

  pump(): Promise<ControllerSchedulerResult> {
    return this.#requestPass({ kind: "full" });
  }

  armOperatorStartupRetry(): void {
    if (this.#stopped) return;
    const mailbox = this.store.getWorkMailbox({ kind: "operator" });
    const shouldArm = mailbox !== null
      && (mailbox.pending !== null || mailbox.processing !== null);
    if (shouldArm) this.#clearDeliveryRetry("operator");
    this.#operatorStartupRetryArmed = shouldArm;
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
      activeRunDeliveries: [],
      failedRunRefs: [],
      wakeups: [],
      inputNotifications: [],
      autoResolvedInputs: []
    };
    try {
      while (this.#pendingFull || this.#pendingKeys.size > 0) {
        const scope: ReconcileScope = this.#pendingFull
          ? { kind: "full" }
          : { kind: "dirty", keys: [...this.#pendingKeys] };
        const runtimeCleanupOutcomes: RuntimeCleanupOutcome[] = [];
        this.#pendingFull = false;
        this.#pendingKeys.clear();
        try {
          if (scope.kind === "full") this.reloadReconciliationInterval();
          const firstRuntimeDrain = this.#drainRuntimeEvents();
          result = await runControllerSchedulerPass(
            this.store,
            this.delivery,
            this.#now(),
            this.#workspacePreparer,
            scope,
            false,
            runtimeCleanupOutcomes,
            this.#lifecycleHost,
            this.#stallWindowMs,
            this.#resourceSuppressionKeys
          );
          const secondRuntimeDrain = this.#drainRuntimeEvents();
          this.#clearPassRetry();
          this.#scheduleRuntimeCleanupRetries(runtimeCleanupOutcomes);
          this.#scheduleDeliveryRetries(result);
          this.#scheduleTaskMailboxRetries(scope);
          if (
            scope.kind === "full"
            || scope.keys.some((key) => key !== "operator")
            || (firstRuntimeDrain?.acknowledgedEventIds.length ?? 0) > 0
            || (secondRuntimeDrain?.acknowledgedEventIds.length ?? 0) > 0
          ) {
            this.#signalOperatorMailbox();
          }
        } catch (error) {
          if (scope.kind === "full") {
            this.#pendingFull = true;
            this.#pendingKeys.clear();
          } else if (!this.#pendingFull) {
            for (const key of scope.keys) this.#pendingKeys.add(key);
          }
          this.#schedulePassRetry();
          throw error;
        }
        if (this.#stopped) break;
      }
      return result;
    } finally {
      this.#scheduleNextInputDeadline();
    }
  }

  async #runOperatorPass(): Promise<void> {
    const result = await runControllerSchedulerPass(
      this.store,
      this.delivery,
      this.#now(),
      undefined,
      { kind: "dirty", keys: ["operator"] }
    );
    if (this.#operatorStartupRetryArmed && result.inputNotifications.length === 0) {
      const mailbox = this.store.getWorkMailbox({ kind: "operator" });
      if (
        mailbox === null
        || (mailbox.pending === null && mailbox.processing === null)
      ) {
        this.#operatorStartupRetryArmed = false;
      }
    }
    this.#scheduleDeliveryRetries(result);
    this.#clearEmptyOperatorRetry();
    this.#scheduleNextInputDeadline();
  }

  #signalOperatorMailbox(): void {
    if (this.#stopped) return;
    const mailbox = this.store.getWorkMailbox({ kind: "operator" });
    const identity = operatorMailboxBatchIdentity(mailbox);
    if (identity === null) {
      this.#lastOperatorSignalIdentity = undefined;
      return;
    }
    if (identity !== this.#lastOperatorSignalIdentity) {
      this.#operatorSignalScheduler.signal("operator");
      this.#lastOperatorSignalIdentity = identity;
    }
  }

  #drainRuntimeEvents(): ReturnType<RuntimeEventProcessorPort["drain"]> | undefined {
    const result = this.#runtimeEventProcessor?.drain(this.#now());
    if (result !== undefined && result.failed.length > 0) {
      throw new RuntimeEventApplyError(
        result.failed.map((failure) => failure.error),
        "One or more native Turn events could not be applied."
      );
    }
    return result;
  }

  #schedulePassRetry(): void {
    if (
      this.#stopped
      || this.#passRetryTimer !== undefined
      || this.#passRetryAttempt >= this.#deliveryRetryLimit
    ) return;
    const delayMs = Math.min(
      2_000,
      this.#deliveryRetryMs * (2 ** Math.min(this.#passRetryAttempt, 3))
    );
    this.#passRetryAttempt += 1;
    this.#passRetryTimer = setTimeout(() => {
      this.#passRetryTimer = undefined;
      if (this.#stopped) return;
      void this.#requestPass({ kind: "dirty", keys: [] }).catch(this.#onError);
    }, delayMs);
    this.#passRetryTimer.unref();
  }

  #clearPassRetry(): void {
    if (this.#passRetryTimer !== undefined) clearTimeout(this.#passRetryTimer);
    this.#passRetryTimer = undefined;
    this.#passRetryAttempt = 0;
  }

  #scheduleNextInputDeadline(): void {
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
    const now = this.#now().getTime();
    // Preserve an upcoming semantic deadline even while another pass backs
    // off. Once that deadline has fired, the bounded pass retry owns failures
    // so an overdue record cannot create a zero-delay hot loop.
    if (nearest.at <= now && this.#passRetryAttempt > 0) return;
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, nearest.at - now)
    );
    this.#deadlineTimer = setTimeout(() => {
      this.#deadlineTimer = undefined;
      for (const key of nearest.keys) this.#signalScheduler.signal(key);
      void this.#signalScheduler.drain().catch(this.#onError);
    }, delayMs);
    this.#deadlineTimer.unref();
  }

  #scheduleDeliveryRetries(result: ControllerSchedulerResult): void {
    const retry = new Map<MailboxKey, Readonly<{
      identity: string;
      terminalFailure?: RoleRunDeliveryFailureIdentity;
    }>>();
    const settled = new Set<MailboxKey>();
    const resignal = new Set<MailboxKey>();
    for (const delivery of result.activeRunDeliveries) {
      const key = `role:${encodeURIComponent(delivery.taskId)}/${encodeURIComponent(delivery.roleName)}` as const;
      if (delivery.terminalized === true) {
        settled.add(key);
        resignal.add(key);
      }
      else if (delivery.reason === "not-ready"
        || delivery.reason === "runtime-unavailable"
        || delivery.reason === "delivery-uncertain") {
        retry.set(key, {
          identity: delivery.runId,
          ...(delivery.terminalFailure === undefined
            ? {}
            : { terminalFailure: delivery.terminalFailure })
        });
      }
      else if (delivery.status === "delivered" || delivery.status === "already-delivered") settled.add(key);
    }
    for (const wakeup of result.wakeups) {
      const key = `role:${encodeURIComponent(wakeup.taskId)}/leader` as const;
      if (
        wakeup.reason === "not-ready"
        || wakeup.reason === "delivery-uncertain"
      ) {
        retry.set(key, { identity: wakeup.runId ?? key });
      }
      else if (wakeup.status === "dispatched") settled.add(key);
    }
    const operatorRetries = result.inputNotifications.filter(
      (notification) => notification.reason === "operator-not-ready"
        || (
          notification.reason === "operator-unavailable"
          && this.#operatorStartupRetryArmed
        )
    );
    if (operatorRetries.length > 0) {
      retry.set("operator", {
        identity: operatorRetries.map((notification) => (
          "inputRequestId" in notification
            ? `input:${notification.inputRequestId}`
            : "recoveryTaskId" in notification
              ? `recovery:${notification.recoveryTaskId}`
              : "stallTaskId" in notification
                ? `stall:${notification.stallTaskId}`
              : `terminal:${notification.terminalTaskId}`
        )).join("|")
      });
    } else if (result.inputNotifications.some(
      (notification) => notification.status === "sent"
        || notification.status === "already-sent"
    )) {
      this.#operatorStartupRetryArmed = false;
      settled.add("operator");
    }
    for (const key of settled) this.#clearDeliveryRetry(key);
    for (const key of resignal) this.signal(key);
    for (const [key, candidate] of retry) {
      this.#scheduleDeliveryRetry(
        key,
        candidate.identity,
        candidate.terminalFailure
      );
    }
  }

  #scheduleRuntimeCleanupRetries(outcomes: readonly RuntimeCleanupOutcome[]): void {
    for (const outcome of outcomes) {
      const key = runtimeCleanupMailboxKey(outcome.target);
      const identity = `runtime-cleanup:${outcome.batchId}`;
      if (outcome.status === "failed") {
        if (outcome.error !== undefined) this.#onError(outcome.error);
        this.#scheduleDeliveryRetry(key, identity);
        continue;
      }
      if (this.#deliveryRetryAttempts.get(key)?.identity === identity) {
        this.#clearDeliveryRetry(key);
      }
    }
  }

  #scheduleTaskMailboxRetries(scope: ReconcileScope): void {
    const selection = compileReconcileSelection(scope);
    const targets = selection.full
      ? this.store.listWorkMailboxes().flatMap((mailbox) => (
          mailbox.target.kind === "task" ? [mailbox.target] : []
        ))
      : [...selection.allRoleTaskIds].map((taskId) => (
          { kind: "task", taskId } as const
        ));
    for (const target of targets) {
      const key = `task:${encodeURIComponent(target.taskId)}` as const;
      const mailbox = this.store.getWorkMailbox(target);
      const batch = mailbox?.pending ?? mailbox?.processing?.batch;
      if (batch === undefined || batch === null) {
        this.#clearDeliveryRetry(key);
        continue;
      }
      this.#scheduleDeliveryRetry(
        key,
        `${batch.fromSequence}-${batch.toSequence}`
      );
    }
  }

  #scheduleDeliveryRetry(
    key: MailboxKey,
    identity: string,
    terminalFailure?: RoleRunDeliveryFailureIdentity
  ): void {
    let previous = this.#deliveryRetryAttempts.get(key);
    if (previous !== undefined && previous.identity !== identity) {
      this.#clearDeliveryRetry(key);
      previous = undefined;
    }
    const stableTerminalFailure = previous?.terminalFailure ?? terminalFailure;
    if (this.#deliveryRetryTimers.has(key)) {
      if (previous !== undefined && stableTerminalFailure !== previous.terminalFailure) {
        this.#deliveryRetryAttempts.set(key, {
          ...previous,
          terminalFailure: stableTerminalFailure
        });
      }
      return;
    }
    const attempts = previous?.attempts ?? 0;
    if (attempts >= this.#deliveryRetryLimit) {
      if (key === "operator") this.#operatorStartupRetryArmed = false;
      this.#terminalizePreparedAfterRetryExhaustion(
        key,
        identity,
        stableTerminalFailure
      );
      return;
    }
    this.#deliveryRetryAttempts.set(key, {
      identity,
      attempts: attempts + 1,
      ...(stableTerminalFailure === undefined
        ? {}
        : { terminalFailure: stableTerminalFailure })
    });
    const delayMs = Math.min(
      2_000,
      this.#deliveryRetryMs * (2 ** Math.min(attempts, 3))
    );
    const timer = setTimeout(() => {
      this.#deliveryRetryTimers.delete(key);
      if (!this.#stopped) this.signal(key);
    }, delayMs);
    timer.unref();
    this.#deliveryRetryTimers.set(key, timer);
  }

  #terminalizePreparedAfterRetryExhaustion(
    key: MailboxKey,
    runId: string,
    failure: RoleRunDeliveryFailureIdentity | undefined
  ): void {
    if (
      !key.startsWith("role:")
      || runId.startsWith("runtime-cleanup:")
      || failure === undefined
    ) {
      return;
    }
    const target = parseMailboxKey(key);
    if (target.kind !== "role") return;
    if (
      target.taskId !== failure.taskId
      || target.roleName !== failure.roleName
      || runId !== failure.runId
    ) {
      throw new Error(`Role delivery retry identity changed: ${key}/${runId}.`);
    }
    const result = this.store.saveRoleRunDeliveryFailure({
      ...failure,
      now: this.#now()
    });
    this.#clearDeliveryRetry(key);
    if (result !== "failed") return;
    this.delivery.forgetPrepared?.({
      taskId: failure.taskId,
      roleName: failure.roleName,
      runId: failure.runId,
      ...(failure.launchId === undefined
        ? {}
        : { launchId: failure.launchId })
    });
    if (!this.#stopped) this.signal(key);
  }

  #clearEmptyOperatorRetry(): void {
    if (
      !this.#operatorStartupRetryArmed
      && !this.#deliveryRetryAttempts.has("operator")
    ) return;
    const mailbox = this.store.getWorkMailbox({ kind: "operator" });
    if (
      mailbox === null
      || (mailbox.pending === null && mailbox.processing === null)
    ) {
      this.#operatorStartupRetryArmed = false;
      this.#clearDeliveryRetry("operator");
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
  let stopping = false;
  const lifecycleRequests = new Set<Promise<unknown>>();
  const server = await startControllerServer(home, async (method, params) => {
    if (stopping) {
      throw controllerApplicationError("METHOD_NOT_FOUND", "Controller is stopping.");
    }
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
    if (method === "scheduler.configure") {
      requireEmptySchedulerConfigureParams(params);
      const intervalMs = runtime.reloadReconciliationInterval();
      return { configured: true, reconciliationIntervalMs: intervalMs };
    }
    if (dispatcher === undefined) {
      throw controllerApplicationError("METHOD_NOT_FOUND", "Controller method was not found.");
    }
    const request = Promise.resolve(dispatcher(method, params));
    lifecycleRequests.add(request);
    try {
      const result = await request;
      if (
        method === "runtime.ensure-role-session"
        && isGlobalOperatorSessionRequest(params)
        && isStartedRuntimeSessionResult(result)
      ) {
        runtime.armOperatorStartupRetry();
      }
      return result;
    } finally {
      lifecycleRequests.delete(request);
    }
  }, async () => {
    stopping = true;
    runtime.stop();
    await Promise.allSettled([...lifecycleRequests]);
    await runtime.shutdownAndDrain();
  });
  runtime.start();
  const closed = server.closed;
  return {
    runtime,
    server,
    closed,
    close: async () => {
      runtime.stop();
      await server.close();
      await runtime.shutdownAndDrain();
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

function requireEmptySchedulerConfigureParams(value: JsonValue): void {
  if (!isEmptyJsonObject(value)) {
    throw controllerApplicationError("INVALID_PARAMS", "scheduler.configure params are invalid.");
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return resolved;
}

function operatorMailboxBatchIdentity(
  mailbox: ReturnType<SchedulerStorePort["getWorkMailbox"]>
): string | null {
  const batch = mailbox?.pending ?? mailbox?.processing?.batch;
  if (batch === null || batch === undefined) return null;
  return [
    batch.fromSequence,
    batch.toSequence,
    batch.firstQueuedAt,
    batch.lastQueuedAt
  ].join(":");
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

function isGlobalOperatorSessionRequest(value: JsonValue): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Readonly<Record<string, JsonValue>>).scope === "global"
    && (value as Readonly<Record<string, JsonValue>>).roleName === "operator";
}

function isStartedRuntimeSessionResult(value: JsonValue): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Readonly<Record<string, JsonValue>>).sessionStarted === true;
}

function controllerApplicationError(
  code: "INVALID_PARAMS" | "METHOD_NOT_FOUND",
  message: string
): Error {
  const error = Object.assign(new Error(message), { code });
  error.name = "CoreApplicationError";
  return error;
}
