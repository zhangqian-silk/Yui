import type { TaskBrief } from "../brief/taskBrief.js";
import type { Decision } from "../decision/decision.js";
import type { InputRequest } from "../input/inputRequest.js";
import type { Milestone } from "../milestone/milestone.js";
import type { LeaderFailure } from "./leaderFailure.js";
import type { OperatorNotification } from "./operatorNotification.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import type { AgentRun } from "../run/agentRun.js";

export type SchedulerTask = Readonly<{
  id: string;
  status: "draft" | "active" | "completed" | "archived";
  repositoryId?: string;
  cwd?: string;
}>;

export type SchedulerRole = Readonly<{
  taskId: string;
  name: string;
  activeAgentId: string;
  adapterId: string;
  status: "idle" | "running" | "detached" | "exited" | "failed";
}>;

export type SchedulerAgentRun = AgentRun;

export type SchedulerRoleSession = Readonly<{
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  status: "reserved" | "ready" | "running" | "stopped" | "broken";
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

export type LeaderDispatchPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerAgentRun;
  session: SchedulerRoleSession | null;
  wakeup: PendingWakeup;
  now: Date;
}>;

export type LeaderDispatchClaimResult = "claimed" | "busy" | "unavailable" | "state-changed";

export type RoleRunDeliveryPersistence = Readonly<{
  task: SchedulerTask;
  role: SchedulerRole;
  run: SchedulerAgentRun;
  session: SchedulerRoleSession | null;
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
  failure: LeaderFailure;
  notification: OperatorNotification;
  claimed?: Readonly<{ run: SchedulerAgentRun; wakeup: PendingWakeup }>;
  now: Date;
}>;

/**
 * FileTaskStore-facing scheduler boundary. The concrete adapter owns the exact
 * Role/session-set model and performs each multi-record persistence operation.
 */
export interface SchedulerStorePort {
  listTasks(): readonly SchedulerTask[];
  getTask(taskId: string): SchedulerTask | null;
  listRoles(taskId: string): readonly SchedulerRole[];
  getRole(taskId: string, roleName: string): SchedulerRole | null;
  getActiveAgentRun(taskId: string, roleName: string): SchedulerAgentRun | null;
  hasOpenInputRequest(taskId: string): boolean;
  listOpenInputRequests(): readonly InputRequest[];
  getOperatorDeliveryTarget(): SchedulerOperatorDeliveryTarget | null;
  resolveExpiredInputRecommendations(now: Date): readonly AutoResolvedInput[];
  getRoleSession(taskId: string, roleName: string): SchedulerRoleSession | null;
  nextAgentRunId(taskId: string): string;

  getPendingWakeup(taskId: string): PendingWakeup | null;
  listPendingWakeups(): readonly PendingWakeup[];
  savePendingWakeup(wakeup: PendingWakeup): void;
  clearPendingWakeup(taskId: string): void;

  getLeaderFailure(taskId: string): LeaderFailure | null;
  getOperatorNotification(taskId: string): OperatorNotification | null;
  getTaskBrief(taskId: string): TaskBrief | null;
  listDecisions(taskId: string): readonly Decision[];
  listMilestones(taskId: string): readonly Milestone[];
  /** Persist the AgentRun, active-run pointer, running Role and active fixed session. */
  saveLeaderDispatch(input: LeaderDispatchPersistence): LeaderDispatchClaimResult;
  /** Persist successful delivery of a Work AgentRun and its fixed session. */
  saveRoleRunDelivery(input: RoleRunDeliveryPersistence): void;
  /** Persist LeaderFailure, OperatorNotification and failed/broken runtime state. */
  saveLeaderDispatchFailure(input: LeaderDispatchFailurePersistence): void;
  /** Fail the run and running WorkItem, clear active-run, and stop the Role session. */
  saveExitedRoleRun(input: ExitedRoleRunPersistence): void;
  /** Mark every recorded Task Role session stopped after tmux termination. */
  saveArchivedTaskStopped(taskId: string, now: Date): void;
}

export type RoleSessionLaunchMode = "new" | "resume";

export type PreparedRoleDelivery = Readonly<{
  deliveryId: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  mode: RoleSessionLaunchMode;
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
    mode: RoleSessionLaunchMode;
    nativeSessionId?: string;
  }>): Promise<PreparedRoleDelivery>;
  waitUntilReady(delivery: PreparedRoleDelivery): Promise<ReadyRoleDelivery>;
  sendOnce(input: Readonly<{
    delivery: ReadyRoleDelivery;
    receiptId: string;
    text: string;
  }>): Promise<"sent" | "already-sent">;
  /** Best-effort nudge to an already-running global Operator composer. */
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
  /** Fast pane receipt lookup; unlike readiness, this is valid while the Agent is busy. */
  findExistingReceipt?(input: Readonly<{
    delivery: PreparedRoleDelivery;
    receiptId: string;
  }>): Promise<ReadyRoleDelivery | null>;
  /** Archive boundary: tmux owns process termination for every Role in the Task. */
  stopTask(taskId: string): Promise<boolean>;
}
