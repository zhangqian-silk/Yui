import type { TaskBrief } from "../brief/taskBrief.js";
import type { Decision } from "../decision/decision.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { Milestone } from "../milestone/milestone.js";
import type { LeaderFailure } from "./leaderFailure.js";
import type {
  LeaderRecoveryOperatorNotification,
  OperatorNotification
} from "./operatorNotification.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import type { AgentRun } from "../run/agentRun.js";
import type {
  MailboxEntityRef,
  MailboxTarget,
  ProcessingBatch,
  WorkMailbox
} from "../coordination/workMailbox.js";
import type { PendingTurnCompletion } from "../executor/turnCompletion.js";
import type {
  RuntimeLifecycleTarget,
  RuntimeRoleOwner
} from "../runtime/lifecycleReservation.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import type { Task } from "../task/task.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";

export type SchedulerTask = Readonly<Pick<
  Task,
  "id" | "title" | "status" | "projectBindings" | "cwd"
>>;

export type SchedulerRole = Readonly<{
  taskId: string;
  name: string;
  activeAgentId: string;
  adapterId: AgentAdapterId;
  model?: string;
  effort?: string;
  effective: EffectiveLaunchSnapshot;
  workspace: string;
  status: "idle" | "running" | "detached" | "exited" | "failed";
}>;

export type SchedulerAgentRun = AgentRun;

export type SchedulerRoleSession = Readonly<{
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  /** Exact external-process generation, when runtime coordination recorded it. */
  launchId?: string;
  status: "reserved" | "ready" | "running" | "stopped" | "broken";
  effective: EffectiveLaunchSnapshot;
  /** Last durable session transition, when the adapter can expose it. */
  updatedAt?: string;
}>;

export type RoleRunStallPersistence = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  agentId: string;
  adapterId: string;
  /** Exact Session fact observed by the scan; null is itself a fenced fact. */
  session: Readonly<{
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    launchId?: string;
    status: SchedulerRoleSession["status"];
  }> | null;
  kind: "delivery-stalled" | "execution-stalled";
  classification: "truly-stalled";
  progressAt: string;
  idleMs: number;
  evidenceKey: string;
  now: Date;
}>;

export type SchedulerRunProgress = Readonly<{
  progressAt: string;
  evidence?: string;
}>;

/** One bounded advisory process sample carried by the full Role inventory. */
export type SchedulerRoleResourceIdentity = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
}>;

export type SchedulerRoleResourceEvidence = Readonly<{
  observedAt: string;
  /** Exact producer generation; missing identity is never consumable progress evidence. */
  identity?: SchedulerRoleResourceIdentity;
  /** Durable progress fence observed/requested for this sample. */
  progressAt?: string;
  /** Set by the inventory producer when one of the counters changed. */
  changed?: boolean;
  /** Explicit activity is advisory and never advances durable progress. */
  active?: boolean;
  cpuTimeMs?: number;
  rssBytes?: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
}>;

export type SchedulerRoleResourceEntry = Readonly<{
  taskId: string;
  roleName: string;
  resource: SchedulerRoleResourceEvidence;
}>;

/** Exact Role generation identity requested for one advisory resource sample. */
export type SchedulerRoleResourceInput = Readonly<{
  taskId: string;
  roleName: string;
  runId?: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
  progressAt?: string;
}>;

export type RoleRunProgressPersistence = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  progressAt: string;
  evidence?: string;
  now: Date;
}>;

/** One durable advisory-resource suppression for one exact Run progress point. */
export type RoleRunResourceSuppressionPersistence = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
  progressAt: string;
  observedAt: string;
  now: Date;
}>;

/**
 * Exact persisted session fact used to fence a low-frequency native-host
 * absence observation from a concurrent launch or Hook update.
 */
export type DormantRuntimeOwnerCandidate = Readonly<{
  owner: RuntimeRoleOwner;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  sessionUpdatedAt: string;
}>;

export type SchedulerOperatorDeliveryTarget = Readonly<{
  roleName: "operator";
  adapterId: string;
}>;

export type AutoResolvedInput = Readonly<{
  inputRequestId: string;
  taskId: string;
  choiceKey: string;
}>;

/** Compiled Controller scope shared by scheduler processors. */
export type SchedulerReconcileSelection = Readonly<{
  full: boolean;
  taskIds: ReadonlySet<string>;
  allRoleTaskIds: ReadonlySet<string>;
  rolesByTask: ReadonlyMap<string, ReadonlySet<string>>;
  operator: boolean;
}>;

export type LeaderDispatchPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerAgentRun;
  session: SchedulerRoleSession | null;
  wakeup: PendingWakeup;
  now: Date;
}>;

export type LeaderDispatchClaimResult = "claimed" | "busy" | "unavailable" | "state-changed";

export type SchedulerMailboxClaimInput = Readonly<{
  target: MailboxTarget;
  batchId: string;
  owner: string;
  now: Date;
  executionRef?: MailboxEntityRef;
}>;

export type SchedulerMailboxClaimResult =
  | Readonly<{ status: "claimed" | "processing"; processing: ProcessingBatch }>
  | Readonly<{ status: "empty" }>;

export type RoleRunDeliveryPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerAgentRun;
  session: SchedulerRoleSession | null;
  /** Matching external-process generation, when lifecycle coordination is enabled. */
  launchId?: string;
  now: Date;
}>;

export type RoleRunDeliveryFailurePersistence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: AgentAdapterId;
  runId: string;
  mailboxBatchId: string;
  nativeSessionId?: string;
  /** Exact external-process generation prepared for this undelivered Run. */
  launchId?: string;
  now: Date;
}>;

export type ExitedRoleRunPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerAgentRun;
  session: SchedulerRoleSession | null;
  summary: string;
  now: Date;
}>;

export type LeaderDispatchFailurePersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  session: SchedulerRoleSession | null;
  claimed: Readonly<{ run: SchedulerAgentRun; wakeup: PendingWakeup }>;
  failure: LeaderFailure;
  notification: LeaderRecoveryOperatorNotification;
  now: Date;
}>;

/**
 * FileTaskStore-facing scheduler boundary. The concrete adapter owns the exact
 * Role/session-set model and performs each multi-record persistence operation.
 */
export interface SchedulerStorePort {
  getPresentationContext(): Readonly<{ timeZone?: unknown }>;
  listTasks(): readonly SchedulerTask[];
  getTask(taskId: string): SchedulerTask | null;
  listRoles(taskId: string): readonly SchedulerRole[];
  getRole(taskId: string, roleName: string): SchedulerRole | null;
  getActiveAgentRun(taskId: string, roleName: string): SchedulerAgentRun | null;
  hasOpenInputRequest(taskId: string): boolean;
  listOpenInputRequests(): readonly InputRequest[];
  listPendingRuntimeTurnCompletions(): readonly PendingTurnCompletion[];
  getInputRequest(taskId: string, inputRequestId: string): InputRequest | null;
  getOperatorDeliveryTarget(): SchedulerOperatorDeliveryTarget | null;
  resolveExpiredInputRecommendations(
    now: Date,
    taskIds?: ReadonlySet<string>
  ): readonly AutoResolvedInput[];
  resolveDueRuntimeTurnCompletions(
    now: Date,
    taskIds?: ReadonlySet<string>
  ): readonly string[];
  getRoleSession(
    taskId: string,
    roleName: string,
    agentId?: string
  ): SchedulerRoleSession | null;
  /** Immutable runtime facts used by the low-frequency stall projection. */
  listEvents?(taskId: string): readonly TaskEvent[];
  /** Optional richer fold of WorkItem/Review/Integration progress for a Run. */
  getRunDurableProgress?(taskId: string, roleName: string, runId: string): SchedulerRunProgress | null;
  /** Materializes a newly observed related-record fold as one run.progress fact. */
  recordRoleRunProgress?(input: RoleRunProgressPersistence): "recorded" | "already-recorded" | "state-changed";
  /** Atomically consumes one advisory resource sample for an exact Run/progress point. */
  recordRoleRunResourceSuppression?(input: RoleRunResourceSuppressionPersistence): "recorded" | "already-recorded" | "state-changed";
  /** Atomically records one new stall episode and routes its responsibility. */
  recordRoleRunStall?(input: RoleRunStallPersistence): "raised" | "already-raised" | "state-changed";
  /**
   * True iff an exact provider-ready fold has been recorded for this generation
   * (adapter/nativeSession/launch). The scheduler consults it, together with the
   * adapter's preInputReadiness capability, to gate a fresh first push — never a
   * sleep, screen scrape, or pane/PID inference. Absent implementation ⇒ no gate.
   */
  isRoleGenerationProviderReady?(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    launchId?: string;
    nativeSessionId?: string;
  }>): boolean;
  hasInFlightTurn(taskId: string, roleName: string): boolean;
  peekNextAgentRunId(taskId: string): string;

  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
  listWorkMailboxes(): readonly WorkMailbox[];
  claimWorkMailbox(input: SchedulerMailboxClaimInput): SchedulerMailboxClaimResult;
  completeWorkMailbox(target: MailboxTarget, batchId: string): boolean;
  releaseWorkMailbox(target: MailboxTarget, batchId: string): boolean;
  /**
   * After a successful targeted stop, atomically clears both a launch
   * reservation and every coalesced cleanup request in its dedicated lane.
   */
  completeRuntimeCleanup?(
    target: Extract<
      MailboxTarget,
      { kind: "role-runtime" | "global-role-runtime" }
    >,
    now: Date
  ): boolean;
  /** Queues a durable exact-owner cleanup obligation for a Task Role runtime. */
  enqueueRuntimeCleanup?(
    owner: RuntimeRoleOwner,
    now?: Date
  ): RuntimeLifecycleTarget | null;
  /** Atomically clears one confirmed-absent reservation and stops its session fact. */
  completeStoppedRuntimeReservation?(
    target: Extract<
      MailboxTarget,
      { kind: "role-runtime" | "global-role-runtime" }
    >,
    batchId: string,
    now: Date
  ): boolean;
  /** Non-stopped native sessions with no active Task Run or lifecycle work. */
  listDormantRuntimeOwners?(): readonly DormantRuntimeOwnerCandidate[];
  /**
   * Persists a confirmed absent dormant owner only while its exact session
   * fact is still current and no launch, cleanup, or Task Run has appeared.
   */
  markRuntimeOwnerStopped?(
    candidate: DormantRuntimeOwnerCandidate,
    now: Date
  ): boolean;
  queueTaskProgress(taskId: string, reason: string, now: Date): void;

  getPendingWakeup(taskId: string): PendingWakeup | null;
  listPendingWakeups(): readonly PendingWakeup[];
  /** Atomically appends one Leader signal without a read/merge/write race. */
  enqueueLeaderWakeup?(taskId: string, reason: string, now: Date): PendingWakeup;
  /**
   * Atomically releases a stranded Leader execution and appends its recovery
   * signal. This prevents a concurrent signal from being lost between those
   * two mailbox transitions.
   */
  releaseLeaderWakeupAndEnqueue?(
    taskId: string,
    batchId: string,
    reason: string,
    now: Date
  ): boolean;
  savePendingWakeup(wakeup: PendingWakeup): void;
  clearPendingWakeup(taskId: string): void;

  getLeaderFailure(taskId: string): LeaderFailure | null;
  getOperatorNotification(taskId: string): OperatorNotification | null;
  getTaskBrief(taskId: string): TaskBrief | null;
  listDecisions(taskId: string): readonly Decision[];
  listMilestones(taskId: string): readonly Milestone[];
  /** Persist the AgentRun, active-run pointer, running Role and active fixed session. */
  saveLeaderDispatch(input: LeaderDispatchPersistence): LeaderDispatchClaimResult;
  /** Persist a fixed session discovered while preparing an undelivered Run. */
  saveRoleRunPrepared(input: RoleRunDeliveryPersistence): void;
  /** Persist successful delivery of a Work AgentRun and its fixed session. */
  saveRoleRunDelivery(input: RoleRunDeliveryPersistence): void;
  /** Atomically fail one exact prepared Run after bounded delivery exhaustion. */
  saveRoleRunDeliveryFailure(
    input: RoleRunDeliveryFailurePersistence
  ): "failed" | "state-changed";
  /** Persist LeaderFailure, OperatorNotification and failed/broken runtime state. */
  saveLeaderDispatchFailure(input: LeaderDispatchFailurePersistence): "failed" | "state-changed";
  /** Fail the exact Run and its WorkItem or ReviewRound, clear active-run, and stop the Role session. */
  saveExitedRoleRun(input: ExitedRoleRunPersistence): "failed" | "state-changed";
}

/** Resolves Tasks without a global scan for a dirty reconciliation pass. */
export function selectedSchedulerTasks(
  store: Pick<SchedulerStorePort, "listTasks" | "getTask">,
  selection?: SchedulerReconcileSelection
): SchedulerTask[] {
  if (selection === undefined || selection.full) return [...store.listTasks()];
  return [...selection.taskIds].flatMap((taskId) => {
    const task = store.getTask(taskId);
    return task === null ? [] : [task];
  });
}

/** Resolves either every Role in a selected Task or only explicit Role keys. */
export function selectedSchedulerRoles(
  store: Pick<SchedulerStorePort, "listRoles" | "getRole">,
  taskId: string,
  selection?: SchedulerReconcileSelection
): SchedulerRole[] {
  if (
    selection === undefined
    || selection.full
    || selection.allRoleTaskIds.has(taskId)
  ) {
    return [...store.listRoles(taskId)];
  }
  const names = selection.rolesByTask.get(taskId);
  if (names === undefined) return [];
  return [...names].flatMap((roleName) => {
    const role = store.getRole(taskId, roleName);
    return role === null ? [] : [role];
  });
}

export type RoleSessionLaunchMode = "new" | "resume";

export type PreparedRoleDelivery = Readonly<{
  deliveryId: string;
  /** External process generation; distinct from the per-Run delivery id. */
  launchId?: string;
  /** Durable Run identity whose transient preparation this entry serves. */
  runId?: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  mode: RoleSessionLaunchMode;
  /** The prepare request created a new external Role window/process. */
  sessionStarted: boolean;
  /** Provider launch argv carried this Run's first prompt atomically. */
  inputSubmittedAtLaunch?: boolean;
}>;

export type ReadyRoleDelivery = Readonly<{
  prepared: PreparedRoleDelivery;
  /** Codex fresh launches remain null until runtime session registration. */
  session: SchedulerRoleSession | null;
}>;

/**
 * The Scheduler never reads stdin and never writes terminal bytes itself.
 * A tmux-owned implementation launches/resumes the role, establishes terminal
 * readiness, and performs receipt-backed literal delivery.
 */
export interface TmuxDeliveryPort {
  prepareRoleSession(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    effective: EffectiveLaunchSnapshot;
    workspace: string;
    mode: RoleSessionLaunchMode;
    runId?: string;
    nativeSessionId?: string;
  }>): Promise<PreparedRoleDelivery>;
  waitUntilReady(delivery: PreparedRoleDelivery): Promise<ReadyRoleDelivery>;
  sendOnce(input: Readonly<{
    delivery: ReadyRoleDelivery;
    receiptId: string;
    text: string;
  }>): Promise<"sent" | "already-sent" | "busy" | "unavailable">;
  /**
   * Drops transient prepared bindings after authoritative terminal/absence
   * state. Omitting runId clears every prepared generation for the Role.
   */
  forgetPrepared?(input: Readonly<{
    taskId: string;
    roleName: string;
    runId?: string;
    launchId?: string;
  }>): void;
  /** Best-effort nudge to an already-running global Operator process. */
  notifyOperatorInputOnce?(input: Readonly<{
    roleName: "operator";
    adapterId: string;
    receiptId: string;
    text: string;
  }>): Promise<"sent" | "already-sent" | "unavailable" | "not-ready">;
  inspectRole(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"present" | "absent">;
  /** Full-reconciliation safety probe for a missing native Turn Hook. */
  inspectRoleReadiness?(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"ready" | "busy" | "absent">;
  inspectRoles?(inputs: readonly Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    runId?: string;
    launchId?: string;
    progressAt?: string;
  }>[], resourceInputs?: readonly SchedulerRoleResourceInput[]):
    Promise<readonly Readonly<{
      taskId: string;
      roleName: string;
      status: "present" | "absent";
      resource?: SchedulerRoleResourceEvidence;
    }>[]>;
  /** Retryable stale lifecycle cleanup for one exact Task Role pane. */
  stopRole?(taskId: string, roleName: string): Promise<boolean>;
}
