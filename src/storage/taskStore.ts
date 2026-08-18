import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateConfiguredAgent, type ConfiguredAgent } from "../agent/agent.js";
import type { TaskBrief } from "../brief/taskBrief.js";
import {
  validateCapabilityGrant,
  type CapabilityGrant
} from "../grant/capabilityGrant.js";
import {
  validateReleaseWorkflow,
  type ReleaseStepStatus,
  type ReleaseWorkflow
} from "../release/releaseWorkflow.js";
import {
  reconciliationIntervalMilliseconds,
  resolveLeaderNextActionMode
} from "../config/yuiConfig.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import {
  mailboxTargetKey,
  validateWorkMailbox,
  type MailboxEntityRef,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import type { Decision } from "../decision/decision.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  validateInputRequest,
  type InputRequest
} from "../input/inputRequest.js";
import {
  validateRoleSessionSet,
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { validateTaskMessage, type TaskMessage } from "../message/message.js";
import type { Milestone } from "../milestone/milestone.js";
import { validateAgentRun, type AgentRun } from "../run/agentRun.js";
import type { PendingProviderRetry } from "../run/providerRetry.js";
import type { RuntimeOwner } from "../runtime/runtimeOwner.js";
import type { SessionOwnerIdentity } from "../runtime/sessionOwnerIdentity.js";
import { FileSessionOwnerRegistry } from "../runtime/sessionOwnerRegistry.js";
import {
  validateReviewConfig,
  type ReviewConfig
} from "../review/reviewConfig.js";
import {
  validateReviewRound,
  type ReviewRound
} from "../review/reviewRound.js";
import type { ReviewFinding } from "../review/reviewFinding.js";
import { sameTaskFinalReviewContract } from "../review/taskFinalReviewContract.js";
import {
  assertProjectCatalog,
  validateProject,
  type Project
} from "../repository/project.js";
import {
  generateHomeIdentity,
  validateHomeIdentity,
  type HomeIdentity
} from "../repository/homeIdentity.js";
import {
  validateAgentProfile,
  type AgentProfile
} from "../profile/agentProfile.js";
import {
  validateChangeSet,
  type ChangeSet
} from "../integration/changeSet.js";
import {
  validateIntegrationAttempt,
  type IntegrationAttempt
} from "../integration/integrationAttempt.js";
import {
  validateIntegrationQueueEntry,
  type IntegrationQueueEntry,
  type IntegrationQueueStatus
} from "../integration/integrationQueueEntry.js";
import {
  CURRENT_DURABLE_JOB_SCHEMA_VERSION,
  validDurableJobTransition,
  validateDurableJob,
  type DurableJob
} from "../job/durableJob.js";
import {
  validateGlobalRole,
  validateTaskRole,
  type GlobalRole,
  type TaskRole
} from "../role/role.js";
import {
  CURRENT_LEADER_FAILURE_SCHEMA_VERSION,
  type LeaderFailure
} from "../scheduler/leaderFailure.js";
import {
  CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
  type OperatorNotification
} from "../scheduler/operatorNotification.js";
import type { PendingWakeup } from "../scheduler/pendingWakeup.js";
import { validateTask, type Task } from "../task/task.js";
import type { NextActionFacts } from "../task/nextAction.js";
import {
  formatAgentRunReceiptId,
  TASK_RECORD_ID_PREFIXES,
  validateTaskRecordReference,
  type TaskRecordKind
} from "../task/taskRecordReference.js";
import {
  workItemExecutionGroupById,
  validateWorkItem,
  type WorkItem,
  type WorkItemCandidate
} from "../workItem/workItem.js";
import {
  isExecutionGroupTransition,
  validateExecutionGroup,
  type ExecutionGroup
} from "../execution/executionGroup.js";
import {
  managedWorkspaceKey,
  validateManagedWorkspace,
  type ManagedWorkspace,
  type ManagedWorkspaceOwner
} from "../worktree/managedWorkspace.js";
import {
  gateArtifactKey,
  validateGateArtifact,
  type GateArtifact,
  type GateArtifactIdentity,
  type GateArtifactPruneOptions,
  type GateArtifactPruneResult,
  type GateArtifactStorePort
} from "../verification/gateArtifact.js";
import { writeTextFileAtomically } from "./durableFile.js";
import { assertHomeWritable } from "./upgradeFence.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  requireCompatibleStorageSchema,
  requireStorageSchema,
  writeCurrentStorageManifest
} from "./storageSchema.js";

export const STORAGE_STATE_FILE = "state.json";
/** The root StorageState schema is the persisted aggregate document version. */
export const CURRENT_STORAGE_STATE_SCHEMA_VERSION = CURRENT_AGGREGATE_SCHEMA_VERSION;
export const CURRENT_CONFIG_SCHEMA_VERSION = 1 as const;
export const CURRENT_HOME_IDENTITY_SCHEMA_VERSION = 1 as const;
export const CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION = 3 as const;
/**
 * Persisted StorageState/StoredTask family versions owned by this boundary.
 *
 * Keep these names next to the strict parser/writer so the upgrade record map
 * can classify exactly the bytes this store accepts and emits. Nested session
 * members and the PendingWakeup projection are included as parser boundaries
 * below, but are not independent record-axis families.
 */
export const CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION = 2 as const;
export const CURRENT_PROJECT_SCHEMA_VERSION = 3 as const;
export const CURRENT_AGENT_PROFILE_SCHEMA_VERSION = 2 as const;
export const CURRENT_GLOBAL_ROLE_SCHEMA_VERSION = 3 as const;
export const CURRENT_GLOBAL_ROLE_SESSION_SET_SCHEMA_VERSION = 3 as const;
export const CURRENT_TASK_SCHEMA_VERSION = 4 as const;
export const CURRENT_TASK_BRIEF_SCHEMA_VERSION = 2 as const;
export const CURRENT_TASK_ROLE_SCHEMA_VERSION = 3 as const;
export const CURRENT_MANAGED_WORKSPACE_SCHEMA_VERSION = 2 as const;
export const CURRENT_WORK_ITEM_SCHEMA_VERSION = 9 as const;
export const CURRENT_REVIEW_ROUND_SCHEMA_VERSION = 4 as const;
export const CURRENT_CHANGE_SET_SCHEMA_VERSION = 3 as const;
export const CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION = 3 as const;
export const CURRENT_MESSAGE_SCHEMA_VERSION = 3 as const;
export const CURRENT_INPUT_REQUEST_SCHEMA_VERSION = 2 as const;
export const CURRENT_DECISION_SCHEMA_VERSION = 1 as const;
export const CURRENT_MILESTONE_SCHEMA_VERSION = 1 as const;
export const CURRENT_EVENT_SCHEMA_VERSION = 2 as const;
export const CURRENT_CAPABILITY_GRANT_SCHEMA_VERSION = 1 as const;
export const CURRENT_RELEASE_WORKFLOW_SCHEMA_VERSION = 1 as const;
export const CURRENT_WORK_MAILBOX_SCHEMA_VERSION = 1 as const;
export const CURRENT_ROLE_AGENT_SESSION_SCHEMA_VERSION = 3 as const;
export const CURRENT_PENDING_WAKEUP_SCHEMA_VERSION = 1 as const;
const STORAGE_LOCK_DIRECTORY = ".state.lock";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = typeof COMPLETION_SHELLS[number];
export type CompletionInstallation = Readonly<{
  scriptPath: string;
  activationPath: string;
}>;
export type FileTaskStoreOptions = Readonly<{
  /** Read-only compatible-old -> current-model normalization before strict parse. */
  normalizeState?: (raw: string) => string;
  /**
   * Seed the read cache from one fingerprint-fenced `state.json` snapshot. The
   * store runs its strict parser over the supplied bytes and caches the result
   * under the supplied fingerprint, so the current-Home one-snapshot open never
   * re-reads merely to construct or first use the returned store. A later
   * external writer still changes the on-disk fingerprint and invalidates this
   * seed on the next read.
   */
  initialStateSnapshot?: { fingerprint: string; raw: string };
}>;
export type YuiConfig = Readonly<{
  schemaVersion: typeof CURRENT_CONFIG_SCHEMA_VERSION;
  defaultAgent?: string;
  defaultWorkspace?: string;
  timeZone?: string;
  currentTaskId?: string;
  lastTaskId?: string;
  reconciliationIntervalSeconds?: number;
  review?: ReviewConfig;
  /**
   * Issue 07 (Leader convergence) feature mode. Optional additive field;
   * Homes without it default to `display`, so no config migration is needed.
   */
  leaderNextActionMode?: "display" | "warn" | "enforce";
  completionInstallations?: Partial<Record<CompletionShell, CompletionInstallation>>;
}>;
export type ConfiguredAgentPatch = Readonly<Partial<
  Pick<ConfiguredAgent, "adapterId" | "command" | "baseArgs" | "environment">
>>;
export type ConfiguredAgentUpdateResult = Readonly<{
  status: "updated" | "unchanged";
  agent: ConfiguredAgent;
}>;

type ActiveRunPointer = Readonly<{
  schemaVersion: typeof CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION;
  runId: string;
}>;

/**
 * Lane-scoped active pointers live beside the legacy role pointers.  The
 * namespace starts with a slash because Role identities reject slashes; this
 * makes the two key spaces disjoint even for legal Role names such as
 * `lane:worker:1`.
 */
export function executionLaneActiveRunKey(
  executionGroupId: string,
  executionLaneId: string
): string {
  return `/execution-lane/${encodeLaneKeyPart(executionGroupId)}:${encodeLaneKeyPart(executionLaneId)}`;
}

function encodeLaneKeyPart(value: string): string {
  return encodeURIComponent(value).replace(/:/gu, "%3A");
}

export function executionLaneActiveRunKeyParts(key: string):
  { executionGroupId: string; executionLaneId: string } | null {
  const match = /^\/execution-lane\/([^:]+):([^:]+)$/u.exec(key);
  if (match === null) return null;
  try {
    return {
      executionGroupId: decodeURIComponent(match[1]),
      executionLaneId: decodeURIComponent(match[2])
    };
  } catch {
    return null;
  }
}

type TaskIdHighWaterMarks = Record<TaskRecordKind, number>;

/** The schema version of each persisted `state.json#/tasks/*` aggregate. */
export const CURRENT_STORED_TASK_SCHEMA_VERSION = 16 as const;

/**
 * Persisted nested-record versions consumed by this store's strict parser.
 * Keep these named at the storage boundary so the upgrade record-axis map can
 * assert it is classifying the same bytes the store reads and writes.
 */
export const CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION = 4 as const;
/**
 * v7 combines optional Issue 04 retry/receipt fields and Issue 05 Leader
 * actionability fields. All are optional, so the v6→v7 migration is a
 * version-only rewrite.
 */
export const CURRENT_AGENT_RUN_SCHEMA_VERSION = 7 as const;
export const CURRENT_INTEGRATION_QUEUE_SCHEMA_VERSION = 1 as const;

type StoredTask = {
  schemaVersion: typeof CURRENT_STORED_TASK_SCHEMA_VERSION;
  task: Task;
  idHighWaterMarks: TaskIdHighWaterMarks;
  brief: TaskBrief | null;
  changeSets: Record<string, ChangeSet>;
  integrationAttempts: Record<string, IntegrationAttempt>;
  integrationQueue: Record<string, IntegrationQueueEntry>;
  durableJobs: Record<string, DurableJob>;
  roles: Record<string, TaskRole>;
  managedWorkspaces: Record<string, ManagedWorkspace>;
  roleSessionSets: Record<string, TaskRoleSessionSet>;
  /**
   * rr13: Per-Session DurableJob caller key hashes. Keyed by
   * `${roleName}\0${agentId}`; the value is the SHA-256 hex digest of the
   * `YUI_JOB_CALLER_KEY` injected at native Session launch. The plaintext key
   * is never persisted — only the hash — so a client that reads durable state
   * cannot replay a job.start/job.cancel caller. Absent hash = fail-closed.
   */
  jobCallerKeyHashes: Record<string, string>;
  workItems: Record<string, WorkItem>;
  agentRuns: Record<string, AgentRun>;
  reviewRounds: Record<string, ReviewRound>;
  activeRuns: Record<string, ActiveRunPointer>;
  messages: Record<string, TaskMessage>;
  inputRequests: Record<string, InputRequest>;
  decisions: Record<string, Decision>;
  milestones: Record<string, Milestone>;
  events: Record<string, TaskEvent>;
  capabilityGrants: Record<string, CapabilityGrant>;
  releaseWorkflows: Record<string, ReleaseWorkflow>;
  leaderFailure: LeaderFailure | null;
  operatorNotification: OperatorNotification | null;
};

type StorageState = {
  schemaVersion: typeof CURRENT_STORAGE_STATE_SCHEMA_VERSION;
  revision: number;
  /** The durable cross-Home-unique identity of this Home. */
  homeIdentity: HomeIdentity;
  config: YuiConfig;
  configuredAgents: Record<string, ConfiguredAgent>;
  projects: Record<string, Project>;
  agentProfiles: Record<string, AgentProfile>;
  globalRoles: Record<string, GlobalRole>;
  globalRoleSessionSets: Record<string, GlobalRoleSessionSet>;
  tasks: Record<string, StoredTask>;
  mailboxes: Record<string, WorkMailbox>;
};

export type TaskStore = {
  rootDirectory(): string;
  transaction<T>(execute: (store: TaskStore) => T): T;
  /**
   * Runs a Controller runtime-inbox fold as one aggregate transaction.  The
   * named seam lets the processor batch independent durable facts without
   * depending on a concrete FileTaskStore.
  */
  withRuntimeEventTransaction<T>(execute: () => T): T;
  /**
   * Async variant of {@link transaction} for callers that need to await
   * external I/O (e.g. git inspect) inside the write lock.  The same
   * re-entrancy and revision-commit semantics apply.
   */
  transactionAsync<T>(execute: (store: TaskStore) => Promise<T>): Promise<T>;
  getConfig(): YuiConfig;
  /** The durable Home identity minted once for this store. */
  getHomeIdentity(): HomeIdentity;
  saveConfig(config: YuiConfig): void;
  saveConfiguredAgent(agent: ConfiguredAgent): void;
  createConfiguredAgentIfAbsent(agent: ConfiguredAgent): ConfiguredAgent | null;
  updateConfiguredAgent(id: string, patch: ConfiguredAgentPatch, now: Date): ConfiguredAgentUpdateResult | null;
  listConfiguredAgents(): ConfiguredAgent[];
  getConfiguredAgent(id: string): ConfiguredAgent | null;
  removeConfiguredAgent(id: string): boolean;
  nextProjectId(): string;
  saveProject(project: Project): void;
  createProjectIfAbsent(project: Project): Project | null;
  listProjects(): Project[];
  getProject(id: string): Project | null;
  removeProject(id: string): boolean;
  saveAgentProfile(profile: AgentProfile): void;
  createAgentProfileIfAbsent(profile: AgentProfile): AgentProfile | null;
  listAgentProfiles(): AgentProfile[];
  getAgentProfile(id: string): AgentProfile | null;
  removeAgentProfile(id: string): boolean;
  saveGlobalRole(role: GlobalRole): void;
  saveGlobalRoleWithSessionSet(role: GlobalRole, sessions: GlobalRoleSessionSet | null): void;
  createGlobalRoleIfAbsent(role: GlobalRole): GlobalRole | null;
  listGlobalRoles(): GlobalRole[];
  getGlobalRole(name: string): GlobalRole | null;
  removeGlobalRole(name: string): boolean;
  getGlobalRoleSessionSet(name: string): GlobalRoleSessionSet | null;
  listGlobalRoleSessionSets(): GlobalRoleSessionSet[];
  saveGlobalRoleSessionSet(sessions: GlobalRoleSessionSet): void;
  nextTaskId(): string;
  saveTask(task: Task): void;
  listTasks(): Task[];
  /** Current durable state revision; advances once per committed mutation. */
  getStateRevision(): number;
  getTask(id: string): Task | null;
  /**
   * Issue 07 (Leader convergence): load exactly the records the next-action
   * projection consumes, filtered at the storage boundary (open Inputs,
   * active/leader Runs). Returns null when the Task does not exist.
   */
  readNextActionFacts(taskId: string): NextActionFacts | null;
  getReviewConfig(): ReviewConfig | null;
  getTaskBrief(taskId: string): TaskBrief | null;
  saveTaskBrief(taskId: string, brief: TaskBrief): void;
  clearTaskBrief(taskId: string): void;
  nextChangeSetId(taskId: string): string;
  saveChangeSet(taskId: string, changeSet: ChangeSet): void;
  listChangeSets(taskId: string): ChangeSet[];
  getChangeSet(taskId: string, changeSetId: string): ChangeSet | null;
  nextIntegrationAttemptId(taskId: string): string;
  saveIntegrationAttempt(taskId: string, attempt: IntegrationAttempt): void;
  listIntegrationAttempts(taskId: string): IntegrationAttempt[];
  getIntegrationAttempt(taskId: string, integrationId: string): IntegrationAttempt | null;
  nextIntegrationQueueEntryId(taskId: string): string;
  saveIntegrationQueueEntry(taskId: string, entry: IntegrationQueueEntry): void;
  listIntegrationQueueEntries(taskId: string): IntegrationQueueEntry[];
  getIntegrationQueueEntry(taskId: string, entryId: string): IntegrationQueueEntry | null;
  nextDurableJobId(taskId: string): string;
  saveDurableJob(taskId: string, job: DurableJob): void;
  listDurableJobs(taskId: string): DurableJob[];
  getDurableJob(taskId: string, jobId: string): DurableJob | null;
  findDurableJobByIdempotencyKey(taskId: string, key: string): DurableJob | null;
  listAllDurableJobs(): DurableJob[];
  hasActiveDurableJobs(): boolean;
  saveRole(taskId: string, role: TaskRole): void;
  listRoles(taskId: string): TaskRole[];
  getRole(taskId: string, name: string): TaskRole | null;
  saveTaskRoleWithSessionSet(role: TaskRole, sessions: TaskRoleSessionSet): void;
  removeTaskRole(taskId: string, name: string): boolean;
  saveManagedWorkspace(workspace: ManagedWorkspace): void;
  listManagedWorkspaces(taskId: string): ManagedWorkspace[];
  /** Singular spelling is retained for the public owner-selector API. */
  listManagedWorkspace(taskId: string): ManagedWorkspace[];
  getManagedWorkspace(owner: ManagedWorkspaceOwner): ManagedWorkspace | null;
  getTaskWorkspace(taskId: string): ManagedWorkspace | null;
  getWorkItemWorkspace(taskId: string, workItemId: string): ManagedWorkspace | null;
  getReviewRoundWorkspace(taskId: string, reviewRoundId: string): ManagedWorkspace | null;
  getIntegrationWorkspace(taskId: string, integrationAttemptId: string): ManagedWorkspace | null;
  removeManagedWorkspace(owner: ManagedWorkspaceOwner): boolean;
  getRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null;
  getTaskRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null;
  listRoleSessionSets(taskId: string): TaskRoleSessionSet[];
  saveRoleSessionSet(sessions: TaskRoleSessionSet): void;
  saveTaskRoleSessionSet(sessions: TaskRoleSessionSet): void;
  getRoleSession(taskId: string, roleName: string): RoleAgentSession | null;
  /** rr13: Look up the durable hash for a Session's job caller key. */
  getJobCallerKeyHash(taskId: string, roleName: string, agentId: string): string | null;
  /** rr13: Persist the hash of a newly launched Session's job caller key. */
  setJobCallerKeyHash(taskId: string, roleName: string, agentId: string, hash: string): void;
  /** Issue 03: Persist one runtime generation's exact physical owner identity. */
  saveSessionOwner(identity: SessionOwnerIdentity): void;
  /** Issue 03: Look up one owner record by launch id. */
  getSessionOwner(launchId: string): SessionOwnerIdentity | null;
  /** Issue 03: Enumerate every persisted owner record. */
  listSessionOwners(): SessionOwnerIdentity[];
  /** Issue 03: Enumerate owner records for one Task/global Role. */
  listSessionOwnersForOwner(owner: RuntimeOwner): SessionOwnerIdentity[];
  /** Issue 03: Remove a record whose physical resources were proven absent. */
  removeSessionOwner(launchId: string): void;
  nextWorkItemId(taskId: string): string;
  getWorkItem(taskId: string, workItemId: string): WorkItem | null;
  listWorkItems(taskId: string): WorkItem[];
  saveWorkItem(taskId: string, item: WorkItem): void;
  nextAgentRunId(taskId: string): string;
  peekNextAgentRunId(taskId: string): string;
  getAgentRun(taskId: string, runId: string): AgentRun | null;
  listAgentRuns(taskId: string): AgentRun[];
  saveAgentRun(run: AgentRun): void;
  /**
   * Issue 04: pending Provider retry scan. Layout 7's authoritative SQLite
   * store answers this with one indexed query; the legacy File store fails
   * closed because in-place retry is a db-only control-plane capability.
   */
  listPendingProviderRetries(): ReadonlyArray<PendingProviderRetry>;
  nextReviewRoundId(taskId: string): string;
  getReviewRound(taskId: string, reviewRoundId: string): ReviewRound | null;
  listReviewRounds(taskId: string): ReviewRound[];
  saveReviewRound(taskId: string, round: ReviewRound): void;
  nextReviewFindingId(taskId: string): string;
  getReviewFinding(taskId: string, reviewFindingId: string): ReviewFinding | null;
  listReviewFindings(taskId: string): ReviewFinding[];
  saveReviewFinding(taskId: string, finding: ReviewFinding): void;
  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null;
  saveActiveAgentRun(run: AgentRun): void;
  clearActiveAgentRun(taskId: string, roleName: string): void;
  getActiveExecutionLaneRun(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): AgentRun | null;
  saveActiveExecutionLaneRun(run: AgentRun): void;
  clearActiveExecutionLaneRun(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): void;
  nextMessageId(taskId: string): string;
  saveMessage(taskId: string, message: TaskMessage): void;
  listMessages(taskId: string): TaskMessage[];
  nextInputRequestId(taskId: string): string;
  saveInputRequest(taskId: string, request: InputRequest): void;
  getInputRequest(taskId: string, requestId: string): InputRequest | null;
  listInputRequests(taskId: string): InputRequest[];
  listAllInputRequests(): InputRequest[];
  nextDecisionId(taskId: string): string;
  saveDecision(taskId: string, decision: Decision): void;
  listDecisions(taskId: string): Decision[];
  getDecision(taskId: string, decisionId: string): Decision | null;
  nextMilestoneId(taskId: string): string;
  saveMilestone(taskId: string, milestone: Milestone): void;
  listMilestones(taskId: string): Milestone[];
  getMilestone(taskId: string, milestoneId: string): Milestone | null;
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
  listEvents(taskId: string): TaskEvent[];
  /**
   * Remove events by id. Used by telemetry compaction to fold legacy
   * `runtime.provider-turn-progress` rows into the sidecar while keeping
   * every semantic event. Returns the number of events actually removed.
   */
  removeEvents(taskId: string, eventIds: readonly string[]): number;
  nextCapabilityGrantId(taskId: string): string;
  saveCapabilityGrant(taskId: string, grant: CapabilityGrant): void;
  listCapabilityGrants(taskId: string): CapabilityGrant[];
  getCapabilityGrant(taskId: string, grantId: string): CapabilityGrant | null;
  nextReleaseWorkflowId(taskId: string): string;
  saveReleaseWorkflow(taskId: string, workflow: ReleaseWorkflow): void;
  listReleaseWorkflows(taskId: string): ReleaseWorkflow[];
  getReleaseWorkflow(taskId: string, workflowId: string): ReleaseWorkflow | null;
  // -- Gate artifacts (Issue 08) ---------------------------------------------
  saveGateArtifact(artifact: GateArtifact, logs: ReadonlyMap<string, Buffer>): void;
  touchGateArtifact(artifact: GateArtifact): void;
  getGateArtifact(projectId: string, key: string): GateArtifact | null;
  findGateArtifactByIdentity(identity: GateArtifactIdentity): GateArtifact | null;
  findL2GateArtifactsForCommit(query: Readonly<{
    projectId: string;
    commit: string;
    planDigest: string;
    toolchainDigest: string;
    targetRef: string;
  }>): GateArtifact[];
  getGateArtifactLogs(artifactKey: string): ReadonlyMap<string, Buffer>;
  pruneGateArtifacts(projectId: string, options: GateArtifactPruneOptions): GateArtifactPruneResult;
  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
  listWorkMailboxes(): WorkMailbox[];
  saveWorkMailbox(mailbox: WorkMailbox): void;
  removeWorkMailbox(target: MailboxTarget): boolean;
  /** @deprecated Transitional projection over the Leader Role WorkMailbox. It cannot expose processing batches or refs. */
  getPendingWakeup(taskId: string): PendingWakeup | null;
  listPendingWakeups(): PendingWakeup[];
  savePendingWakeup(wakeup: PendingWakeup): void;
  clearPendingWakeup(taskId: string): void;
  getLeaderFailure(taskId: string): LeaderFailure | null;
  saveLeaderFailure(failure: LeaderFailure): void;
  clearLeaderFailure(taskId: string): void;
  getOperatorNotification(taskId: string): OperatorNotification | null;
  saveOperatorNotification(notification: OperatorNotification): void;
  clearOperatorNotification(taskId: string): void;
};

export class FileTaskStore implements TaskStore {
  #transaction: { state: StorageState; baseRevision: number; dirty: boolean } | null = null;
  #readCache: { fingerprint: string; state: StorageState } | null = null;
  #normalizeState: ((raw: string) => string) | undefined;
  #sessionOwnerRegistry: FileSessionOwnerRegistry | undefined;

  constructor(private readonly rootDir: string, options: FileTaskStoreOptions = {}) {
    this.#normalizeState = options.normalizeState;
    this.#requireReadableSchema();
    const snapshot = options.initialStateSnapshot;
    if (snapshot !== undefined) {
      // The one-snapshot open already fenced these bytes; run the same strict
      // parser the lazy path would, then warm the cache under the snapshot's
      // fingerprint. A later external writer still invalidates it on next read.
      this.#readCache = {
        fingerprint: snapshot.fingerprint,
        state: this.#parseState(snapshot.raw)
      };
    }
  }

  rootDirectory(): string { return this.rootDir; }

  transaction<T>(execute: (store: TaskStore) => T): T {
    if (this.#transaction !== null) return synchronousResult(execute(this));
    return this.#withWriteLock(() => {
      const state = this.#readCachedState();
      this.#transaction = { state, baseRevision: state.revision, dirty: false };
      try {
        const result = synchronousResult(execute(this));
        if (this.#transaction.dirty) this.#commit(state, this.#transaction.baseRevision);
        return result;
      } catch (error) {
        this.#readCache = null;
        throw error;
      } finally {
        this.#transaction = null;
      }
    });
  }

  withRuntimeEventTransaction<T>(execute: () => T): T {
    return this.transaction(() => execute());
  }

  async transactionAsync<T>(execute: (store: TaskStore) => Promise<T>): Promise<T> {
    if (this.#transaction !== null) return execute(this);
    const release = acquireStorageLock(this.rootDir);
    try {
      const state = this.#readCachedState();
      this.#transaction = { state, baseRevision: state.revision, dirty: false };
      try {
        const result = await execute(this);
        if (this.#transaction.dirty) this.#commit(state, this.#transaction.baseRevision);
        return result;
      } catch (error) {
        this.#readCache = null;
        throw error;
      } finally {
        this.#transaction = null;
      }
    } finally {
      release();
    }
  }

  getConfig(): YuiConfig { return clone(this.#state().config); }
  getHomeIdentity(): HomeIdentity { return clone(this.#state().homeIdentity); }
  saveConfig(config: YuiConfig): void {
    const stored = versioned<YuiConfig>(
      config,
      CURRENT_CONFIG_SCHEMA_VERSION,
      "Yui config"
    );
    validateYuiConfig(stored);
    this.#mutate((state) => { state.config = stored; });
  }

  saveConfiguredAgent(agent: ConfiguredAgent): void {
    const stored = identified<ConfiguredAgent>(
      agent,
      CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION,
      "id",
      agent.id,
      "Configured Agent"
    );
    validateConfiguredAgent(stored);
    this.#mutate((state) => { state.configuredAgents[stored.id] = stored; });
  }
  createConfiguredAgentIfAbsent(agent: ConfiguredAgent): ConfiguredAgent | null {
    return this.transaction((store) => {
      if (store.getConfiguredAgent(agent.id) !== null) return null;
      store.saveConfiguredAgent(agent);
      return clone(agent);
    });
  }
  updateConfiguredAgent(
    id: string,
    patch: ConfiguredAgentPatch,
    now: Date
  ): ConfiguredAgentUpdateResult | null {
    return this.transaction((store) => {
      const existing = store.getConfiguredAgent(id);
      if (existing === null) return null;
      const candidate = versioned<ConfiguredAgent>({
        ...existing,
        ...clone(patch),
        updatedAt: now.toISOString()
      }, CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION, "Configured Agent");
      const unchanged = isDeepStrictEqual(
        { ...existing, updatedAt: candidate.updatedAt },
        candidate
      );
      if (unchanged) return { status: "unchanged", agent: existing };
      store.saveConfiguredAgent(candidate);
      return { status: "updated", agent: candidate };
    });
  }
  listConfiguredAgents(): ConfiguredAgent[] { return values(this.#state().configuredAgents, "id"); }
  getConfiguredAgent(id: string): ConfiguredAgent | null { return optional(this.#state().configuredAgents[id]); }
  removeConfiguredAgent(id: string): boolean {
    return this.#remove((state) => state.configuredAgents, id);
  }

  nextProjectId(): string {
    return this.#nextGlobalId("project", (state) => Object.keys(state.projects));
  }
  saveProject(project: Project): void {
    const stored = identified<Project>(
      project,
      CURRENT_PROJECT_SCHEMA_VERSION,
      "id",
      project.id,
      "Project"
    );
    validateProject(stored);
    this.#mutate((state) => {
      assertProjectCatalog([
        ...Object.values(state.projects).filter(({ id }) => id !== stored.id),
        stored
      ]);
      state.projects[stored.id] = stored;
    });
  }
  createProjectIfAbsent(project: Project): Project | null {
    validateProject(project);
    return this.transaction((store) => {
      if (store.getProject(project.id) !== null) return null;
      try {
        assertProjectCatalog([...store.listProjects(), project]);
      } catch {
        return null;
      }
      store.saveProject(project);
      return clone(project);
    });
  }
  listProjects(): Project[] { return values(this.#state().projects, "id"); }
  getProject(id: string): Project | null { return optional(this.#state().projects[id]); }
  removeProject(id: string): boolean {
    return this.transaction((store) => {
      if (store.listTasks().some((task) => task.projectBindings.some(
        (binding) => binding.projectId === id
      ))) {
        throw new StorageRecordError(`Project is still used by a Task: ${id}`);
      }
      return this.#remove((state) => state.projects, id);
    });
  }

  saveAgentProfile(profile: AgentProfile): void {
    const stored = identified<AgentProfile>(
      profile,
      CURRENT_AGENT_PROFILE_SCHEMA_VERSION,
      "id",
      profile.id,
      "Agent Profile"
    );
    validateAgentProfile(stored);
    this.#mutate((state) => {
      const existing = state.agentProfiles[stored.id];
      if (existing !== undefined) {
        if (stored.revision < existing.revision) {
          throw new StorageRecordError(
            `Agent Profile revision cannot move backwards: ${stored.id}.`
          );
        }
        if (
          stored.revision === existing.revision
          && !isDeepStrictEqual(stored, existing)
        ) {
          throw new StorageRecordError(
            `Agent Profile revision cannot be overwritten: ${stored.id}/${stored.revision}.`
          );
        }
        if (stored.revision > existing.revision + 1) {
          throw new StorageRecordError(
            `Agent Profile revision must be contiguous: ${stored.id}/${stored.revision}.`
          );
        }
      } else if (stored.revision !== 1) {
        throw new StorageRecordError(
          `A new Agent Profile must start at revision 1: ${stored.id}.`
        );
      }
      state.agentProfiles[stored.id] = stored;
    });
  }
  createAgentProfileIfAbsent(profile: AgentProfile): AgentProfile | null {
    return this.transaction((store) => {
      if (store.getAgentProfile(profile.id) !== null) return null;
      store.saveAgentProfile(profile);
      return clone(profile);
    });
  }
  listAgentProfiles(): AgentProfile[] {
    return values(this.#state().agentProfiles, "id");
  }
  getAgentProfile(id: string): AgentProfile | null {
    return optional(this.#state().agentProfiles[id]);
  }
  removeAgentProfile(id: string): boolean {
    return this.#remove((state) => state.agentProfiles, id);
  }

  saveGlobalRole(role: GlobalRole): void {
    const stored = identified<GlobalRole>(
      role,
      CURRENT_GLOBAL_ROLE_SCHEMA_VERSION,
      "name",
      role.name,
      "Global Role"
    );
    validateGlobalRole(stored);
    const sessions = this.getGlobalRoleSessionSet(stored.name);
    if (sessions !== null) assertSessionsMatchRole(sessions, stored);
    this.#mutate((state) => { state.globalRoles[stored.name] = stored; });
  }
  saveGlobalRoleWithSessionSet(role: GlobalRole, sessions: GlobalRoleSessionSet | null): void {
    const storedRole = identified<GlobalRole>(
      role,
      CURRENT_GLOBAL_ROLE_SCHEMA_VERSION,
      "name",
      role.name,
      "Global Role"
    );
    validateGlobalRole(storedRole);
    const storedSessions = sessions === null ? null : globalSessions(sessions);
    if (storedSessions !== null) assertSessionsMatchRole(storedSessions, storedRole);
    this.transaction(() => {
      this.#mutate((state) => {
        state.globalRoles[storedRole.name] = storedRole;
        if (storedSessions === null) delete state.globalRoleSessionSets[storedRole.name];
        else state.globalRoleSessionSets[storedRole.name] = storedSessions;
      });
    });
  }
  createGlobalRoleIfAbsent(role: GlobalRole): GlobalRole | null {
    return this.transaction((store) => {
      if (store.getGlobalRole(role.name) !== null) return null;
      store.saveGlobalRole(role);
      return clone(role);
    });
  }
  listGlobalRoles(): GlobalRole[] { return values(this.#state().globalRoles, "name"); }
  getGlobalRole(name: string): GlobalRole | null { return optional(this.#state().globalRoles[name]); }
  removeGlobalRole(name: string): boolean {
    return this.transaction(() => {
      const removed = this.#remove((state) => state.globalRoles, name);
      this.#mutate((state) => { delete state.globalRoleSessionSets[name]; });
      return removed;
    });
  }
  getGlobalRoleSessionSet(name: string): GlobalRoleSessionSet | null {
    return optional(this.#state().globalRoleSessionSets[name]);
  }
  listGlobalRoleSessionSets(): GlobalRoleSessionSet[] {
    return values(this.#state().globalRoleSessionSets, (set) => set.owner.roleName);
  }
  saveGlobalRoleSessionSet(sessions: GlobalRoleSessionSet): void {
    const stored = globalSessions(sessions);
    const role = this.getGlobalRole(stored.owner.roleName);
    if (role === null) throw new StorageRecordError(`Global Role not found: ${stored.owner.roleName}`);
    assertSessionsMatchRole(stored, role);
    this.#mutate((state) => { state.globalRoleSessionSets[stored.owner.roleName] = stored; });
  }

  nextTaskId(): string { return this.#nextGlobalId("task", (state) => Object.keys(state.tasks)); }
  saveTask(task: Task): void {
    const stored = validateTask(identified<Task>(
      task,
      CURRENT_TASK_SCHEMA_VERSION,
      "id",
      task.id,
      "Task"
    ));
    this.#mutate((state) => {
      for (const binding of stored.projectBindings) {
        if (state.projects[binding.projectId] === undefined) {
          throw new StorageRecordError(`Task Project not found: ${binding.projectId}`);
        }
      }
      const aggregate = state.tasks[stored.id] ?? emptyStoredTask(stored);
      aggregate.task = stored;
      state.tasks[stored.id] = aggregate;
    });
  }
  listTasks(): Task[] {
    // Clone only the Task headers, not the whole stored aggregate (events,
    // runs, messages): a scheduler pass lists Tasks per phase, and cloning
    // each aggregate's full event history turned every phase into a 32 MiB
    // projection. Callers that need a Task's events read them explicitly.
    return Object.values(this.#state().tasks)
      .map((aggregate) => clone(aggregate.task))
      .sort((left, right) => numericCompare(left.id, right.id));
  }
  getStateRevision(): number { return this.#state().revision; }
  getTask(id: string): Task | null { return optional(this.#state().tasks[id]?.task); }
  readNextActionFacts(taskId: string): NextActionFacts | null {
    const aggregate = this.#state().tasks[taskId];
    if (aggregate === undefined) return null;
    const agentRuns = values(aggregate.agentRuns, "id");
    return {
      task: {
        id: aggregate.task.id,
        status: aggregate.task.status,
        projectBindings: aggregate.task.projectBindings
      },
      workItems: values(aggregate.workItems, "id"),
      changeSets: values(aggregate.changeSets, "id"),
      integrations: values(aggregate.integrationAttempts, "id"),
      reviewRounds: values(aggregate.reviewRounds, "id"),
      openInputRequests: values(aggregate.inputRequests, "id")
        .filter((request) => request.status === "open"),
      activeRuns: agentRuns.filter((run) => run.status === "active"),
      leaderRuns: agentRuns.filter((run) => run.roleName === "leader")
    };
  }
  getReviewConfig(): ReviewConfig | null {
    return optional(this.#state().config.review);
  }
  getTaskBrief(taskId: string): TaskBrief | null {
    return optional(this.#state().tasks[taskId]?.brief ?? undefined);
  }
  saveTaskBrief(taskId: string, brief: TaskBrief): void {
    const stored = storedTaskBrief(brief);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { state.tasks[taskId].brief = stored; });
  }
  clearTaskBrief(taskId: string): void {
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { state.tasks[taskId].brief = null; });
  }

  nextChangeSetId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "changeSet");
  }
  saveChangeSet(taskId: string, changeSet: ChangeSet): void {
    const stored = identifiedChangeSet(changeSet, changeSet.id);
    validateChangeSet(stored);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`ChangeSet belongs to another Task: ${stored.taskId}.`);
    }
    const aggregate = this.#requireTaskForWrite(taskId);
    const evidenceRound = Object.values(aggregate.reviewRounds).find(
      ({ evidenceCommit, reviewBaseCommit }) => evidenceCommit !== undefined && evidenceCommit !== reviewBaseCommit && evidenceCommit === stored.headCommit
    );
    if (evidenceRound !== undefined) {
      throw new StorageRecordError(
        `ReviewRound evidence commit ${evidenceRound.id}/${stored.headCommit} cannot become a ChangeSet.`
      );
    }
    if (!aggregate.task.projectBindings.some(({ projectId }) => projectId === stored.projectId)) {
      throw new StorageRecordError(`ChangeSet Project does not match Task: ${stored.id}.`);
    }
    if (aggregate.workItems[stored.workItemId] === undefined) {
      throw new StorageRecordError(`ChangeSet Work Item not found: ${stored.workItemId}.`);
    }
    const existing = aggregate.changeSets[stored.id];
    if (existing !== undefined && !isDeepStrictEqual(existing, stored)) {
      throw new StorageRecordError(`ChangeSet is immutable: ${stored.id}.`);
    }
    this.#mutate((state) => {
      const task = state.tasks[taskId];
      observeTaskRecordId(task, "changeSet", stored.id);
      task.changeSets[stored.id] = stored;
    });
  }
  listChangeSets(taskId: string): ChangeSet[] {
    return values(this.#requireTask(taskId).changeSets, "id");
  }
  getChangeSet(taskId: string, changeSetId: string): ChangeSet | null {
    return optional(this.#state().tasks[taskId]?.changeSets[changeSetId]);
  }

  nextIntegrationAttemptId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "integrationAttempt");
  }
  saveIntegrationAttempt(taskId: string, attempt: IntegrationAttempt): void {
    const stored = identified<IntegrationAttempt>(
      attempt,
      CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION,
      "id",
      attempt.id,
      "Integration Attempt"
    );
    validateIntegrationAttempt(stored);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Integration Attempt belongs to another Task: ${stored.taskId}.`);
    }
    const aggregate = this.#requireTaskForWrite(taskId);
    if (!aggregate.task.projectBindings.some(
      ({ projectId }) => projectId === stored.projectId
    )) {
      throw new StorageRecordError(`Integration Project does not match Task: ${stored.id}.`);
    }
    for (const changeSetId of stored.changeSetIds) {
      const changeSet = aggregate.changeSets[changeSetId];
      if (changeSet === undefined) {
        throw new StorageRecordError(`Integration ChangeSet not found: ${changeSetId}.`);
      }
      if (changeSet.projectId !== stored.projectId) {
        throw new StorageRecordError(`Integration ChangeSet belongs to another Project: ${changeSetId}.`);
      }
      const evidenceRound = Object.values(aggregate.reviewRounds).find(
        ({ evidenceCommit, reviewBaseCommit }) => evidenceCommit !== undefined && evidenceCommit !== reviewBaseCommit && evidenceCommit === changeSet.headCommit
      );
      if (evidenceRound !== undefined) {
        throw new StorageRecordError(
          `ReviewRound evidence commit ${evidenceRound.id}/${changeSet.headCommit} cannot become an Integration source.`
        );
      }
    }
    const existing = aggregate.integrationAttempts[stored.id];
    if (existing !== undefined) {
      if (Date.parse(stored.updatedAt) < Date.parse(existing.updatedAt)) {
        throw new StorageRecordError(
          `Integration Attempt updatedAt cannot move backwards: ${stored.id}.`
        );
      }
      if (!validIntegrationTransition(existing, stored)) {
        throw new StorageRecordError(`Integration Attempt transition is invalid: ${stored.id}.`);
      }
    }
    this.#mutate((state) => {
      const task = state.tasks[taskId];
      observeTaskRecordId(task, "integrationAttempt", stored.id);
      task.integrationAttempts[stored.id] = stored;
    });
  }
  listIntegrationAttempts(taskId: string): IntegrationAttempt[] {
    return values(this.#requireTask(taskId).integrationAttempts, "id");
  }
  getIntegrationAttempt(taskId: string, integrationId: string): IntegrationAttempt | null {
    return optional(this.#state().tasks[taskId]?.integrationAttempts[integrationId]);
  }

  nextIntegrationQueueEntryId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "integrationQueue");
  }
  saveIntegrationQueueEntry(taskId: string, entry: IntegrationQueueEntry): void {
    const stored = identified<IntegrationQueueEntry>(
      entry,
      CURRENT_INTEGRATION_QUEUE_SCHEMA_VERSION,
      "id",
      entry.id,
      "Integration queue entry"
    );
    validateIntegrationQueueEntry(stored);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Integration queue entry belongs to another Task: ${stored.taskId}.`);
    }
    const aggregate = this.#requireTaskForWrite(taskId);
    if (!aggregate.task.projectBindings.some(
      ({ projectId }) => projectId === stored.projectId
    )) {
      throw new StorageRecordError(`Integration queue Project does not match Task: ${stored.id}.`);
    }
    const changeSet = aggregate.changeSets[stored.changeSetId];
    if (changeSet === undefined) {
      throw new StorageRecordError(`Integration queue ChangeSet not found: ${stored.changeSetId}.`);
    }
    if (changeSet.projectId !== stored.projectId) {
      throw new StorageRecordError(
        `Integration queue ChangeSet belongs to another Project: ${stored.changeSetId}.`
      );
    }
    const existing = aggregate.integrationQueue[stored.id];
    if (existing !== undefined) {
      if (Date.parse(stored.updatedAt) < Date.parse(existing.updatedAt)) {
        throw new StorageRecordError(
          `Integration queue entry updatedAt cannot move backwards: ${stored.id}.`
        );
      }
      if (!validIntegrationQueueTransition(existing, stored)) {
        throw new StorageRecordError(`Integration queue entry transition is invalid: ${stored.id}.`);
      }
    }
    this.#mutate((state) => {
      const task = state.tasks[taskId];
      observeTaskRecordId(task, "integrationQueue", stored.id);
      task.integrationQueue[stored.id] = stored;
    });
  }
  listIntegrationQueueEntries(taskId: string): IntegrationQueueEntry[] {
    return values(this.#requireTask(taskId).integrationQueue, "id");
  }
  getIntegrationQueueEntry(taskId: string, entryId: string): IntegrationQueueEntry | null {
    return optional(this.#state().tasks[taskId]?.integrationQueue[entryId]);
  }

  nextDurableJobId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "durableJob");
  }
  saveDurableJob(taskId: string, job: DurableJob): void {
    const stored = identified<DurableJob>(
      job,
      CURRENT_DURABLE_JOB_SCHEMA_VERSION,
      "id",
      job.id,
      "DurableJob"
    );
    validateDurableJob(stored);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`DurableJob belongs to another Task: ${stored.taskId}.`);
    }
    const aggregate = this.#requireTaskForWrite(taskId);
    if (!aggregate.task.projectBindings.some(
      ({ projectId }) => projectId === stored.projectId
    )) {
      throw new StorageRecordError(`DurableJob Project does not match Task: ${stored.id}.`);
    }
    const existing = aggregate.durableJobs[stored.id];
    if (existing !== undefined) {
      if (Date.parse(stored.updatedAt) < Date.parse(existing.updatedAt)) {
        throw new StorageRecordError(
          `DurableJob updatedAt cannot move backwards: ${stored.id}.`
        );
      }
      if (!validDurableJobTransition(existing, stored)) {
        throw new StorageRecordError(`DurableJob transition is invalid: ${stored.id}.`);
      }
    }
    this.#mutate((state) => {
      const task = state.tasks[taskId];
      observeTaskRecordId(task, "durableJob", stored.id);
      task.durableJobs[stored.id] = stored;
    });
  }
  listDurableJobs(taskId: string): DurableJob[] {
    return values(this.#requireTask(taskId).durableJobs, "id");
  }
  getDurableJob(taskId: string, jobId: string): DurableJob | null {
    return optional(this.#state().tasks[taskId]?.durableJobs[jobId]);
  }
  findDurableJobByIdempotencyKey(taskId: string, key: string): DurableJob | null {
    const aggregate = this.#state().tasks[taskId];
    if (aggregate === undefined) return null;
    const found = Object.values(aggregate.durableJobs)
      .find((job) => job.idempotencyKey === key);
    return optional(found);
  }
  listAllDurableJobs(): DurableJob[] {
    const all: DurableJob[] = [];
    for (const aggregate of Object.values(this.#state().tasks)) {
      all.push(...Object.values(aggregate.durableJobs));
    }
    return all.map((job) => clone(job));
  }
  hasActiveDurableJobs(): boolean {
    for (const aggregate of Object.values(this.#state().tasks)) {
      for (const job of Object.values(aggregate.durableJobs)) {
        if (job.status === "queued" || job.status === "running") return true;
      }
    }
    return false;
  }

  saveRole(taskId: string, role: TaskRole): void {
    const aggregate = this.#requireTaskForWrite(taskId);
    const stored = identified<TaskRole>(
      role,
      CURRENT_TASK_ROLE_SCHEMA_VERSION,
      "name",
      role.name,
      "Task Role"
    );
    if (stored.taskId !== taskId) throw new StorageRecordError(`Task Role belongs to another Task: ${stored.taskId}`);
    validateTaskRole(stored);
    const sessions = this.getRoleSessionSet(taskId, stored.name);
    if (sessions !== null) assertSessionsMatchRole(sessions, stored);
    this.#mutate((state) => { state.tasks[aggregate.task.id].roles[stored.name] = stored; });
  }
  listRoles(taskId: string): TaskRole[] { return values(this.#requireTask(taskId).roles, "name"); }
  getRole(taskId: string, name: string): TaskRole | null { return optional(this.#state().tasks[taskId]?.roles[name]); }
  saveTaskRoleWithSessionSet(role: TaskRole, sessions: TaskRoleSessionSet): void {
    const storedRole = identified<TaskRole>(
      role,
      CURRENT_TASK_ROLE_SCHEMA_VERSION,
      "name",
      role.name,
      "Task Role"
    );
    validateTaskRole(storedRole);
    const storedSessions = taskSessions(sessions);
    assertSessionsMatchRole(storedSessions, storedRole);
    this.transaction(() => {
      this.#requireTaskForWrite(storedRole.taskId);
      this.#mutate((state) => {
        state.tasks[storedRole.taskId].roles[storedRole.name] = storedRole;
        state.tasks[storedRole.taskId].roleSessionSets[storedRole.name] = storedSessions;
      });
    });
  }
  removeTaskRole(taskId: string, name: string): boolean {
    return this.transaction(() => {
      const aggregate = this.#requireTask(taskId);
      const removed = this.#remove(() => aggregate.roles, name);
      this.#mutate((state) => {
        delete aggregate.roleSessionSets[name];
        delete aggregate.activeRuns[name];
        delete state.mailboxes[mailboxTargetKey({ kind: "role", taskId, roleName: name })];
      });
      return removed;
    });
  }
  saveManagedWorkspace(workspace: ManagedWorkspace): void {
    const stored = versioned<ManagedWorkspace>(
      workspace,
      CURRENT_MANAGED_WORKSPACE_SCHEMA_VERSION,
      "Managed workspace"
    );
    validateManagedWorkspace(stored);
    const taskId = stored.owner.taskId;
    const aggregate = this.#requireTaskForWrite(taskId);
    if (stored.owner.type === "work-item"
      && aggregate.workItems[stored.owner.workItemId] === undefined) {
      throw new StorageRecordError(
        `Managed workspace WorkItem not found: ${taskId}/${stored.owner.workItemId}.`
      );
    }
    if (stored.owner.type === "review-round"
      && aggregate.reviewRounds[stored.owner.reviewRoundId] === undefined) {
      throw new StorageRecordError(
        `Managed workspace ReviewRound not found: ${taskId}/${stored.owner.reviewRoundId}.`
      );
    }
    if (stored.owner.type === "integration-attempt"
      && aggregate.integrationAttempts[stored.owner.integrationAttemptId] === undefined) {
      throw new StorageRecordError(
        `Managed workspace Integration Attempt not found: ${taskId}/${stored.owner.integrationAttemptId}.`
      );
    }
    if (stored.owner.type === "execution-lane") {
      const groupOwner = stored.owner;
      if (groupOwner.purpose === "execution") {
        const item = groupOwner.workItemId === undefined
          ? undefined
          : aggregate.workItems[groupOwner.workItemId];
        if (item === undefined
          || workItemExecutionGroupById(item, groupOwner.executionGroupId) === undefined
          || !workItemExecutionGroupById(item, groupOwner.executionGroupId)!.lanes.some(
            ({ id }) => id === groupOwner.executionLaneId
          )) {
          throw new StorageRecordError(
            `Managed execution Lane WorkItem lineage is invalid: ${taskId}/${groupOwner.executionGroupId}/${groupOwner.executionLaneId}.`
          );
        }
      } else {
        const round = groupOwner.reviewRoundId === undefined
          ? undefined
          : aggregate.reviewRounds[groupOwner.reviewRoundId];
        if (round === undefined || round.executionGroup?.id !== groupOwner.executionGroupId
          || !round.executionGroup.lanes.some(({ id }) => id === groupOwner.executionLaneId)) {
          throw new StorageRecordError(
            `Managed review Lane ReviewRound lineage is invalid: ${taskId}/${groupOwner.executionGroupId}/${groupOwner.executionLaneId}.`
          );
        }
      }
    }
    assertManagedWorkspaceReferences(aggregate, stored, "Managed workspace");
    const boundProjects = new Set(
      aggregate.task.projectBindings.map(({ projectId }) => projectId)
    );
    if (stored.entries.some(({ projectId }) => !boundProjects.has(projectId))) {
      throw new StorageRecordError(
        `Managed workspace Project does not match Task: ${taskId}.`
      );
    }
    this.#mutate((state) => {
      state.tasks[taskId].managedWorkspaces[managedWorkspaceKey(stored.owner)] = stored;
    });
  }
  listManagedWorkspaces(taskId: string): ManagedWorkspace[] {
    return values(this.#requireTask(taskId).managedWorkspaces, (workspace) =>
      managedWorkspaceKey(workspace.owner)
    );
  }
  listManagedWorkspace(taskId: string): ManagedWorkspace[] {
    return this.listManagedWorkspaces(taskId);
  }
  getTaskWorkspace(taskId: string): ManagedWorkspace | null {
    return this.getManagedWorkspace({ type: "task", taskId });
  }
  getWorkItemWorkspace(taskId: string, workItemId: string): ManagedWorkspace | null {
    return this.getManagedWorkspace({ type: "work-item", taskId, workItemId });
  }
  getReviewRoundWorkspace(taskId: string, reviewRoundId: string): ManagedWorkspace | null {
    return this.getManagedWorkspace({ type: "review-round", taskId, reviewRoundId });
  }
  getIntegrationWorkspace(
    taskId: string,
    integrationAttemptId: string
  ): ManagedWorkspace | null {
    return this.getManagedWorkspace({
      type: "integration-attempt",
      taskId,
      integrationAttemptId
    });
  }
  getManagedWorkspace(owner: ManagedWorkspaceOwner): ManagedWorkspace | null {
    return optional(
      this.#state().tasks[owner.taskId]?.managedWorkspaces[managedWorkspaceKey(owner)]
    );
  }
  removeManagedWorkspace(owner: ManagedWorkspaceOwner): boolean {
    this.#requireTaskForWrite(owner.taskId);
    return this.#remove(
      (state) => state.tasks[owner.taskId].managedWorkspaces,
      managedWorkspaceKey(owner)
    );
  }

  getRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null {
    return optional(this.#state().tasks[taskId]?.roleSessionSets[roleName]);
  }
  getTaskRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null {
    return this.getRoleSessionSet(taskId, roleName);
  }
  listRoleSessionSets(taskId: string): TaskRoleSessionSet[] {
    return values(this.#requireTask(taskId).roleSessionSets, (set) => set.owner.roleName);
  }
  saveRoleSessionSet(sessions: TaskRoleSessionSet): void {
    const stored = taskSessions(sessions);
    const taskId = stored.owner.taskId;
    this.#requireTaskForWrite(taskId);
    const role = this.getRole(taskId, stored.owner.roleName);
    if (role === null) throw new StorageRecordError(`Task Role not found: ${taskId}/${stored.owner.roleName}`);
    assertSessionsMatchRole(stored, role);
    this.#mutate((state) => { state.tasks[taskId].roleSessionSets[stored.owner.roleName] = stored; });
  }
  saveTaskRoleSessionSet(sessions: TaskRoleSessionSet): void { this.saveRoleSessionSet(sessions); }
  getRoleSession(taskId: string, roleName: string): RoleAgentSession | null {
    const set = this.getRoleSessionSet(taskId, roleName);
    return set === null ? null : optional(set.sessions[set.activeAgentId]);
  }
  getJobCallerKeyHash(taskId: string, roleName: string, agentId: string): string | null {
    const hashes = this.#state().tasks[taskId]?.jobCallerKeyHashes;
    if (hashes === undefined) return null;
    return optional(hashes[jobCallerKeyHashKey(roleName, agentId)]);
  }
  setJobCallerKeyHash(taskId: string, roleName: string, agentId: string, hash: string): void {
    this.#requireTaskForWrite(taskId);
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new StorageRecordError(`Job caller key hash is invalid: ${taskId}/${roleName}.`);
    }
    this.#mutate((state) => {
      state.tasks[taskId].jobCallerKeyHashes[jobCallerKeyHashKey(roleName, agentId)] = hash;
    });
  }

  saveSessionOwner(identity: SessionOwnerIdentity): void {
    this.#sessionOwners().record(identity);
  }
  getSessionOwner(launchId: string): SessionOwnerIdentity | null {
    return this.#sessionOwners().get(launchId);
  }
  listSessionOwners(): SessionOwnerIdentity[] {
    return this.#sessionOwners().list();
  }
  listSessionOwnersForOwner(owner: RuntimeOwner): SessionOwnerIdentity[] {
    return this.#sessionOwners().listForOwner(owner);
  }
  removeSessionOwner(launchId: string): void {
    this.#sessionOwners().remove(launchId);
  }
  #sessionOwners(): FileSessionOwnerRegistry {
    if (this.#sessionOwnerRegistry === undefined) {
      this.#sessionOwnerRegistry = new FileSessionOwnerRegistry(this.rootDir);
    }
    return this.#sessionOwnerRegistry;
  }

  nextWorkItemId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "workItem");
  }
  getWorkItem(taskId: string, id: string): WorkItem | null { return optional(this.#state().tasks[taskId]?.workItems[id]); }
  listWorkItems(taskId: string): WorkItem[] { return values(this.#requireTask(taskId).workItems, "id"); }
  saveWorkItem(taskId: string, item: WorkItem): void {
    const stored = identified<WorkItem>(
      item,
      CURRENT_WORK_ITEM_SCHEMA_VERSION,
      "id",
      item.id,
      "Work item"
    );
    if (stored.taskId !== taskId) throw new StorageRecordError(`Work item belongs to another Task: ${stored.taskId}`);
    validateWorkItem(stored);
    const aggregate = this.#requireTaskForWrite(taskId);
    const boundProjects = new Set(aggregate.task.projectBindings.map(({ projectId }) => projectId));
    if (stored.writeProjectIds.some((projectId) => !boundProjects.has(projectId))) {
      throw new StorageRecordError(`Work Item writable Project does not belong to Task: ${stored.id}.`);
    }
    const writableProjects = new Set(stored.writeProjectIds);
    if (stored.baseRefs?.some(({ projectId }) => !boundProjects.has(projectId))) {
      throw new StorageRecordError(`Work Item base-ref Project does not belong to Task: ${stored.id}.`);
    }
    if (stored.baseRefs?.some(({ projectId }) => !writableProjects.has(projectId))) {
      throw new StorageRecordError(
        `Work Item base-ref Project must be writable: ${stored.id}.`
      );
    }
    for (const dependencyId of stored.dependsOn) {
      const dependency = this.getWorkItem(taskId, dependencyId);
      if (dependency === null) {
        throw new StorageRecordError(`Work Item dependency not found: ${dependencyId}.`);
      }
    }
    assertAcyclicWorkItems({
      ...aggregate.workItems,
      [stored.id]: stored
    });
    for (const candidate of stored.candidates) {
      assertWorkItemCandidateReferences(aggregate, stored, candidate, "Work Item candidate");
    }
    const existing = this.getWorkItem(taskId, stored.id);
    if (existing !== null && !validWorkItemTransition(existing, stored)) {
      throw new StorageRecordError(`Work Item transition is invalid: ${stored.id}.`);
    }
    this.#mutate((state) => {
      const task = state.tasks[taskId];
      observeTaskRecordId(task, "workItem", stored.id);
      task.workItems[stored.id] = stored;
    });
  }

  nextAgentRunId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "agentRun");
  }
  peekNextAgentRunId(taskId: string): string {
    return this.#peekTaskRecordId(taskId, "agentRun");
  }
  getAgentRun(taskId: string, id: string): AgentRun | null { return optional(this.#state().tasks[taskId]?.agentRuns[id]); }
  listAgentRuns(taskId: string): AgentRun[] { return values(this.#requireTask(taskId).agentRuns, "id"); }
  listPendingProviderRetries(): ReadonlyArray<PendingProviderRetry> {
    // The legacy File store can answer the empty case without a scan fallback.
    // If durable retry state exists, the db-only capability must fail closed
    // instead of silently losing the Controller's wake deadline.
    for (const task of this.listTasks()) {
      if (task.status !== "active") continue;
      for (const run of this.listAgentRuns(task.id)) {
        if (run.status === "active" && run.providerRetry?.nextAttemptAt !== undefined) {
          throw new StorageRecordError(
            "Provider retry in place requires the SQLite backend; run `yui update` to migrate this Home."
          );
        }
      }
    }
    return [];
  }
  saveAgentRun(run: AgentRun): void {
    const stored = identified<AgentRun>(
      run,
      CURRENT_AGENT_RUN_SCHEMA_VERSION,
      "id",
      run.id,
      "Agent run"
    );
    validateAgentRun(stored);
    const aggregate = this.#requireTaskForWrite(stored.taskId);
    if (stored.purpose === "review"
      && aggregate.task.projectBindings.length > 0
      && stored.workspace === undefined) {
      throw new StorageRecordError(
        `A Project-backed review Agent run requires its ReviewRound workspace: ${stored.id}.`
      );
    }
    if (stored.reviewRoundId !== undefined) {
      const round = aggregate.reviewRounds[stored.reviewRoundId];
      if (round === undefined) {
        throw new StorageRecordError(`Agent run ReviewRound not found: ${stored.reviewRoundId}.`);
      }
      const laneRole = round.executionGroup?.lanes.find(({ id }) => id === stored.executionLaneId)?.roleName;
      if (round.workItemId !== stored.workItemId
        || (round.reviewerRoleName !== stored.roleName && laneRole !== stored.roleName)) {
        throw new StorageRecordError(`Agent run does not match ReviewRound: ${stored.id}.`);
      }
    }
    assertAgentRunExecutionReferences(aggregate, stored);
    this.#mutate((state) => {
      const task = state.tasks[stored.taskId];
      observeTaskRecordId(task, "agentRun", stored.id);
      task.agentRuns[stored.id] = stored;
    });
  }
  nextReviewRoundId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "reviewRound");
  }
  getReviewRound(taskId: string, reviewRoundId: string): ReviewRound | null {
    return optional(this.#state().tasks[taskId]?.reviewRounds[reviewRoundId]);
  }
  listReviewRounds(taskId: string): ReviewRound[] {
    return values(this.#requireTask(taskId).reviewRounds, "id");
  }
  saveReviewRound(taskId: string, round: ReviewRound): void {
    const stored = identified<ReviewRound>(
      round,
      CURRENT_REVIEW_ROUND_SCHEMA_VERSION,
      "id",
      round.id,
      "ReviewRound"
    );
    validateReviewRound(stored);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`ReviewRound belongs to another Task: ${stored.taskId}.`);
    }
    const aggregate = this.#requireTaskForWrite(taskId);
    const item = aggregate.workItems[stored.workItemId];
    if (item === undefined) {
      throw new StorageRecordError(`ReviewRound Work Item not found: ${stored.workItemId}.`);
    }
    const candidate = item.candidates.find(({ id }) => id === stored.candidateId);
    if (candidate === undefined) {
      throw new StorageRecordError(`ReviewRound Candidate not found: ${stored.candidateId}.`);
    }
    assertWorkItemCandidateReferences(aggregate, item, candidate, `ReviewRound candidate ${stored.id}`);
    if ((stored.scope ?? "work-item") === "task"
      && !sameTaskFinalReviewContract(
        stored.taskFinalReviewContract,
        candidate.taskFinalReviewContract
      )) {
      throw new StorageRecordError(
        `Task ReviewRound contract does not match its Candidate: ${stored.id}.`
      );
    }
    if (stored.reviewerRunId !== undefined) {
      const reviewerRun = aggregate.agentRuns[stored.reviewerRunId];
      if (reviewerRun !== undefined
        && (reviewerRun.reviewRoundId !== stored.id || reviewerRun.purpose !== "review")) {
        throw new StorageRecordError(`ReviewRound Reviewer Run is invalid: ${stored.reviewerRunId}.`);
      }
    }
    const existing = aggregate.reviewRounds[stored.id];
    if (existing !== undefined && !validReviewRoundTransition(existing, stored)) {
      throw new StorageRecordError(`ReviewRound transition is invalid: ${stored.id}.`);
    }
    this.#mutate((state) => {
      const task = state.tasks[taskId];
      observeTaskRecordId(task, "reviewRound", stored.id);
      task.reviewRounds[stored.id] = stored;
    });
  }
  nextReviewFindingId(taskId: string): string {
    throw new StorageRecordError(
      `Review findings require the SQLite backend (yui.db); migrate this Home with \`yui update\` before using the finding ledger on Task ${taskId}.`
    );
  }
  getReviewFinding(taskId: string, reviewFindingId: string): ReviewFinding | null {
    throw new StorageRecordError(
      `Review findings require the SQLite backend (yui.db); migrate this Home with \`yui update\` before using the finding ledger on Task ${taskId}.`
    );
  }
  listReviewFindings(taskId: string): ReviewFinding[] {
    throw new StorageRecordError(
      `Review findings require the SQLite backend (yui.db); migrate this Home with \`yui update\` before using the finding ledger on Task ${taskId}.`
    );
  }
  saveReviewFinding(taskId: string, finding: ReviewFinding): void {
    throw new StorageRecordError(
      `Review findings require the SQLite backend (yui.db); migrate this Home with \`yui update\` before using the finding ledger on Task ${taskId}.`
    );
  }
  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null {
    const aggregate = this.#state().tasks[taskId];
    const pointer = aggregate?.activeRuns[roleName];
    if (aggregate === undefined || pointer === undefined) return null;
    const run = aggregate.agentRuns[pointer.runId];
    if (run === undefined) throw new StorageRecordError(`Active Agent run pointer is dangling: ${taskId}/${roleName}`);
    return clone(run);
  }
  saveActiveAgentRun(run: AgentRun): void {
    if (run.executionGroupId !== undefined && run.executionLaneId !== undefined) {
      this.saveActiveExecutionLaneRun(run);
      return;
    }
    if (run.status !== "active") throw new StorageRecordError(`Active Agent run must have active status: ${run.id}`);
    this.transaction((store) => {
      const current = store.getActiveAgentRun(run.taskId, run.roleName);
      if (current !== null && current.id !== run.id) {
        throw new StorageRecordError(`Role already has an active Agent run: ${run.taskId}/${run.roleName}`);
      }
      const sessions = store.getTaskRoleSessionSet(run.taskId, run.roleName);
      if (sessions !== null && sessions.inFlight !== null && sessions.inFlight.runId !== run.id) {
        throw new StorageRecordError(
          `Role still has an in-flight Turn: ${run.taskId}/${run.roleName}/${sessions.inFlight.runId}`
        );
      }
      store.saveAgentRun(run);
      this.#mutate((state) => {
        state.tasks[run.taskId].activeRuns[run.roleName] = {
          schemaVersion: CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
          runId: run.id
        };
      });
    });
  }
  clearActiveAgentRun(taskId: string, roleName: string): void {
    this.#mutate((state) => {
      const task = state.tasks[taskId];
      if (task === undefined) return;
      const rolePointer = task.activeRuns[roleName];
      delete task.activeRuns[roleName];
      // Older Controller paths only know the Role key.  When that key points
      // at a lane-backed Run, remove the matching lane pointer too; preserve
      // every other lane for the same Role in a multi-lane group.
      if (rolePointer === undefined) return;
      for (const [key, pointer] of Object.entries(task.activeRuns)) {
        if (executionLaneActiveRunKeyParts(key) !== null && pointer.runId === rolePointer.runId) {
          delete task.activeRuns[key];
        }
      }
    });
  }
  getActiveExecutionLaneRun(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): AgentRun | null {
    const aggregate = this.#state().tasks[taskId];
    const key = executionLaneActiveRunKey(executionGroupId, executionLaneId);
    const pointer = aggregate?.activeRuns[key];
    if (aggregate === undefined || pointer === undefined) return null;
    const run = aggregate.agentRuns[pointer.runId];
    if (run === undefined) {
      throw new StorageRecordError(`Active Agent run pointer is dangling: ${taskId}/${key}`);
    }
    if (run.executionGroupId !== executionGroupId
      || run.executionLaneId !== executionLaneId
      || run.status !== "active") {
      throw new StorageRecordError(`Active Agent run pointer is invalid: ${taskId}/${key}`);
    }
    return clone(run);
  }
  saveActiveExecutionLaneRun(run: AgentRun): void {
    if (run.status !== "active") {
      throw new StorageRecordError(`Active Agent run must have active status: ${run.id}`);
    }
    if (run.executionGroupId === undefined || run.executionLaneId === undefined) {
      throw new StorageRecordError(`Lane active Agent run requires execution lineage: ${run.id}`);
    }
    this.transaction((store) => {
      const key = executionLaneActiveRunKey(run.executionGroupId!, run.executionLaneId!);
      const current = store.getActiveExecutionLaneRun(
        run.taskId,
        run.executionGroupId!,
        run.executionLaneId!
      );
      if (current !== null && current.id !== run.id) {
        throw new StorageRecordError(`Execution Lane already has an active Agent run: ${run.taskId}/${key}`);
      }
      const sessions = store.getTaskRoleSessionSet(run.taskId, run.roleName);
      if (sessions !== null && sessions.inFlight !== null && sessions.inFlight.runId !== run.id) {
        throw new StorageRecordError(
          `Role still has an in-flight Turn: ${run.taskId}/${run.roleName}/${sessions.inFlight.runId}`
        );
      }
      store.saveAgentRun(run);
      this.#mutate((state) => {
        const task = state.tasks[run.taskId];
        task.activeRuns[key] = {
          schemaVersion: CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
          runId: run.id
        };
        // Preserve the legacy role pointer for the single-lane delivery path.
        // A second lane for the same Role keeps the first pointer unchanged;
        // lane-aware readers use the exact key above.
        if (task.activeRuns[run.roleName] === undefined) {
          task.activeRuns[run.roleName] = {
            schemaVersion: CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
            runId: run.id
          };
        }
      });
    });
  }
  clearActiveExecutionLaneRun(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): void {
    this.#mutate((state) => {
      const task = state.tasks[taskId];
      if (task === undefined) return;
      const key = executionLaneActiveRunKey(executionGroupId, executionLaneId);
      const pointer = task.activeRuns[key];
      delete task.activeRuns[key];
      const runId = pointer?.runId;
      for (const [roleName, rolePointer] of Object.entries(task.activeRuns)) {
        if (executionLaneActiveRunKeyParts(roleName) !== null) continue;
        const roleRun = task.agentRuns[rolePointer.runId];
        const matches = runId !== undefined
          ? rolePointer.runId === runId
          : roleRun?.executionGroupId === executionGroupId
            && roleRun.executionLaneId === executionLaneId;
        if (matches) {
          delete task.activeRuns[roleName];
        }
      }
    });
  }

  nextMessageId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "message");
  }
  saveMessage(taskId: string, message: TaskMessage): void {
    validateTaskMessage(message);
    if (message.taskId !== taskId) {
      throw new StorageRecordError(`Message belongs to another Task: ${message.taskId}`);
    }
    this.#saveTaskRecord(taskId, "messages", message, "Message");
  }
  listMessages(taskId: string): TaskMessage[] { return values(this.#requireTask(taskId).messages, "id"); }
  nextInputRequestId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "inputRequest");
  }
  saveInputRequest(taskId: string, request: InputRequest): void {
    const stored = validateInputRequest(versioned<InputRequest>(
      request,
      CURRENT_INPUT_REQUEST_SCHEMA_VERSION,
      "Input request"
    ));
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Input request belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      const existing = aggregate.inputRequests[stored.id];
      if (existing === undefined && stored.status !== "open") {
        throw new StorageRecordError(`Input request must start open: ${stored.id}`);
      }
      if (existing !== undefined && !isValidInputRequestTransition(existing, stored)) {
        throw new StorageRecordError(`Input request cannot be overwritten: ${stored.id}`);
      }
      observeTaskRecordId(aggregate, "inputRequest", stored.id);
      aggregate.inputRequests[stored.id] = stored;
    });
  }
  getInputRequest(taskId: string, requestId: string): InputRequest | null {
    return optional(this.#state().tasks[taskId]?.inputRequests[requestId]);
  }
  listInputRequests(taskId: string): InputRequest[] {
    return values(this.#requireTask(taskId).inputRequests, "id");
  }
  listAllInputRequests(): InputRequest[] {
    return Object.values(this.#state().tasks)
      .flatMap((aggregate) => Object.values(aggregate.inputRequests).map(clone))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.taskId.localeCompare(right.taskId)
        || numericCompare(left.id, right.id)
      ));
  }
  nextDecisionId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "decision");
  }
  saveDecision(taskId: string, decision: Decision): void {
    const stored = storedDecision(decision);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Decision belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      const existing = aggregate.decisions[stored.id];
      if (existing === undefined && stored.status !== "active") {
        throw new StorageRecordError(`Decision must start active: ${stored.id}`);
      }
      if (existing !== undefined && !isValidDecisionSupersession(existing, stored)) {
        throw new StorageRecordError(`Decision cannot be overwritten: ${stored.id}`);
      }
      observeTaskRecordId(aggregate, "decision", stored.id);
      aggregate.decisions[stored.id] = stored;
    });
  }
  listDecisions(taskId: string): Decision[] {
    return values(this.#requireTask(taskId).decisions, "id");
  }
  getDecision(taskId: string, decisionId: string): Decision | null {
    return this.#requireTask(taskId).decisions[decisionId] ?? null;
  }
  nextMilestoneId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "milestone");
  }
  saveMilestone(taskId: string, milestone: Milestone): void {
    const stored = storedMilestone(milestone);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Milestone belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      if (aggregate.milestones[stored.id] !== undefined) {
        throw new StorageRecordError(`Milestone already exists: ${taskId}/${stored.id}`);
      }
      observeTaskRecordId(aggregate, "milestone", stored.id);
      aggregate.milestones[stored.id] = stored;
    });
  }
  listMilestones(taskId: string): Milestone[] {
    return values(this.#requireTask(taskId).milestones, "id");
  }
  getMilestone(taskId: string, milestoneId: string): Milestone | null {
    return this.#requireTask(taskId).milestones[milestoneId] ?? null;
  }
  nextEventId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "event");
  }
  saveEvent(taskId: string, event: TaskEvent): void {
    const stored = storedTaskEvent(event);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Task event belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      if (aggregate.events[stored.id] !== undefined) {
        throw new StorageRecordError(`Task event already exists: ${taskId}/${stored.id}`);
      }
      observeTaskRecordId(aggregate, "event", stored.id);
      aggregate.events[stored.id] = stored;
    });
  }
  listEvents(taskId: string): TaskEvent[] { return values(this.#requireTask(taskId).events, "id"); }

  removeEvents(taskId: string, eventIds: readonly string[]): number {
    if (eventIds.length === 0) return 0;
    let removed = 0;
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      for (const id of eventIds) {
        if (aggregate.events[id] !== undefined) {
          delete aggregate.events[id];
          removed++;
        }
      }
    });
    return removed;
  }

  nextCapabilityGrantId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "capabilityGrant");
  }
  saveCapabilityGrant(taskId: string, grant: CapabilityGrant): void {
    const stored = storedCapabilityGrant(grant);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Capability grant belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      const existing = aggregate.capabilityGrants[stored.id];
      if (existing === undefined) {
        if (stored.revokedAt !== undefined) {
          throw new StorageRecordError(`Capability grant must start unrevoked: ${stored.id}`);
        }
        if (stored.usesUsed !== 0) {
          throw new StorageRecordError(`Capability grant must start unused: ${stored.id}`);
        }
      } else if (!isValidCapabilityGrantTransition(existing, stored)) {
        throw new StorageRecordError(`Capability grant cannot be overwritten: ${taskId}/${stored.id}`);
      }
      observeTaskRecordId(aggregate, "capabilityGrant", stored.id);
      aggregate.capabilityGrants[stored.id] = stored;
    });
  }
  listCapabilityGrants(taskId: string): CapabilityGrant[] {
    return values(this.#requireTask(taskId).capabilityGrants, "id");
  }
  getCapabilityGrant(taskId: string, grantId: string): CapabilityGrant | null {
    return this.#requireTask(taskId).capabilityGrants[grantId] ?? null;
  }

  nextReleaseWorkflowId(taskId: string): string {
    return this.#nextTaskRecordId(taskId, "releaseWorkflow");
  }
  saveReleaseWorkflow(taskId: string, workflow: ReleaseWorkflow): void {
    const stored = storedReleaseWorkflow(workflow);
    if (stored.taskId !== taskId) {
      throw new StorageRecordError(`Release workflow belongs to another Task: ${stored.taskId}`);
    }
    this.#mutate((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      const existing = aggregate.releaseWorkflows[stored.id];
      if (existing !== undefined && !isValidReleaseWorkflowTransition(existing, stored)) {
        throw new StorageRecordError(`Release workflow cannot be overwritten: ${taskId}/${stored.id}`);
      }
      observeTaskRecordId(aggregate, "releaseWorkflow", stored.id);
      aggregate.releaseWorkflows[stored.id] = stored;
    });
  }
  listReleaseWorkflows(taskId: string): ReleaseWorkflow[] {
    return values(this.#requireTask(taskId).releaseWorkflows, "id");
  }
  getReleaseWorkflow(taskId: string, workflowId: string): ReleaseWorkflow | null {
    return this.#requireTask(taskId).releaseWorkflows[workflowId] ?? null;
  }

  // -- Gate artifacts (Issue 08) ---------------------------------------------
  // FileTaskStore delegates to the file-backed artifact namespace under
  // `<home>/artifacts/gates/`.  This is the transitional path for Homes that
  // have not yet migrated to SQLite; the SqliteTaskStore stores the same
  // records and logs in `gate_artifacts` / `gate_artifact_logs`.

  #gateArtifactRecordPath(projectId: string, key: string): string {
    return join(this.rootDir, "artifacts", "gates", projectId, `${key}.json`);
  }

  #gateArtifactLogsRoot(projectId: string, key: string): string {
    return join(this.rootDir, "artifacts", "gates", projectId, key);
  }

  saveGateArtifact(artifact: GateArtifact, logs: ReadonlyMap<string, Buffer>): void {
    validateGateArtifact(artifact);
    const recordPath = this.#gateArtifactRecordPath(artifact.projectId, artifact.key);
    const logsRoot = this.#gateArtifactLogsRoot(artifact.projectId, artifact.key);
    this.#mutate(() => {
      writeTextFileAtomically(recordPath, `${JSON.stringify(artifact, null, 2)}\n`);
      mkdirSync(logsRoot, { recursive: true, mode: 0o700 });
      for (const [stepName, content] of logs) {
        writeFileSync(join(logsRoot, stepName), content, { mode: 0o600 });
      }
    });
  }

  touchGateArtifact(artifact: GateArtifact): void {
    validateGateArtifact(artifact);
    writeTextFileAtomically(
      this.#gateArtifactRecordPath(artifact.projectId, artifact.key),
      `${JSON.stringify(artifact, null, 2)}\n`
    );
  }

  getGateArtifact(projectId: string, key: string): GateArtifact | null {
    const path = this.#gateArtifactRecordPath(projectId, key);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GateArtifact;
    return validateGateArtifact(parsed);
  }

  findGateArtifactByIdentity(identity: GateArtifactIdentity): GateArtifact | null {
    return this.getGateArtifact(identity.projectId, gateArtifactKey(identity));
  }

  findL2GateArtifactsForCommit(query: Readonly<{
    projectId: string;
    commit: string;
    planDigest: string;
    toolchainDigest: string;
    targetRef: string;
  }>): GateArtifact[] {
    const root = join(this.rootDir, "artifacts", "gates", query.projectId);
    if (!existsSync(root)) return [];
    const results: GateArtifact[] = [];
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith(".json")) continue;
      let artifact: GateArtifact | null;
      try {
        artifact = this.getGateArtifact(query.projectId, entry.slice(0, -".json".length));
      } catch {
        continue;
      }
      if (artifact === null
        || artifact.level !== "L2"
        || artifact.status !== "complete"
        || artifact.outcome !== "succeeded"
        || artifact.commit !== query.commit
        || artifact.planDigest !== query.planDigest
        || artifact.toolchainDigest !== query.toolchainDigest
        || artifact.boundary?.targetRef !== query.targetRef) {
        continue;
      }
      results.push(artifact);
    }
    return results;
  }

  getGateArtifactLogs(artifactKey: string): ReadonlyMap<string, Buffer> {
    // The artifact key is content-addressed; we need the projectId to build
    // the path.  Callers that have the artifact should use
    // getGateArtifactLogsForArtifact; this fallback scans all projects.
    const gatesRoot = join(this.rootDir, "artifacts", "gates");
    if (!existsSync(gatesRoot)) return new Map();
    for (const projectId of readdirSync(gatesRoot)) {
      const logsRoot = join(gatesRoot, projectId, artifactKey);
      if (existsSync(logsRoot) && statSync(logsRoot).isDirectory()) {
        return this.#readGateArtifactLogs(logsRoot);
      }
    }
    return new Map();
  }

  #readGateArtifactLogs(logsRoot: string): ReadonlyMap<string, Buffer> {
    const logs = new Map<string, Buffer>();
    if (!existsSync(logsRoot)) return logs;
    for (const entry of readdirSync(logsRoot)) {
      const fullPath = join(logsRoot, entry);
      if (statSync(fullPath).isFile()) {
        logs.set(entry, readFileSync(fullPath));
      }
    }
    return logs;
  }

  pruneGateArtifacts(projectId: string, options: GateArtifactPruneOptions): GateArtifactPruneResult {
    const root = join(this.rootDir, "artifacts", "gates", projectId);
    if (!existsSync(root)) return Object.freeze({ retained: 0, deleted: 0 });
    let retained = 0;
    let deleted = 0;
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith(".json")) continue;
      const key = entry.slice(0, -".json".length);
      let artifact: GateArtifact;
      try {
        const loaded = this.getGateArtifact(projectId, key);
        if (loaded === null) continue;
        artifact = loaded;
      } catch {
        retained += 1;
        continue;
      }
      const age = options.now.getTime() - Date.parse(artifact.lastUsedAt);
      if (options.isReferenced(key) || age < options.ttlMs) {
        retained += 1;
        continue;
      }
      rmSync(this.#gateArtifactRecordPath(projectId, key), { force: true });
      rmSync(this.#gateArtifactLogsRoot(projectId, key), { recursive: true, force: true });
      deleted += 1;
    }
    return Object.freeze({ retained, deleted });
  }

  getWorkMailbox(target: MailboxTarget): WorkMailbox | null {
    return optional(this.#state().mailboxes[mailboxTargetKey(target)]);
  }
  listWorkMailboxes(): WorkMailbox[] {
    return Object.entries(this.#state().mailboxes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, mailbox]) => clone(mailbox));
  }
  saveWorkMailbox(value: WorkMailbox): void {
    let mailbox: WorkMailbox;
    try {
      mailbox = validateWorkMailbox(versioned<WorkMailbox>(
        value,
        CURRENT_WORK_MAILBOX_SCHEMA_VERSION,
        "WorkMailbox"
      ));
    }
    catch (error) { throw new StorageRecordError(error instanceof Error ? error.message : String(error)); }
    this.#mutate((state) => {
      validateMailboxReferences(state, mailbox);
      state.mailboxes[mailboxTargetKey(mailbox.target)] = clone(mailbox);
    });
  }
  removeWorkMailbox(target: MailboxTarget): boolean {
    return this.#remove((state) => state.mailboxes, mailboxTargetKey(target));
  }

  getPendingWakeup(taskId: string): PendingWakeup | null {
    return pendingWakeupProjection(this.getWorkMailbox({ kind: "role", taskId, roleName: "leader" }));
  }
  listPendingWakeups(): PendingWakeup[] {
    return this.listWorkMailboxes()
      .flatMap((mailbox) => {
        const wakeup = pendingWakeupProjection(mailbox);
        return wakeup === null ? [] : [wakeup];
      })
      .sort((a, b) => numericCompare(a.taskId, b.taskId));
  }
  savePendingWakeup(value: PendingWakeup): void {
    const wakeup = identified<PendingWakeup>(
      value,
      CURRENT_PENDING_WAKEUP_SCHEMA_VERSION,
      "taskId",
      value.taskId,
      "Pending wakeup"
    );
    const target: MailboxTarget = { kind: "role", taskId: wakeup.taskId, roleName: "leader" };
    this.transaction(() => {
      const existing = this.getWorkMailbox(target);
      if (existing !== null && existing.pending !== null
        && wakeup.requestCount <= existing.pending.requestCount) {
        throw new StorageRecordError(`Pending wakeup is stale: ${wakeup.taskId}`);
      }
      const fromSequence = existing?.pending?.fromSequence ?? existing?.nextSequence ?? 1;
      const toSequence = fromSequence + wakeup.requestCount - 1;
      this.saveWorkMailbox({
        schemaVersion: CURRENT_WORK_MAILBOX_SCHEMA_VERSION,
        target,
        nextSequence: Math.max(existing?.nextSequence ?? 1, toSequence + 1),
        processing: existing?.processing ?? null,
        pending: {
          ...existing?.pending,
          fromSequence,
          toSequence,
          reasons: [...wakeup.reasons],
          refs: existing?.pending?.refs ?? [],
          requestCount: wakeup.requestCount,
          firstQueuedAt: wakeup.firstRequestedAt,
          lastQueuedAt: wakeup.lastRequestedAt
        }
      });
    });
  }
  clearPendingWakeup(taskId: string): void {
    this.removeWorkMailbox({ kind: "role", taskId, roleName: "leader" });
  }
  getLeaderFailure(taskId: string): LeaderFailure | null { return optional(this.#state().tasks[taskId]?.leaderFailure ?? undefined); }
  saveLeaderFailure(value: LeaderFailure): void { this.#saveSingleton(value.taskId, "leaderFailure", value, "Leader failure"); }
  clearLeaderFailure(taskId: string): void { this.#clearSingleton(taskId, "leaderFailure"); }
  getOperatorNotification(taskId: string): OperatorNotification | null { return optional(this.#state().tasks[taskId]?.operatorNotification ?? undefined); }
  saveOperatorNotification(value: OperatorNotification): void { this.#saveSingleton(value.taskId, "operatorNotification", value, "Operator notification"); }
  clearOperatorNotification(taskId: string): void { this.#clearSingleton(taskId, "operatorNotification"); }

  #saveSingleton<K extends "leaderFailure" | "operatorNotification">(
    taskId: string, key: K, value: StoredTask[K], label: string
  ): void {
    const schemaVersion = key === "leaderFailure"
      ? CURRENT_LEADER_FAILURE_SCHEMA_VERSION
      : CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION;
    const stored = identified<StoredTask[K]>(value, schemaVersion, "taskId", taskId, label);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => { state.tasks[taskId][key] = stored; });
  }
  #clearSingleton(key: string, field: "leaderFailure" | "operatorNotification"): void {
    this.#mutate((state) => { if (state.tasks[key] !== undefined) state.tasks[key][field] = null; });
  }
  #saveTaskRecord<K extends "messages">(
    taskId: string, key: K, value: StoredTask[K][string], label: string
  ): void {
    const record = versioned<{
      schemaVersion: typeof CURRENT_MESSAGE_SCHEMA_VERSION;
      id: string;
    }>(value, CURRENT_MESSAGE_SCHEMA_VERSION, label);
    this.#requireTaskForWrite(taskId);
    this.#mutate((state) => {
      if (state.tasks[taskId][key][record.id] !== undefined) {
        throw new StorageRecordError(`${label} already exists: ${taskId}/${record.id}`);
      }
      observeTaskRecordId(state.tasks[taskId], "message", record.id);
      (state.tasks[taskId][key] as Record<string, typeof value>)[record.id] = clone(value);
    });
  }
  #requireTask(taskId: string): StoredTask {
    const aggregate = this.#state().tasks[taskId];
    if (aggregate === undefined) throw new StorageRecordError(`Task not found: ${taskId}`);
    return aggregate;
  }
  #requireTaskForWrite(taskId: string): StoredTask { return this.#requireTask(taskId); }

  #state(): StorageState { return this.#transaction?.state ?? this.#readCachedState(); }
  #mutate(execute: (state: StorageState) => void): void { this.#mutateResult((state) => { execute(state); }); }
  #mutateResult<T>(execute: (state: StorageState) => T): T {
    if (this.#transaction !== null) {
      const result = execute(this.#transaction.state);
      this.#transaction.dirty = true;
      return result;
    }
    return this.#withWriteLock(() => {
      const state = this.#readCachedState();
      try {
        const result = execute(state);
        this.#commit(state, state.revision);
        return result;
      } catch (error) {
        this.#readCache = null;
        throw error;
      }
    });
  }
  #remove<T>(select: (state: StorageState) => Record<string, T>, id: string): boolean {
    return this.#mutateResult((state) => {
      const records = select(state);
      if (records[id] === undefined) return false;
      delete records[id];
      return true;
    });
  }
  #nextGlobalId(prefix: string, collect: (state: StorageState) => string[]): string {
    const pattern = new RegExp(`^${prefix}-(\\d+)$`);
    const maximum = collect(this.#state()).reduce((max, id) => {
      const match = pattern.exec(id);
      return match === null ? max : Math.max(max, Number.parseInt(match[1], 10));
    }, 0);
    return `${prefix}-${maximum + 1}`;
  }

  #nextTaskRecordId(taskId: string, kind: TaskRecordKind): string {
    return this.#mutateResult((state) => {
      const aggregate = requireTaskFromState(state, taskId);
      const next = nextTaskRecordSequence(aggregate, taskId, kind);
      aggregate.idHighWaterMarks[kind] = next;
      return `${TASK_RECORD_ID_PREFIXES[kind]}-${next}`;
    });
  }

  #peekTaskRecordId(taskId: string, kind: TaskRecordKind): string {
    const aggregate = this.#requireTask(taskId);
    return `${TASK_RECORD_ID_PREFIXES[kind]}-${nextTaskRecordSequence(
      aggregate,
      taskId,
      kind
    )}`;
  }

  #readState(): StorageState {
    this.#requireReadableSchema();
    const path = join(this.rootDir, STORAGE_STATE_FILE);
    if (!existsSync(path)) return emptyState();
    return this.#parseState(readFileSync(path, "utf8"));
  }
  #readCachedState(): StorageState {
    this.#requireReadableSchema();
    const path = join(this.rootDir, STORAGE_STATE_FILE);
    if (!existsSync(path)) {
      if (this.#readCache?.fingerprint === "missing") return this.#readCache.state;
      const state = emptyState();
      this.#readCache = { fingerprint: "missing", state };
      return state;
    }
    const fingerprint = stateFileFingerprint(path);
    if (this.#readCache?.fingerprint === fingerprint) return this.#readCache.state;
    const state = this.#parseState(readFileSync(path, "utf8"));
    this.#readCache = { fingerprint, state };
    return state;
  }
  #commit(state: StorageState, expectedRevision: number): void {
    // The upgrade admission fence is honored at the single write moment, so both
    // baseline CLI writers and the Controller (which mutate through this same
    // store) refuse to persist while an upgrade owns the Home. Reads and
    // read-only transactions never reach here, and the fencing process itself is
    // exempt so it can re-pin the revision under the lock.
    assertHomeWritable(this.rootDir);
    const current = this.#readState();
    if (current.revision !== expectedRevision) {
      throw new StorageConflictError(`Storage changed concurrently (expected revision ${expectedRevision}, found ${current.revision}).`);
    }
    state.revision = expectedRevision + 1;
    const content = `${JSON.stringify(state, null, 2)}\n`;
    parseState(content);
    writeTextFileAtomically(join(this.rootDir, STORAGE_STATE_FILE), content);
    if (this.#normalizeState !== undefined) {
      // A compatible read never rewrites the Home. Its first actual mutation
      // emits current-only state, then advances the durable manifest to the
      // same current family versions under the existing storage write lock.
      // A crash between the two atomic files is detected as manifest/state
      // inconsistency on the next open; it is never silently accepted.
      writeCurrentStorageManifest(this.rootDir);
      this.#normalizeState = undefined;
    }
    // Keep the state we just wrote as the warm read cache. The atomic write
    // produced a new fingerprint, so a concurrent external writer is still
    // detected on the next read; our own mutations no longer re-parse the
    // whole Home to observe state they already held under the write lock.
    this.#readCache = {
      fingerprint: stateFileFingerprint(join(this.rootDir, STORAGE_STATE_FILE)),
      state
    };
  }
  #parseState(raw: string): StorageState {
    return parseState(this.#normalizeState?.(raw) ?? raw);
  }
  #withWriteLock<T>(execute: () => T): T {
    const release = acquireStorageLock(this.rootDir);
    try { return execute(); } finally { release(); }
  }
  #requireReadableSchema(): void {
    if (this.#normalizeState === undefined) requireStorageSchema(this.rootDir);
    else requireCompatibleStorageSchema(this.rootDir);
  }
}

/**
 * The on-disk identity of a `state.json` the store's read cache is keyed on.
 * The one-snapshot current-Home open fences its single read with the same
 * fingerprint, so a writer that changes the file between the fence and the
 * store's next read is detected exactly like a normal cache invalidation.
 */
export function stateFileFingerprint(path: string): string {
  const stat = statSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

export class StorageRecordError extends Error { constructor(message: string) { super(message); this.name = "StorageRecordError"; } }
export class StorageConflictError extends Error { constructor(message: string) { super(message); this.name = "StorageConflictError"; } }
/**
 * Raised by the persistence worker when an `AbortSignal` cancels an in-flight
 * command batch. The open transaction is rolled back; the database is unchanged.
 * Already-committed transactions are not undone (their effects are idempotent
 * and semantically owned by the caller, design §3.1).
 */
export class StorageCancelledError extends Error { constructor(message: string) { super(message); this.name = "StorageCancelledError"; } }

export function resolveYuiHome(env: NodeJS.ProcessEnv): string {
  return env.YUI_HOME === undefined || env.YUI_HOME.length === 0
    ? join(homedir(), ".yui")
    : resolve(env.YUI_HOME);
}
export function ensureYuiHome(rootDir: string): void { mkdirSync(rootDir, { recursive: true, mode: 0o700 }); }

function emptyState(): StorageState {
  return {
    schemaVersion: CURRENT_STORAGE_STATE_SCHEMA_VERSION,
    revision: 0,
    homeIdentity: generateHomeIdentity(new Date()),
    config: { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION },
    configuredAgents: {},
    projects: {},
    agentProfiles: {},
    globalRoles: {},
    globalRoleSessionSets: {},
    tasks: {},
    mailboxes: {}
  };
}
/** rr13: Durable map key for a Session's job caller key hash. */
function jobCallerKeyHashKey(roleName: string, agentId: string): string {
  return `${roleName}\0${agentId}`;
}

function emptyStoredTask(task: Task): StoredTask {
  return {
    schemaVersion: CURRENT_STORED_TASK_SCHEMA_VERSION,
    task,
    idHighWaterMarks: emptyTaskIdHighWaterMarks(),
    brief: null,
    changeSets: {},
    integrationAttempts: {},
    integrationQueue: {},
    durableJobs: {},
    roles: {},
    managedWorkspaces: {},
    roleSessionSets: {},
    jobCallerKeyHashes: {},
    workItems: {},
    agentRuns: {},
    reviewRounds: {},
    activeRuns: {},
    messages: {},
    inputRequests: {},
    decisions: {},
    milestones: {},
    events: {},
    capabilityGrants: {},
    releaseWorkflows: {},
    leaderFailure: null,
    operatorNotification: null
  };
}

function emptyTaskIdHighWaterMarks(): TaskIdHighWaterMarks {
  return {
    workItem: 0,
    agentRun: 0,
    reviewRound: 0,
    reviewFinding: 0,
    changeSet: 0,
    integrationAttempt: 0,
    integrationQueue: 0,
    durableJob: 0,
    message: 0,
    inputRequest: 0,
    decision: 0,
    milestone: 0,
    event: 0,
    capabilityGrant: 0,
    releaseWorkflow: 0
  };
}

function nextTaskRecordSequence(
  aggregate: StoredTask,
  taskId: string,
  kind: TaskRecordKind
): number {
  const next = aggregate.idHighWaterMarks[kind] + 1;
  if (!Number.isSafeInteger(next)) {
    throw new StorageRecordError(`Task ${kind} id space is exhausted: ${taskId}.`);
  }
  return next;
}

function validateTaskIdHighWaterMarks(value: unknown, taskId: string): void {
  const marks = object(value, `Task id high-water marks ${taskId}`);
  const kinds = Object.keys(TASK_RECORD_ID_PREFIXES) as TaskRecordKind[];
  exact(marks, kinds, `Task id high-water marks ${taskId}`);
  for (const kind of kinds) {
    if (!Number.isSafeInteger(marks[kind]) || (marks[kind] as number) < 0) {
      throw new StorageRecordError(
        `Task id high-water mark is invalid: ${taskId}/${kind}.`
      );
    }
  }
}

function parseState(raw: string): StorageState {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch (error) { throw new StorageRecordError(`Invalid ${STORAGE_STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`); }
  const state = object(parsed, "Storage state");
  exact(state, [
    "schemaVersion",
    "revision",
    "homeIdentity",
    "config",
    "configuredAgents",
    "projects",
    "agentProfiles",
    "globalRoles",
    "globalRoleSessionSets",
    "tasks",
    "mailboxes"
  ], "Storage state");
  if (state.schemaVersion !== CURRENT_STORAGE_STATE_SCHEMA_VERSION || !Number.isInteger(state.revision) || (state.revision as number) < 0) throw new StorageRecordError("Storage state schemaVersion/revision is invalid.");
  const result = clone(state) as unknown as StorageState;
  try {
    result.homeIdentity = validateHomeIdentity(versioned(
      result.homeIdentity,
      CURRENT_HOME_IDENTITY_SCHEMA_VERSION,
      "Home identity"
    ));
  } catch (error) {
    throw new StorageRecordError(error instanceof Error ? error.message : String(error));
  }
  result.config = versioned(
    result.config,
    CURRENT_CONFIG_SCHEMA_VERSION,
    "Yui config"
  );
  validateYuiConfig(result.config);
  parseMap(result.configuredAgents, (value, key) => {
    const agent = identified<ConfiguredAgent>(
      value,
      CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION,
      "id",
      key,
      "Configured Agent"
    );
    validateConfiguredAgent(agent);
    return agent;
  }, "configuredAgents");
  parseMap(result.projects, (value, key) => {
    const project = identified<Project>(
      value,
      CURRENT_PROJECT_SCHEMA_VERSION,
      "id",
      key,
      "Project"
    );
    validateProject(project);
    return project;
  }, "projects");
  try {
    assertProjectCatalog(Object.values(result.projects));
  } catch (error) {
    throw new StorageRecordError(error instanceof Error ? error.message : String(error));
  }
  parseMap(result.agentProfiles, (value, key) => {
    const profile = identified<AgentProfile>(
      value,
      CURRENT_AGENT_PROFILE_SCHEMA_VERSION,
      "id",
      key,
      "Agent Profile"
    );
    validateAgentProfile(profile);
    return profile;
  }, "agentProfiles");
  parseMap(result.globalRoles, (value, key) => {
    const role = identified<GlobalRole>(
      value,
      CURRENT_GLOBAL_ROLE_SCHEMA_VERSION,
      "name",
      key,
      "Global Role"
    );
    validateGlobalRole(role);
    return role;
  }, "globalRoles");
  parseMap(result.globalRoleSessionSets, (value, key) => { const set = globalSessions(value); if (set.owner.roleName !== key) throw new StorageRecordError(`Global Role session set identity is inconsistent: ${key}`); return set; }, "globalRoleSessionSets");
  parseMap(result.tasks, (value, key) => parseStoredTask(value, key), "tasks");
  parseMap(result.mailboxes, (value, key) => {
    let mailbox: WorkMailbox;
    try {
      mailbox = validateWorkMailbox(versioned<WorkMailbox>(
        value,
        CURRENT_WORK_MAILBOX_SCHEMA_VERSION,
        "WorkMailbox"
      ));
    }
    catch (error) { throw new StorageRecordError(error instanceof Error ? error.message : String(error)); }
    if (mailboxTargetKey(mailbox.target) !== key) {
      throw new StorageRecordError(`WorkMailbox identity is inconsistent: ${key}`);
    }
    return mailbox;
  }, "mailboxes");
  for (const [name, role] of Object.entries(result.globalRoles)) {
    const sessions = result.globalRoleSessionSets[name];
    if (sessions !== undefined) assertSessionsMatchRole(sessions, role);
  }
  for (const name of Object.keys(result.globalRoleSessionSets)) {
    if (result.globalRoles[name] === undefined) {
      throw new StorageRecordError(`Global Role session set has no Role: ${name}`);
    }
  }
  for (const aggregate of Object.values(result.tasks)) {
    for (const binding of aggregate.task.projectBindings) {
      if (result.projects[binding.projectId] === undefined) {
        throw new StorageRecordError(
          `Task Project not found: ${aggregate.task.id}/${binding.projectId}`
        );
      }
    }
    for (const [name, role] of Object.entries(aggregate.roles)) {
      const sessions = aggregate.roleSessionSets[name];
      if (sessions !== undefined) assertSessionsMatchRole(sessions, role);
    }
    for (const name of Object.keys(aggregate.roleSessionSets)) {
      if (aggregate.roles[name] === undefined) {
        throw new StorageRecordError(`Task Role session set has no Role: ${aggregate.task.id}/${name}`);
      }
    }
    for (const [key, workspace] of Object.entries(aggregate.managedWorkspaces)) {
      if (workspace.owner.taskId !== aggregate.task.id) {
        throw new StorageRecordError(`Managed workspace belongs to another Task: ${key}`);
      }
      const boundProjects = new Set(aggregate.task.projectBindings.map(({ projectId }) => projectId));
      if (workspace.entries.some(({ projectId }) => !boundProjects.has(projectId))) {
        throw new StorageRecordError(`Managed workspace Project does not match Task: ${aggregate.task.id}/${key}`);
      }
      if (workspace.owner.type === "work-item"
        && aggregate.workItems[workspace.owner.workItemId] === undefined) {
        throw new StorageRecordError(`Managed workspace WorkItem not found: ${aggregate.task.id}/${workspace.owner.workItemId}`);
      }
      if (workspace.owner.type === "review-round"
        && aggregate.reviewRounds[workspace.owner.reviewRoundId] === undefined) {
        throw new StorageRecordError(`Managed workspace ReviewRound not found: ${aggregate.task.id}/${workspace.owner.reviewRoundId}`);
      }
      if (workspace.owner.type === "integration-attempt"
        && aggregate.integrationAttempts[workspace.owner.integrationAttemptId] === undefined) {
        throw new StorageRecordError(`Managed workspace Integration Attempt not found: ${aggregate.task.id}/${workspace.owner.integrationAttemptId}`);
      }
      if (workspace.owner.type === "execution-lane") {
        const laneOwner = workspace.owner;
        const laneItem = laneOwner.purpose === "execution"
          ? aggregate.workItems[laneOwner.workItemId ?? ""]
          : undefined;
        const group = laneOwner.purpose === "execution"
          ? (laneItem === undefined
            ? undefined
            : workItemExecutionGroupById(laneItem, laneOwner.executionGroupId))
          : aggregate.reviewRounds[laneOwner.reviewRoundId ?? ""]?.executionGroup;
        if (group?.id !== laneOwner.executionGroupId
          || !group.lanes.some(({ id }) => id === laneOwner.executionLaneId)) {
          throw new StorageRecordError(`Managed workspace Execution Lane not found: ${aggregate.task.id}/${key}`);
        }
      }
    }
    validateCanonicalTaskReferences(result, aggregate);
  }
  for (const mailbox of Object.values(result.mailboxes)) validateMailboxReferences(result, mailbox);
  return result;
}

/** Strict current-model gate used by the compatible loader before any writer opens. */
export function validateCurrentStorageStateSnapshot(value: unknown): void {
  parseState(`${JSON.stringify(value)}\n`);
}
function parseStoredTask(value: unknown, taskId: string): StoredTask {
  const aggregate = object(value, `Task aggregate ${taskId}`) as unknown as StoredTask;
  exact(aggregate as unknown as Record<string, unknown>, [
    "schemaVersion",
    "task",
    "idHighWaterMarks",
    "brief",
    "changeSets",
    "integrationAttempts",
    "integrationQueue",
    "durableJobs",
    "roles",
    "managedWorkspaces",
    "roleSessionSets",
    "jobCallerKeyHashes",
    "workItems",
    "agentRuns",
    "reviewRounds",
    "activeRuns",
    "messages",
    "inputRequests",
    "decisions",
    "milestones",
    "events",
    "capabilityGrants",
    "releaseWorkflows",
    "leaderFailure",
    "operatorNotification"
  ], `Task aggregate ${taskId}`);
  parseMap(aggregate.changeSets, (record, key) => {
    const changeSet = identifiedChangeSet(record, key);
    if (changeSet.taskId !== taskId) {
      throw new StorageRecordError(`ChangeSet belongs to another Task: ${changeSet.taskId}.`);
    }
    validateChangeSet(changeSet);
    return changeSet;
  }, "changeSets");
  parseMap(aggregate.integrationAttempts, (record, key) => {
    const attempt = identified<IntegrationAttempt>(
      record,
      CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION,
      "id",
      key,
      "Integration Attempt"
    );
    if (attempt.taskId !== taskId) {
      throw new StorageRecordError(
        `Integration Attempt belongs to another Task: ${attempt.taskId}.`
      );
    }
    validateIntegrationAttempt(attempt);
    return attempt;
  }, "integrationAttempts");
  parseMap(aggregate.integrationQueue, (record, key) => {
    const entry = identified<IntegrationQueueEntry>(
      record,
      CURRENT_INTEGRATION_QUEUE_SCHEMA_VERSION,
      "id",
      key,
      "Integration queue entry"
    );
    if (entry.taskId !== taskId) {
      throw new StorageRecordError(
        `Integration queue entry belongs to another Task: ${entry.taskId}.`
      );
    }
    if (aggregate.changeSets[entry.changeSetId] === undefined) {
      throw new StorageRecordError(
        `Integration queue entry ChangeSet not found: ${entry.changeSetId}.`
      );
    }
    validateIntegrationQueueEntry(entry);
    return entry;
  }, "integrationQueue");
  parseMap(aggregate.durableJobs, (record, key) => {
    const job = identified<DurableJob>(
      record,
      CURRENT_DURABLE_JOB_SCHEMA_VERSION,
      "id",
      key,
      "DurableJob"
    );
    if (job.taskId !== taskId) {
      throw new StorageRecordError(
        `DurableJob belongs to another Task: ${job.taskId}.`
      );
    }
    validateDurableJob(job);
    return job;
  }, "durableJobs");
  versioned(
    aggregate,
    CURRENT_STORED_TASK_SCHEMA_VERSION,
    `Task aggregate ${taskId}`
  );
  validateTaskIdHighWaterMarks(aggregate.idHighWaterMarks, taskId);
  validateTask(identified(
    aggregate.task,
    CURRENT_TASK_SCHEMA_VERSION,
    "id",
    taskId,
    "Task"
  ));
  if (aggregate.brief !== null) storedTaskBrief(aggregate.brief);
  parseMap(aggregate.roles, (record, key) => {
    const role = identified<TaskRole>(
      record,
      CURRENT_TASK_ROLE_SCHEMA_VERSION,
      "name",
      key,
      "Task Role"
    );
    if (role.taskId !== taskId) throw new StorageRecordError(`Task Role belongs to another Task: ${role.taskId}`);
    validateTaskRole(role);
    return role;
  }, "roles");
  parseMap(aggregate.managedWorkspaces, (record, key) => {
    const workspace = versioned<ManagedWorkspace>(
      record,
      CURRENT_MANAGED_WORKSPACE_SCHEMA_VERSION,
      "Managed workspace"
    );
    validateManagedWorkspace(workspace);
    if (workspace.owner.taskId !== taskId) {
      throw new StorageRecordError(
        `Managed workspace belongs to another Task: ${workspace.owner.taskId}`
      );
    }
    if (managedWorkspaceKey(workspace.owner) !== key) {
      throw new StorageRecordError(`Managed workspace identity is inconsistent: ${taskId}/${key}`);
    }
    return workspace;
  }, "managedWorkspaces");
  parseMap(aggregate.roleSessionSets, (record, key) => { const set = taskSessions(record); if (set.owner.taskId !== taskId || set.owner.roleName !== key) throw new StorageRecordError(`Task Role session set identity is inconsistent: ${taskId}/${key}`); return set; }, "roleSessionSets");
  parseMap(aggregate.jobCallerKeyHashes, (hash, key) => {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
      throw new StorageRecordError(`Job caller key hash is invalid: ${taskId}/${key}.`);
    }
    return hash;
  }, "jobCallerKeyHashes");
  parseMap(aggregate.workItems, (record, key) => {
    const item = identified<WorkItem>(
      record,
      CURRENT_WORK_ITEM_SCHEMA_VERSION,
      "id",
      key,
      "Work item"
    );
    if (item.taskId !== taskId) {
      throw new StorageRecordError(`Work item belongs to another Task: ${item.taskId}`);
    }
    validateWorkItem(item);
    return item;
  }, "workItems");
  parseMap(aggregate.agentRuns, (record, key) => {
    const run = identified<AgentRun>(
      record,
      CURRENT_AGENT_RUN_SCHEMA_VERSION,
      "id",
      key,
      "Agent run"
    );
    if (run.taskId !== taskId) {
      throw new StorageRecordError(`Agent run belongs to another Task: ${run.taskId}`);
    }
    validateAgentRun(run);
    return run;
  }, "agentRuns");
  parseMap(aggregate.reviewRounds, (record, key) => {
    const round = identified<ReviewRound>(
      record,
      CURRENT_REVIEW_ROUND_SCHEMA_VERSION,
      "id",
      key,
      "ReviewRound"
    );
    if (round.taskId !== taskId) {
      throw new StorageRecordError(`ReviewRound belongs to another Task: ${round.taskId}.`);
    }
    validateReviewRound(round);
    return round;
  }, "reviewRounds");
  parseMap(aggregate.activeRuns, (record, key) => {
    const pointer = versioned<ActiveRunPointer>(
      record,
      CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
      `Active run ${key}`
    );
    const run = typeof pointer.runId === "string" ? aggregate.agentRuns[pointer.runId] : undefined;
    const laneMatch = executionLaneActiveRunKeyParts(key);
    const validLanePointer = laneMatch !== null
      && run !== undefined
      && run.executionGroupId === laneMatch.executionGroupId
      && run.executionLaneId === laneMatch.executionLaneId;
    const validRolePointer = laneMatch === null
      && run !== undefined
      && run.roleName === key;
    if (run === undefined || run.status !== "active"
      || (!validLanePointer && !validRolePointer)) {
      throw new StorageRecordError(`Active run pointer is invalid: ${taskId}/${key}`);
    }
    return pointer;
  }, "activeRuns");
  parseMap(aggregate.messages, (record, key) => {
    const message = identified<TaskMessage>(
      record,
      CURRENT_MESSAGE_SCHEMA_VERSION,
      "id",
      key,
      "Message"
    );
    if (message.taskId !== taskId) {
      throw new StorageRecordError(`Message belongs to another Task: ${message.taskId}`);
    }
    validateTaskMessage(message);
    return message;
  }, "messages");
  parseMap(aggregate.inputRequests, (record, key) => {
    const request = validateInputRequest(versioned<InputRequest>(
      record,
      CURRENT_INPUT_REQUEST_SCHEMA_VERSION,
      "Input request"
    ));
    if (request.id !== key) {
      throw new StorageRecordError(`Input request identity is inconsistent: ${key}.`);
    }
    if (request.taskId !== taskId) {
      throw new StorageRecordError(`Input request belongs to another Task: ${request.taskId}`);
    }
    return request;
  }, "inputRequests");
  parseMap(aggregate.decisions, (record, key) => {
    const decision = storedDecision(record);
    if (decision.id !== key) throw new StorageRecordError(`Decision identity is inconsistent: ${key}.`);
    if (decision.taskId !== taskId) {
      throw new StorageRecordError(`Decision belongs to another Task: ${decision.taskId}`);
    }
    return decision;
  }, "decisions");
  parseMap(aggregate.milestones, (record, key) => {
    const milestone = storedMilestone(record);
    if (milestone.id !== key) throw new StorageRecordError(`Milestone identity is inconsistent: ${key}.`);
    if (milestone.taskId !== taskId) {
      throw new StorageRecordError(`Milestone belongs to another Task: ${milestone.taskId}`);
    }
    return milestone;
  }, "milestones");
  parseMap(aggregate.events, (record, key) => {
    const event = storedTaskEvent(record);
    if (event.id !== key) throw new StorageRecordError(`Task event identity is inconsistent: ${key}.`);
    if (event.taskId !== taskId) {
      throw new StorageRecordError(`Task event belongs to another Task: ${event.taskId}`);
    }
    return event;
  }, "events");
  parseMap(aggregate.capabilityGrants, (record, key) => {
    const grant = storedCapabilityGrant(record);
    if (grant.id !== key) {
      throw new StorageRecordError(`Capability grant identity is inconsistent: ${key}.`);
    }
    if (grant.taskId !== taskId) {
      throw new StorageRecordError(`Capability grant belongs to another Task: ${grant.taskId}`);
    }
    return grant;
  }, "capabilityGrants");
  parseMap(aggregate.releaseWorkflows, (record, key) => {
    const workflow = storedReleaseWorkflow(record);
    if (workflow.id !== key) {
      throw new StorageRecordError(`Release workflow identity is inconsistent: ${key}.`);
    }
    if (workflow.taskId !== taskId) {
      throw new StorageRecordError(`Release workflow belongs to another Task: ${workflow.taskId}`);
    }
    return workflow;
  }, "releaseWorkflows");
  for (const [key, label] of [["leaderFailure", "Leader failure"], ["operatorNotification", "Operator notification"]] as const) {
    const record = aggregate[key];
    if (record !== null) {
      const schemaVersion = key === "leaderFailure"
        ? CURRENT_LEADER_FAILURE_SCHEMA_VERSION
        : CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION;
      identified(record, schemaVersion, "taskId", taskId, label);
    }
  }
  validateTaskIdHighWaterCoverage(aggregate, taskId);
  return aggregate;
}

function validateTaskIdHighWaterCoverage(
  aggregate: StoredTask,
  taskId: string
): void {
  const records: Readonly<Record<TaskRecordKind, Readonly<Record<string, unknown>>>> = {
    workItem: aggregate.workItems,
    agentRun: aggregate.agentRuns,
    reviewRound: aggregate.reviewRounds,
    // Issue 06 dbonly: review findings are SQLite-native; the file aggregate
    // never carries them, so coverage is trivially empty.
    reviewFinding: {},
    changeSet: aggregate.changeSets,
    integrationAttempt: aggregate.integrationAttempts,
    integrationQueue: aggregate.integrationQueue,
    durableJob: aggregate.durableJobs,
    message: aggregate.messages,
    inputRequest: aggregate.inputRequests,
    decision: aggregate.decisions,
    milestone: aggregate.milestones,
    event: aggregate.events,
    capabilityGrant: aggregate.capabilityGrants,
    releaseWorkflow: aggregate.releaseWorkflows
  };
  for (const kind of Object.keys(TASK_RECORD_ID_PREFIXES) as TaskRecordKind[]) {
    const pattern = new RegExp(`^${TASK_RECORD_ID_PREFIXES[kind]}-(\\d+)$`);
    for (const id of Object.keys(records[kind])) {
      const match = pattern.exec(id);
      if (match === null) {
        throw new StorageRecordError(`Task-local ${kind} id is invalid: ${taskId}/${id}.`);
      }
      const sequence = Number.parseInt(match[1]!, 10);
      if (sequence > aggregate.idHighWaterMarks[kind]) {
        throw new StorageRecordError(
          `Task id high-water mark is behind ${taskId}/${kind}: ${id}.`
        );
      }
    }
  }
}

function observeTaskRecordId(
  aggregate: StoredTask,
  kind: TaskRecordKind,
  id: string
): void {
  validateTaskRecordReference({ taskId: aggregate.task.id, localId: id }, kind);
  const match = new RegExp(`^${TASK_RECORD_ID_PREFIXES[kind]}-(\\d+)$`).exec(id);
  if (match === null) throw new StorageRecordError(`Task-local ${kind} id is invalid: ${id}.`);
  const sequence = Number.parseInt(match[1]!, 10);
  aggregate.idHighWaterMarks[kind] = Math.max(
    aggregate.idHighWaterMarks[kind],
    sequence
  );
}

function validateYuiConfig(config: YuiConfig): void {
  try {
    reconciliationIntervalMilliseconds(config.reconciliationIntervalSeconds);
    resolveTimeZone(config.timeZone);
    if (config.review !== undefined) validateReviewConfig(config.review);
    resolveLeaderNextActionMode(config.leaderNextActionMode);
  } catch (error) {
    throw new StorageRecordError(
      error instanceof Error ? error.message : "Yui reconciliation interval is invalid."
    );
  }
}

function globalSessions(value: unknown): GlobalRoleSessionSet {
  const set = versioned<GlobalRoleSessionSet>(
    value,
    CURRENT_GLOBAL_ROLE_SESSION_SET_SCHEMA_VERSION,
    "Global Role session set"
  );
  if (set.owner?.scope !== "global" || typeof set.owner.roleName !== "string") throw new StorageRecordError("Global Role session owner is invalid.");
  validateSessions(set.sessions);
  validateRoleSessionSet(set);
  return set;
}
function taskSessions(value: unknown): TaskRoleSessionSet {
  const set = versioned<TaskRoleSessionSet>(
    value,
    CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION,
    "Task Role session set"
  );
  if (set.owner?.scope !== "task" || typeof set.owner.taskId !== "string" || typeof set.owner.roleName !== "string") throw new StorageRecordError("Task Role session owner is invalid.");
  validateSessions(set.sessions);
  validateRoleSessionSet(set);
  return set;
}
function validateSessions(sessions: Record<string, RoleAgentSession>): void {
  parseMap(
    sessions,
    (record, key) => identified(
      record,
      CURRENT_ROLE_AGENT_SESSION_SCHEMA_VERSION,
      "agentId",
      key,
      "Role Agent session"
    ),
    "sessions"
  );
}
function assertSessionsMatchRole(
  sessions: GlobalRoleSessionSet | TaskRoleSessionSet,
  role: GlobalRole | TaskRole
): void {
  validateRoleSessionSet(sessions);
  if (sessions.owner.roleName !== role.name) {
    throw new StorageRecordError(`Role session set does not match Role: ${role.name}`);
  }
  if ("taskId" in role && (sessions.owner.scope !== "task" || sessions.owner.taskId !== role.taskId)) {
    throw new StorageRecordError(`Task Role session owner is inconsistent: ${role.taskId}/${role.name}`);
  }
  if (!("taskId" in role) && sessions.owner.scope !== "global") {
    throw new StorageRecordError(`Global Role session owner is inconsistent: ${role.name}`);
  }
  const ownedSessions = [
    ...Object.entries(sessions.sessions),
    ...(sessions.owner.scope === "global"
      ? Object.entries((sessions as GlobalRoleSessionSet).history ?? {})
      : [
          ...((sessions as TaskRoleSessionSet).history ?? []).map((session, index) => (
            [`history-${index}`, session] as const
          ))
        ])
  ];
  for (const [, session] of ownedSessions) {
    const agentId = session.agentId;
    const binding = role.agentBindings[agentId];
    if (binding === undefined || binding.adapterId !== session.adapterId) {
      throw new StorageRecordError(`Role Agent session has no matching binding: ${role.name}/${agentId}`);
    }
  }
}

function storedTaskBrief(value: unknown): TaskBrief {
  const brief = versioned<TaskBrief>(
    value,
    CURRENT_TASK_BRIEF_SCHEMA_VERSION,
    "Task Brief"
  );
  exact(
    brief as unknown as Record<string, unknown>,
    [
      "schemaVersion",
      "objective",
      "boundaries",
      "technicalApproach",
      "currentFocus",
      "leaderSummary",
      "updatedAt",
      "updatedBy"
    ],
    "Task Brief"
  );
  requireNormalizedText(brief.objective, "Task Brief objective");
  requireOptionalNormalizedText(brief.technicalApproach, "Task Brief technical approach");
  requireNormalizedText(brief.currentFocus, "Task Brief current focus");
  requireNormalizedText(brief.leaderSummary, "Task Brief leader summary");
  requireNormalizedText(brief.updatedBy, "Task Brief updatedBy");
  if (!Array.isArray(brief.boundaries)) {
    throw new StorageRecordError("Task Brief boundaries must be an array.");
  }
  const boundaries = brief.boundaries.map((boundary) => (
    requireNormalizedText(boundary, "Task Brief boundary")
  ));
  if (new Set(boundaries).size !== boundaries.length) {
    throw new StorageRecordError("Task Brief boundaries must be unique.");
  }
  requireTimestamp(brief.updatedAt, "Task Brief updatedAt");
  return brief;
}

function storedDecision(value: unknown): Decision {
  const decision = versioned<Decision>(
    value,
    CURRENT_DECISION_SCHEMA_VERSION,
    "Decision"
  );
  const baseFields = [
    "schemaVersion", "id", "taskId", "title", "rationale", "status", "createdAt", "updatedAt"
  ];
  if (decision.status === "active") {
    exact(decision as unknown as Record<string, unknown>, baseFields, "Decision");
  } else if (decision.status === "superseded") {
    exact(
      decision as unknown as Record<string, unknown>,
      [...baseFields, "supersededReason", "supersededAt"],
      "Decision"
    );
    requireNormalizedText(decision.supersededReason, "Decision supersededReason");
    requireTimestamp(decision.supersededAt, "Decision supersededAt");
    if (decision.supersededAt !== decision.updatedAt) {
      throw new StorageRecordError("Decision supersededAt must match updatedAt.");
    }
  } else {
    throw new StorageRecordError(`Decision status is invalid: ${String(decision.status)}.`);
  }
  requireRecordIdentity(decision.id, "Decision id");
  requireRecordIdentity(decision.taskId, "Decision Task id");
  validateTaskRecordReference({ taskId: decision.taskId, localId: decision.id }, "decision");
  requireNormalizedText(decision.title, "Decision title");
  requireNormalizedText(decision.rationale, "Decision rationale");
  requireTimestamp(decision.createdAt, "Decision createdAt");
  requireTimestamp(decision.updatedAt, "Decision updatedAt");
  if (Date.parse(decision.updatedAt) < Date.parse(decision.createdAt)) {
    throw new StorageRecordError("Decision updatedAt cannot precede createdAt.");
  }
  return decision;
}

function storedMilestone(value: unknown): Milestone {
  const milestone = versioned<Milestone>(
    value,
    CURRENT_MILESTONE_SCHEMA_VERSION,
    "Milestone"
  );
  exact(
    milestone as unknown as Record<string, unknown>,
    ["schemaVersion", "id", "taskId", "title", "summary", "createdBy", "createdAt"],
    "Milestone"
  );
  requireRecordIdentity(milestone.id, "Milestone id");
  requireRecordIdentity(milestone.taskId, "Milestone Task id");
  validateTaskRecordReference({ taskId: milestone.taskId, localId: milestone.id }, "milestone");
  requireNormalizedText(milestone.title, "Milestone title");
  requireNormalizedText(milestone.summary, "Milestone summary");
  if (milestone.createdBy !== "leader") {
    throw new StorageRecordError("Milestone createdBy must be leader.");
  }
  requireTimestamp(milestone.createdAt, "Milestone createdAt");
  return milestone;
}

function storedTaskEvent(value: unknown): TaskEvent {
  const event = versioned<TaskEvent>(
    value,
    CURRENT_EVENT_SCHEMA_VERSION,
    "Task event"
  );
  exact(
    event as unknown as Record<string, unknown>,
    ["schemaVersion", "id", "taskId", "type", "payload", "createdAt"],
    "Task event"
  );
  requireRecordIdentity(event.id, "Task event id");
  requireRecordIdentity(event.taskId, "Task event Task id");
  validateTaskRecordReference({ taskId: event.taskId, localId: event.id }, "event");
  requireNormalizedText(event.type, "Task event type");
  const payload = object(event.payload, "Task event payload");
  for (const [key, payloadValue] of Object.entries(payload)) {
    requireRecordIdentity(key, "Task event payload key");
    if (typeof payloadValue !== "string" || payloadValue.includes("\0")) {
      throw new StorageRecordError(`Task event payload value is invalid: ${key}.`);
    }
  }
  requireTimestamp(event.createdAt, "Task event createdAt");
  return event;
}

export function storedCapabilityGrant(value: unknown): CapabilityGrant {
  const grant = versioned<CapabilityGrant>(
    value,
    CURRENT_CAPABILITY_GRANT_SCHEMA_VERSION,
    "Capability grant"
  );
  const fields = [
    "schemaVersion", "id", "taskId", "granter", "scope", "actions",
    "parameterBounds", "usesUsed", "irreversibilityCeiling", "createdAt", "updatedAt"
  ];
  if (grant.expiresAt !== undefined) fields.push("expiresAt");
  if (grant.maxUses !== undefined) fields.push("maxUses");
  if (grant.useReservations !== undefined) fields.push("useReservations");
  if (grant.revokedAt !== undefined) fields.push("revokedAt");
  if (grant.revokedBy !== undefined) fields.push("revokedBy");
  exact(grant as unknown as Record<string, unknown>, fields, "Capability grant");
  requireRecordIdentity(grant.id, "Capability grant id");
  requireRecordIdentity(grant.taskId, "Capability grant Task id");
  validateTaskRecordReference({ taskId: grant.taskId, localId: grant.id }, "capabilityGrant");
  requireNormalizedText(grant.granter, "Capability grant granter");
  storedCapabilityGrantScope(grant.scope, grant.taskId);
  if (!Array.isArray(grant.actions) || grant.actions.length === 0) {
    throw new StorageRecordError("Capability grant actions must be a non-empty array.");
  }
  const actions = grant.actions.map((action) => requireNormalizedText(action, "Capability grant action"));
  if (new Set(actions).size !== actions.length) {
    throw new StorageRecordError("Capability grant actions must be unique.");
  }
  const bounds = object(grant.parameterBounds, "Capability grant parameterBounds");
  for (const [name, allowed] of Object.entries(bounds)) {
    requireRecordIdentity(name, "Capability grant parameter");
    if (!Array.isArray(allowed) || allowed.length === 0) {
      throw new StorageRecordError(`Capability grant parameter bound must list allowed values: ${name}.`);
    }
    const values = allowed.map((entry) => requireNormalizedText(entry, `Capability grant parameter ${name} value`));
    if (new Set(values).size !== values.length) {
      throw new StorageRecordError(`Capability grant parameter bound values must be unique: ${name}.`);
    }
  }
  if (grant.expiresAt !== undefined) {
    requireTimestamp(grant.expiresAt, "Capability grant expiresAt");
  }
  if (grant.maxUses !== undefined
    && (!Number.isSafeInteger(grant.maxUses) || (grant.maxUses as number) < 1)) {
    throw new StorageRecordError("Capability grant maxUses must be a positive integer.");
  }
  if (!Number.isSafeInteger(grant.usesUsed) || (grant.usesUsed as number) < 0) {
    throw new StorageRecordError("Capability grant usesUsed must be a non-negative integer.");
  }
  if (grant.maxUses !== undefined && (grant.usesUsed as number) > (grant.maxUses as number)) {
    throw new StorageRecordError("Capability grant usesUsed cannot exceed maxUses.");
  }
  if (!["none", "reversible", "irreversible"].includes(grant.irreversibilityCeiling)) {
    throw new StorageRecordError(
      `Capability grant irreversibility ceiling is invalid: ${String(grant.irreversibilityCeiling)}.`
    );
  }
  if ((grant.revokedAt === undefined) !== (grant.revokedBy === undefined)) {
    throw new StorageRecordError("Capability grant revocation requires both revokedAt and revokedBy.");
  }
  if (grant.revokedAt !== undefined) {
    requireTimestamp(grant.revokedAt, "Capability grant revokedAt");
    requireNormalizedText(grant.revokedBy!, "Capability grant revokedBy");
  }
  requireTimestamp(grant.createdAt, "Capability grant createdAt");
  requireTimestamp(grant.updatedAt, "Capability grant updatedAt");
  try {
    return validateCapabilityGrant(grant);
  } catch (error) {
    throw new StorageRecordError(error instanceof Error ? error.message : String(error));
  }
}

function storedCapabilityGrantScope(scope: CapabilityGrant["scope"], taskId: string): void {
  const value = object(scope, "Capability grant scope");
  const fields: string[] = [];
  if (value.taskId !== undefined) fields.push("taskId");
  if (value.projectIds !== undefined) fields.push("projectIds");
  if (value.repositories !== undefined) fields.push("repositories");
  if (value.packages !== undefined) fields.push("packages");
  if (value.homePath !== undefined) fields.push("homePath");
  exact(value, fields, "Capability grant scope");
  if (fields.length === 0) {
    throw new StorageRecordError(`Capability grant scope requires at least one selector: ${taskId}.`);
  }
  if (value.taskId !== undefined) {
    requireRecordIdentity(value.taskId as string, "Capability grant scope taskId");
  }
  if (value.projectIds !== undefined) {
    if (!Array.isArray(value.projectIds) || value.projectIds.length === 0) {
      throw new StorageRecordError("Capability grant scope projectIds must be a non-empty array.");
    }
    const projectIds = (value.projectIds as unknown[]).map(
      (entry) => requireRecordIdentity(entry as string, "Capability grant scope Project")
    );
    if (new Set(projectIds).size !== projectIds.length) {
      throw new StorageRecordError("Capability grant scope Project ids must be unique.");
    }
  }
  if (value.repositories !== undefined) {
    if (!Array.isArray(value.repositories) || value.repositories.length === 0) {
      throw new StorageRecordError("Capability grant scope repositories must be a non-empty array.");
    }
    const repositories = (value.repositories as unknown[]).map((entry) => {
      const repository = object(entry, "Capability grant scope repository");
      exact(repository, ["owner", "name"], "Capability grant scope repository");
      return {
        owner: requireNormalizedText(repository.owner, "Capability grant scope repository owner"),
        name: requireNormalizedText(repository.name, "Capability grant scope repository name")
      };
    });
    const keys = new Set(repositories.map(({ owner, name }) => `${owner}/${name}`));
    if (keys.size !== repositories.length) {
      throw new StorageRecordError("Capability grant scope repositories must be unique.");
    }
  }
  if (value.packages !== undefined) {
    if (!Array.isArray(value.packages) || value.packages.length === 0) {
      throw new StorageRecordError("Capability grant scope packages must be a non-empty array.");
    }
    const packages = (value.packages as unknown[]).map(
      (entry) => requireNormalizedText(entry as string, "Capability grant scope package")
    );
    if (new Set(packages).size !== packages.length) {
      throw new StorageRecordError("Capability grant scope packages must be unique.");
    }
  }
  if (value.homePath !== undefined) {
    requireNormalizedText(value.homePath as string, "Capability grant scope homePath");
  }
}

export function isValidCapabilityGrantTransition(existing: CapabilityGrant, candidate: CapabilityGrant): boolean {
  if (existing.revokedAt !== undefined) {
    // Idempotent re-revoke: the domain returns the revoked record unchanged.
    return isDeepStrictEqual(candidate, existing);
  }
  const immutable = candidate.id === existing.id
    && candidate.taskId === existing.taskId
    && candidate.granter === existing.granter
    && isDeepStrictEqual(candidate.scope, existing.scope)
    && isDeepStrictEqual(candidate.actions, existing.actions)
    && isDeepStrictEqual(candidate.parameterBounds, existing.parameterBounds)
    && candidate.expiresAt === existing.expiresAt
    && candidate.maxUses === existing.maxUses
    && candidate.irreversibilityCeiling === existing.irreversibilityCeiling
    && candidate.createdAt === existing.createdAt;
  if (!immutable) return false;
  if (candidate.revokedAt !== undefined) {
    // Revocation consumes no uses and records no reservations.
    return (candidate.usesUsed as number) === (existing.usesUsed as number)
      && isDeepStrictEqual(candidate.useReservations, existing.useReservations)
      && Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt);
  }
  // A use record must advance the counter (compare-and-swap): a stale equal
  // increment from a concurrent reader is rejected, so two workflows cannot
  // spend the same maxUses slot. Reservations are append-only, one per use.
  return (candidate.usesUsed as number) > (existing.usesUsed as number)
    && reservationsAppendOnly(existing.useReservations, candidate.useReservations)
    && Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt);
}

function reservationsAppendOnly(
  existing: readonly string[] | undefined,
  candidate: readonly string[] | undefined
): boolean {
  if (existing === undefined || existing.length === 0) return true;
  if (candidate === undefined || candidate.length < existing.length) return false;
  return existing.every((key, index) => candidate[index] === key);
}

export function storedReleaseWorkflow(value: unknown): ReleaseWorkflow {
  const workflow = versioned<ReleaseWorkflow>(
    value,
    CURRENT_RELEASE_WORKFLOW_SCHEMA_VERSION,
    "Release workflow"
  );
  const fields = [
    "schemaVersion", "id", "taskId", "grantId", "source", "plan", "steps",
    "createdAt", "updatedAt"
  ];
  exact(workflow as unknown as Record<string, unknown>, fields, "Release workflow");
  requireRecordIdentity(workflow.id, "Release workflow id");
  requireRecordIdentity(workflow.taskId, "Release workflow Task id");
  validateTaskRecordReference({ taskId: workflow.taskId, localId: workflow.id }, "releaseWorkflow");
  requireNormalizedText(workflow.grantId, "Release workflow grantId");
  storedReleaseWorkflowSource(workflow.source);
  if (!Array.isArray(workflow.plan) || workflow.plan.length === 0) {
    throw new StorageRecordError("Release workflow plan must be a non-empty array.");
  }
  const planIds = new Set<string>();
  for (const entry of workflow.plan) {
    const plan = object(entry, "Release workflow plan entry");
    const planFields = ["id", "kind", "idempotencyKey"];
    if (plan.params !== undefined) planFields.push("params");
    if (plan.irreversibility !== undefined) planFields.push("irreversibility");
    exact(plan, planFields, "Release workflow plan entry");
    const planId = requireRecordIdentity(plan.id, "Release step id");
    if (planIds.has(planId)) {
      throw new StorageRecordError(`Release workflow plan ids must be unique: ${planId}.`);
    }
    planIds.add(planId);
    if (!RELEASE_WORKFLOW_KINDS.has(plan.kind as string)) {
      throw new StorageRecordError(`Release step kind is invalid: ${String(plan.kind)}.`);
    }
    requireNormalizedText(plan.idempotencyKey, "Release step idempotencyKey");
    if (plan.params !== undefined) {
      const params = object(plan.params, "Release step params");
      for (const [name, paramValue] of Object.entries(params)) {
        requireRecordIdentity(name, "Release step param");
        requireNormalizedText(paramValue, `Release step param ${name}`);
      }
    }
    if (plan.irreversibility !== undefined
      && !["none", "reversible", "irreversible"].includes(plan.irreversibility as string)) {
      throw new StorageRecordError(
        `Release step irreversibility is invalid: ${String(plan.irreversibility)}.`
      );
    }
  }
  const steps = object(workflow.steps, "Release workflow steps");
  for (const planId of planIds) {
    if (!Object.hasOwn(steps, planId)) {
      throw new StorageRecordError(`Release workflow step record is missing: ${planId}.`);
    }
  }
  for (const key of Object.keys(steps)) {
    if (!planIds.has(key)) {
      throw new StorageRecordError(`Release workflow step record has no plan entry: ${key}.`);
    }
  }
  for (const planId of planIds) {
    storedReleaseStep(steps[planId], planId);
  }
  requireTimestamp(workflow.createdAt, "Release workflow createdAt");
  requireTimestamp(workflow.updatedAt, "Release workflow updatedAt");
  try {
    return validateReleaseWorkflow(workflow);
  } catch (error) {
    throw new StorageRecordError(error instanceof Error ? error.message : String(error));
  }
}

function storedReleaseWorkflowSource(source: ReleaseWorkflow["source"]): void {
  const value = object(source, "Release workflow source");
  const sourceFields = ["repository", "commit"];
  if (value.artifact !== undefined) sourceFields.push("artifact");
  exact(value, sourceFields, "Release workflow source");
  const repository = object(value.repository, "Release workflow source repository");
  exact(repository, ["owner", "name"], "Release workflow source repository");
  requireNormalizedText(repository.owner, "Release workflow source repository owner");
  requireNormalizedText(repository.name, "Release workflow source repository name");
  requireNormalizedText(value.commit, "Release workflow source commit");
  if (value.artifact !== undefined) {
    const artifact = object(value.artifact, "Release workflow source artifact");
    exact(artifact, ["name", "integrity"], "Release workflow source artifact");
    requireNormalizedText(artifact.name, "Release workflow source artifact name");
    requireNormalizedText(artifact.integrity, "Release workflow source artifact integrity");
  }
}

function storedReleaseStep(step: unknown, planId: string): void {
  const value = object(step, `Release step record ${planId}`);
  const stepFields = ["planId", "status", "attempts", "logs"];
  if (value.externalId !== undefined) stepFields.push("externalId");
  if (value.externalIdentity !== undefined) stepFields.push("externalIdentity");
  if (value.lastAttemptAt !== undefined) stepFields.push("lastAttemptAt");
  if (value.terminalAt !== undefined) stepFields.push("terminalAt");
  exact(value, stepFields, `Release step record ${planId}`);
  requireNormalizedText(value.planId, `Release step planId ${planId}`);
  if (value.planId !== planId) {
    throw new StorageRecordError(
      `Release step record planId ${String(value.planId)} does not match its key: ${planId}.`
    );
  }
  if (!RELEASE_WORKFLOW_STATUSES.has(value.status as string)) {
    throw new StorageRecordError(`Release step status is invalid: ${String(value.status)}.`);
  }
  if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0) {
    throw new StorageRecordError(`Release step attempts must be a non-negative integer: ${planId}.`);
  }
  if (value.externalId !== undefined) {
    requireNormalizedText(value.externalId, `Release step externalId ${planId}`);
  }
  if (value.externalIdentity !== undefined) {
    const identity = object(value.externalIdentity, `Release step externalIdentity ${planId}`);
    exact(identity, ["kind", "value"], `Release step externalIdentity ${planId}`);
    requireNormalizedText(identity.kind, `Release step externalIdentity kind ${planId}`);
    requireNormalizedText(identity.value, `Release step externalIdentity value ${planId}`);
  }
  // An `unknown` step without an externalIdentity is a crash-recovery state:
  // the process died during executeStep after the effect may have landed, but
  // before an identity was recorded. The domain validation permits it and the
  // engine fails closed (unconfirmed) on resume; the store must persist it.
  if (!Array.isArray(value.logs)) {
    throw new StorageRecordError(`Release step logs must be an array: ${planId}.`);
  }
  for (const line of value.logs) {
    requireNormalizedText(line, `Release step log ${planId}`);
  }
  if (value.lastAttemptAt !== undefined) {
    requireTimestamp(value.lastAttemptAt, `Release step lastAttemptAt ${planId}`);
  }
  if (value.status === "running" && value.lastAttemptAt === undefined) {
    throw new StorageRecordError(`Release step running status requires lastAttemptAt: ${planId}.`);
  }
  if (value.terminalAt !== undefined) {
    requireTimestamp(value.terminalAt, `Release step terminalAt ${planId}`);
  }
  if ((value.status === "succeeded" || value.status === "skipped") && value.terminalAt === undefined) {
    throw new StorageRecordError(`Release step ${String(value.status)} status requires terminalAt: ${planId}.`);
  }
}

const RELEASE_WORKFLOW_KINDS: ReadonlySet<string> = new Set([
  "pr-create-or-reuse", "ci-confirm", "merge", "version-tag",
  "npm-publish", "fresh-install-smoke", "cli-update",
  "controller-replace", "project-migrate", "post-verify"
]);

const RELEASE_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  "pending", "running", "succeeded", "failed", "unknown", "skipped"
]);

/**
 * Workflow records only move forward in time: a save with an older updatedAt
 * than the stored record is rejected. Equal updatedAt permits idempotent
 * re-saves of the same record. The exact source and the predeclared plan are
 * immutable after create, and each step status may only follow the release
 * state machine (no rewinds that could re-trigger a side effect).
 */
export function isValidReleaseWorkflowTransition(existing: ReleaseWorkflow, candidate: ReleaseWorkflow): boolean {
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)) return false;
  if (!isDeepStrictEqual(candidate.source, existing.source)) return false;
  if (!isDeepStrictEqual(candidate.plan, existing.plan)) return false;
  const existingKeys = Object.keys(existing.steps);
  const candidateKeys = Object.keys(candidate.steps);
  if (existingKeys.length !== candidateKeys.length) return false;
  for (const key of existingKeys) {
    const from = existing.steps[key];
    const to = candidate.steps[key];
    if (from === undefined || to === undefined) return false;
    if (!isLegalStepTransition(from.status, to.status)) return false;
    if (to.attempts < from.attempts) return false;
  }
  return true;
}

/**
 * The legal step-status transitions. Self-transitions are always allowed
 * (idempotent re-saves). `pending -> failed` is permitted because the engine
 * records an authorization denial atomically (start then fail in one save).
 * `failed -> succeeded` is permitted only via an authoritative query that
 * proves the effect landed (confirmFailedStep).
 */
const LEGAL_STEP_TRANSITIONS: Readonly<Record<ReleaseStepStatus, readonly ReleaseStepStatus[]>> = {
  pending: ["running", "skipped", "failed"],
  running: ["running", "succeeded", "failed", "unknown"],
  failed: ["running", "succeeded"],
  unknown: ["running", "succeeded"],
  succeeded: [],
  skipped: []
};

function isLegalStepTransition(from: ReleaseStepStatus, to: ReleaseStepStatus): boolean {
  if (from === to) return true;
  return LEGAL_STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

function isValidDecisionSupersession(existing: Decision, candidate: Decision): boolean {
  return existing.status === "active"
    && candidate.status === "superseded"
    && candidate.id === existing.id
    && candidate.taskId === existing.taskId
    && candidate.title === existing.title
    && candidate.rationale === existing.rationale
    && candidate.createdAt === existing.createdAt
    && Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt);
}

function isValidInputRequestTransition(existing: InputRequest, candidate: InputRequest): boolean {
  if (existing.status !== "open" || candidate.status === "open") return false;
  return candidate.id === existing.id
    && candidate.taskId === existing.taskId
    && isDeepStrictEqual(candidate.requester, existing.requester)
    && candidate.question === existing.question
    && isDeepStrictEqual(candidate.choices, existing.choices)
    && isDeepStrictEqual(candidate.blockedRefs, existing.blockedRefs)
    && isDeepStrictEqual(candidate.policy, existing.policy)
    && candidate.createdAt === existing.createdAt
    && Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt);
}

function requireTaskFromState(state: StorageState, taskId: string): StoredTask {
  const aggregate = state.tasks[taskId];
  if (aggregate === undefined) throw new StorageRecordError(`Task not found: ${taskId}`);
  return aggregate;
}

function requireRecordIdentity(value: unknown, label: string): string {
  const normalized = requireNormalizedText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new StorageRecordError(`${label} is invalid.`);
  }
  return normalized;
}

function requireNormalizedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new StorageRecordError(`${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new StorageRecordError(`${label} is required.`);
  if (normalized !== value) throw new StorageRecordError(`${label} must be normalized.`);
  return normalized;
}

function requireOptionalNormalizedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new StorageRecordError(`${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized !== value) throw new StorageRecordError(`${label} must be normalized.`);
  return normalized;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new StorageRecordError(`${label} is invalid.`);
  }
  return value;
}

function parseMap<T>(value: unknown, parse: (entry: unknown, key: string) => T, label: string): asserts value is Record<string, T> {
  const records = object(value, label);
  for (const [key, entry] of Object.entries(records)) parse(entry, key);
}
function versioned<T>(value: unknown, schemaVersion: number, label: string): T {
  assertJsonValue(value, label);
  const record = object(value, label);
  if (record.schemaVersion !== schemaVersion) throw new StorageRecordError(`${label} must use schemaVersion ${schemaVersion}.`);
  return clone(record) as T;
}
function identified<T>(value: unknown, schemaVersion: number, key: string, expected: string, label: string): T {
  const record = versioned<Record<string, unknown>>(value, schemaVersion, label);
  if (record[key] !== expected) throw new StorageRecordError(`${label} identity is inconsistent: ${expected}.`);
  return record as T;
}
function identifiedChangeSet(value: unknown, expectedId: string): ChangeSet {
  return identified<ChangeSet>(
    value,
    CURRENT_CHANGE_SET_SCHEMA_VERSION,
    "id",
    expectedId,
    "ChangeSet"
  );
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StorageRecordError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new StorageRecordError(`${label} has unknown field: ${unknown}.`);
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new StorageRecordError(`${label} is missing field: ${missing}.`);
}
function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new StorageRecordError(`${label} contains a non-JSON value.`);
  if (seen.has(value)) throw new StorageRecordError(`${label} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) for (const entry of value) assertJsonValue(entry, label, seen);
  else for (const [key, entry] of Object.entries(value)) { if (entry === undefined) throw new StorageRecordError(`${label} contains undefined at ${key}.`); assertJsonValue(entry, label, seen); }
  seen.delete(value);
}
function clone<T>(value: T): T { assertJsonValue(value, "Stored value"); return JSON.parse(JSON.stringify(value)) as T; }
function optional<T>(value: T | undefined): T | null { return value === undefined ? null : clone(value); }
function values<T>(records: Record<string, T>, identity: keyof T | ((value: T) => string)): T[] {
  return Object.values(records).map(clone).sort((left, right) => numericCompare(typeof identity === "function" ? identity(left) : String(left[identity]), typeof identity === "function" ? identity(right) : String(right[identity])));
}
function numericCompare(left: string, right: string): number { return left.localeCompare(right, undefined, { numeric: true }); }
export function pendingWakeupProjection(mailbox: WorkMailbox | null): PendingWakeup | null {
  if (mailbox === null || mailbox.target.kind !== "role" || mailbox.target.roleName !== "leader"
    || mailbox.pending === null) {
    return null;
  }
  return {
    schemaVersion: CURRENT_PENDING_WAKEUP_SCHEMA_VERSION,
    taskId: mailbox.target.taskId,
    reasons: [...mailbox.pending.reasons],
    requestCount: mailbox.pending.requestCount,
    firstRequestedAt: mailbox.pending.firstQueuedAt,
    lastRequestedAt: mailbox.pending.lastQueuedAt
  };
}
function validateMailboxReferences(state: StorageState, mailbox: WorkMailbox): void {
  if (
    mailbox.target.kind === "task"
    || mailbox.target.kind === "role"
    || mailbox.target.kind === "role-runtime"
  ) {
    const aggregate = state.tasks[mailbox.target.taskId];
    if (aggregate === undefined) {
      throw new StorageRecordError(`WorkMailbox target Task not found: ${mailbox.target.taskId}`);
    }
    if (mailbox.target.kind === "role" && aggregate.roles[mailbox.target.roleName] === undefined) {
      throw new StorageRecordError(
        `WorkMailbox target Role not found: ${mailbox.target.taskId}/${mailbox.target.roleName}`
      );
    }
  }
  const refs: MailboxEntityRef[] = [];
  if (mailbox.processing !== null) {
    refs.push(...mailbox.processing.batch.refs);
    if (mailbox.processing.executionRef !== undefined) refs.push(mailbox.processing.executionRef);
  }
  if (mailbox.pending !== null) refs.push(...mailbox.pending.refs);
  for (const ref of refs) {
    if (!mailboxReferenceExists(state, ref)) {
      const identity = "taskId" in ref ? `${ref.taskId}/${ref.id}` : ref.id;
      throw new StorageRecordError(`WorkMailbox reference does not exist: ${ref.type}/${identity}`);
    }
  }
}

function validateCanonicalTaskReferences(state: StorageState, aggregate: StoredTask): void {
  const taskId = aggregate.task.id;
  if (aggregate.task.replacementTaskId !== undefined) {
    const replacement = state.tasks[aggregate.task.replacementTaskId];
    if (replacement === undefined || replacement.task.id === taskId) {
      throw new StorageRecordError(
        `Replacement Task reference is invalid: ${taskId}/${aggregate.task.replacementTaskId}.`
      );
    }
  }
  const boundProjects = new Set(aggregate.task.projectBindings.map(({ projectId }) => projectId));
  assertAcyclicWorkItems(aggregate.workItems);
  for (const item of Object.values(aggregate.workItems)) {
    for (const dependencyId of item.dependsOn) {
      if (aggregate.workItems[dependencyId] === undefined) {
        throw new StorageRecordError(`Work Item dependency not found: ${taskId}/${dependencyId}.`);
      }
    }
    if (item.writeProjectIds.some((projectId) => !boundProjects.has(projectId))) {
      throw new StorageRecordError(
        `Work Item writable Project does not belong to Task: ${taskId}/${item.id}.`
      );
    }
    const writableProjects = new Set(item.writeProjectIds);
    if (item.baseRefs?.some(({ projectId }) => !boundProjects.has(projectId))) {
      throw new StorageRecordError(
        `Work Item base-ref Project does not belong to Task: ${taskId}/${item.id}.`
      );
    }
    if (item.baseRefs?.some(({ projectId }) => !writableProjects.has(projectId))) {
      throw new StorageRecordError(
        `Work Item base-ref Project must be writable: ${taskId}/${item.id}.`
      );
    }
    const replacementWorkItemId = item.disposition?.replacementWorkItemId;
    if (replacementWorkItemId !== undefined) {
      if (replacementWorkItemId === item.id) {
        throw new StorageRecordError(`Work Item cannot replace itself: ${taskId}/${item.id}.`);
      }
      const replacement = aggregate.workItems[replacementWorkItemId];
      if (replacement === undefined || replacement.taskId !== taskId) {
        throw new StorageRecordError(
          `Replacement Work Item must belong to the same Task: ${taskId}/${replacementWorkItemId}.`
        );
      }
    }
    for (const candidate of item.candidates) {
      assertWorkItemCandidateReferences(
        aggregate,
        item,
        candidate,
        `Work Item candidate ${item.id}`
      );
    }
  }
  for (const workspace of Object.values(aggregate.managedWorkspaces)) {
    if (workspace.owner.type === "work-item"
      && aggregate.workItems[workspace.owner.workItemId] === undefined) {
      throw new StorageRecordError(
        `Managed workspace Work Item not found: ${taskId}/${workspace.owner.workItemId}.`
      );
    }
    if (workspace.owner.type === "review-round") {
      const round = aggregate.reviewRounds[workspace.owner.reviewRoundId];
      if (round === undefined) {
        throw new StorageRecordError(
          `Managed workspace ReviewRound is invalid: ${taskId}/${workspace.owner.reviewRoundId}.`
        );
      }
    }
  }
  for (const [roleName, sessions] of Object.entries(aggregate.roleSessionSets)) {
    if (sessions.inFlight !== null) {
      const run = aggregate.agentRuns[sessions.inFlight.runId];
      if (run === undefined || run.roleName !== roleName
        || sessions.inFlight.receiptId !== formatAgentRunReceiptId(taskId, run.id)) {
        throw new StorageRecordError(`Task Role in-flight Run is invalid: ${taskId}/${roleName}.`);
      }
    }
    if (sessions.pendingTurnCompletion !== null) {
      const completion = sessions.pendingTurnCompletion;
      const run = aggregate.agentRuns[completion.runId];
      if (completion.taskId !== taskId || run === undefined || run.roleName !== roleName) {
        throw new StorageRecordError(
          `Task Role pending completion Run is invalid: ${taskId}/${roleName}.`
        );
      }
    }
  }
  for (const run of Object.values(aggregate.agentRuns)) {
    if (run.workItemId !== undefined && aggregate.workItems[run.workItemId] === undefined) {
      throw new StorageRecordError(`Agent Run Work Item not found: ${taskId}/${run.id}.`);
    }
    if (run.reviewRoundId !== undefined
      && aggregate.reviewRounds[run.reviewRoundId] === undefined) {
      throw new StorageRecordError(`Agent Run ReviewRound not found: ${taskId}/${run.id}.`);
    }
    assertAgentRunExecutionReferences(aggregate, run);
  }
  for (const message of Object.values(aggregate.messages)) {
    if (message.runId !== undefined && aggregate.agentRuns[message.runId] === undefined) {
      throw new StorageRecordError(`Message Run not found: ${taskId}/${message.id}.`);
    }
    if (message.workItemId !== undefined
      && aggregate.workItems[message.workItemId] === undefined) {
      throw new StorageRecordError(`Message Work Item not found: ${taskId}/${message.id}.`);
    }
  }
  for (const request of Object.values(aggregate.inputRequests)) {
    if (aggregate.agentRuns[request.requester.runId] === undefined) {
      throw new StorageRecordError(`Input requester Run not found: ${taskId}/${request.id}.`);
    }
    for (const reference of request.blockedRefs) {
      const found = reference.type === "run"
        ? aggregate.agentRuns[reference.id]
        : aggregate.workItems[reference.id];
      if (found === undefined) {
        throw new StorageRecordError(
          `Input blocked ${reference.type} not found: ${taskId}/${request.id}/${reference.id}.`
        );
      }
    }
  }
  for (const round of Object.values(aggregate.reviewRounds)) {
    const item = aggregate.workItems[round.workItemId];
    if (item === undefined) {
      throw new StorageRecordError(`ReviewRound references are invalid: ${round.id}.`);
    }
    const candidate = item.candidates.find(({ id }) => id === round.candidateId);
    if (candidate === undefined) {
      throw new StorageRecordError(`ReviewRound Candidate not found: ${round.candidateId}.`);
    }
    assertWorkItemCandidateReferences(aggregate, item, candidate, `ReviewRound candidate ${round.id}`);
    if ((round.scope ?? "work-item") === "task") {
      const frozenProjects = round.taskCandidate?.projects ?? [];
      if (frozenProjects.length !== boundProjects.size
        || frozenProjects.some(({ projectId }) => !boundProjects.has(projectId))) {
        throw new StorageRecordError(
          `Task ReviewRound Projects do not match Task scope: ${round.id}.`
        );
      }
      if (!sameTaskFinalReviewContract(
        round.taskFinalReviewContract,
        candidate.taskFinalReviewContract
      )) {
        throw new StorageRecordError(
          `Task ReviewRound contract does not match its Candidate: ${round.id}.`
        );
      }
    }
    if (round.reviewerRunId !== undefined) {
      const reviewerRun = aggregate.agentRuns[round.reviewerRunId];
      if (reviewerRun === undefined
        || reviewerRun.reviewRoundId !== round.id
        || reviewerRun.purpose !== "review") {
        throw new StorageRecordError(`ReviewRound Reviewer Run is invalid: ${round.id}.`);
      }
    }
  }
  for (const changeSet of Object.values(aggregate.changeSets)) {
    if (aggregate.workItems[changeSet.workItemId] === undefined) {
      throw new StorageRecordError(`ChangeSet Work Item not found: ${changeSet.id}.`);
    }
    if (!aggregate.task.projectBindings.some(
      ({ projectId }) => projectId === changeSet.projectId
    )) {
      throw new StorageRecordError(`ChangeSet Project does not match Task: ${changeSet.id}.`);
    }
    const evidenceRound = Object.values(aggregate.reviewRounds).find(
      ({ evidenceCommit, reviewBaseCommit }) => evidenceCommit !== undefined && evidenceCommit !== reviewBaseCommit && evidenceCommit === changeSet.headCommit
    );
    if (evidenceRound !== undefined) {
      throw new StorageRecordError(
        `ReviewRound evidence commit ${evidenceRound.id}/${changeSet.headCommit} cannot become a ChangeSet.`
      );
    }
  }
  for (const integration of Object.values(aggregate.integrationAttempts)) {
    if (!boundProjects.has(integration.projectId)) {
      throw new StorageRecordError(
        `Integration Project does not match Task: ${integration.id}.`
      );
    }
    for (const changeSetId of integration.changeSetIds) {
      const changeSet = aggregate.changeSets[changeSetId];
      if (changeSet === undefined) {
        throw new StorageRecordError(`Integration ChangeSet not found: ${integration.id}/${changeSetId}.`);
      }
      if (changeSet.projectId !== integration.projectId) {
        throw new StorageRecordError(
          `Integration ChangeSet belongs to another Project: ${integration.id}/${changeSetId}.`
        );
      }
      const evidenceRound = Object.values(aggregate.reviewRounds).find(
        ({ evidenceCommit, reviewBaseCommit }) => evidenceCommit !== undefined && evidenceCommit !== reviewBaseCommit && evidenceCommit === changeSet.headCommit
      );
      if (evidenceRound !== undefined) {
        throw new StorageRecordError(
          `ReviewRound evidence commit ${evidenceRound.id}/${changeSet.headCommit} cannot become an Integration source.`
        );
      }
    }
  }
  for (const workspace of Object.values(aggregate.managedWorkspaces)) {
    assertManagedWorkspaceReferences(aggregate, workspace, "Managed workspace");
  }
}

/**
 * Enforce the owner-specific scope at the storage boundary.  The map key and
 * foreign-record checks prevent dangling identities; these checks prevent a
 * valid owner from being paired with another lifecycle's Project scope.
 */
function assertManagedWorkspaceReferences(
  aggregate: StoredTask,
  workspace: ManagedWorkspace,
  label: string,
  workItemOverride?: WorkItem
): void {
  const taskId = aggregate.task.id;
  const boundProjects = aggregate.task.projectBindings.map(({ projectId }) => projectId).sort();
  const actualProjects = workspace.entries.map(({ projectId }) => projectId).sort();
  const requireVisibleTaskScope = (): void => {
    // Project bindings are persisted before the physical workspace is
    // reconciled.  During that bounded hand-off a workspace may be missing a
    // newly-bound Project, but it must never expose a Project outside the
    // current Task.  Launch preparation closes the temporary subset before
    // the workspace can be used.
    if (actualProjects.some((projectId) => !boundProjects.includes(projectId))) {
      throw new StorageRecordError(`${label} Project scope does not match Task: ${taskId}.`);
    }
  };
  switch (workspace.owner.type) {
    case "task":
      requireVisibleTaskScope();
      if (workspace.entries.some(({ access }) => access !== "write")) {
        throw new StorageRecordError(`${label} Task workspace must be writable: ${taskId}.`);
      }
      return;
    case "work-item": {
      const item = workItemOverride?.id === workspace.owner.workItemId
        ? workItemOverride
        : aggregate.workItems[workspace.owner.workItemId];
      if (item === undefined) {
        throw new StorageRecordError(
          `${label} WorkItem not found: ${taskId}/${workspace.owner.workItemId}.`
        );
      }
      requireVisibleTaskScope();
      const writable = workspace.entries
        .filter(({ access }) => access === "write")
        .map(({ projectId }) => projectId)
        .sort();
      const expectedWritable = [...item.writeProjectIds].sort();
      // Write scope expansion is persisted before the physical WorkItem
      // workspace is reconciled.  The stored workspace may therefore expose
      // a temporary subset, but it may never grant write access outside the
      // current WorkItem authorization.
      if (writable.some((projectId) => !expectedWritable.includes(projectId))) {
        throw new StorageRecordError(
          `${label} WorkItem write scope does not match: ${taskId}/${item.id}.`
        );
      }
      return;
    }
    case "review-round": {
      const round = aggregate.reviewRounds[workspace.owner.reviewRoundId];
      if (round === undefined) {
        throw new StorageRecordError(
          `${label} ReviewRound not found: ${taskId}/${workspace.owner.reviewRoundId}.`
        );
      }
      requireVisibleTaskScope();
      if (workspace.entries.some(({ access }) => access !== "write")) {
        throw new StorageRecordError(
          `${label} ReviewRound workspace must be writable: ${taskId}/${round.id}.`
        );
      }
      const item = aggregate.workItems[round.workItemId];
      const candidate = item?.candidates.find(({ id }) => id === round.candidateId);
      const frozenProjects = round.scope === "task"
        ? round.taskCandidate?.projects
        : candidate?.gitSnapshot?.projects;
      if (frozenProjects !== undefined) {
        const expected = [...frozenProjects]
          .map(({ projectId, commit }) => ({ projectId, commit }))
          .sort((left, right) => left.projectId.localeCompare(right.projectId));
        const actual = workspace.entries
          .map(({ projectId, baseCommit }) => ({ projectId, commit: baseCommit }))
          .sort((left, right) => left.projectId.localeCompare(right.projectId));
        const matches = expected.length === actual.length
          && expected.every((frozen, index) => {
            const reviewEntry = actual[index];
            return reviewEntry?.projectId === frozen.projectId
              && reviewEntry.commit === frozen.commit;
          });
        if (!matches) {
          const provenance = round.scope === "task"
            ? "Task frozen project set"
            : "Candidate frozen commit";
          throw new StorageRecordError(
            `${label} ReviewRound does not use the ${provenance}: ${taskId}/${round.id}.`
          );
        }
      }
      return;
    }
    case "integration-attempt": {
      const attempt = aggregate.integrationAttempts[workspace.owner.integrationAttemptId];
      if (attempt === undefined) {
        throw new StorageRecordError(
          `${label} Integration Attempt not found: ${taskId}/${workspace.owner.integrationAttemptId}.`
        );
      }
      if (workspace.entries.length !== 1
        || workspace.entries[0].projectId !== attempt.projectId
        || workspace.entries[0].access !== "write") {
        throw new StorageRecordError(
          `${label} Integration Attempt scope is invalid: ${taskId}/${attempt.id}.`
        );
      }
      return;
    }
    case "execution-lane": {
      const owner = workspace.owner;
      const laneItem = owner.purpose === "execution"
        ? aggregate.workItems[owner.workItemId ?? ""]
        : undefined;
      const group = owner.purpose === "execution"
        ? (laneItem === undefined
          ? undefined
          : workItemExecutionGroupById(laneItem, owner.executionGroupId))
        : aggregate.reviewRounds[owner.reviewRoundId ?? ""]?.executionGroup;
      if (group === undefined || group.id !== owner.executionGroupId
        || !group.lanes.some(({ id }) => id === owner.executionLaneId)) {
        throw new StorageRecordError(
          `${label} Execution Lane lineage is invalid: ${taskId}/${owner.executionGroupId}/${owner.executionLaneId}.`
        );
      }
      requireVisibleTaskScope();
      const writable = workspace.entries
        .filter(({ access }) => access === "write")
        .map(({ projectId }) => projectId)
        .sort();
      const expectedWritable = owner.purpose === "execution"
        ? [...(aggregate.workItems[owner.workItemId ?? ""]?.writeProjectIds ?? [])].sort()
        : boundProjects;
      if (!isDeepStrictEqual(writable, expectedWritable)) {
        throw new StorageRecordError(
          `${label} Execution Lane write scope does not match: ${taskId}/${owner.executionLaneId}.`
        );
      }
      return;
    }
  }
}

function validIntegrationTransition(
  before: IntegrationAttempt,
  after: IntegrationAttempt
): boolean {
  if (
    before.id !== after.id
    || before.taskId !== after.taskId
    || before.projectId !== after.projectId
    || before.targetRef !== after.targetRef
    || before.expectedHead !== after.expectedHead
    || !isDeepStrictEqual(before.changeSetIds, after.changeSetIds)
    || !isDeepStrictEqual(before.checkCommands, after.checkCommands)
    || before.createdAt !== after.createdAt
  ) return false;
  const allowed: Readonly<Record<IntegrationAttempt["status"], readonly IntegrationAttempt["status"][]>> = {
    running: ["running", "blocked", "validating", "failed"],
    blocked: ["blocked", "validating", "failed"],
    validating: ["validating", "committed", "failed"],
    committed: ["committed", "superseded"],
    superseded: ["superseded"],
    failed: ["failed"]
  };
  return allowed[before.status].includes(after.status);
}

/**
 * Storage-level defence in depth for the integration queue state machine: the
 * identity fields and the check/evidence lists are immutable once written, and
 * a status may only move along the queue's legal transitions.  The service
 * owns the CAS claim; this rejects a stale or forged write that slipped past it.
 */
function validIntegrationQueueTransition(
  before: IntegrationQueueEntry,
  after: IntegrationQueueEntry
): boolean {
  if (
    before.id !== after.id
    || before.taskId !== after.taskId
    || before.projectId !== after.projectId
    || before.changeSetId !== after.changeSetId
    || before.targetRef !== after.targetRef
    || !isDeepStrictEqual(before.checkCommands, after.checkCommands)
    || !isDeepStrictEqual(before.evidenceRefs, after.evidenceRefs)
    || before.createdAt !== after.createdAt
  ) return false;
  const allowed: Readonly<Record<IntegrationQueueStatus, readonly IntegrationQueueStatus[]>> = {
    queued: ["queued", "running", "validated", "superseded"],
    running: ["running", "conflicted", "committed"],
    conflicted: ["conflicted", "running", "committed", "queued", "superseded"],
    validated: ["validated", "running", "queued", "superseded"],
    committed: ["committed"],
    superseded: ["superseded"]
  };
  return allowed[before.status].includes(after.status);
}

function assertAcyclicWorkItems(items: Readonly<Record<string, WorkItem>>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new StorageRecordError(`Work Item dependency cycle detected: ${id}.`);
    visiting.add(id);
    const item = items[id];
    if (item !== undefined) {
      for (const dependencyId of item.dependsOn) visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(items)) visit(id);
}

function mailboxReferenceExists(state: StorageState, ref: MailboxEntityRef): boolean {
  if ("taskId" in ref) {
    const aggregate = state.tasks[ref.taskId];
    if (aggregate === undefined) return false;
    switch (ref.type) {
      case "run": return aggregate.agentRuns[ref.id] !== undefined;
      case "work-item": return aggregate.workItems[ref.id] !== undefined;
      case "input": return aggregate.inputRequests[ref.id] !== undefined;
      case "message": return aggregate.messages[ref.id] !== undefined;
    }
  }
  switch (ref.type) {
    case "task": return state.tasks[ref.id] !== undefined;
    case "session":
      return [
        ...Object.values(state.globalRoleSessionSets),
        ...Object.values(state.tasks).flatMap((task) => Object.values(task.roleSessionSets))
      ].some((set) => Object.values(set.sessions).some((session) => session.nativeSessionId === ref.id));
    default: return false;
  }
}
function validWorkItemTransition(existing: WorkItem, candidate: WorkItem): boolean {
  if (isDeepStrictEqual(existing, candidate)) return true;
  if (
    existing.id !== candidate.id
    || existing.taskId !== candidate.taskId
    || existing.assignee !== candidate.assignee
    || existing.createdAt !== candidate.createdAt
    || !isDeepStrictEqual(existing.baseRefs, candidate.baseRefs)
    || candidate.revision !== existing.revision + 1
    || Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)
  ) return false;
  if (!compatibleWorkItemExecutionGroups(existing, candidate)) return false;
  if (
    existing.status !== candidate.status
    && (
      existing.title !== candidate.title
      || existing.objective !== candidate.objective
      || !isDeepStrictEqual(existing.acceptance, candidate.acceptance)
      || !isDeepStrictEqual(existing.dependsOn, candidate.dependsOn)
      || !isDeepStrictEqual(existing.writeProjectIds, candidate.writeProjectIds)
    )
  ) return false;
  const candidateProjects = new Set(candidate.writeProjectIds);
  if (existing.writeProjectIds.some((projectId) => !candidateProjects.has(projectId))) {
    return false;
  }
  const candidatesChanged = !isDeepStrictEqual(existing.candidates, candidate.candidates);
  const submittedCandidate = existing.status === "running"
    && candidate.status === "awaiting_acceptance"
    && candidate.candidates.length === existing.candidates.length + 1
    && isDeepStrictEqual(
      candidate.candidates.slice(0, existing.candidates.length),
      existing.candidates
    );
  if (candidatesChanged && !submittedCandidate) {
    return false;
  }
  const allowed: Readonly<Record<WorkItem["status"], readonly WorkItem["status"][]>> = {
    pending: ["pending", "running", "retired"],
    running: [
      "running",
      "awaiting_acceptance",
      "completed",
      "failed",
      "retired"
    ],
    awaiting_acceptance: [
      "awaiting_acceptance",
      "completed",
      "failed",
      "retired"
    ],
    completed: ["completed"],
    failed: ["failed", "running", "retired"],
    retired: ["retired"]
  };
  return allowed[existing.status].includes(candidate.status);
}

function compatibleWorkItemExecutionGroups(
  existing: WorkItem,
  candidate: WorkItem
): boolean {
  if (candidate.executionGroups.length < existing.executionGroups.length) return false;
  for (const [index, historical] of existing.executionGroups.entries()) {
    const next = candidate.executionGroups[index];
    if (next === undefined || next.id !== historical.id) return false;
    const isCurrent = existing.currentExecutionGroupId === historical.id;
    const mutableCurrent = isCurrent && historical.resolution === undefined;
    if (!mutableCurrent && !isDeepStrictEqual(historical, next)) return false;
    if (mutableCurrent && !compatibleExecutionGroups(historical, next)) return false;
  }
  const appended = candidate.executionGroups.slice(existing.executionGroups.length);
  if (appended.length > 1) return false;
  if (appended.length === 1) {
    const priorCurrent = existing.currentExecutionGroupId === undefined
      ? undefined
      : workItemExecutionGroupById(existing, existing.currentExecutionGroupId);
    if (priorCurrent !== undefined && priorCurrent.resolution === undefined) return false;
    if (candidate.currentExecutionGroupId !== appended[0]!.id) return false;
  } else if (candidate.currentExecutionGroupId !== existing.currentExecutionGroupId) {
    const priorCurrent = existing.currentExecutionGroupId === undefined
      ? undefined
      : workItemExecutionGroupById(existing, existing.currentExecutionGroupId);
    const clearingResolvedRetry = existing.status === "failed"
      && candidate.status === "running"
      && candidate.currentExecutionGroupId === undefined
      && priorCurrent?.resolution !== undefined;
    if (!clearingResolvedRetry) return false;
  }
  if (candidate.currentExecutionGroupId !== undefined
    && workItemExecutionGroupById(candidate, candidate.currentExecutionGroupId) === undefined) {
    return false;
  }
  return true;
}

function assertWorkItemCandidateReferences(
  aggregate: StoredTask,
  item: WorkItem,
  candidate: WorkItemCandidate,
  label: string
): void {
  if (candidate.workItemRevision > item.revision) {
    throw new StorageRecordError(`${label} revision is invalid.`);
  }
  if ((candidate.executionGroupId === undefined) !== (candidate.executionLaneId === undefined)) {
    throw new StorageRecordError(`${label} execution lineage is incomplete.`);
  }
  if (candidate.executionGroupId !== undefined) {
    const group = workItemExecutionGroupById(item, candidate.executionGroupId!);
    const lane = group?.lanes.find(({ id }) => id === candidate.executionLaneId);
    if (group === undefined
      || group.id !== candidate.executionGroupId
      || lane === undefined) {
      throw new StorageRecordError(
        `${label} execution lineage is invalid: candidate=${candidate.executionGroupId}/${candidate.executionLaneId}; `
        + `item=${group?.id ?? "none"}/${lane?.id ?? "none"}.`
      );
    }
  }
  if (candidate.workspace !== undefined) {
    if (candidate.workspace.owner.taskId !== item.taskId) {
      throw new StorageRecordError(`${label} workspace belongs to another Task.`);
    }
    if (candidate.workspace.owner.type === "work-item"
      && candidate.workspace.owner.workItemId !== item.id) {
      throw new StorageRecordError(`${label} workspace belongs to another Work Item.`);
    }
    if (candidate.workspace.owner.type !== "work-item") {
      throw new StorageRecordError(`${label} must use the WorkItem-owned Develop workspace.`);
    }
    assertManagedWorkspaceReferences(aggregate, candidate.workspace, label, item);
  }
  if (candidate.source.type === "direct") {
    if (item.assignee !== undefined) {
      throw new StorageRecordError(`${label} cannot be direct for an assigned Work Item.`);
    }
    if (candidate.workspace !== undefined
      && (candidate.workspace.owner.type !== "work-item"
        || candidate.workspace.owner.taskId !== item.taskId
        || candidate.workspace.owner.workItemId !== item.id)) {
      throw new StorageRecordError(`${label} must use the WorkItem-owned Develop workspace.`);
    }
    if (candidate.taskMainSnapshot !== undefined) {
      const expectedProjects = [...item.writeProjectIds].sort();
      const actualProjects = candidate.taskMainSnapshot.projects
        .map(({ projectId }) => projectId)
        .sort();
      if (!isDeepStrictEqual(actualProjects, expectedProjects)) {
        throw new StorageRecordError(`${label} Task-main snapshot scope is stale.`);
      }
      for (const project of candidate.taskMainSnapshot.projects) {
        const binding = aggregate.task.projectBindings.find(
          ({ projectId }) => projectId === project.projectId
        );
        if (binding === undefined || binding.directory !== project.directory) {
          throw new StorageRecordError(
            `${label} Task-main snapshot Project is not bound: ${project.projectId}.`
          );
        }
      }
    }
    return;
  }
  const run = aggregate.agentRuns[candidate.source.runId];
  const resolvedGroupSummary = candidate.executionGroupId === undefined
    ? undefined
    : workItemExecutionGroupById(item, candidate.executionGroupId)?.resolution?.summary;
  if (run === undefined
    || run.workItemId !== item.id
    || run.purpose !== "execution"
    || run.status !== "yielded"
    || (run.summary !== candidate.summary && resolvedGroupSummary !== candidate.summary)) {
    throw new StorageRecordError(`${label} Run is invalid: ${candidate.source.runId}.`);
  }
  if (candidate.executionGroupId !== run.executionGroupId
    || candidate.executionLaneId !== run.executionLaneId) {
    throw new StorageRecordError(`${label} execution lineage does not match its source Run.`);
  }
  // A Gitless execution Run still carries its durable Task-owned empty view
  // for runtime fencing, while its Candidate intentionally has no Develop
  // workspace or Git snapshot. This is the only source/run workspace
  // mismatch permitted at the storage boundary.
  const gitlessRunWorkspace = run.workspace?.owner.type === "task"
    && run.workspace.owner.taskId === item.taskId
    && aggregate.task.projectBindings.length === 0
    && run.workspace.entries.length === 0
    && (() => {
      const durable = aggregate.managedWorkspaces[managedWorkspaceKey(run.workspace!.owner)];
      return durable !== undefined && isDeepStrictEqual(durable, run.workspace);
    })();
  if (!gitlessRunWorkspace
    && (candidate.workspace === undefined) !== (run.workspace === undefined)) {
    throw new StorageRecordError(`${label} workspace does not match its source Run.`);
  }
  if (!gitlessRunWorkspace && candidate.workspace !== undefined && run.workspace !== undefined) {
    assertCandidateWorkspaceMatchesRun(candidate.workspace, run.workspace, label);
  }
  if (candidate.workspace !== undefined && (
    candidate.workspace.owner.type !== "work-item"
    || candidate.workspace.owner.taskId !== item.taskId
    || candidate.workspace.owner.workItemId !== item.id
  )) {
    throw new StorageRecordError(`${label} must use the WorkItem-owned Develop workspace.`);
  }
}

function assertAgentRunExecutionReferences(
  aggregate: StoredTask,
  run: AgentRun
): void {
  if ((run.executionGroupId === undefined) !== (run.executionLaneId === undefined)) {
    throw new StorageRecordError(`Agent Run execution lineage is incomplete: ${run.id}.`);
  }
  if (run.executionGroupId === undefined) return;
  const ownerGroup = run.purpose === "review"
    ? (run.reviewRoundId === undefined
      ? undefined
      : aggregate.reviewRounds[run.reviewRoundId]?.executionGroup)
    : (run.workItemId === undefined || run.executionGroupId === undefined
      ? undefined
      : (() => {
          const item = aggregate.workItems[run.workItemId];
          return item === undefined
            ? undefined
            : workItemExecutionGroupById(item, run.executionGroupId!);
        })());
  if (ownerGroup === undefined) {
    throw new StorageRecordError(`Agent Run ExecutionGroup not found: ${run.id}.`);
  }
  validateExecutionGroup(ownerGroup);
  const lane = ownerGroup.lanes.find(({ id }) => id === run.executionLaneId);
  if (ownerGroup.id !== run.executionGroupId || lane === undefined) {
    throw new StorageRecordError(`Agent Run ExecutionLane does not match its owner: ${run.id}.`);
  }
  if (lane.roleName !== run.roleName) {
    throw new StorageRecordError(`Agent Run Role does not match its ExecutionLane: ${run.id}.`);
  }
}

function compatibleExecutionGroups(
  existing: ExecutionGroup | undefined,
  candidate: ExecutionGroup | undefined
): boolean {
  if (existing === undefined) return true;
  if (candidate === undefined) return false;
  return isExecutionGroupTransition(existing, candidate);
}

/** Candidate freezes Git commits at yield time, so timestamp/baseCommit fields
 * may differ from the Run's dispatch snapshot while workspace identity and
 * execution scope must remain exact. */
function assertCandidateWorkspaceMatchesRun(
  candidate: ManagedWorkspace,
  run: ManagedWorkspace,
  label: string
): void {
  if (candidate.owner.type === "work-item" && run.owner.type === "execution-lane") {
    if (candidate.owner.taskId !== run.owner.taskId
      || run.owner.purpose !== "execution"
      || candidate.owner.workItemId !== run.owner.workItemId
      || candidate.entries.length !== run.entries.length) {
      throw new StorageRecordError(`${label} workspace lineage does not match its source Lane.`);
    }
    for (const source of run.entries) {
      const target = candidate.entries.find(({ projectId }) => projectId === source.projectId);
      if (target === undefined || target.directory !== source.directory || target.access !== source.access) {
        throw new StorageRecordError(`${label} workspace Project scope does not match its source Lane.`);
      }
    }
    return;
  }
  if (
    candidate.owner.type !== run.owner.type
    || candidate.owner.taskId !== run.owner.taskId
    || candidate.root !== run.root
    || candidate.entries.length !== run.entries.length
  ) {
    throw new StorageRecordError(`${label} workspace does not match its source Run.`);
  }
  for (const source of run.entries) {
    const frozen = candidate.entries.find(({ projectId }) => projectId === source.projectId);
    if (
      frozen === undefined
      || frozen.directory !== source.directory
      || frozen.access !== source.access
      || frozen.path !== source.path
      || frozen.branch !== source.branch
      || frozen.baseRef !== source.baseRef
    ) {
      throw new StorageRecordError(`${label} workspace scope does not match its source Run.`);
    }
  }
}

function validReviewRoundTransition(
  existing: ReviewRound,
  candidate: ReviewRound
): boolean {
  if (isDeepStrictEqual(existing, candidate)) return true;
  if (
    existing.id !== candidate.id
    || existing.taskId !== candidate.taskId
    || existing.workItemId !== candidate.workItemId
    || existing.candidateId !== candidate.candidateId
    || existing.reviewerRoleName !== candidate.reviewerRoleName
    || existing.reviewBaseCommit !== candidate.reviewBaseCommit
    || (existing.scope ?? "work-item") !== (candidate.scope ?? "work-item")
    || !isDeepStrictEqual(existing.taskCandidate, candidate.taskCandidate)
    || !sameTaskFinalReviewContract(
      existing.taskFinalReviewContract,
      candidate.taskFinalReviewContract
    )
    || !compatibleExecutionGroups(existing.executionGroup, candidate.executionGroup)
    // Issue 06: a Leader retry resets a failed Task-final Round to pending;
    // the retry is itself a Leader request, so requestedBy may change from
    // the original policy/contract value to "leader".
    || (existing.requestedBy !== candidate.requestedBy
      && !(existing.status === "failed"
        && candidate.status === "pending"
        && (candidate.scope ?? "work-item") === "task"))
    || existing.createdAt !== candidate.createdAt
  ) return false;
  if (existing.status === "pending") {
    if (candidate.status === "pending") {
      return (existing.workspace === undefined
        && candidate.workspace !== undefined
        || existing.executionGroup === undefined
        && candidate.executionGroup !== undefined
        || existing.executionGroup !== undefined
        && candidate.executionGroup !== undefined
        && !isDeepStrictEqual(existing.executionGroup, candidate.executionGroup))
        && candidate.reviewerRunId === undefined
        && candidate.summary === undefined
        && candidate.checks === undefined
        && candidate.evidenceCommit === undefined
        && candidate.endedAt === undefined
        && candidate.workspaceDisposition === undefined;
    }
    return ["running", "failed"].includes(candidate.status)
      && (existing.workspace === undefined
        || isDeepStrictEqual(existing.workspace, candidate.workspace));
  }
  if (existing.status === "running") {
    if (candidate.status === "running") {
      return existing.reviewerRunId === candidate.reviewerRunId
        && isDeepStrictEqual(existing.workspace, candidate.workspace)
        && existing.executionGroup !== undefined
        && candidate.executionGroup !== undefined
        && !isDeepStrictEqual(existing.executionGroup, candidate.executionGroup)
        && candidate.summary === undefined
        && candidate.report === undefined
        && candidate.checks === undefined
        && candidate.evidenceCommit === undefined
        && candidate.endedAt === undefined
        && candidate.workspaceDisposition === undefined;
    }
    return ["completed", "failed"].includes(candidate.status)
      && existing.reviewerRunId === candidate.reviewerRunId
      && isDeepStrictEqual(existing.workspace, candidate.workspace);
  }
  // Issue 06: a failed Task-final execution attempt may be reset to pending
  // under the same semantic Round ID. AgentRun history remains the attempt
  // trail; terminal Review metadata is cleared by retryTaskReviewRound.
  if (existing.status === "failed"
    && candidate.status === "pending"
    && (candidate.scope ?? "work-item") === "task") {
    return candidate.reviewerRunId === undefined
      && candidate.summary === undefined
      && candidate.report === undefined
      && candidate.checks === undefined
      && candidate.evidenceCommit === undefined
      && candidate.endedAt === undefined
      && candidate.workspaceDisposition === undefined
      && (existing.workspace === undefined
        || candidate.workspace === undefined
        || isDeepStrictEqual(existing.workspace, candidate.workspace))
      && compatibleExecutionGroups(
        existing.executionGroup,
        candidate.executionGroup
      );
  }
  if (existing.status === candidate.status
    && (existing.status === "completed" || existing.status === "failed")) {
    const {
      workspaceDisposition: _existingDisposition,
      ...existingResult
    } = existing;
    const {
      workspaceDisposition: _candidateDisposition,
      ...candidateResult
    } = candidate;
    return isDeepStrictEqual(existingResult, candidateResult)
      && existing.workspaceDisposition?.kind !== "removed"
      && candidate.workspaceDisposition !== undefined;
  }
  return false;
}
function synchronousResult<T>(value: T): T { if (typeof value === "object" && value !== null && "then" in value) throw new StorageRecordError("FileTaskStore transactions must be synchronous."); return value; }

function acquireStorageLock(rootDir: string): () => void {
  ensureYuiHome(rootDir);
  const lock = join(rootDir, STORAGE_LOCK_DIRECTORY);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner"), `${process.pid}\n`, { mode: 0o600 });
      return () => { rmSync(lock, { recursive: true, force: true }); };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      reclaimDeadLock(lock);
      if (Date.now() >= deadline) throw new StorageConflictError(`Timed out waiting for storage lock: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}

/**
 * Run `execute` while holding the same storage write lock the store uses, without
 * the version-gated {@link FileTaskStore} constructor. The upgrade orchestrator
 * uses this to re-pin the committed revision under the lock against a source Home
 * whose schema is not the current version (so a store cannot be constructed yet).
 */
export function withStorageWriteLock<T>(rootDir: string, execute: () => T): T {
  const release = acquireStorageLock(rootDir);
  try {
    return execute();
  } finally {
    release();
  }
}
function reclaimDeadLock(lock: string): void {
  try {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < 1_000) return;
    const pid = Number.parseInt(readFileSync(join(lock, "owner"), "utf8"), 10);
    if (Number.isInteger(pid) && processIsAlive(pid)) return;
    rmSync(lock, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return;
  }
}
function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; } }
