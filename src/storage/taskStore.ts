import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConfiguredAgent } from "../agent/agent.js";
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
  validatePublicationReference,
  type PublicationReference
} from "../task/publicationReference.js";
import {
  reconciliationIntervalMilliseconds,
  resolveAgentLaunchInactivityTimeoutSeconds,
  resolveControllerTaskConcurrency,
  resolveDeliveryTimeoutSeconds,
  resolveLeaderNextActionMode,
  resolveLeaderSemanticBudgetTurns,
  resolveResourcesGcAutoQuarantine,
  resolveResourcesGcMode,
  resolveResourcesQuarantineTtlHours,
  resolveRuntimeHealth,
  resolveTelemetryEnabled,
  resolveTelemetryTurnCap,
  resolveTelemetryTerminalKeep,
  resolveTmuxBin,
  resolveTmuxHistoryLimit
} from "../config/yuiConfig.js";
import { resolveTimeZone } from "../output/timePresentation.js";
import type { MailboxTarget, WorkMailbox } from "../coordination/workMailbox.js";
import type { Decision } from "../decision/decision.js";
import type { ContextSnapshot } from "../context/contextSnapshot.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { InputRequest } from "../input/inputRequest.js";
import {
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import type { TaskMessage } from "../message/message.js";
import type { Milestone } from "../milestone/milestone.js";
import type { Turn } from "../turn/turn.js";
import type { RuntimeOwner } from "../runtime/runtimeOwner.js";
import {
  type RuntimeSessionCandidate,
  type RuntimeSessionCandidateQuery
} from "../runtime/runtimeSessionCandidate.js";
import type { SessionOwnerIdentity } from "../runtime/sessionOwnerIdentity.js";
import {
  validateReviewConfig,
  type ReviewConfig
} from "../review/reviewConfig.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { ReviewFinding } from "../review/reviewFinding.js";
import type { Project, ProjectReferenceSummary } from "../repository/project.js";
import type { HomeIdentity } from "../repository/homeIdentity.js";
import type { AgentProfile } from "../profile/agentProfile.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { IntegrationQueueEntry } from "../integration/integrationQueueEntry.js";
import type { DurableJob } from "../job/durableJob.js";
import type { GlobalRole, TaskRole } from "../role/role.js";
import type { LeaderFailure } from "../scheduler/leaderFailure.js";
import type { PendingWakeup } from "../scheduler/pendingWakeup.js";
import type { TaskWake } from "../scheduler/taskWake.js";
import type { Task } from "../task/task.js";
import type { NextActionFacts } from "../task/nextAction.js";
import type { CompletionReadinessFacts } from "../task/completionReadiness.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { ManagedWorkspace, ManagedWorkspaceOwner } from "../worktree/managedWorkspace.js";
import {
  type GateArtifact,
  type GateArtifactIdentity,
  type GateArtifactPruneOptions,
  type GateArtifactPruneResult
} from "../verification/gateArtifact.js";

export const CURRENT_CONFIG_SCHEMA_VERSION = 6 as const;
/** Current SQLite payload-family versions owned by this storage boundary. */
export const CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION = 2 as const;
export const CURRENT_PROJECT_SCHEMA_VERSION = 5 as const;
export const CURRENT_AGENT_PROFILE_SCHEMA_VERSION = 2 as const;
export const CURRENT_GLOBAL_ROLE_SCHEMA_VERSION = 3 as const;
export const CURRENT_GLOBAL_ROLE_SESSION_SET_SCHEMA_VERSION = 4 as const;
export const CURRENT_TASK_SCHEMA_VERSION = 6 as const;
export const CURRENT_TASK_BRIEF_SCHEMA_VERSION = 2 as const;
export const CURRENT_CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CURRENT_TASK_ROLE_SCHEMA_VERSION = 4 as const;
export const CURRENT_MANAGED_WORKSPACE_SCHEMA_VERSION = 2 as const;
export const CURRENT_WORK_ITEM_SCHEMA_VERSION = 14 as const;
export const CURRENT_REVIEW_ROUND_SCHEMA_VERSION = 6 as const;
export const CURRENT_CHANGE_SET_SCHEMA_VERSION = 4 as const;
export const CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION = 5 as const;
export const CURRENT_MESSAGE_SCHEMA_VERSION = 3 as const;
export const CURRENT_INPUT_REQUEST_SCHEMA_VERSION = 3 as const;
export const CURRENT_DECISION_SCHEMA_VERSION = 1 as const;
export const CURRENT_MILESTONE_SCHEMA_VERSION = 2 as const;
export const CURRENT_EVENT_SCHEMA_VERSION = 2 as const;
export const CURRENT_CAPABILITY_GRANT_SCHEMA_VERSION = 2 as const;
export const CURRENT_RELEASE_WORKFLOW_SCHEMA_VERSION = 1 as const;
export const CURRENT_WORK_MAILBOX_SCHEMA_VERSION = 5 as const;
export const CURRENT_PUBLICATION_REFERENCE_SCHEMA_VERSION = 1 as const;
export const CURRENT_PENDING_WAKEUP_SCHEMA_VERSION = 1 as const;
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = typeof COMPLETION_SHELLS[number];
export type CompletionInstallation = Readonly<{
  scriptPath: string;
  activationPath: string;
}>;
export type YuiConfig = Readonly<{
  schemaVersion: typeof CURRENT_CONFIG_SCHEMA_VERSION;
  defaultAgent?: string;
  defaultWorkspace?: string;
  timeZone?: string;
  currentTaskId?: string;
  lastTaskId?: string;
  reconciliationIntervalSeconds?: number;
  /**
   * Resource GC mode (Issue 10). `report` (default) only reports candidates;
   * `quarantine` allows `yui resources gc --apply` to quarantine releasable
   * resources. Permanent deletion is always delayed behind the observation
   * window.
   */
  resourcesGcMode?: "report" | "quarantine";
  /**
   * Whether the Controller may automatically quarantine resources for
   * terminal Tasks (Issue 10). Defaults to false; permanent deletion is
   * always manual and delayed.
   */
  resourcesGcAutoQuarantine?: boolean;
  review?: ReviewConfig;
  /**
   * Issue 07 (Leader convergence) feature mode. An omitted value resolves to
   * `display` within the current config contract.
   */
  leaderNextActionMode?: "display" | "warn" | "enforce";
  runtimeHealth?: import("../config/yuiConfig.js").RuntimeHealthConfig;
  controllerTaskConcurrency?: number;
  agentLaunchInactivityTimeoutSeconds?: number;
  deliveryTimeoutSeconds?: number;
  leaderSemanticBudgetTurns?: number;
  resourcesQuarantineTtlHours?: number;
  /**
   * Path to the tmux binary. Defaults to `tmux` on PATH.
   */
  tmuxBin?: string;
  tmuxHistoryLimit?: number;
  /** Whether optional diagnostic telemetry is active. */
  telemetryEnabled?: boolean;
  /** Terminal Turn/generation progress rows retained after prune. */
  telemetryTerminalKeep?: number;
  /** Hard cap of progress rows per Turn while it is still active. */
  telemetryTurnCap?: number;
  completionInstallations?: Partial<Record<CompletionShell, CompletionInstallation>>;
}>;
export type ConfiguredAgentPatch = Readonly<Partial<
  Pick<ConfiguredAgent, "adapterId" | "command" | "baseArgs" | "environment">
>>;
export type ConfiguredAgentUpdateResult = Readonly<{
  status: "updated" | "unchanged";
  agent: ConfiguredAgent;
}>;

/**
 * Lane-scoped active pointers live beside Role pointers. The
 * namespace starts with a slash because Role identities reject slashes; this
 * makes the two key spaces disjoint even for legal Role names such as
 * `lane:worker:1`.
 */
export function executionLaneActiveTurnKey(
  executionGroupId: string,
  executionLaneId: string
): string {
  return `/execution-lane/${encodeLaneKeyPart(executionGroupId)}:${encodeLaneKeyPart(executionLaneId)}`;
}

function encodeLaneKeyPart(value: string): string {
  return encodeURIComponent(value).replace(/:/gu, "%3A");
}

export function executionLaneActiveTurnKeyParts(key: string):
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

/**
 * Nested-record versions consumed by the current SQLite payload validators.
 */
export const CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION = 11 as const;
export const CURRENT_TURN_SCHEMA_VERSION = 3 as const;
export const CURRENT_INTEGRATION_QUEUE_SCHEMA_VERSION = 1 as const;
export type TaskStore = {
  rootDirectory(): string;
  transaction<T>(execute: (store: TaskStore) => T): T;
  /**
   * Runs a Controller runtime-inbox fold as one aggregate transaction.  The
   * named seam lets the processor batch independent durable facts without
   * depending on a concrete storage implementation.
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
  /**
   * Project reference projection for the lifecycle fail-closed gates: every
   * Task binding a Project (including historical), the subset still active,
   * and the unresolved delivery (Work Items, Turns, Integration
   * Attempts) inside those active Tasks.
   */
  summarizeProjectReferences(projectId: string): ProjectReferenceSummary;
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
  /** Active Task ids only; production SQLite uses its bounded catalog index. */
  listActiveTaskIds(): string[];
  /** Current durable state revision; advances once per committed mutation. */
  getStateRevision(): number;
  getTask(id: string): Task | null;
  /**
   * Issue 07 (Leader convergence): load exactly the records the next-action
   * projection consumes, filtered at the storage boundary (open Inputs,
   * active/leader Turns). Returns null when the Task does not exist.
   */
  readNextActionFacts(taskId: string): NextActionFacts | null;
  /**
   * Issue 06 (Task terminalization readiness): load the full record set the
   * completion readiness projection consumes, including managed workspaces,
   * DurableJobs, integration queue entries, Review findings, and the event
   * fold. Returns null when the Task does not exist.
   */
  readCompletionReadinessFacts(taskId: string): CompletionReadinessFacts | null;
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
  /** Jobs that still require Controller supervision, across all Tasks. */
  listActiveDurableJobs(): DurableJob[];
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
  /** Current non-stopped Role Sessions; production SQLite reads a bounded hot projection. */
  listRuntimeSessionCandidates(query?: RuntimeSessionCandidateQuery): RuntimeSessionCandidate[];
  /** Pending native Turn completions from the independent bounded hot projection. */
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
  nextContextSnapshotId(taskId: string): string;
  getContextSnapshot(taskId: string, snapshotId: string): ContextSnapshot | null;
  listContextSnapshots(taskId: string): ContextSnapshot[];
  saveContextSnapshot(snapshot: ContextSnapshot): void;
  nextTurnId(taskId: string): string;
  peekNextTurnId(taskId: string): string;
  getTurn(taskId: string, turnId: string): Turn | null;
  listTurns(taskId: string): Turn[];
  saveTurn(turn: Turn): void;
  nextReviewRoundId(taskId: string): string;
  getReviewRound(taskId: string, reviewRoundId: string): ReviewRound | null;
  listReviewRounds(taskId: string): ReviewRound[];
  saveReviewRound(taskId: string, round: ReviewRound): void;
  nextReviewFindingId(taskId: string): string;
  getReviewFinding(taskId: string, reviewFindingId: string): ReviewFinding | null;
  listReviewFindings(taskId: string): ReviewFinding[];
  saveReviewFinding(taskId: string, finding: ReviewFinding): void;
  getActiveTurn(taskId: string, roleName: string): Turn | null;
  saveActiveTurn(turn: Turn): void;
  clearActiveTurn(taskId: string, roleName: string): void;
  getActiveExecutionLaneTurn(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): Turn | null;
  saveActiveExecutionLaneTurn(turn: Turn): void;
  clearActiveExecutionLaneTurn(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): void;
  nextMessageId(taskId: string): string;
  saveMessage(taskId: string, message: TaskMessage): void;
  updateMessage(taskId: string, message: TaskMessage): void;
  listMessages(taskId: string): TaskMessage[];
  nextInputRequestId(taskId: string): string;
  saveInputRequest(taskId: string, request: InputRequest): void;
  getInputRequest(taskId: string, requestId: string): InputRequest | null;
  listInputRequests(taskId: string): InputRequest[];
  /** Open requests only; production SQLite uses the bounded partial index. */
  listOpenInputRequests(taskIds?: readonly string[]): InputRequest[];
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
  nextTaskWakeId(taskId: string): string;
  peekNextTaskWakeId(taskId: string): string;
  saveTaskWake(taskId: string, wake: TaskWake): void;
  getTaskWake(taskId: string, wakeId: string): TaskWake | null;
  listTaskWakes(taskId: string): TaskWake[];
  /**
   * Remove telemetry-source events after their progress facts have been folded
   * into the bounded telemetry store. Returns the number actually removed.
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
  nextPublicationReferenceId(taskId: string): string;
  savePublicationReference(taskId: string, reference: PublicationReference): void;
  listPublicationReferences(taskId: string): PublicationReference[];
  getPublicationReference(taskId: string, referenceId: string): PublicationReference | null;
  findPublicationReferenceByExternalKey(externalKey: string): PublicationReference | null;
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
  /** Mailboxes with processing or pending work, in mailbox target-key order. */
  listReadyWorkMailboxes(): WorkMailbox[];
  saveWorkMailbox(mailbox: WorkMailbox): void;
  removeWorkMailbox(target: MailboxTarget): boolean;
  /** Leader wake aggregation projection over its Role WorkMailbox. */
  getPendingWakeup(taskId: string): PendingWakeup | null;
  listPendingWakeups(): PendingWakeup[];
  savePendingWakeup(wakeup: PendingWakeup): void;
  clearPendingWakeup(taskId: string): void;
  getLeaderFailure(taskId: string): LeaderFailure | null;
  saveLeaderFailure(failure: LeaderFailure): void;
  clearLeaderFailure(taskId: string): void;
};

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
  const requested = env.YUI_HOME === undefined || env.YUI_HOME.length === 0
    ? join(homedir(), ".yui")
    : resolve(env.YUI_HOME);
  return canonicalizeYuiHome(requested);
}
export function ensureYuiHome(rootDir: string): void { mkdirSync(rootDir, { recursive: true, mode: 0o700 }); }

/**
 * YUI_HOME is a runtime identity, not only a storage path. Resolve every
 * existing symlink component before Controller/tmux namespaces or exact
 * descriptors derive identity from it. A Home may not exist before `setup`,
 * so retain proven-missing trailing components below the longest existing
 * physical ancestor. Existing-but-unresolvable paths fail closed.
 */
function canonicalizeYuiHome(value: string): string {
  const absolute = resolve(value);
  let current = absolute;
  const trailing: string[] = [];
  for (;;) {
    try {
      const physical = realpathSync(current);
      return trailing.length === 0 ? physical : join(physical, ...trailing);
    } catch (realpathError) {
      if (!isErrno(realpathError, "ENOENT")) {
        throw unstableYuiHome(absolute, realpathError);
      }
      try {
        lstatSync(current);
      } catch (lstatError) {
        if (!isErrno(lstatError, "ENOENT")) {
          throw unstableYuiHome(absolute, lstatError);
        }
        const parent = dirname(current);
        if (parent === current) return absolute;
        trailing.unshift(basename(current));
        current = parent;
        continue;
      }
      throw unstableYuiHome(absolute, realpathError);
    }
  }
}

function unstableYuiHome(path: string, cause: unknown): Error {
  return new Error(
    `YUI_HOME cannot be resolved to a stable physical path: ${path}.`,
    { cause }
  );
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export function validateYuiConfig(config: YuiConfig): void {
  try {
    const optionalFields = [
      "defaultAgent",
      "defaultWorkspace",
      "timeZone",
      "currentTaskId",
      "lastTaskId",
      "reconciliationIntervalSeconds",
      "resourcesGcMode",
      "resourcesGcAutoQuarantine",
      "review",
      "leaderNextActionMode",
      "runtimeHealth",
      "controllerTaskConcurrency",
      "agentLaunchInactivityTimeoutSeconds",
      "deliveryTimeoutSeconds",
      "leaderSemanticBudgetTurns",
      "resourcesQuarantineTtlHours",
      "tmuxBin",
      "tmuxHistoryLimit",
      "telemetryEnabled",
      "telemetryTerminalKeep",
      "telemetryTurnCap",
      "completionInstallations"
    ] as const satisfies readonly (Exclude<keyof YuiConfig, "schemaVersion">)[];
    exact(
      config as unknown as Record<string, unknown>,
      [
        "schemaVersion",
        ...optionalFields.filter((field) => config[field] !== undefined)
      ],
      "Yui config"
    );
    if (config.schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION) {
      throw new TypeError(
        `Yui config must use schemaVersion ${CURRENT_CONFIG_SCHEMA_VERSION}.`
      );
    }
    reconciliationIntervalMilliseconds(config.reconciliationIntervalSeconds);
    resolveTimeZone(config.timeZone);
    if (config.review !== undefined) validateReviewConfig(config.review);
    resolveLeaderNextActionMode(config.leaderNextActionMode);
    resolveResourcesGcMode(config.resourcesGcMode);
    resolveResourcesGcAutoQuarantine(config.resourcesGcAutoQuarantine);
    resolveResourcesQuarantineTtlHours(config.resourcesQuarantineTtlHours);
    resolveRuntimeHealth(config.runtimeHealth);
    resolveControllerTaskConcurrency(config.controllerTaskConcurrency);
    resolveAgentLaunchInactivityTimeoutSeconds(config.agentLaunchInactivityTimeoutSeconds);
    resolveDeliveryTimeoutSeconds(config.deliveryTimeoutSeconds);
    resolveLeaderSemanticBudgetTurns(config.leaderSemanticBudgetTurns);
    resolveTmuxBin(config.tmuxBin);
    resolveTmuxHistoryLimit(config.tmuxHistoryLimit);
    resolveTelemetryEnabled(config.telemetryEnabled);
    resolveTelemetryTerminalKeep(config.telemetryTerminalKeep);
    resolveTelemetryTurnCap(config.telemetryTurnCap);
  } catch (error) {
    throw new StorageRecordError(
      error instanceof Error ? error.message : "Yui reconciliation interval is invalid."
    );
  }
}

export function storedCapabilityGrant(value: unknown): CapabilityGrant {
  const grant = versioned<CapabilityGrant>(
    value,
    CURRENT_CAPABILITY_GRANT_SCHEMA_VERSION,
    "Capability grant"
  );
  const fields = [
    "schemaVersion", "id", "taskId", "granter", "scope", "actions",
    "parameterBounds", "usesUsed", "useReservations", "irreversibilityCeiling",
    "createdAt", "updatedAt"
  ];
  if (grant.expiresAt !== undefined) fields.push("expiresAt");
  if (grant.maxUses !== undefined) fields.push("maxUses");
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
  existing: readonly string[],
  candidate: readonly string[]
): boolean {
  if (existing.length === 0) return true;
  if (candidate.length < existing.length) return false;
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

export function storedPublicationReference(value: unknown): PublicationReference {
  const reference = versioned<PublicationReference>(
    value,
    CURRENT_PUBLICATION_REFERENCE_SCHEMA_VERSION,
    "Publication reference"
  );
  const fields = [
    "schemaVersion", "id", "taskId", "projectId", "provider", "repository",
    "externalKind", "externalId", "state", "verification", "recordedBy",
    "source", "createdAt"
  ];
  if (reference.externalUrl !== undefined) fields.push("externalUrl");
  if (reference.title !== undefined) fields.push("title");
  if (reference.sourceBranch !== undefined) fields.push("sourceBranch");
  if (reference.targetBranch !== undefined) fields.push("targetBranch");
  if (reference.localCommit !== undefined) fields.push("localCommit");
  if (reference.remoteCommit !== undefined) fields.push("remoteCommit");
  if (reference.evidence !== undefined) fields.push("evidence");
  if (reference.supersedes !== undefined) fields.push("supersedes");
  if (reference.mergedAt !== undefined) fields.push("mergedAt");
  exact(reference as unknown as Record<string, unknown>, fields, "Publication reference");
  requireRecordIdentity(reference.id, "Publication reference id");
  requireRecordIdentity(reference.taskId, "Publication reference Task id");
  validateTaskRecordReference(
    { taskId: reference.taskId, localId: reference.id },
    "publicationReference"
  );
  requireRecordIdentity(reference.projectId, "Publication reference Project id");
  requireNormalizedText(reference.provider, "Publication reference provider");
  requireNormalizedText(reference.repository, "Publication reference repository");
  requireNormalizedText(reference.externalKind, "Publication reference external kind");
  requireNormalizedText(reference.externalId, "Publication reference external id");
  if (reference.externalUrl !== undefined) {
    requireNormalizedText(reference.externalUrl, "Publication reference external URL");
  }
  if (reference.title !== undefined) {
    requireNormalizedText(reference.title, "Publication reference title");
  }
  if (reference.sourceBranch !== undefined) {
    requireNormalizedText(reference.sourceBranch, "Publication reference source branch");
  }
  if (reference.targetBranch !== undefined) {
    requireNormalizedText(reference.targetBranch, "Publication reference target branch");
  }
  if (reference.localCommit !== undefined) {
    requireNormalizedText(reference.localCommit, "Publication reference local commit");
  }
  if (reference.remoteCommit !== undefined) {
    requireNormalizedText(reference.remoteCommit, "Publication reference remote commit");
  }
  requireNormalizedText(reference.state, "Publication reference state");
  requireNormalizedText(reference.verification, "Publication reference verification");
  if (reference.evidence !== undefined) {
    requireNormalizedText(reference.evidence, "Publication reference evidence");
  }
  if (reference.supersedes !== undefined) {
    requireNormalizedText(reference.supersedes, "Publication reference supersedes id");
  }
  requireNormalizedText(reference.recordedBy, "Publication reference recordedBy");
  requireNormalizedText(reference.source, "Publication reference source");
  if (reference.mergedAt !== undefined) {
    requireTimestamp(reference.mergedAt, "Publication reference mergedAt");
  }
  requireTimestamp(reference.createdAt, "Publication reference createdAt");
  try {
    return validatePublicationReference(reference);
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

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new StorageRecordError(`${label} is invalid.`);
  }
  return value;
}

function versioned<T>(value: unknown, schemaVersion: number, label: string): T {
  assertJsonValue(value, label);
  const record = object(value, label);
  if (record.schemaVersion !== schemaVersion) throw new StorageRecordError(`${label} must use schemaVersion ${schemaVersion}.`);
  return clone(record) as T;
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
export function pendingWakeupProjection(mailbox: WorkMailbox | null): PendingWakeup | null {
  const pending = mailbox?.processing?.owner.startsWith("leader-steer:") === true
    ? mailbox.processing.batch
    : mailbox?.pending ?? null;
  if (mailbox === null || mailbox.target.kind !== "role" || mailbox.target.roleName !== "leader"
    || pending === null) {
    return null;
  }
  return {
    schemaVersion: CURRENT_PENDING_WAKEUP_SCHEMA_VERSION,
    taskId: mailbox.target.taskId,
    reasons: [...pending.reasons],
    requestCount: pending.requestCount,
    firstRequestedAt: pending.firstQueuedAt,
    lastRequestedAt: pending.lastQueuedAt
  };
}
