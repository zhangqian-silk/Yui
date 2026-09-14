import {
  type MailboxTarget
} from "../coordination/workMailbox.js";
import type { RoleAgentConfig } from "../executor/agentAdapter.js";
import { type ResolvedInputTarget } from "../message/inputControlResolution.js";
import type { TaskWorkspaceActivation } from "../repository/taskWorkspacePreparer.js";
import {
  type DeltaRecheckPreflight
} from "../review/deltaRecheck.js";
import {
  type ReviewerBusy
} from "../review/reviewerAvailability.js";
import {
  type TaskReviewCandidate
} from "../review/reviewRound.js";
import {
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import type { AgentRunConfigurationObservation } from "../runtime/agentRunConfiguration.js";
import type { ProviderAuthorityFence } from "../runtime/providerAuthorityFence.js";
import type { TaskStore } from "../storage/taskStore.js";
import { type TaskRemoteDeliveryProof } from "../task/remoteDeliveryService.js";
import {
  type Task,
  type TaskCompletedBy
} from "../task/task.js";
import type { TmuxRolePaneState } from "../tmux/tmuxManager.js";
import {
  type CandidateGitSnapshot,
  type DirectTaskMainSnapshot
} from "../workItem/workItem.js";
import type {
  TaskRetirementProof,
  WorkItemIntegrationProof
} from "../workspace/workItemChangeSetManager.js";
import {
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import {
  type TaskCompletionPublishedTreeProof
} from "./taskCompletionGate.js";
import {
  type TaskRoleHostObservation
} from "./taskRoleRuntimeStatus.js";

export type TaskCommandExecution =
  | Readonly<{ kind: "output"; output: string; data?: unknown }>
  | Readonly<{
      kind: "session-stop";
      taskId: string;
      roleName: string;
      agentId: string;
      adapterId: string;
      nativeSessionId: string;
      sessionUpdatedAt: string;
      reason: string;
      output: string;
    }>
  | Readonly<{
      kind: "view";
      taskId: string;
      roleName: string;
      access: "read-only";
      output?: string;
    }>
  | Readonly<{
      kind: "authority";
      action: "takeover" | "release";
      taskId: string;
      roleName: string;
      nativeSessionId: string;
      authority: ProviderAuthorityFence;
      output: string;
    }>
  | Readonly<{
      /**
       * A resolved live steer against the exact current native Turn. Core has
       * already persisted the Message and proven the target, capability, and
       * writer fence from durable state; the CLI performs the one Agent Host
       * steer call and never re-decides urgency, target, or fallback.
       */
      kind: "input-steer";
      taskId: string;
      roleName: string;
      messageId: string;
      target: ResolvedInputTarget;
      /** Stable Provider request id for the steer; repeating it is idempotent. */
      receiptId: string;
      text: string;
      output: string;
    }>
  | Readonly<{
      /**
       * A resolved live interrupt of the exact current native Turn, delivered
       * only through the Provider's native cancel. Core has proven native
       * interrupt capability and the exact target; the CLI performs the one
       * Agent Host cancel and never kills, restarts, or detaches the process.
       */
      kind: "input-interrupt";
      taskId: string;
      roleName: string;
      target: ResolvedInputTarget;
      /** Stable Provider request id for the cancel; repeating it is idempotent. */
      receiptId: string;
      /** The claimed then-handoff Message to deliver once, when one was chosen. */
      thenMessageId?: string;
      output: string;
    }>;


/**
 * The command layer only persists intent. It never launches an Agent, writes
 * terminal bytes, or attaches a tmux client.
 */
export type TaskWorkflowRuntimePort = Readonly<{
  notifyMailboxChanged(target: MailboxTarget): void | Promise<void>;
  reconcileTask(taskId: string): void;
  inspectTaskRolePanes?(taskId: string): readonly TmuxRolePaneState[];
}>;


export type TaskWorkflowStore = TaskStore;


export type TaskRoleAgentConfigurationMutation = Readonly<{
  agentId: string;
  config: RoleAgentConfig;
  cwd: string;
}>;


export type TaskCommandOptions = Readonly<{
  /** Controller-only recovery identity; ordinary user retry uses the same CAS. */
  providerRetryChainId?: string;
  runtime?: TaskWorkflowRuntimePort;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  yuiHome?: string;
  /** Completion CLI parsing may read stdin/files before remote reconciliation. */
  completionSummary?: string;
  /** Explicit Git/publication proof prepared before completion mutation. */
  completionPublishedTreeProof?: TaskCompletionPublishedTreeProof;
  workItemIntegrationProof?: WorkItemIntegrationProof;
  candidateGitSnapshot?: CandidateGitSnapshot;
  /** CLI-verified clean Task-main snapshot for exact direct capture or safe delivery promotion. */
  directTaskMainSnapshot?: DirectTaskMainSnapshot;
  /** Prepared by the repository/workspace lifecycle before command mutation. */
  executionLaneWorkspaces?: ReadonlyMap<string, ManagedWorkspace>;
  /** Atomic Draft -> active plus Task-main workspace adoption completed by CLI preflight. */
  taskWorkspaceActivation?: TaskWorkspaceActivation;
  /**
   * Under-fence Project path snapshot captured when a new Group's Lane
   * workspaces were prepared. The dispatch aggregate CAS revalidates the Task
   * binding set and exact Project paths against it, so a project migrate in
   * the prepare/adopt gap fails closed instead of stranding a Lane on the
   * external checkout. Undefined when no fence is held (existing Group).
   */
  laneDispatchProjectPaths?: ReadonlyMap<string, string>;
  taskRetirementProof?: TaskRetirementProof;
  /** Verified by exact CLI preflight; never reconstructed from process.env. */
  taskFinalReviewContract?: TaskFinalReviewContract;
  /** Verified under the release handover lock by the exact global Operator CLI. */
  /** Physical Task-main heads verified by the CLI immediately before command execution. */
  actualTaskReviewCandidate?: TaskReviewCandidate;
  /** CLI-frozen remote merge coverage checked before destructive archive cleanup. */
  archiveRemoteDeliveryProof?: TaskRemoteDeliveryProof;
  /** Issue 07: CLI-verified delta-recheck assessment for `task review request --delta-recheck`. */
  deltaRecheckPreflight?: DeltaRecheckPreflight;
  /** Issue 07: per-Project diff text for a delta-recheck dispatch, digest-verified. */
  deltaRecheckDiff?: Readonly<Record<string, string>>;
  /**
   * What the live Agent reported it is running under, read by the CLI before a
   * Session inspect.
   *
   * Absent for every other command, and absent rather than empty when no Session
   * has ever run — the inspect prints only persisted facts in that case. When
   * present it is a reading, not a request: the Role's configuration remains the
   * expectation, and this states what the Agent answered about it.
   */
  liveRunConfiguration?: AgentRunConfigurationObservation;
  liveHostObservations?: Readonly<Record<string, TaskRoleHostObservation>>;
  /** CLI-prepared capability validation; throws before a Role mutation persists. */
  validateAgentConfiguration?: (
    input: Readonly<{
      agentId: string;
      config: RoleAgentConfig;
      cwd: string;
    }>
  ) => void;
}>;


export type TaskCompletionPreflight = Readonly<{
  task: Task;
  actor: TaskCompletedBy;
  completed: boolean;
  /** Existing Task-final ReviewRound must use the normal resume/block path. */
  activeTaskReview: boolean;
  taskFinalReviewContract?: TaskFinalReviewContract;
}>;


/** Normal scheduling result when a Reviewer slot is temporarily occupied. */
export type ReviewRequestBusy = ReviewerBusy;
