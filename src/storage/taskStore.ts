import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import type { TaskComment } from "../comment/comment.js";
import type { Milestone } from "../milestone/milestone.js";
import type { Decision } from "../decision/decision.js";
import type { Cycle } from "../cycle/cycle.js";
import { dataError, usageError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  activeRoleAgentSession,
  type GlobalRoleSessionSet,
  type NativeSessionIdentity,
  type RoleAgentSession,
  roleAgentSessionIdentities,
  type RoleSessionOwner,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  isCanonicalNativeSessionId,
  isCanonicalNativeSessionRoot
} from "../executor/nativeSessionIdentity.js";
import {
  assertRuntimeOperationAllowsMutation,
  listRuntimeOperationClaims
} from "../executor/roleRuntimeOperationClaim.js";
import type { TaskInputDraft } from "../input/taskInput.js";
import type { InputRequest, InputResolution } from "../input/inputRequest.js";
import { isInputRequestRecord, isInputResolutionRecord } from "../input/inputRecordCodec.js";
import type { OperatorDelivery } from "../operator/operatorDelivery.js";
import { isOperatorDelivery } from "../operator/operatorDelivery.js";
import type { GlobalRole, Role } from "../role/role.js";
import type { ChildRole } from "../role/childRole.js";
import type { AgentRun } from "../run/agentRun.js";
import {
  createConfiguredAgent,
  isProbeExecutablePin,
  type ConfiguredAgent,
  type EnvironmentBinding,
  type ProbeExecutablePin
} from "../agent/agent.js";
import { pendingWakeupsMatch, type PendingWakeup } from "../scheduler/pendingWakeup.js";
import type { OfflineResolutionClock } from "../scheduler/offlineResolutionClock.js";
import { isOfflineResolutionClock } from "../scheduler/offlineResolutionClock.js";
import type { InputResolutionWakeup } from "../scheduler/inputResolutionWakeup.js";
import { isInputResolutionWakeup } from "../scheduler/inputResolutionWakeup.js";
import type { LeaderFailure } from "../scheduler/leaderFailure.js";
import type { OperatorNotification } from "../scheduler/operatorNotification.js";
import type { TaskSchedule } from "../scheduler/taskSchedule.js";
import type { Task } from "../task/task.js";
import { emptyTaskTopics, type TaskTopics } from "../topic/topic.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { RoleWorktree } from "../worktree/worktree.js";
import { taskRecordCodec } from "./taskRecordCodec.js";
import {
  isSafeStorageSegment,
  sessionSetMatchesRole,
  snapshotConfiguredAgentRecord,
  snapshotGlobalRoleRecord,
  snapshotGlobalRoleSessionSetRecord,
  snapshotTaskRoleRecord,
  snapshotTaskRoleSessionSetRecord
} from "./recordValidation.js";
import {
  createConfiguredSkillRecord,
  isConfiguredSkillId,
  snapshotConfiguredSkillRecord,
  type ConfiguredSkill
} from "./configuredSkill.js";
import {
  hasExactOwnKeys,
  lowerUnknownInertData,
  stringifyCanonicalInertData
} from "./inertData.js";
import { hasNoSurroundingWhitespace } from "./stringValidation.js";
import {
  executeDomainReadSnapshot,
  executeDomainTransaction,
  hasActiveDomainTransactionAuthority
} from "./domainTransaction.js";
import type { NativePinnedRootReader } from "./nativeStorageFs.js";
import { writeRecoverableSnapshot } from "./recoveryJournal.js";
import { writeTextFileAtomically } from "./durableFile.js";

const INPUT_POINTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PINNED_READ_BYTES = 64 * 1024 * 1024;
const DIRECTORY_MODE = 0o040000n;
const REGULAR_FILE_MODE = 0o100000n;
const FILE_TYPE_MASK = 0o170000n;
const activeTaskReaderGrants = new WeakMap<TaskReader, { backing: FileTaskStore }>();
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const isProxy = utilTypes.isProxy;

export type ConfiguredAgentUpdateResult = {
  status: "updated" | "unchanged";
  agent: ConfiguredAgent;
};

export type GlobalNativeSessionIdentityOwner = {
  scope: "global";
  roleName: string;
  agentId: string;
};

export type TaskNativeSessionIdentityOwner = {
  scope: "task";
  taskId: string;
  roleName: string;
  agentId: string;
};

export type NativeSessionIdentityOwner =
  | GlobalNativeSessionIdentityOwner
  | TaskNativeSessionIdentityOwner;

export type NativeSessionIdentityClaim =
  | { state: "owned"; owner: NativeSessionIdentityOwner }
  | { state: "retired" };

type NativeSessionIdentityLedger = {
  schemaVersion: 3;
  identities: Record<string, NativeSessionIdentityClaim>;
};

export type ConfiguredAgentPatch = {
  adapterId?: string;
  command?: string;
  baseArgs?: string[];
  environment?: EnvironmentBinding[];
  probePin?: ProbeExecutablePin | null;
  probePinRefreshRequired?: true | null;
};

export type TaskStore = {
  rootDirectory(): string;
  runReadSnapshot<T>(execute: (reader: TaskReader) => T): T;
  getConfig(): TaskmuxConfig;
  saveConfig(config: TaskmuxConfig): void;
  nextTaskId(): string;
  saveTask(task: Task): void;
  deleteTask(id: string): boolean;
  restoreTask(id: string): boolean;
  listTrashedTaskIds(): string[];
  readTrashedTask<T>(taskId: string, execute: (reader: TaskReader) => T): T | null;
  listTasks(): Task[];
  getTask(id: string): Task | null;
  getTaskTopics(taskId: string): TaskTopics;
  saveTaskTopics(taskId: string, topics: TaskTopics): void;
  getTaskInputDraft(taskId: string): TaskInputDraft | null;
  saveTaskInputDraft(taskId: string, draft: TaskInputDraft): void;
  clearTaskInputDraft(taskId: string): void;
  getInputRequest(taskId: string, requestId: string): InputRequest | null;
  listInputRequests(taskId: string): InputRequest[];
  saveInputRequest(request: InputRequest): void;
  getInputResolution(taskId: string, resolutionId: string): InputResolution | null;
  listInputResolutions(taskId: string): InputResolution[];
  saveInputResolution(resolution: InputResolution): void;
  getOperatorDelivery(deliveryId: string): OperatorDelivery | null;
  listOperatorDeliveries(): OperatorDelivery[];
  saveOperatorDelivery(delivery: OperatorDelivery): void;
  getOfflineResolutionClock(taskId: string, requestId: string): OfflineResolutionClock | null;
  listOfflineResolutionClocks(): OfflineResolutionClock[];
  saveOfflineResolutionClock(clock: OfflineResolutionClock): void;
  clearOfflineResolutionClock(taskId: string, requestId: string): void;
  clearAllOfflineResolutionClocks(): void;
  getInputResolutionWakeup(taskId: string, requestId: string): InputResolutionWakeup | null;
  listInputResolutionWakeups(): InputResolutionWakeup[];
  saveInputResolutionWakeup(wakeup: InputResolutionWakeup): void;
  clearInputResolutionWakeup(taskId: string, requestId: string): void;
  getPendingWakeup(taskId: string): PendingWakeup | null;
  savePendingWakeup(wakeup: PendingWakeup): void;
  listPendingWakeups(): PendingWakeup[];
  clearPendingWakeup(taskId: string): void;
  clearPendingWakeupIfUnchanged(expected: PendingWakeup): boolean;
  getLeaderFailure(taskId: string): LeaderFailure | null;
  saveLeaderFailure(failure: LeaderFailure): void;
  clearLeaderFailure(taskId: string): void;
  getOperatorNotification(taskId: string): OperatorNotification | null;
  saveOperatorNotification(notification: OperatorNotification): void;
  clearOperatorNotification(taskId: string): void;
  getTaskSchedule(taskId: string): TaskSchedule | null;
  saveTaskSchedule(taskId: string, schedule: TaskSchedule): void;
  nextCycleId(taskId: string): string;
  getCycle(taskId: string, cycleId: string): Cycle | null;
  listCycles(taskId: string): Cycle[];
  saveCycle(taskId: string, cycle: Cycle): void;
  nextWorkItemId(taskId: string): string;
  getWorkItem(taskId: string, workItemId: string): WorkItem | null;
  listWorkItems(taskId: string): WorkItem[];
  saveWorkItem(taskId: string, workItem: WorkItem): void;
  getRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null;
  listRoleSessionSets(taskId: string): TaskRoleSessionSet[];
  listAllRoleSessionSets(): Array<GlobalRoleSessionSet | TaskRoleSessionSet>;
  nativeSessionIdentityClaims(): Map<string, NativeSessionIdentityClaim>;
  reconcileNativeSessionIdentityLedger(): void;
  mergeImportedNativeSessionIdentityClaims(imported: Record<string, NativeSessionIdentityClaim>): void;
  saveRoleSessionSet(sessionSet: TaskRoleSessionSet): void;
  getGlobalRoleSessionSet(roleName: string): GlobalRoleSessionSet | null;
  listGlobalRoleSessionSets(): GlobalRoleSessionSet[];
  saveGlobalRoleSessionSet(sessionSet: GlobalRoleSessionSet): void;
  getAgentSession(taskId: string, roleName: string): RoleAgentSession | null;
  nextAgentRunId(taskId: string): string;
  getAgentRun(taskId: string, runId: string): AgentRun | null;
  listAgentRuns(taskId: string): AgentRun[];
  saveAgentRun(run: AgentRun): void;
  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null;
  saveActiveAgentRun(run: AgentRun): void;
  clearActiveAgentRun(taskId: string, roleName: string): void;
  saveTaskBrief(taskId: string, markdown: string): void;
  readTaskBrief(taskId: string): string | null;
  appendTaskTopicSummary(taskId: string, markdown: string): void;
  readTaskTopicSummaries(taskId: string): string | null;
  appendTaskTimeline(taskId: string, markdown: string): void;
  readTaskTimeline(taskId: string): string | null;
  nextMilestoneId(taskId: string): string;
  getMilestone(taskId: string, milestoneId: string): Milestone | null;
  listMilestones(taskId: string): Milestone[];
  saveMilestone(taskId: string, milestone: Milestone): void;
  nextDecisionId(taskId: string): string;
  getDecision(taskId: string, decisionId: string): Decision | null;
  listDecisions(taskId: string): Decision[];
  saveDecision(taskId: string, decision: Decision): void;
  saveRoleWorktree(taskId: string, worktree: RoleWorktree): void;
  getRoleWorktree(taskId: string, roleName: string): RoleWorktree | null;
  listRoleWorktrees(taskId: string): RoleWorktree[];
  removeRoleWorktree(taskId: string, roleName: string): void;
  saveRole(taskId: string, role: Role): void;
  saveRoleWithSessionSet(
    taskId: string,
    role: Role,
    sessionSet: TaskRoleSessionSet | null,
    allowMonotonicImport?: boolean
  ): void;
  createRoleIfAbsent(taskId: string, role: Role): Role | null;
  compareAndSwapRole(taskId: string, expectedUpdatedAt: string, role: Role): Role | null;
  compareAndSwapRoleWithSessionSet(
    taskId: string,
    expectedUpdatedAt: string,
    expectedSessionSet: TaskRoleSessionSet | null,
    role: Role,
    sessionSet: TaskRoleSessionSet
  ): Role | null;
  renameRole(taskId: string, oldName: string, role: Role): void;
  listRoles(taskId: string): Role[];
  getRole(taskId: string, name: string): Role | null;
  saveChildRole(taskId: string, role: ChildRole): void;
  getChildRole(taskId: string, name: string): ChildRole | null;
  listChildRoles(taskId: string): ChildRole[];
  removeTaskRole(taskId: string, name: string): { removed: boolean; childCount: number };
  saveGlobalRole(role: GlobalRole): void;
  saveGlobalRoleWithSessionSet(
    role: GlobalRole,
    sessionSet: GlobalRoleSessionSet | null,
    allowMonotonicImport?: boolean
  ): void;
  createGlobalRoleIfAbsent(role: GlobalRole): GlobalRole | null;
  compareAndSwapGlobalRole(expectedUpdatedAt: string, role: GlobalRole): GlobalRole | null;
  compareAndSwapGlobalRoleWithSessionSet(
    expectedUpdatedAt: string,
    expectedSessionSet: GlobalRoleSessionSet | null,
    role: GlobalRole,
    sessionSet: GlobalRoleSessionSet
  ): GlobalRole | null;
  listGlobalRoles(): GlobalRole[];
  getGlobalRole(name: string): GlobalRole | null;
  removeGlobalRole(name: string): boolean;
  nextCommentId(taskId: string): string;
  saveComment(taskId: string, comment: TaskComment): void;
  listComments(taskId: string): TaskComment[];
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
  listEvents(taskId: string): TaskEvent[];
  saveTranscript(taskId: string, roleName: string, transcript: string): void;
  clearTranscript(taskId: string, roleName: string): void;
  readTranscript(taskId: string, roleName: string): string | null;
  saveConfiguredAgent(agent: ConfiguredAgent): void;
  createConfiguredAgentIfAbsent(agent: ConfiguredAgent): ConfiguredAgent | null;
  updateConfiguredAgent(id: string, patch: ConfiguredAgentPatch, now: Date): ConfiguredAgentUpdateResult | null;
  listConfiguredAgents(): ConfiguredAgent[];
  getConfiguredAgent(id: string): ConfiguredAgent | null;
  removeConfiguredAgent(id: string): boolean;
  saveConfiguredSkill(skill: ConfiguredSkill): void;
  listConfiguredSkills(): ConfiguredSkill[];
  getConfiguredSkill(id: string): ConfiguredSkill | null;
  pruneTrashedTasks(taskIds?: readonly string[]): number;
};

export type TaskReader = Pick<TaskStore,
  | "runReadSnapshot"
  | "getConfig"
  | "nextTaskId"
  | "listTrashedTaskIds"
  | "readTrashedTask"
  | "listTasks"
  | "getTask"
  | "getTaskTopics"
  | "getTaskInputDraft"
  | "getInputRequest"
  | "listInputRequests"
  | "getInputResolution"
  | "listInputResolutions"
  | "getOperatorDelivery"
  | "listOperatorDeliveries"
  | "getOfflineResolutionClock"
  | "listOfflineResolutionClocks"
  | "getInputResolutionWakeup"
  | "listInputResolutionWakeups"
  | "getPendingWakeup"
  | "listPendingWakeups"
  | "getLeaderFailure"
  | "getOperatorNotification"
  | "getTaskSchedule"
  | "nextCycleId"
  | "getCycle"
  | "listCycles"
  | "nextWorkItemId"
  | "getWorkItem"
  | "listWorkItems"
  | "getRoleSessionSet"
  | "listRoleSessionSets"
  | "listAllRoleSessionSets"
  | "nativeSessionIdentityClaims"
  | "getGlobalRoleSessionSet"
  | "listGlobalRoleSessionSets"
  | "getAgentSession"
  | "nextAgentRunId"
  | "getAgentRun"
  | "listAgentRuns"
  | "getActiveAgentRun"
  | "readTaskBrief"
  | "readTaskTopicSummaries"
  | "readTaskTimeline"
  | "nextMilestoneId"
  | "getMilestone"
  | "listMilestones"
  | "nextDecisionId"
  | "getDecision"
  | "listDecisions"
  | "getRoleWorktree"
  | "listRoles"
  | "getRole"
  | "getChildRole"
  | "listChildRoles"
  | "listGlobalRoles"
  | "getGlobalRole"
  | "nextCommentId"
  | "listComments"
  | "nextEventId"
  | "listEvents"
  | "readTranscript"
  | "listConfiguredAgents"
  | "getConfiguredAgent"
  | "listConfiguredSkills"
  | "getConfiguredSkill"
>;

export type TaskmuxConfig = {
  schemaVersion: 1;
  defaultAgent?: string;
  defaultWorkspace?: string;
  currentTaskId?: string;
  lastTaskId?: string;
  completionInstallations?: Partial<Record<CompletionShell, CompletionInstallation>>;
};

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = typeof COMPLETION_SHELLS[number];
export type CompletionInstallation = {
  scriptPath: string;
  activationPath: string;
};

export function resolveTaskmuxHome(env: NodeJS.ProcessEnv): string {
  return env.TASKMUX_HOME === undefined || env.TASKMUX_HOME.length === 0
    ? join(trustedAccountHome().canonicalPath, ".taskmux")
    : resolve(env.TASKMUX_HOME);
}

const TASKMUX_HOME_PRIVATE_MODE = 0o700n;
const LINUX_O_PATH = 0o10000000;
const TASKMUX_HOME_PRIVATE_REQUIREMENT =
  "TASKMUX_HOME must be an owned real directory with exact mode 0700.";
const TASKMUX_HOME_PROCFD_REQUIREMENT =
  "TaskMux requires mounted and accessible /proc/self/fd descriptor traversal.";
const TASKMUX_HOME_PROCFD_ERROR_KIND = "taskmux-home-procfd";

export type TaskmuxHomeInspection =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "ready"; identity: TaskmuxHomeIdentity }>
  | Readonly<{
      status: "repair-required";
      mode: string;
      identity: TaskmuxHomeIdentity;
    }>;

export type TaskmuxHomeIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  birthtimeNs: bigint;
}>;

export type EnsureTaskmuxHomeOptions = Readonly<{
  repairExisting?: TaskmuxHomeIdentity;
}>;

export function inspectTaskmuxHome(rootDir: string): TaskmuxHomeInspection {
  const normalizedRoot = assertTaskmuxHomePathAllowed(rootDir);
  const opened = openTaskmuxHomeDirectory(normalizedRoot);
  if (opened === undefined) {
    return Object.freeze({ status: "missing" });
  }
  try {
    assertOwnedRealTaskmuxHome(opened.metadata);
    const mode = opened.metadata.mode & 0o7777n;
    if (mode === TASKMUX_HOME_PRIVATE_MODE) {
      return Object.freeze({
        status: "ready",
        identity: taskmuxHomeIdentity(opened.metadata)
      });
    }
    return Object.freeze({
      status: "repair-required",
      mode: formatTaskmuxHomeMode(mode),
      identity: taskmuxHomeIdentity(opened.metadata)
    });
  } finally {
    closeSync(opened.descriptor);
  }
}

export function assertTaskmuxHomeReady(rootDir: string): void {
  const inspection = inspectTaskmuxHome(rootDir);
  if (inspection.status === "ready") return;
  if (inspection.status === "missing") {
    throw dataError("TaskMux is not initialized. Run `taskmux setup`.");
  }
  throw dataError(taskmuxHomeRepairMessage(inspection.mode));
}

export function ensureTaskmuxHome(
  rootDir: string,
  options: EnsureTaskmuxHomeOptions = {}
): void {
  const normalizedRoot = assertTaskmuxHomePathAllowed(rootDir);
  let inspection = inspectTaskmuxHome(normalizedRoot);
  if (options.repairExisting !== undefined) {
    if (
      inspection.status === "missing" ||
      !sameTaskmuxHomeIdentity(inspection.identity, options.repairExisting)
    ) {
      throw dataError("TASKMUX_HOME changed after repair confirmation. No changes were made.");
    }
    if (inspection.status === "ready") return;

    repairExistingTaskmuxHome(normalizedRoot, options.repairExisting);
    if (inspectTaskmuxHome(normalizedRoot).status !== "ready") {
      throw dataError(TASKMUX_HOME_PRIVATE_REQUIREMENT);
    }
    return;
  }

  if (inspection.status === "missing") {
    createMissingTaskmuxHome(normalizedRoot);
    inspection = inspectTaskmuxHome(normalizedRoot);
  }

  if (inspection.status === "ready") return;
  if (inspection.status === "missing") {
    throw dataError("TASKMUX_HOME could not be created. Run taskmux setup again.");
  }
  throw dataError(taskmuxHomeRepairMessage(inspection.mode));
}

function assertTaskmuxHomePathAllowed(rootDir: string): string {
  const normalizedRoot = resolve(rootDir);
  if (normalizedRoot === parse(normalizedRoot).root) {
    throw dataError("TASKMUX_HOME must not be the filesystem root.");
  }
  const accountHome = trustedAccountHome();
  if (
    normalizedRoot === accountHome.configuredPath ||
    normalizedRoot === accountHome.canonicalPath
  ) {
    throw dataError(
      "TASKMUX_HOME must not be the current user's home directory. Use a dedicated directory such as ~/.taskmux."
    );
  }
  return normalizedRoot;
}

type TrustedAccountHome = Readonly<{
  configuredPath: string;
  canonicalPath: string;
}>;

function trustedAccountHome(): TrustedAccountHome {
  let configuredPath: string;
  try {
    configuredPath = userInfo().homedir;
  } catch {
    throw dataError(
      "TaskMux could not resolve the current user's home directory from operating-system account data."
    );
  }
  if (configuredPath.length === 0 || !isAbsolute(configuredPath)) {
    throw dataError(
      "Operating-system account data returned an invalid current-user home directory."
    );
  }

  const normalizedConfiguredPath = resolve(configuredPath);
  let canonicalPath: string;
  try {
    canonicalPath = resolve(realpathSync(normalizedConfiguredPath));
  } catch {
    throw dataError(
      "TaskMux could not resolve the current user's home directory from operating-system account data."
    );
  }
  return Object.freeze({
    configuredPath: normalizedConfiguredPath,
    canonicalPath
  });
}

function createMissingTaskmuxHome(rootDir: string): void {
  const parsed = parse(rootDir);
  const segments = relative(parsed.root, rootDir).split("/").filter((segment) => segment.length > 0);
  let parentDescriptor = openSync(
    parsed.root,
    LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );

  try {
    for (const segment of segments) {
      let child = openChildDirectory(parentDescriptor, segment);
      let created = false;
      if (child === undefined) {
        const childPath = descriptorChildPath(parentDescriptor, segment);
        try {
          mkdirSync(childPath, { mode: Number(TASKMUX_HOME_PRIVATE_MODE) });
          created = true;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        child = openChildDirectory(parentDescriptor, segment);
        if (child === undefined) {
          throw dataError("TASKMUX_HOME changed while it was being created.");
        }
      }
      if (created) {
        try {
          assertOwnedRealTaskmuxHome(child.metadata);
          tightenPinnedDirectory(child.descriptor);
        } catch (error) {
          closeSync(child.descriptor);
          throw error;
        }
      }
      parentDescriptor = replaceDirectoryDescriptor(parentDescriptor, child.descriptor);
    }
  } finally {
    closeSync(parentDescriptor);
  }
}

function repairExistingTaskmuxHome(
  rootDir: string,
  expectedIdentity: TaskmuxHomeIdentity
): void {
  const opened = openTaskmuxHomeDirectory(rootDir);
  if (opened === undefined) {
    throw dataError("TASKMUX_HOME disappeared before repair could begin.");
  }
  try {
    assertOwnedRealTaskmuxHome(opened.metadata);
    if (!sameTaskmuxHomeIdentity(taskmuxHomeIdentity(opened.metadata), expectedIdentity)) {
      throw dataError("TASKMUX_HOME changed after repair confirmation. No changes were made.");
    }
    if ((opened.metadata.mode & 0o7777n) !== TASKMUX_HOME_PRIVATE_MODE) {
      tightenPinnedDirectory(opened.descriptor);
    }
  } finally {
    closeSync(opened.descriptor);
  }
}

function openTaskmuxHomeDirectory(rootDir: string): {
  descriptor: number;
  metadata: BigIntStats;
} | undefined {
  const opened = openPinnedDirectory(rootDir);
  if (opened === undefined) return undefined;
  try {
    assertNotFilesystemRootIdentity(opened.metadata);
    assertNotTrustedAccountHomeIdentity(opened.metadata);
    return opened;
  } catch (error) {
    closeSync(opened.descriptor);
    throw error;
  }
}

function openPinnedDirectory(rootDir: string): {
  descriptor: number;
  metadata: BigIntStats;
} | undefined {
  const parsed = parse(rootDir);
  const segments = relative(parsed.root, rootDir).split("/").filter((segment) => segment.length > 0);
  let descriptor = openSync(
    parsed.root,
    LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  let metadata = fstatSync(descriptor, { bigint: true });
  try {
    for (const segment of segments) {
      const child = openChildDirectory(descriptor, segment);
      if (child === undefined) return undefined;
      descriptor = replaceDirectoryDescriptor(descriptor, child.descriptor);
      metadata = child.metadata;
    }
    const result = { descriptor, metadata };
    descriptor = -1;
    return result;
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function openChildDirectory(parentDescriptor: number, segment: string): {
  descriptor: number;
  metadata: BigIntStats;
} | undefined {
  assertProcfdDescriptorAnchor(parentDescriptor);
  const childPath = descriptorChildPath(parentDescriptor, segment);
  let pathMetadata: BigIntStats | undefined;
  try {
    pathMetadata = lstatSync(childPath, { bigint: true, throwIfNoEntry: false });
  } catch (error) {
    reclassifyProcfdTraversalFailure(parentDescriptor, error);
  }
  if (pathMetadata === undefined) {
    assertProcfdDescriptorAnchor(parentDescriptor);
    return undefined;
  }
  if (pathMetadata.isSymbolicLink()) {
    throw dataError("TASKMUX_HOME must not contain a symbolic link.");
  }
  if (!pathMetadata.isDirectory()) {
    throw dataError("TASKMUX_HOME must be a directory.");
  }

  let descriptor: number;
  try {
    descriptor = openSync(
      childPath,
      LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch (error) {
    reclassifyProcfdTraversalFailure(parentDescriptor, error);
  }
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino
    ) {
      throw dataError("TASKMUX_HOME changed while it was being inspected.");
    }
    return { descriptor, metadata };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function descriptorChildPath(descriptor: number, segment: string): string {
  return `/proc/self/fd/${descriptor}/${segment}`;
}

function assertProcfdDescriptorAnchor(descriptor: number): void {
  const anchor = `/proc/self/fd/${descriptor}`;
  try {
    const metadata = lstatSync(anchor, { bigint: true, throwIfNoEntry: false });
    if (metadata === undefined) {
      throw taskmuxHomeProcfdError("ENOENT");
    }
  } catch (error) {
    if (taskmuxHomeProcfdSystemCode(error) !== undefined) throw error;
    const code = errorCode(error);
    if (code === "ENOENT" || code === "EACCES") {
      throw taskmuxHomeProcfdError(code);
    }
    throw error;
  }
}

function reclassifyProcfdTraversalFailure(descriptor: number, error: unknown): never {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "EACCES") {
    assertProcfdDescriptorAnchor(descriptor);
  }
  throw error;
}

function replaceDirectoryDescriptor(current: number, next: number): number {
  try {
    closeSync(current);
  } catch (error) {
    try {
      closeSync(next);
    } catch {
      // Preserve the original close failure.
    }
    throw error;
  }
  return next;
}

function assertOwnedRealTaskmuxHome(metadata: BigIntStats): void {
  if (
    !metadata.isDirectory() ||
    metadata.uid !== BigInt(process.geteuid?.() ?? -1)
  ) {
    throw dataError(TASKMUX_HOME_PRIVATE_REQUIREMENT);
  }
}

function assertNotFilesystemRootIdentity(metadata: BigIntStats): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      "/",
      LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch {
    throw dataError("TaskMux could not inspect the filesystem root.");
  }
  try {
    const rootMetadata = fstatSync(descriptor, { bigint: true });
    if (metadata.dev === rootMetadata.dev && metadata.ino === rootMetadata.ino) {
      throw dataError("TASKMUX_HOME must not be the filesystem root.");
    }
  } finally {
    closeSync(descriptor);
  }
}

function assertNotTrustedAccountHomeIdentity(metadata: BigIntStats): void {
  const accountHome = trustedAccountHome();
  let descriptor: number;
  try {
    descriptor = openSync(
      accountHome.canonicalPath,
      LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch {
    throw dataError(
      "TaskMux could not inspect the current user's home directory from operating-system account data."
    );
  }
  try {
    const accountMetadata = fstatSync(descriptor, { bigint: true });
    if (metadata.dev === accountMetadata.dev && metadata.ino === accountMetadata.ino) {
      throw dataError(
        "TASKMUX_HOME must not be the current user's home directory. Use a dedicated directory such as ~/.taskmux."
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

function taskmuxHomeIdentity(metadata: BigIntStats): TaskmuxHomeIdentity {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
    nlink: metadata.nlink,
    birthtimeNs: metadata.birthtimeNs
  });
}

function sameTaskmuxHomeIdentity(
  actual: TaskmuxHomeIdentity,
  expected: TaskmuxHomeIdentity
): boolean {
  return actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.uid === expected.uid &&
    actual.mode === expected.mode &&
    actual.nlink === expected.nlink &&
    actual.birthtimeNs === expected.birthtimeNs;
}

function tightenPinnedDirectory(descriptor: number): void {
  try {
    chmodSync(`/proc/self/fd/${descriptor}`, Number(TASKMUX_HOME_PRIVATE_MODE));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw dataError(`${TASKMUX_HOME_PRIVATE_REQUIREMENT}${detail}`);
  }
  const metadata = fstatSync(descriptor, { bigint: true });
  if ((metadata.mode & 0o7777n) !== TASKMUX_HOME_PRIVATE_MODE) {
    throw dataError(TASKMUX_HOME_PRIVATE_REQUIREMENT);
  }
}

function taskmuxHomeRepairMessage(mode: string): string {
  return `${TASKMUX_HOME_PRIVATE_REQUIREMENT} Existing mode is ${mode}. Refusing to change an existing directory automatically. Run taskmux setup in an interactive terminal and confirm repair.`;
}

function formatTaskmuxHomeMode(mode: bigint): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function taskmuxHomeProcfdError(systemCode: "ENOENT" | "EACCES"): ReturnType<typeof dataError> {
  const error = dataError(`${TASKMUX_HOME_PROCFD_REQUIREMENT} ${systemCode}.`);
  Object.defineProperties(error, {
    kind: { value: TASKMUX_HOME_PROCFD_ERROR_KIND },
    systemCode: { value: systemCode }
  });
  return error;
}

function taskmuxHomeProcfdSystemCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "kind" in error &&
    error.kind === TASKMUX_HOME_PROCFD_ERROR_KIND &&
    "systemCode" in error &&
    typeof error.systemCode === "string"
  ) {
    return error.systemCode;
  }
  return undefined;
}

export class FileTaskStore implements TaskStore {
  static createEphemeralWorkspace(prefix = "taskmux-ephemeral-storage-"): FileTaskStore {
    return new FileTaskStore(mkdtempSync(join(tmpdir(), prefix)), undefined, true);
  }

  static forDomainTransactionWorkspace(
    rootDir: string,
    runtimeOperationToken?: string,
    runtimeRecoveryToken?: string
  ): FileTaskStore {
    return new FileTaskStore(
      rootDir,
      undefined,
      false,
      runtimeOperationToken,
      runtimeRecoveryToken
    );
  }

  constructor(
    private readonly rootDir: string,
    private readonly pinnedReader: NativePinnedRootReader | null | undefined = undefined,
    private readonly ephemeral = false,
    private readonly runtimeOperationToken?: string,
    private readonly runtimeRecoveryToken?: string,
    private readonly pinnedRootPrefix = ""
  ) {}

  rootDirectory(): string {
    return this.rootDir;
  }

  runDomainTransaction<T>(
    transactionId: string,
    execute: (workingRoot: string) => T
  ): T {
    return executeDomainTransaction(this.rootDir, transactionId, execute);
  }

  disposeEphemeralWorkspace(): void {
    if (!this.ephemeral) {
      throw new Error("TaskMux storage is not an ephemeral workspace.");
    }
    rmSync(this.rootDir, { recursive: true, force: true });
  }

  runReadSnapshot<T>(execute: (reader: TaskReader) => T): T {
    if (this.pinnedReader !== undefined) {
      return withBoundedTaskReader(this, execute);
    }
    return executeDomainReadSnapshot(this.rootDir, (reader) =>
      withBoundedTaskReader(new FileTaskStore(this.rootDir, reader ?? null), execute)
    );
  }

  getConfig(): TaskmuxConfig {
    const raw = this.readOptionalText(this.configFile());

    if (raw === null) {
      return { schemaVersion: 1 };
    }

    return parseTaskmuxConfig(raw);
  }

  saveConfig(config: TaskmuxConfig): void {
    mkdirSync(this.rootDir, { recursive: true });
    this.writeSnapshot(this.configFile(), `${JSON.stringify(config, null, 2)}\n`);
  }

  nextTaskId(): string {
    const maxId = this.listTasks().reduce((max, task) => {
      const match = /^task-(\d+)$/.exec(task.id);
      if (match === null) {
        return max;
      }

      return Math.max(max, Number.parseInt(match[1], 10));
    }, 0);

    return `task-${maxId + 1}`;
  }

  saveTask(task: Task): void {
    const taskDir = this.taskDir(task.id);
    const encoded = taskRecordCodec.encodeTask(task);

    mkdirSync(taskDir, { recursive: true });
    this.writeSnapshot(this.taskFile(task.id), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    this.writeSnapshot(this.taskInfoFile(task.id), `${JSON.stringify(encoded.info, null, 2)}\n`);
  }

  deleteTask(id: string): boolean {
    if (this.readOptionalText(this.taskFile(id)) === null) {
      return false;
    }

    const trashDir = this.trashedTaskDir(id);
    if (existsSync(trashDir)) {
      this.retireTrashedSessionIdentities(this.listTrashedRoleSessionSets(id));
      rmSync(trashDir, { recursive: true, force: true });
    }
    for (const sessionSet of this.listRoleSessionSets(id)) {
      this.reserveSessionIdentities(sessionSet);
    }
    mkdirSync(this.trashedTasksDir(), { recursive: true });
    renameSync(this.taskDir(id), trashDir);
    const roleSessionSetsDir = this.roleSessionSetsDir(id);
    if (existsSync(roleSessionSetsDir)) {
      renameSync(roleSessionSetsDir, this.trashedRoleSessionSetsDir(id));
    }
    return true;
  }

  restoreTask(id: string): boolean {
    if (this.readOptionalText(this.trashedTaskFile(id)) === null) {
      return false;
    }

    if (this.readOptionalText(this.taskFile(id)) !== null) {
      throw dataError(`Cannot restore task because active task already exists: ${id}`);
    }

    const roleSessionSetsDir = this.roleSessionSetsDir(id);
    if (existsSync(roleSessionSetsDir)) {
      throw dataError(`Cannot restore task because active Role sessions already exist: ${id}`);
    }
    const trashedSessionSets = this.listTrashedRoleSessionSets(id);
    assertIdentityOwnershipsUnique(trashedSessionSets.flatMap(sessionIdentityOwnerships));
    for (const sessionSet of trashedSessionSets) {
      this.assertSessionIdentitiesUnique(sessionSet);
    }
    for (const sessionSet of trashedSessionSets) {
      this.reserveSessionIdentities(sessionSet);
    }
    mkdirSync(this.tasksDir(), { recursive: true });
    const trashedRoleSessionSetsDir = this.trashedRoleSessionSetsDir(id);
    if (existsSync(trashedRoleSessionSetsDir)) {
      mkdirSync(dirname(roleSessionSetsDir), { recursive: true });
      renameSync(trashedRoleSessionSetsDir, roleSessionSetsDir);
    }
    renameSync(this.trashedTaskDir(id), this.taskDir(id));
    return true;
  }

  listTrashedTaskIds(): string[] {
    const trashStore = this.trashTaskStore();
    return this.directoryNames(this.trashedTasksDir())
      .map((id) => {
        if (this.getTask(id) !== null) {
          throw dataError(`Task id is present in both live and trash storage: ${id}`);
        }
        if (trashStore.getTask(id) === null) {
          throw dataError(`Invalid trashed task record: ${id}`);
        }
        return id;
      })
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  }

  readTrashedTask<T>(taskId: string, execute: (reader: TaskReader) => T): T | null {
    if (this.pinnedReader === undefined) {
      return this.runReadSnapshot((reader) => reader.readTrashedTask(taskId, execute));
    }
    const trashStore = this.trashTaskStore();
    const trashedTask = trashStore.getTask(taskId);
    if (trashedTask === null) {
      return null;
    }
    if (this.getTask(taskId) !== null) {
      throw dataError(`Task id is present in both live and trash storage: ${taskId}`);
    }
    return withBoundedTaskReader(trashStore, execute);
  }

  listTasks(): Task[] {
    return this.directoryNames(this.tasksDir())
      .map((name) => this.getTask(name))
      .filter((task): task is Task => task !== null)
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  }

  getTask(id: string): Task | null {
    const runtimeRaw = this.readOptionalText(this.taskFile(id));

    if (runtimeRaw === null) {
      return null;
    }

    const infoRaw = this.readOptionalText(this.taskInfoFile(id));

    return taskRecordCodec.decodeTask(id, runtimeRaw, infoRaw);
  }

  getTaskTopics(taskId: string): TaskTopics {
    const raw = this.readOptionalText(this.topicsFile(taskId));

    return raw === null ? emptyTaskTopics() : parseTaskTopics(taskId, raw);
  }

  saveTaskTopics(taskId: string, topics: TaskTopics): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    this.writeSnapshot(this.topicsFile(taskId), `${JSON.stringify(topics, null, 2)}\n`);
  }

  getTaskInputDraft(taskId: string): TaskInputDraft | null {
    const raw = this.readOptionalText(this.taskInputDraftFile(taskId));

    return raw === null ? null : parseTaskInputDraft(taskId, raw);
  }

  saveTaskInputDraft(taskId: string, draft: TaskInputDraft): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    this.writeSnapshot(this.taskInputDraftFile(taskId), `${JSON.stringify(draft, null, 2)}\n`);
  }

  clearTaskInputDraft(taskId: string): void {
    rmSync(this.taskInputDraftFile(taskId), { force: true });
  }

  getInputRequest(taskId: string, requestId: string): InputRequest | null {
    assertInputPointerId(taskId, "task");
    assertInputPointerId(requestId, "input request");
    const raw = this.readOptionalText(this.inputRequestFile(taskId, requestId));
    return raw === null ? null : parseInputRequest(taskId, requestId, raw);
  }

  listInputRequests(taskId: string): InputRequest[] {
    assertInputPointerId(taskId, "task");
    return this.jsonRecordIds(this.inputRequestsDir(taskId))
      .map((id) => this.getInputRequest(taskId, id))
      .filter((request): request is InputRequest => request !== null);
  }

  saveInputRequest(request: InputRequest): void {
    const encoded = encodeInputRequestRecord(request);
    if (encoded === null) {
      throw dataError("Invalid input request record");
    }
    mkdirSync(this.inputRequestsDir(encoded.record.taskId), { recursive: true });
    this.writeSnapshot(
      this.inputRequestFile(encoded.record.taskId, encoded.record.id),
      encoded.content
    );
  }

  getInputResolution(taskId: string, resolutionId: string): InputResolution | null {
    assertInputPointerId(taskId, "task");
    assertInputPointerId(resolutionId, "input resolution");
    const raw = this.readOptionalText(this.inputResolutionFile(taskId, resolutionId));
    return raw === null ? null : parseInputResolution(taskId, resolutionId, raw);
  }

  listInputResolutions(taskId: string): InputResolution[] {
    assertInputPointerId(taskId, "task");
    return this.jsonRecordIds(this.inputResolutionsDir(taskId))
      .map((id) => this.getInputResolution(taskId, id))
      .filter((resolution): resolution is InputResolution => resolution !== null);
  }

  saveInputResolution(resolution: InputResolution): void {
    const encoded = encodeInputResolutionRecord(resolution);
    if (encoded === null) {
      throw dataError("Invalid input resolution record");
    }
    mkdirSync(this.inputResolutionsDir(encoded.record.taskId), { recursive: true });
    this.writeSnapshot(
      this.inputResolutionFile(encoded.record.taskId, encoded.record.id),
      encoded.content
    );
  }

  getOperatorDelivery(deliveryId: string): OperatorDelivery | null {
    assertInputPointerId(deliveryId, "operator delivery");
    const raw = this.readOptionalText(this.operatorDeliveryFile(deliveryId));
    return raw === null ? null : parseOperatorDelivery(deliveryId, raw);
  }

  listOperatorDeliveries(): OperatorDelivery[] {
    return this.jsonRecordIds(this.operatorDeliveriesDir())
      .map((id) => this.getOperatorDelivery(id))
      .filter((delivery): delivery is OperatorDelivery => delivery !== null)
      .sort((left, right) =>
        left.sequence - right.sequence || left.deliveryId.localeCompare(right.deliveryId)
      );
  }

  saveOperatorDelivery(delivery: OperatorDelivery): void {
    if (!isOperatorDelivery(delivery, delivery?.deliveryId)) {
      throw dataError("Invalid operator delivery record");
    }
    mkdirSync(this.operatorDeliveriesDir(), { recursive: true });
    this.writeSnapshot(
      this.operatorDeliveryFile(delivery.deliveryId),
      `${JSON.stringify(delivery, null, 2)}\n`
    );
  }

  getOfflineResolutionClock(taskId: string, requestId: string): OfflineResolutionClock | null {
    assertInputPointerId(taskId, "task");
    assertInputPointerId(requestId, "input request");
    const raw = this.readOptionalText(this.offlineResolutionClockFile(taskId, requestId));
    return raw === null ? null : parseOfflineResolutionClock(taskId, requestId, raw);
  }

  listOfflineResolutionClocks(): OfflineResolutionClock[] {
    const clocks: OfflineResolutionClock[] = [];
    for (const taskId of this.directoryNames(this.offlineResolutionClocksDir())) {
      for (const requestId of this.jsonRecordIds(this.offlineResolutionClockTaskDir(taskId))) {
        const clock = this.getOfflineResolutionClock(taskId, requestId);
        if (clock !== null) clocks.push(clock);
      }
    }
    return clocks.sort((left, right) =>
      left.offlineSince.localeCompare(right.offlineSince) ||
      left.taskId.localeCompare(right.taskId) ||
      left.requestId.localeCompare(right.requestId)
    );
  }

  saveOfflineResolutionClock(clock: OfflineResolutionClock): void {
    if (!isOfflineResolutionClock(clock, clock?.taskId, clock?.requestId)) {
      throw dataError("Invalid offline resolution clock record");
    }
    mkdirSync(this.offlineResolutionClockTaskDir(clock.taskId), { recursive: true });
    this.writeSnapshot(
      this.offlineResolutionClockFile(clock.taskId, clock.requestId),
      `${JSON.stringify(clock, null, 2)}\n`
    );
  }

  clearOfflineResolutionClock(taskId: string, requestId: string): void {
    assertInputPointerId(taskId, "task");
    assertInputPointerId(requestId, "input request");
    rmSync(this.offlineResolutionClockFile(taskId, requestId), { force: true });
  }

  clearAllOfflineResolutionClocks(): void {
    rmSync(this.offlineResolutionClocksDir(), { recursive: true, force: true });
  }

  getInputResolutionWakeup(taskId: string, requestId: string): InputResolutionWakeup | null {
    assertInputPointerId(taskId, "task");
    assertInputPointerId(requestId, "input request");
    const raw = this.readOptionalText(this.inputResolutionWakeupFile(taskId, requestId));
    return raw === null ? null : parseInputResolutionWakeup(taskId, requestId, raw);
  }

  listInputResolutionWakeups(): InputResolutionWakeup[] {
    const wakeups: InputResolutionWakeup[] = [];
    for (const taskId of this.directoryNames(this.inputResolutionWakeupsDir())) {
      for (const requestId of this.jsonRecordIds(this.inputResolutionWakeupTaskDir(taskId))) {
        const wakeup = this.getInputResolutionWakeup(taskId, requestId);
        if (wakeup !== null) wakeups.push(wakeup);
      }
    }
    return wakeups.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.taskId.localeCompare(right.taskId) ||
      left.requestId.localeCompare(right.requestId)
    );
  }

  saveInputResolutionWakeup(wakeup: InputResolutionWakeup): void {
    if (!isInputResolutionWakeup(wakeup, wakeup?.taskId, wakeup?.requestId)) {
      throw dataError("Invalid input resolution wakeup record");
    }
    mkdirSync(this.inputResolutionWakeupTaskDir(wakeup.taskId), { recursive: true });
    this.writeSnapshot(
      this.inputResolutionWakeupFile(wakeup.taskId, wakeup.requestId),
      `${JSON.stringify(wakeup, null, 2)}\n`
    );
  }

  clearInputResolutionWakeup(taskId: string, requestId: string): void {
    assertInputPointerId(taskId, "task");
    assertInputPointerId(requestId, "input request");
    rmSync(this.inputResolutionWakeupFile(taskId, requestId), { force: true });
  }

  getPendingWakeup(taskId: string): PendingWakeup | null {
    const raw = this.readOptionalText(this.pendingWakeupFile(taskId));

    return raw === null ? null : parsePendingWakeup(taskId, raw);
  }

  savePendingWakeup(wakeup: PendingWakeup): void {
    mkdirSync(this.pendingWakeupsDir(), { recursive: true });
    this.writeSnapshot(this.pendingWakeupFile(wakeup.taskId), `${JSON.stringify(wakeup, null, 2)}\n`);
  }

  listPendingWakeups(): PendingWakeup[] {
    return this.jsonRecordIds(this.pendingWakeupsDir())
      .map((taskId) => this.getPendingWakeup(taskId))
      .filter((wakeup): wakeup is PendingWakeup => wakeup !== null)
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  clearPendingWakeup(taskId: string): void {
    rmSync(this.pendingWakeupFile(taskId), { force: true });
  }

  clearPendingWakeupIfUnchanged(expected: PendingWakeup): boolean {
    if (hasActiveDomainTransactionAuthority(this.rootDir)) {
      return this.clearPendingWakeupIfExpected(expected);
    }
    return executeDomainTransaction(
      this.rootDir,
      `pending-wakeup-cas-${randomUUID()}`,
      (workingRoot) => new FileTaskStore(workingRoot).clearPendingWakeupIfExpected(expected)
    );
  }

  getLeaderFailure(taskId: string): LeaderFailure | null {
    const raw = this.readOptionalText(this.leaderFailureFile(taskId));
    return raw === null ? null : parseLeaderFailure(taskId, raw);
  }

  saveLeaderFailure(failure: LeaderFailure): void {
    mkdirSync(this.leaderFailuresDir(), { recursive: true });
    this.writeSnapshot(this.leaderFailureFile(failure.taskId), `${JSON.stringify(failure, null, 2)}\n`);
  }

  clearLeaderFailure(taskId: string): void {
    rmSync(this.leaderFailureFile(taskId), { force: true });
  }

  getOperatorNotification(taskId: string): OperatorNotification | null {
    const raw = this.readOptionalText(this.operatorNotificationFile(taskId));
    return raw === null ? null : parseOperatorNotification(taskId, raw);
  }

  saveOperatorNotification(notification: OperatorNotification): void {
    mkdirSync(this.operatorNotificationsDir(), { recursive: true });
    this.writeSnapshot(
      this.operatorNotificationFile(notification.taskId),
      `${JSON.stringify(notification, null, 2)}\n`
    );
  }

  clearOperatorNotification(taskId: string): void {
    rmSync(this.operatorNotificationFile(taskId), { force: true });
  }

  getTaskSchedule(taskId: string): TaskSchedule | null {
    const raw = this.readOptionalText(this.taskScheduleFile(taskId));
    return raw === null ? null : parseTaskSchedule(taskId, raw);
  }

  saveTaskSchedule(taskId: string, schedule: TaskSchedule): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    this.writeSnapshot(this.taskScheduleFile(taskId), `${JSON.stringify(schedule, null, 2)}\n`);
  }

  nextCycleId(taskId: string): string {
    return this.nextRecordId("cycle", (id) => this.getCycle(taskId, id));
  }

  getCycle(taskId: string, cycleId: string): Cycle | null {
    const raw = this.readOptionalText(this.cycleFile(taskId, cycleId));

    return raw === null ? null : parseCycle(taskId, cycleId, raw);
  }

  listCycles(taskId: string): Cycle[] {
    return this.jsonRecordIds(this.cyclesDir(taskId))
      .map((id) => this.getCycle(taskId, id))
      .filter((cycle): cycle is Cycle => cycle !== null);
  }

  saveCycle(taskId: string, cycle: Cycle): void {
    mkdirSync(this.cyclesDir(taskId), { recursive: true });
    this.writeSnapshot(this.cycleFile(taskId, cycle.id), `${JSON.stringify(cycle, null, 2)}\n`);
  }

  nextWorkItemId(taskId: string): string {
    return this.nextRecordId("work-item", (id) => this.getWorkItem(taskId, id));
  }

  getWorkItem(taskId: string, workItemId: string): WorkItem | null {
    const raw = this.readOptionalText(this.workItemFile(taskId, workItemId));

    return raw === null ? null : parseWorkItem(taskId, workItemId, raw);
  }

  listWorkItems(taskId: string): WorkItem[] {
    return this.jsonRecordIds(this.workItemsDir(taskId))
      .map((id) => this.getWorkItem(taskId, id))
      .filter((item): item is WorkItem => item !== null);
  }

  saveWorkItem(taskId: string, workItem: WorkItem): void {
    mkdirSync(this.workItemsDir(taskId), { recursive: true });
    this.writeSnapshot(this.workItemFile(taskId, workItem.id), `${JSON.stringify(workItem, null, 2)}\n`);
  }

  getRoleSessionSet(taskId: string, roleName: string): TaskRoleSessionSet | null {
    const raw = this.readOptionalText(this.roleSessionSetFile(taskId, roleName));
    if (raw === null) return null;
    const sessionSet = parseTaskRoleSessionSet(taskId, roleName, raw);
    const role = this.getRole(taskId, roleName);
    if (role === null || !sessionSetMatchesRole(sessionSet, role)) {
      throw dataError(`Invalid role session set: ${taskId}/${roleName}`);
    }
    return sessionSet;
  }

  listRoleSessionSets(taskId: string): TaskRoleSessionSet[] {
    return this.jsonRecordIds(this.roleSessionSetsDir(taskId))
      .map((roleName) => this.getRoleSessionSet(taskId, roleName))
      .filter((sessionSet): sessionSet is TaskRoleSessionSet => sessionSet !== null);
  }

  listAllRoleSessionSets(): Array<GlobalRoleSessionSet | TaskRoleSessionSet> {
    return [
      ...this.listGlobalRoleSessionSets(),
      ...this.directoryNames(join(this.roleSessionsDir(), "tasks"))
        .flatMap((taskId) => this.listRoleSessionSets(taskId))
    ];
  }

  nativeSessionIdentityClaims(): Map<string, NativeSessionIdentityClaim> {
    return new Map(Object.entries(this.readNativeSessionIdentityLedger().identities));
  }

  reconcileNativeSessionIdentityLedger(): void {
    const ledger = this.readNativeSessionIdentityLedger();
    this.writeNativeSessionIdentityLedger(
      this.reconcileIdentityClaims(ledger.identities, this.physicalSessionIdentityOwners())
    );
  }

  mergeImportedNativeSessionIdentityClaims(
    imported: Record<string, NativeSessionIdentityClaim>
  ): void {
    const storedImported = snapshotNativeSessionIdentityClaims(imported);
    if (storedImported === null) throw dataError("Invalid imported native session identity ledger.");
    const ledger = this.readNativeSessionIdentityLedger();
    const identities = { ...ledger.identities };
    for (const [key, claim] of Object.entries(storedImported)) {
      const existing = identities[key];
      if (existing !== undefined && !nativeSessionIdentityClaimsMatch(existing, claim)) {
        throw dataError("Imported native session identity conflicts with the target ledger.");
      }
      identities[key] = claim;
    }
    this.writeNativeSessionIdentityLedger(
      this.reconcileIdentityClaims(identities, this.physicalSessionIdentityOwners())
    );
  }

  saveRoleSessionSet(sessionSet: TaskRoleSessionSet): void {
    const stored = snapshotTaskRoleSessionSetRecord(sessionSet);
    if (stored === null) throw dataError("Task Role session storage requires a task owner.");
    const role = this.getRole(stored.owner.taskId, stored.owner.roleName);
    if (role === null || !sessionSetMatchesRole(stored, role)) {
      throw dataError(`Invalid role session set: ${stored.owner.taskId}/${stored.owner.roleName}`);
    }
    const existing = this.getRoleSessionSet(stored.owner.taskId, stored.owner.roleName);
    this.assertSessionIdentityLineagePreserved(existing, stored);
    this.assertSessionIdentitiesUnique(stored);
    this.reserveSessionIdentities(stored);
    mkdirSync(this.roleSessionSetsDir(stored.owner.taskId), { recursive: true });
    this.writeSnapshot(
      this.roleSessionSetFile(stored.owner.taskId, stored.owner.roleName),
      `${JSON.stringify(stored, null, 2)}\n`
    );
  }

  getGlobalRoleSessionSet(roleName: string): GlobalRoleSessionSet | null {
    const raw = this.readOptionalText(this.globalRoleSessionSetFile(roleName));
    if (raw === null) return null;
    const sessionSet = parseGlobalRoleSessionSet(roleName, raw);
    const role = this.getGlobalRole(roleName);
    if (role === null || !sessionSetMatchesRole(sessionSet, role)) {
      throw dataError(`Invalid global role session set: ${roleName}`);
    }
    return sessionSet;
  }

  listGlobalRoleSessionSets(): GlobalRoleSessionSet[] {
    return this.jsonRecordIds(this.globalRoleSessionSetsDir())
      .map((roleName) => this.getGlobalRoleSessionSet(roleName))
      .filter((sessionSet): sessionSet is GlobalRoleSessionSet => sessionSet !== null);
  }

  saveGlobalRoleSessionSet(sessionSet: GlobalRoleSessionSet): void {
    const stored = snapshotGlobalRoleSessionSetRecord(sessionSet);
    if (stored === null) throw dataError("Global Role session storage requires a global owner.");
    const role = this.getGlobalRole(stored.owner.roleName);
    if (role === null || !sessionSetMatchesRole(stored, role)) {
      throw dataError(`Invalid global role session set: ${stored.owner.roleName}`);
    }
    const existing = this.getGlobalRoleSessionSet(stored.owner.roleName);
    this.assertSessionIdentityLineagePreserved(existing, stored);
    this.assertSessionIdentitiesUnique(stored);
    this.reserveSessionIdentities(stored);
    mkdirSync(this.globalRoleSessionSetsDir(), { recursive: true });
    this.writeSnapshot(
      this.globalRoleSessionSetFile(stored.owner.roleName),
      `${JSON.stringify(stored, null, 2)}\n`
    );
  }

  getAgentSession(taskId: string, roleName: string): RoleAgentSession | null {
    return activeRoleAgentSession(this.getRoleSessionSet(taskId, roleName));
  }

  nextAgentRunId(taskId: string): string {
    return this.nextRecordId("agent-run", (id) => this.getAgentRun(taskId, id));
  }

  getAgentRun(taskId: string, runId: string): AgentRun | null {
    const raw = this.readOptionalText(this.agentRunFile(taskId, runId));
    return raw === null ? null : parseAgentRun(taskId, runId, raw);
  }

  listAgentRuns(taskId: string): AgentRun[] {
    return this.jsonRecordIds(this.agentRunsDir(taskId))
      .map((id) => this.getAgentRun(taskId, id))
      .filter((run): run is AgentRun => run !== null);
  }

  saveAgentRun(run: AgentRun): void {
    mkdirSync(this.agentRunsDir(run.taskId), { recursive: true });
    this.writeSnapshot(this.agentRunFile(run.taskId, run.id), `${JSON.stringify(run, null, 2)}\n`);
  }

  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null {
    const raw = this.readOptionalText(this.activeAgentRunFile(taskId, roleName));
    if (raw === null) {
      return null;
    }

    const value = parseJson(raw, `Invalid active agent run record: ${taskId}/${roleName}`);
    if (!isRecord(value) || typeof value.id !== "string") {
      throw dataError(`Invalid active agent run record: ${taskId}/${roleName}`);
    }
    return parseAgentRun(taskId, value.id, raw);
  }

  saveActiveAgentRun(run: AgentRun): void {
    mkdirSync(this.activeAgentRunsDir(run.taskId), { recursive: true });
    this.writeSnapshot(this.activeAgentRunFile(run.taskId, run.roleName), `${JSON.stringify(run, null, 2)}\n`);
  }

  clearActiveAgentRun(taskId: string, roleName: string): void {
    rmSync(this.activeAgentRunFile(taskId, roleName), { force: true });
  }

  saveTaskBrief(taskId: string, markdown: string): void {
    mkdirSync(this.taskDir(taskId), { recursive: true });
    this.writeSnapshot(this.taskBriefFile(taskId), markdown);
  }

  readTaskBrief(taskId: string): string | null {
    return this.readOptionalText(this.taskBriefFile(taskId));
  }

  appendTaskTopicSummary(taskId: string, markdown: string): void {
    const existing = this.readOptionalText(this.taskTopicSummariesFile(taskId)) ?? "";
    this.writeSnapshot(this.taskTopicSummariesFile(taskId), `${existing}${markdown}`);
  }

  readTaskTopicSummaries(taskId: string): string | null {
    return this.readOptionalText(this.taskTopicSummariesFile(taskId));
  }

  appendTaskTimeline(taskId: string, markdown: string): void {
    const existing = this.readOptionalText(this.taskTimelineFile(taskId)) ?? "";
    this.writeSnapshot(this.taskTimelineFile(taskId), `${existing}${markdown}`);
  }

  readTaskTimeline(taskId: string): string | null {
    return this.readOptionalText(this.taskTimelineFile(taskId));
  }

  nextMilestoneId(taskId: string): string {
    return this.nextRecordId("milestone", (id) => this.getMilestone(taskId, id));
  }

  getMilestone(taskId: string, milestoneId: string): Milestone | null {
    const raw = this.readOptionalText(this.milestoneFile(taskId, milestoneId));
    return raw === null ? null : parseMilestone(taskId, milestoneId, raw);
  }

  listMilestones(taskId: string): Milestone[] {
    return this.jsonRecordIds(this.milestonesDir(taskId))
      .map((id) => this.getMilestone(taskId, id))
      .filter((milestone): milestone is Milestone => milestone !== null);
  }

  saveMilestone(taskId: string, milestone: Milestone): void {
    mkdirSync(this.milestonesDir(taskId), { recursive: true });
    this.writeSnapshot(this.milestoneFile(taskId, milestone.id), `${JSON.stringify(milestone, null, 2)}\n`);
  }

  nextDecisionId(taskId: string): string {
    return this.nextRecordId("decision", (id) => this.getDecision(taskId, id));
  }

  getDecision(taskId: string, decisionId: string): Decision | null {
    const raw = this.readOptionalText(this.decisionFile(taskId, decisionId));
    return raw === null ? null : parseDecision(taskId, decisionId, raw);
  }

  listDecisions(taskId: string): Decision[] {
    return this.jsonRecordIds(this.decisionsDir(taskId))
      .map((id) => this.getDecision(taskId, id))
      .filter((decision): decision is Decision => decision !== null);
  }

  saveDecision(taskId: string, decision: Decision): void {
    mkdirSync(this.decisionsDir(taskId), { recursive: true });
    this.writeSnapshot(this.decisionFile(taskId, decision.id), `${JSON.stringify(decision, null, 2)}\n`);
  }

  saveRoleWorktree(taskId: string, worktree: RoleWorktree): void {
    mkdirSync(this.roleDir(taskId, worktree.roleName), { recursive: true });
    this.writeSnapshot(
      this.roleWorktreeFile(taskId, worktree.roleName),
      `${JSON.stringify(worktree, null, 2)}\n`
    );
  }

  getRoleWorktree(taskId: string, roleName: string): RoleWorktree | null {
    const raw = this.readOptionalText(this.roleWorktreeFile(taskId, roleName));
    return raw === null ? null : parseRoleWorktree(taskId, roleName, raw);
  }

  listRoleWorktrees(taskId: string): RoleWorktree[] {
    return this.listRoles(taskId)
      .map((role) => this.getRoleWorktree(taskId, role.name))
      .filter((worktree): worktree is RoleWorktree => worktree !== null)
      .sort((left, right) => left.roleName.localeCompare(right.roleName));
  }

  removeRoleWorktree(taskId: string, roleName: string): void {
    rmSync(this.roleWorktreeFile(taskId, roleName), { force: true });
  }

  saveRole(taskId: string, role: Role): void {
    const storedRole = snapshotTaskRoleRecord(role, taskId);
    if (storedRole === null) throw dataError("Invalid role record");
    if (this.getChildRole(taskId, storedRole.name) !== null) {
      throw dataError(`Role name is already owned by a child role: ${taskId}/${storedRole.name}`);
    }
    const sessionRaw = this.readOptionalText(this.roleSessionSetFile(taskId, storedRole.name));
    if (sessionRaw !== null) {
      const sessionSet = parseTaskRoleSessionSet(taskId, storedRole.name, sessionRaw);
      if (!sessionSetMatchesRole(sessionSet, storedRole)) {
        throw dataError(`Role update is incompatible with its session set: ${taskId}/${storedRole.name}`);
      }
      this.reserveSessionIdentities(sessionSet);
    }
    this.writeRoleRecord(taskId, storedRole);
  }

  saveRoleWithSessionSet(
    taskId: string,
    role: Role,
    sessionSet: TaskRoleSessionSet | null,
    allowMonotonicImport = false
  ): void {
    const storedRole = snapshotTaskRoleRecord(role, taskId);
    const storedSessionSet = sessionSet === null
      ? null
      : snapshotTaskRoleSessionSetRecord(sessionSet, taskId, role.name);
    if (
      storedRole === null ||
      (sessionSet !== null && (storedSessionSet === null || !sessionSetMatchesRole(storedSessionSet, storedRole)))
    ) {
      throw dataError(`Invalid Role/session state: ${taskId}/${role.name}`);
    }
    if (this.getChildRole(taskId, storedRole.name) !== null) {
      throw dataError(`Role name is already owned by a child role: ${taskId}/${storedRole.name}`);
    }
    const existingSessionSet = this.getRoleSessionSet(taskId, storedRole.name);
    this.assertSessionIdentityLineagePreserved(
      existingSessionSet,
      storedSessionSet,
      allowMonotonicImport
    );
    if (existingSessionSet !== null) this.reserveSessionIdentities(existingSessionSet);
    if (storedSessionSet !== null) {
      this.assertSessionIdentitiesUnique(storedSessionSet);
      this.reserveSessionIdentities(storedSessionSet);
    }
    this.writeRoleRecord(taskId, storedRole);
    if (storedSessionSet === null) {
      rmSync(this.roleSessionSetFile(taskId, storedRole.name), { force: true });
      return;
    }
    mkdirSync(this.roleSessionSetsDir(taskId), { recursive: true });
    this.writeSnapshot(
      this.roleSessionSetFile(taskId, storedRole.name),
      `${JSON.stringify(storedSessionSet, null, 2)}\n`
    );
  }

  createRoleIfAbsent(taskId: string, role: Role): Role | null {
    const storedRole = snapshotTaskRoleRecord(role, taskId);
    if (storedRole === null) throw dataError("Invalid role record");
    if (
      this.getRole(taskId, storedRole.name) !== null ||
      this.readOptionalText(this.roleInfoFile(taskId, storedRole.name)) !== null
    ) return null;
    this.saveRole(taskId, storedRole);
    return storedRole;
  }

  compareAndSwapRole(taskId: string, expectedUpdatedAt: string, role: Role): Role | null {
    const storedRole = snapshotTaskRoleRecord(role, taskId);
    if (storedRole === null) throw dataError("Invalid role record");
    const current = this.getRole(taskId, storedRole.name);
    if (current === null || current.updatedAt !== expectedUpdatedAt) return null;
    const updated = withCanonicalRoleRevision(storedRole, current.updatedAt);
    this.saveRole(taskId, updated);
    return updated;
  }

  compareAndSwapRoleWithSessionSet(
    taskId: string,
    expectedUpdatedAt: string,
    expectedSessionSet: TaskRoleSessionSet | null,
    role: Role,
    sessionSet: TaskRoleSessionSet
  ): Role | null {
    const storedRole = snapshotTaskRoleRecord(role, taskId);
    const storedExpected = expectedSessionSet === null
      ? null
      : snapshotTaskRoleSessionSetRecord(expectedSessionSet, taskId, role.name);
    const storedSessionSet = snapshotTaskRoleSessionSetRecord(sessionSet, taskId, role.name);
    if (
      storedRole === null ||
      (expectedSessionSet !== null && storedExpected === null) ||
      storedSessionSet === null ||
      !sessionSetMatchesRole(storedSessionSet, storedRole)
    ) throw dataError(`Invalid Role/session state: ${taskId}/${role.name}`);
    const current = this.getRole(taskId, storedRole.name);
    const currentSessionSet = this.getRoleSessionSet(taskId, storedRole.name);
    if (
      current === null ||
      current.updatedAt !== expectedUpdatedAt ||
      !isDeepStrictEqual(currentSessionSet, storedExpected)
    ) return null;
    const updated = withCanonicalRoleRevision(storedRole, current.updatedAt);
    this.saveRoleWithSessionSet(taskId, updated, storedSessionSet);
    return updated;
  }

  private writeRoleRecord(taskId: string, role: Role): void {
    const roleDir = this.roleDir(taskId, role.name);
    const encoded = taskRecordCodec.encodeRole(role);
    mkdirSync(roleDir, { recursive: true });
    this.writeSnapshot(this.roleFile(taskId, role.name), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    this.writeSnapshot(this.roleInfoFile(taskId, role.name), `${JSON.stringify(encoded.info, null, 2)}\n`);
  }

  renameRole(taskId: string, oldName: string, role: Role): void {
    const storedRole = snapshotTaskRoleRecord(role, taskId);
    if (storedRole === null) throw dataError("Invalid role record");
    const roleName = storedRole.name;
    if (oldName === roleName) {
      throw dataError("Role rename requires different Role names.");
    }
    const storageName = this.readOptionalText(this.roleFile(taskId, oldName)) === null
      ? null
      : oldName;
    if (storageName === null) return;
    if (this.getRole(taskId, roleName) !== null || this.getChildRole(taskId, roleName) !== null) {
      throw dataError(`Role name is already owned: ${taskId}/${roleName}`);
    }

    const existingSessions = this.getRoleSessionSet(taskId, oldName);
    const roleWorktree = this.getRoleWorktree(taskId, oldName);
    const activeRun = this.getActiveAgentRun(taskId, oldName);
    const historicalRuns = this.jsonRecordIds(this.agentRunsDir(taskId))
      .map((runId) => this.getAgentRun(taskId, runId))
      .filter((run): run is AgentRun => run !== null && run.roleName === oldName);
    const childRoles = this.listChildRoles(taskId).filter((child) => child.parentRole === oldName);
    const assignedWorkItems = this.listWorkItems(taskId).filter((item) => item.assignee === oldName);
    const renamedSessions = existingSessions === null
      ? null
      : snapshotTaskRoleSessionSetRecord(
        { ...existingSessions, owner: { ...existingSessions.owner, roleName } },
        taskId,
        roleName
      );
    if (existingSessions !== null && (
      renamedSessions === null || !sessionSetMatchesRole(renamedSessions, storedRole)
    )) {
      throw dataError(`Invalid role session set: ${taskId}/${roleName}`);
    }
    if (renamedSessions !== null) {
      this.assertSessionIdentityTransferCompatibleWithTrash(renamedSessions);
      this.reserveSessionIdentities(existingSessions as TaskRoleSessionSet);
    }

    const encoded = taskRecordCodec.encodeRole(storedRole);
    taskRecordCodec.decodeRole(
      taskId,
      roleName,
      JSON.stringify(encoded.runtime),
      JSON.stringify(encoded.info)
    );
    this.writeSnapshot(this.roleFile(taskId, storageName), `${JSON.stringify(encoded.runtime, null, 2)}\n`);
    this.writeSnapshot(this.roleInfoFile(taskId, storageName), `${JSON.stringify(encoded.info, null, 2)}\n`);
    renameSync(this.roleDir(taskId, storageName), this.roleDir(taskId, roleName));

    if (roleWorktree !== null) {
      this.saveRoleWorktree(taskId, { ...roleWorktree, roleName });
    }
    if (renamedSessions !== null && existingSessions !== null) {
      mkdirSync(this.roleSessionSetsDir(taskId), { recursive: true });
      this.writeSnapshot(
        this.roleSessionSetFile(taskId, roleName),
        `${JSON.stringify(renamedSessions, null, 2)}\n`
      );
      rmSync(this.roleSessionSetFile(taskId, oldName), { force: true });
      this.transferSessionIdentityOwnership(existingSessions.owner, renamedSessions.owner, renamedSessions);
    }
    if (activeRun !== null) {
      this.clearActiveAgentRun(taskId, oldName);
      this.saveActiveAgentRun({ ...activeRun, roleName });
    }
    for (const run of historicalRuns) this.saveAgentRun({ ...run, roleName });
    for (const child of childRoles) {
      this.saveChildRole(taskId, { ...child, parentRole: roleName, updatedAt: storedRole.updatedAt });
    }
    for (const item of assignedWorkItems) {
      this.saveWorkItem(taskId, { ...item, assignee: roleName, updatedAt: storedRole.updatedAt });
    }
  }

  listRoles(taskId: string): Role[] {
    return this.directoryNames(this.rolesDir(taskId))
      .map((name) => this.readRoleByStorageName(taskId, name))
      .filter((role): role is Role => role !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getRole(taskId: string, name: string): Role | null {
    try {
      return this.getRoleByStorageName(taskId, name);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  saveChildRole(taskId: string, role: ChildRole): void {
    const roleDir = this.roleDir(taskId, role.name);
    mkdirSync(roleDir, { recursive: true });
    rmSync(this.roleFile(taskId, role.name), { force: true });
    this.writeSnapshot(this.roleInfoFile(taskId, role.name), `${JSON.stringify(role, null, 2)}\n`);
  }

  getChildRole(taskId: string, name: string): ChildRole | null {
    const raw = this.readOptionalText(this.roleInfoFile(taskId, name));

    if (raw === null) {
      return null;
    }

    const value = parseJson(raw, `Invalid child role record: ${name}`);
    if (!isRecord(value) || value.architecture !== "child") {
      return null;
    }

    return parseChildRole(name, raw);
  }

  listChildRoles(taskId: string): ChildRole[] {
    return this.directoryNames(this.rolesDir(taskId))
      .map((name) => this.getChildRole(taskId, name))
      .filter((role): role is ChildRole => role !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  removeTaskRole(taskId: string, name: string): { removed: boolean; childCount: number } {
    const roleDir = this.roleDir(taskId, name);
    const exists = this.readOptionalText(this.roleFile(taskId, name)) !== null ||
      this.readOptionalText(this.roleInfoFile(taskId, name)) !== null;

    if (!exists) {
      return { removed: false, childCount: 0 };
    }

    const childNames = this.directoryNames(this.rolesDir(taskId)).filter((candidate) =>
      this.getChildRole(taskId, candidate)?.parentRole === name
    );
    const sessionSet = this.getRoleSessionSet(taskId, name);
    if (sessionSet !== null) this.reserveSessionIdentities(sessionSet);
    rmSync(roleDir, { recursive: true, force: true });
    rmSync(this.roleSessionSetFile(taskId, name), { force: true });
    childNames.forEach((childName) => rmSync(this.roleDir(taskId, childName), { recursive: true, force: true }));
    return { removed: true, childCount: childNames.length };
  }

  saveGlobalRole(role: GlobalRole): void {
    const storedRole = snapshotGlobalRoleRecord(role);
    if (storedRole === null) throw dataError("Invalid global role record");
    const sessionRaw = this.readOptionalText(this.globalRoleSessionSetFile(storedRole.name));
    if (sessionRaw !== null) {
      const sessionSet = parseGlobalRoleSessionSet(storedRole.name, sessionRaw);
      if (!sessionSetMatchesRole(sessionSet, storedRole)) {
        throw dataError(`Global Role update is incompatible with its session set: ${storedRole.name}`);
      }
      this.reserveSessionIdentities(sessionSet);
    }
    this.writeGlobalRoleRecord(storedRole);
  }

  saveGlobalRoleWithSessionSet(
    role: GlobalRole,
    sessionSet: GlobalRoleSessionSet | null,
    allowMonotonicImport = false
  ): void {
    const storedRole = snapshotGlobalRoleRecord(role);
    const storedSessionSet = sessionSet === null
      ? null
      : snapshotGlobalRoleSessionSetRecord(sessionSet, role.name);
    if (
      storedRole === null ||
      (sessionSet !== null && (storedSessionSet === null || !sessionSetMatchesRole(storedSessionSet, storedRole)))
    ) throw dataError(`Invalid global Role/session state: ${role.name}`);
    const existingSessionSet = this.getGlobalRoleSessionSet(storedRole.name);
    this.assertSessionIdentityLineagePreserved(
      existingSessionSet,
      storedSessionSet,
      allowMonotonicImport
    );
    if (existingSessionSet !== null) this.reserveSessionIdentities(existingSessionSet);
    if (storedSessionSet !== null) {
      this.assertSessionIdentitiesUnique(storedSessionSet);
      this.reserveSessionIdentities(storedSessionSet);
    }
    this.writeGlobalRoleRecord(storedRole);
    if (storedSessionSet === null) {
      rmSync(this.globalRoleSessionSetFile(storedRole.name), { force: true });
      return;
    }
    mkdirSync(this.globalRoleSessionSetsDir(), { recursive: true });
    this.writeSnapshot(
      this.globalRoleSessionSetFile(storedRole.name),
      `${JSON.stringify(storedSessionSet, null, 2)}\n`
    );
  }

  createGlobalRoleIfAbsent(role: GlobalRole): GlobalRole | null {
    const storedRole = snapshotGlobalRoleRecord(role);
    if (storedRole === null) throw dataError("Invalid global role record");
    if (this.getGlobalRole(storedRole.name) !== null) return null;
    this.saveGlobalRole(storedRole);
    return storedRole;
  }

  compareAndSwapGlobalRole(expectedUpdatedAt: string, role: GlobalRole): GlobalRole | null {
    const storedRole = snapshotGlobalRoleRecord(role);
    if (storedRole === null) throw dataError("Invalid global role record");
    const current = this.getGlobalRole(storedRole.name);
    if (current === null || current.updatedAt !== expectedUpdatedAt) return null;
    const updated = withCanonicalRoleRevision(storedRole, current.updatedAt);
    this.saveGlobalRole(updated);
    return updated;
  }

  compareAndSwapGlobalRoleWithSessionSet(
    expectedUpdatedAt: string,
    expectedSessionSet: GlobalRoleSessionSet | null,
    role: GlobalRole,
    sessionSet: GlobalRoleSessionSet
  ): GlobalRole | null {
    const storedRole = snapshotGlobalRoleRecord(role);
    const storedExpected = expectedSessionSet === null
      ? null
      : snapshotGlobalRoleSessionSetRecord(expectedSessionSet, role.name);
    const storedSessionSet = snapshotGlobalRoleSessionSetRecord(sessionSet, role.name);
    if (
      storedRole === null ||
      (expectedSessionSet !== null && storedExpected === null) ||
      storedSessionSet === null ||
      !sessionSetMatchesRole(storedSessionSet, storedRole)
    ) throw dataError(`Invalid global Role/session state: ${role.name}`);
    const current = this.getGlobalRole(storedRole.name);
    const currentSessionSet = this.getGlobalRoleSessionSet(storedRole.name);
    if (
      current === null ||
      current.updatedAt !== expectedUpdatedAt ||
      !isDeepStrictEqual(currentSessionSet, storedExpected)
    ) return null;
    const updated = withCanonicalRoleRevision(storedRole, current.updatedAt);
    this.saveGlobalRoleWithSessionSet(updated, storedSessionSet);
    return updated;
  }

  private writeGlobalRoleRecord(role: GlobalRole): void {
    const roleDir = this.globalRoleDir(role.name);
    mkdirSync(roleDir, { recursive: true });
    this.writeSnapshot(this.globalRoleFile(role.name), `${JSON.stringify(role, null, 2)}\n`);
  }

  listGlobalRoles(): GlobalRole[] {
    return this.directoryNames(this.globalRolesDir())
      .map((name) => this.getGlobalRole(name))
      .filter((role): role is GlobalRole => role !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getGlobalRole(name: string): GlobalRole | null {
    const raw = this.readOptionalText(this.globalRoleFile(name));
    return raw === null ? null : parseGlobalRole(name, raw);
  }

  removeGlobalRole(name: string): boolean {
    if (this.getGlobalRole(name) === null) return false;
    try {
      const sessionSet = this.getGlobalRoleSessionSet(name);
      if (sessionSet !== null) this.reserveSessionIdentities(sessionSet);
      rmSync(this.globalRoleDir(name), { recursive: true });
      rmSync(this.globalRoleSessionSetFile(name), { force: true });
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  nextCommentId(taskId: string): string {
    return `comment-${this.listComments(taskId).length + 1}`;
  }

  saveComment(taskId: string, comment: TaskComment): void {
    const existing = this.readOptionalText(this.commentsFile(taskId)) ?? "";
    this.writeSnapshot(this.commentsFile(taskId), `${existing}${JSON.stringify(comment)}\n`);
  }

  listComments(taskId: string): TaskComment[] {
    const raw = this.readOptionalText(this.commentsFile(taskId));
    return raw === null
      ? []
      : raw.split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line, index) => parseComment(`${taskId}:${index + 1}`, line));
  }

  nextEventId(taskId: string): string {
    return `event-${this.listEvents(taskId).length + 1}`;
  }

  saveEvent(taskId: string, event: TaskEvent): void {
    const existing = this.readOptionalText(this.eventsFile(taskId)) ?? "";
    this.writeSnapshot(this.eventsFile(taskId), `${existing}${JSON.stringify(event)}\n`);
  }

  listEvents(taskId: string): TaskEvent[] {
    const raw = this.readOptionalText(this.eventsFile(taskId));
    return raw === null
      ? []
      : raw.split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line, index) => parseEvent(`${taskId}:${index + 1}`, line));
  }

  saveTranscript(taskId: string, roleName: string, transcript: string): void {
    const storageName = this.resolveRoleStorageName(taskId, roleName) ?? roleName;
    const roleDir = this.roleDir(taskId, storageName);
    mkdirSync(roleDir, { recursive: true });
    this.writeSnapshot(this.transcriptFile(taskId, storageName), transcript);
  }

  clearTranscript(taskId: string, roleName: string): void {
    const storageName = this.resolveRoleStorageName(taskId, roleName) ?? roleName;
    rmSync(this.transcriptFile(taskId, storageName), { force: true });
  }

  readTranscript(taskId: string, roleName: string): string | null {
    const storageName = this.resolveRoleStorageName(taskId, roleName);

    if (storageName === null) {
      return null;
    }

    return this.readOptionalText(this.transcriptFile(taskId, storageName));
  }

  saveConfiguredAgent(agent: ConfiguredAgent): void {
    const stored = snapshotConfiguredAgentRecord(agent);
    if (stored === null) throw dataError("Invalid agent record");
    this.writeConfiguredAgent(stored);
  }

  createConfiguredAgentIfAbsent(agent: ConfiguredAgent): ConfiguredAgent | null {
    const stored = snapshotConfiguredAgentRecord(agent);
    if (stored === null) throw dataError("Invalid agent record");
    if (this.getConfiguredAgent(stored.id) !== null) return null;
    this.writeConfiguredAgent(stored);
    return stored;
  }

  updateConfiguredAgent(
    id: string,
    patch: ConfiguredAgentPatch,
    now: Date
  ): ConfiguredAgentUpdateResult | null {
    const storedPatch = snapshotConfiguredAgentPatch(patch);
    if (storedPatch === null || Object.keys(storedPatch).length === 0) {
      throw usageError("Agent update requires at least one operational option.");
    }
    if (!Number.isFinite(now.getTime())) throw usageError("Agent update timestamp is invalid.");
    const existing = this.getConfiguredAgent(id);
    if (existing === null) return null;
    let candidate: ConfiguredAgent;
    try {
      const probePin = storedPatch.probePin === undefined
        ? (storedPatch.adapterId === undefined && storedPatch.command === undefined
          ? existing.probePin
          : undefined)
        : storedPatch.probePin ?? undefined;
      const refreshRequired = storedPatch.probePinRefreshRequired === undefined
        ? (storedPatch.probePin === undefined &&
            storedPatch.adapterId === undefined &&
            storedPatch.command === undefined
          ? existing.probePinRefreshRequired
          : undefined)
        : storedPatch.probePinRefreshRequired ?? undefined;
      candidate = {
        ...createConfiguredAgent(
          existing.id,
          storedPatch.adapterId ?? existing.adapterId,
          storedPatch.command ?? existing.command,
          storedPatch.baseArgs ?? existing.baseArgs,
          storedPatch.environment ?? existing.environment,
          now,
          probePin,
          probePin === undefined ? refreshRequired : undefined
        ),
        createdAt: existing.createdAt
      };
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
    if (sameConfiguredAgentOperation(existing, candidate)) {
      return { status: "unchanged", agent: existing };
    }
    this.writeConfiguredAgent(candidate);
    return { status: "updated", agent: candidate };
  }

  private writeConfiguredAgent(agent: ConfiguredAgent): void {
    const agentDir = this.agentDir(agent.id);
    mkdirSync(agentDir, { recursive: true });
    this.writeSnapshot(this.agentFile(agent.id), `${JSON.stringify(agent, null, 2)}\n`);
  }

  listConfiguredAgents(): ConfiguredAgent[] {
    return this.directoryNames(this.agentsDir())
      .map((name) => this.getConfiguredAgent(name))
      .filter((agent): agent is ConfiguredAgent => agent !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getConfiguredAgent(id: string): ConfiguredAgent | null {
    const raw = this.readOptionalText(this.agentFile(id));
    return raw === null ? null : parseConfiguredAgent(id, raw);
  }

  removeConfiguredAgent(id: string): boolean {
    try {
      rmSync(this.agentDir(id), { recursive: true });
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  saveConfiguredSkill(skill: ConfiguredSkill): void {
    const stored = snapshotConfiguredSkillRecord(skill);
    if (stored === null) throw dataError("Invalid configured Skill record.");
    const skillDir = this.configuredSkillDir(stored.id);
    mkdirSync(skillDir, { recursive: true });
    this.writeSnapshot(this.configuredSkillFile(stored.id), stored.content);
  }

  listConfiguredSkills(): ConfiguredSkill[] {
    if (this.pinnedReader === undefined) {
      return this.runReadSnapshot((reader) => reader.listConfiguredSkills());
    }
    return this.directoryNames(this.configuredSkillsDir())
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map((id) => {
        if (!isConfiguredSkillId(id)) {
          throw dataError(`Invalid configured Skill record: ${id}`);
        }
        const skill = this.getConfiguredSkill(id);
        if (skill === null) {
          throw dataError(`Invalid configured Skill record: ${id}`);
        }
        return skill;
      });
  }

  getConfiguredSkill(id: string): ConfiguredSkill | null {
    if (!isConfiguredSkillId(id)) throw dataError("Invalid configured Skill id.");
    if (this.pinnedReader === undefined) {
      return this.runReadSnapshot((reader) => reader.getConfiguredSkill(id));
    }
    const content = this.readOptionalText(this.configuredSkillFile(id));
    if (content === null) return null;
    try {
      return createConfiguredSkillRecord(id, content);
    } catch {
      throw dataError(`Invalid configured Skill record: ${id}`);
    }
  }

  pruneTrashedTasks(taskIds?: readonly string[]): number {
    const selected = taskIds === undefined
      ? this.directoryNames(this.trashedTasksDir())
      : [...new Set(taskIds.map((taskId) => requireSafeStorageSegment(taskId, "task")))]
        .filter((taskId) => existsSync(this.trashedTaskDir(taskId)));
    const trashedSessionSets = selected.flatMap((taskId) => this.listTrashedRoleSessionSets(taskId));
    this.retireTrashedSessionIdentities(trashedSessionSets);
    for (const taskId of selected) {
      rmSync(this.trashedTaskDir(taskId), { recursive: true, force: true });
    }
    return selected.length;
  }

  /**
   * Clears task-scoped host runtime before portable import creates task
   * semantic authority where no live Task currently exists. This only runs
   * inside the import's caller-owned domain transaction, never restores host
   * state, and refuses to bypass a live runtime-operation fence.
   */
  clearNonportableTaskRuntimeForPortableImport(taskIds: readonly string[]): void {
    if (!hasActiveDomainTransactionAuthority(this.rootDir)) {
      throw new Error("Portable import runtime cleanup requires an active FileTaskStore transaction.");
    }
    const selected = [...new Set(taskIds.map((taskId) =>
      requireSafeStorageSegment(taskId, "task")))];
    if (selected.length === 0) return;
    this.assertPortableImportRuntimeUnfenced(selected);
    const selectedIds = new Set(selected);
    const staleSessionSets = selected.flatMap((taskId) => this.listRoleSessionSets(taskId));
    for (const taskId of selected) {
      rmSync(this.activeAgentRunsDir(taskId), { recursive: true, force: true });
      rmSync(this.roleSessionSetsDir(taskId), { recursive: true, force: true });
      rmSync(this.pendingWakeupFile(taskId), { force: true });
      rmSync(this.leaderFailureFile(taskId), { force: true });
      rmSync(this.operatorNotificationFile(taskId), { force: true });
      rmSync(this.offlineResolutionClockTaskDir(taskId), { recursive: true, force: true });
      rmSync(this.inputResolutionWakeupTaskDir(taskId), { recursive: true, force: true });
    }
    for (const delivery of this.listOperatorDeliveries()) {
      if (selectedIds.has(delivery.taskId)) {
        rmSync(this.operatorDeliveryFile(delivery.deliveryId), { force: true });
      }
    }
    this.retireTrashedSessionIdentities(staleSessionSets);
  }

  /**
   * Removes host-local Role sessions attached to existing portable trash
   * records. This runs only inside the import transaction and never restores
   * a discarded host session on a later Task restore.
   */
  clearTrashedRoleSessionsForPortableImport(taskIds: readonly string[]): void {
    if (!hasActiveDomainTransactionAuthority(this.rootDir)) {
      throw new Error("Portable import trash-session cleanup requires an active FileTaskStore transaction.");
    }
    const selected = [...new Set(taskIds.map((taskId) =>
      requireSafeStorageSegment(taskId, "task")))]
      .filter((taskId) => existsSync(this.trashedTaskDir(taskId)));
    if (selected.length === 0) return;
    this.assertPortableImportRuntimeUnfenced(selected);
    const sessionSets = selected.flatMap((taskId) => this.listTrashedRoleSessionSets(taskId));
    this.retireTrashedSessionIdentities(sessionSets);
    for (const taskId of selected) {
      rmSync(this.trashedRoleSessionSetsDir(taskId), { recursive: true, force: true });
    }
  }

  private assertPortableImportRuntimeUnfenced(taskIds: readonly string[]): void {
    const selectedIds = new Set(taskIds);
    const fenced = listRuntimeOperationClaims(this.rootDir).find((claim) =>
      claim.taskId !== null && selectedIds.has(claim.taskId)
    );
    if (fenced !== undefined) {
      throw dataError(`Portable import cannot replace Task with an active runtime operation: ${fenced.taskId}.`);
    }
  }

  private tasksDir(): string {
    return join(this.rootDir, "tasks");
  }

  private configFile(): string {
    return join(this.rootDir, "config.json");
  }

  private taskDir(id: string): string {
    return join(this.tasksDir(), id);
  }

  private taskFile(id: string): string {
    return join(this.taskDir(id), "task.json");
  }

  private taskInfoFile(id: string): string {
    return join(this.taskDir(id), "info.json");
  }

  private topicsFile(taskId: string): string {
    return join(this.taskDir(taskId), "topics.json");
  }

  private taskInputDraftFile(taskId: string): string {
    return join(this.taskDir(taskId), "input-draft.json");
  }

  private inputRequestsDir(taskId: string): string {
    return join(this.taskDir(taskId), "input-requests");
  }

  private inputRequestFile(taskId: string, requestId: string): string {
    return join(this.inputRequestsDir(taskId), `${requestId}.json`);
  }

  private inputResolutionsDir(taskId: string): string {
    return join(this.taskDir(taskId), "input-resolutions");
  }

  private inputResolutionFile(taskId: string, resolutionId: string): string {
    return join(this.inputResolutionsDir(taskId), `${resolutionId}.json`);
  }

  private taskScheduleFile(taskId: string): string {
    return join(this.taskDir(taskId), "schedule.json");
  }

  private taskBriefFile(taskId: string): string {
    return join(this.taskDir(taskId), "brief.md");
  }

  private taskTopicSummariesFile(taskId: string): string {
    return join(this.taskDir(taskId), "topic-summaries.md");
  }

  private taskTimelineFile(taskId: string): string {
    return join(this.taskDir(taskId), "timeline.md");
  }

  private milestonesDir(taskId: string): string {
    return join(this.taskDir(taskId), "milestones");
  }

  private milestoneFile(taskId: string, milestoneId: string): string {
    return join(this.milestonesDir(taskId), `${milestoneId}.json`);
  }

  private decisionsDir(taskId: string): string {
    return join(this.taskDir(taskId), "decisions");
  }

  private decisionFile(taskId: string, decisionId: string): string {
    return join(this.decisionsDir(taskId), `${decisionId}.json`);
  }

  private runtimeDir(): string {
    return join(this.rootDir, "runtime");
  }

  private nativeSessionIdentityLedgerFile(): string {
    return join(this.runtimeDir(), "native-session-identities.json");
  }

  private pendingWakeupsDir(): string {
    return join(this.runtimeDir(), "pending-wakeups");
  }

  private pendingWakeupFile(taskId: string): string {
    return join(this.pendingWakeupsDir(), `${taskId}.json`);
  }

  private leaderFailuresDir(): string {
    return join(this.runtimeDir(), "leader-failures");
  }

  private leaderFailureFile(taskId: string): string {
    return join(this.leaderFailuresDir(), `${taskId}.json`);
  }

  private operatorNotificationsDir(): string {
    return join(this.runtimeDir(), "operator-notifications");
  }

  private operatorNotificationFile(taskId: string): string {
    return join(this.operatorNotificationsDir(), `${taskId}.json`);
  }

  private operatorDeliveriesDir(): string {
    return join(this.runtimeDir(), "operator-deliveries");
  }

  private operatorDeliveryFile(deliveryId: string): string {
    return join(this.operatorDeliveriesDir(), `${deliveryId}.json`);
  }

  private offlineResolutionClocksDir(): string {
    return join(this.runtimeDir(), "offline-resolution-clocks");
  }

  private offlineResolutionClockTaskDir(taskId: string): string {
    return join(this.offlineResolutionClocksDir(), taskId);
  }

  private offlineResolutionClockFile(taskId: string, requestId: string): string {
    return join(this.offlineResolutionClockTaskDir(taskId), `${requestId}.json`);
  }

  private inputResolutionWakeupsDir(): string {
    return join(this.runtimeDir(), "input-resolution-wakeups");
  }

  private inputResolutionWakeupTaskDir(taskId: string): string {
    return join(this.inputResolutionWakeupsDir(), taskId);
  }

  private inputResolutionWakeupFile(taskId: string, requestId: string): string {
    return join(this.inputResolutionWakeupTaskDir(taskId), `${requestId}.json`);
  }

  private cyclesDir(taskId: string): string {
    return join(this.taskDir(taskId), "cycles");
  }

  private cycleFile(taskId: string, cycleId: string): string {
    return join(this.cyclesDir(taskId), `${cycleId}.json`);
  }

  private workItemsDir(taskId: string): string {
    return join(this.taskDir(taskId), "work-items");
  }

  private workItemFile(taskId: string, workItemId: string): string {
    return join(this.workItemsDir(taskId), `${workItemId}.json`);
  }

  private roleSessionsDir(): string {
    return join(this.runtimeDir(), "role-sessions");
  }

  private roleSessionSetsDir(taskId: string): string {
    return join(this.roleSessionsDir(), "tasks", requireSafeStorageSegment(taskId, "task"));
  }

  private roleSessionSetFile(taskId: string, roleName: string): string {
    return join(this.roleSessionSetsDir(taskId), `${requireSafeStorageSegment(roleName, "role")}.json`);
  }

  private globalRoleSessionSetsDir(): string {
    return join(this.roleSessionsDir(), "global");
  }

  private globalRoleSessionSetFile(roleName: string): string {
    return join(this.globalRoleSessionSetsDir(), `${requireSafeStorageSegment(roleName, "role")}.json`);
  }

  private agentRunsDir(taskId: string): string {
    return join(this.taskDir(taskId), "agent-runs");
  }

  private agentRunFile(taskId: string, runId: string): string {
    return join(this.agentRunsDir(taskId), `${runId}.json`);
  }

  private activeRunsDir(): string {
    return join(this.runtimeDir(), "active-runs");
  }

  private activeAgentRunsDir(taskId: string): string {
    return join(this.activeRunsDir(), taskId);
  }

  private activeAgentRunFile(taskId: string, roleName: string): string {
    return join(this.activeAgentRunsDir(taskId), `${roleName}.json`);
  }

  private trashDir(): string {
    return join(this.rootDir, "trash");
  }

  private trashedTasksDir(): string {
    return join(this.trashDir(), "tasks");
  }

  private trashedTaskDir(id: string): string {
    return join(this.trashedTasksDir(), id);
  }

  private trashedTaskFile(id: string): string {
    return join(this.trashedTaskDir(id), "task.json");
  }

  private trashTaskStore(): FileTaskStore {
    const prefix = this.pinnedRootPrefix.length === 0
      ? "trash"
      : `${this.pinnedRootPrefix}/trash`;
    return new FileTaskStore(
      this.trashDir(),
      this.pinnedReader,
      false,
      this.runtimeOperationToken,
      this.runtimeRecoveryToken,
      prefix
    );
  }

  private trashedRoleSessionSetsDir(taskId: string): string {
    return join(this.trashedTaskDir(taskId), "role-sessions");
  }

  private trashedRoleSessionSetFile(taskId: string, roleName: string): string {
    return join(
      this.trashedRoleSessionSetsDir(taskId),
      `${requireSafeStorageSegment(roleName, "role")}.json`
    );
  }

  private trashedRolesDir(taskId: string): string {
    return join(this.trashedTaskDir(taskId), "roles");
  }

  private trashedRoleDir(taskId: string, name: string): string {
    return join(this.trashedRolesDir(taskId), requireSafeStorageSegment(name, "role"));
  }

  private trashedRoleFile(taskId: string, name: string): string {
    return join(this.trashedRoleDir(taskId, name), "role.json");
  }

  private trashedRoleInfoFile(taskId: string, name: string): string {
    return join(this.trashedRoleDir(taskId, name), "info.json");
  }

  private commentsFile(taskId: string): string {
    return join(this.taskDir(taskId), "comments.jsonl");
  }

  private eventsFile(taskId: string): string {
    return join(this.taskDir(taskId), "events.jsonl");
  }

  private rolesDir(taskId: string): string {
    return join(this.taskDir(taskId), "roles");
  }

  private globalRolesDir(): string {
    return join(this.rootDir, "roles");
  }

  private globalRoleDir(name: string): string {
    return join(this.globalRolesDir(), name);
  }

  private globalRoleFile(name: string): string {
    return join(this.globalRoleDir(name), "role.json");
  }

  private roleDir(taskId: string, name: string): string {
    return join(this.rolesDir(taskId), name);
  }

  private roleFile(taskId: string, name: string): string {
    return join(this.roleDir(taskId, name), "role.json");
  }

  private roleInfoFile(taskId: string, name: string): string {
    return join(this.roleDir(taskId, name), "info.json");
  }

  private roleWorktreeFile(taskId: string, name: string): string {
    return join(this.roleDir(taskId, name), "worktree.json");
  }

  private transcriptFile(taskId: string, name: string): string {
    return join(this.roleDir(taskId, name), "transcript.log");
  }

  private agentsDir(): string {
    return join(this.rootDir, "agents");
  }

  private agentDir(id: string): string {
    return join(this.agentsDir(), id);
  }

  private agentFile(id: string): string {
    return join(this.agentDir(id), "agent.json");
  }

  private configuredSkillsDir(): string {
    return join(this.rootDir, "skills");
  }

  private configuredSkillDir(id: string): string {
    if (!isConfiguredSkillId(id)) throw dataError("Invalid configured Skill id.");
    return join(this.configuredSkillsDir(), id);
  }

  private configuredSkillFile(id: string): string {
    return join(this.configuredSkillDir(id), "SKILL.md");
  }

  private getRoleByStorageName(taskId: string, storageName: string): Role | null {
    const role = this.readRoleByStorageName(taskId, storageName);

    return role?.name === storageName ? role : null;
  }

  private readRoleByStorageName(taskId: string, storageName: string): Role | null {
    const runtimeRaw = this.readOptionalText(this.roleFile(taskId, storageName));

    if (runtimeRaw === null) {
      return null;
    }

    const infoRaw = this.readOptionalText(this.roleInfoFile(taskId, storageName));

    return taskRecordCodec.decodeRole(taskId, storageName, runtimeRaw, infoRaw);
  }

  private findRoleByInfoName(taskId: string, name: string): Role | null {
    for (const storageName of this.directoryNames(this.rolesDir(taskId))) {
      const role = this.readRoleByStorageName(taskId, storageName);

      if (role !== null && role.name === name) {
        return role;
      }
    }

    return null;
  }

  private resolveRoleStorageName(taskId: string, name: string): string | null {
    if (this.readOptionalText(this.roleFile(taskId, name)) !== null) {
      return name;
    }

    for (const storageName of this.directoryNames(this.rolesDir(taskId))) {
      const role = this.readRoleByStorageName(taskId, storageName);

      if (role !== null && role.name === name) {
        return storageName;
      }
    }

    return null;
  }

  private directoryNames(path: string): string[] {
    if (this.pinnedReader !== undefined) {
      if (this.pinnedReader === null) return [];
      const relativePath = this.pinnedRelativePath(path);
      try {
        return this.pinnedReader.readdir(relativePath)
          .filter((name) => this.pinnedEntryIs(relativePath, name, DIRECTORY_MODE));
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return [];
        throw error;
      }
    }
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private jsonRecordIds(path: string): string[] {
    if (this.pinnedReader !== undefined) {
      if (this.pinnedReader === null) return [];
      const relativePath = this.pinnedRelativePath(path);
      try {
        return this.pinnedReader.readdir(relativePath)
          .filter((name) => name.endsWith(".json"))
          .filter((name) => this.pinnedEntryIs(relativePath, name, REGULAR_FILE_MODE))
          .map((name) => name.slice(0, -5))
          .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return [];
        throw error;
      }
    }
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -5))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private writeSnapshot(target: string, content: string): void {
    this.assertPathRuntimeOperationAllowsMutation(target);
    if (this.ephemeral) {
      writeTextFileAtomically(target, content);
      return;
    }
    writeRecoverableSnapshot(this.rootDir, target, content);
  }

  private assertPathRuntimeOperationAllowsMutation(target: string): void {
    const parts = relative(this.rootDir, target).split(sep);
    if (parts[0] === "tasks" && parts[1] !== undefined) {
      if (parts[2] === "roles" && parts[3] !== undefined) {
        assertRuntimeOperationAllowsMutation(
          this.rootDir,
          { scope: "task-role", taskId: parts[1], roleName: parts[3] },
          this.runtimeOperationToken,
          this.runtimeRecoveryToken
        );
        return;
      }
      assertRuntimeOperationAllowsMutation(
        this.rootDir,
        { scope: "task", taskId: parts[1] },
        this.runtimeOperationToken,
        this.runtimeRecoveryToken
      );
      return;
    }
    if (parts[0] === "roles" && parts[1] !== undefined) {
      assertRuntimeOperationAllowsMutation(
        this.rootDir,
        { scope: "global-role", roleName: parts[1] },
        this.runtimeOperationToken,
        this.runtimeRecoveryToken
      );
    }
  }

  private readOptionalText(path: string): string | null {
    if (this.pinnedReader !== undefined) {
      if (this.pinnedReader === null) return null;
      try {
        return this.pinnedReader.readFileExact(
          this.pinnedRelativePath(path),
          MAX_PINNED_READ_BYTES
        ).bytes.toString("utf8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
      }
    }
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  private pinnedRelativePath(path: string): string {
    const relativePath = relative(this.rootDir, path);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw dataError("TaskMux pinned read path escaped its storage root.");
    }
    const localPath = relativePath.length === 0 ? "." : relativePath.split(sep).join("/");
    if (this.pinnedRootPrefix.length === 0) {
      return localPath;
    }
    return localPath === "."
      ? this.pinnedRootPrefix
      : `${this.pinnedRootPrefix}/${localPath}`;
  }

  private clearPendingWakeupIfExpected(expected: PendingWakeup): boolean {
    const current = this.getPendingWakeup(expected.taskId);
    if (current === null || !pendingWakeupsMatch(current, expected)) {
      return false;
    }
    this.clearPendingWakeup(expected.taskId);
    return true;
  }

  private pinnedEntryIs(directory: string, name: string, type: bigint): boolean {
    const path = directory === "." ? name : `${directory}/${name}`;
    const identity = this.pinnedReader?.lstat(path);
    return identity !== undefined && (identity.mode & FILE_TYPE_MASK) === type;
  }

  private assertSessionIdentitiesUnique(candidate: GlobalRoleSessionSet | TaskRoleSessionSet): void {
    const candidateClaims = sessionIdentityOwnerships(candidate);
    assertIdentityOwnershipsUnique(candidateClaims);
    const ledger = this.readNativeSessionIdentityLedger();
    for (const { key, owner } of candidateClaims) {
      const existing = ledger.identities[key];
      if (existing?.state === "retired") {
        throw dataError("Native Agent session identity is permanently retired.");
      }
      if (existing?.state === "owned" && !nativeSessionIdentityOwnersMatch(existing.owner, owner)) {
        throw dataError("Native Agent session identity is already owned by another Role Agent.");
      }
    }

    const liveOwners = this.physicalSessionIdentityOwners();
    for (const { key, owner } of candidateClaims) {
      const liveOwner = liveOwners.get(key);
      if (liveOwner !== undefined && !nativeSessionIdentityOwnersMatch(liveOwner, owner)) {
        throw dataError("Native Agent session identity is already owned by another Role Agent.");
      }
    }
  }

  private reserveSessionIdentities(candidate: GlobalRoleSessionSet | TaskRoleSessionSet): void {
    const ledger = this.readNativeSessionIdentityLedger();
    const claims = sessionIdentityOwnerships(candidate);
    assertIdentityOwnershipsUnique(claims);
    const liveOwners = this.physicalSessionIdentityOwners();
    for (const { key, owner } of claims) {
      const liveOwner = liveOwners.get(key);
      if (liveOwner !== undefined && !nativeSessionIdentityOwnersMatch(liveOwner, owner)) {
        throw dataError("Native Agent session identity is already owned by another Role Agent.");
      }
      liveOwners.set(key, owner);
    }
    this.writeNativeSessionIdentityLedger(this.reconcileIdentityClaims(ledger.identities, liveOwners));
  }

  private reconcileIdentityClaims(
    existingClaims: Record<string, NativeSessionIdentityClaim>,
    physicalOwners: Map<string, NativeSessionIdentityOwner>
  ): Record<string, NativeSessionIdentityClaim> {
    const identities = { ...existingClaims };
    for (const [key, owner] of physicalOwners) {
      const existing = identities[key];
      if (existing?.state === "retired") {
        throw dataError("Native Agent session identity is permanently retired.");
      }
      if (existing?.state === "owned" && !nativeSessionIdentityOwnersMatch(existing.owner, owner)) {
        throw dataError("Native Agent session identity is already owned by another Role Agent.");
      }
      identities[key] = { state: "owned", owner };
    }
    return identities;
  }

  private physicalSessionIdentityOwners(): Map<string, NativeSessionIdentityOwner> {
    const liveSets = this.listAllRoleSessionSets();
    const trashedSets = this.directoryNames(this.trashedTasksDir())
      .flatMap((taskId) => this.listTrashedRoleSessionSets(taskId));
    return compatibleIdentityOwnerMap([...liveSets, ...trashedSets].flatMap(sessionIdentityOwnerships));
  }

  private transferSessionIdentityOwnership(
    from: RoleSessionOwner,
    to: RoleSessionOwner,
    sessionSet: GlobalRoleSessionSet | TaskRoleSessionSet
  ): void {
    const ledger = this.readNativeSessionIdentityLedger();
    const identities = { ...ledger.identities };
    for (const [agentId, session] of Object.entries(sessionSet.sessions)) {
      const fromOwner = nativeSessionIdentityOwner(from, agentId);
      const toOwner = nativeSessionIdentityOwner(to, agentId);
      for (const identity of roleAgentSessionIdentities(session)) {
        const key = nativeSessionIdentityKey(identity);
        const existing = identities[key];
        if (
          existing === undefined ||
          (existing.state === "owned" && nativeSessionIdentityOwnersMatch(existing.owner, fromOwner))
        ) {
          identities[key] = { state: "owned", owner: toOwner };
        } else {
          throw dataError("Native Agent session identity is already owned by another Role Agent.");
        }
      }
    }
    this.writeNativeSessionIdentityLedger(identities);
  }

  private assertSessionIdentityTransferCompatibleWithTrash(candidate: TaskRoleSessionSet): void {
    const trashedOwners = compatibleIdentityOwnerMap(
      this.directoryNames(this.trashedTasksDir())
        .flatMap((taskId) => this.listTrashedRoleSessionSets(taskId))
        .flatMap(sessionIdentityOwnerships)
    );
    for (const { key, owner } of sessionIdentityOwnerships(candidate)) {
      const trashedOwner = trashedOwners.get(key);
      if (trashedOwner !== undefined && !nativeSessionIdentityOwnersMatch(trashedOwner, owner)) {
        throw dataError("Native Agent session identity is already owned by another trashed Role Agent.");
      }
    }
  }

  private retireTrashedSessionIdentities(sessionSets: TaskRoleSessionSet[]): void {
    if (sessionSets.length === 0) return;
    const trashClaims = sessionSets.flatMap(sessionIdentityOwnerships);
    assertIdentityOwnershipsUnique(trashClaims);
    const liveOwners = identityOwnerMap(this.listAllRoleSessionSets().flatMap(sessionIdentityOwnerships));
    const ledger = this.readNativeSessionIdentityLedger();
    const identities = { ...ledger.identities };

    for (const { key, owner: trashOwner } of trashClaims) {
      const liveOwner = liveOwners.get(key);
      const existing = identities[key];
      if (liveOwner !== undefined) {
        if (
          !nativeSessionIdentityOwnersMatch(liveOwner, trashOwner) ||
          existing?.state === "retired" ||
          (existing?.state === "owned" && !nativeSessionIdentityOwnersMatch(existing.owner, liveOwner))
        ) {
          throw dataError("Native Agent session identity ledger conflicts with live Role Agent ownership.");
        }
        identities[key] = { state: "owned", owner: liveOwner };
        continue;
      }

      if (existing?.state === "owned" && !nativeSessionIdentityOwnersMatch(existing.owner, trashOwner)) {
        throw dataError("Native Agent session identity ledger conflicts with trashed Role Agent ownership.");
      }
      if (existing?.state !== "retired") identities[key] = { state: "retired" };
    }
    this.writeNativeSessionIdentityLedger(identities);
  }

  private assertSessionIdentityLineagePreserved(
    existing: GlobalRoleSessionSet | TaskRoleSessionSet | null,
    candidate: GlobalRoleSessionSet | TaskRoleSessionSet | null,
    allowMonotonicImport = false
  ): void {
    if (existing === null) return;
    if (candidate === null) {
      throw dataError("Role Agent session identity lineage cannot be removed.");
    }
    for (const [agentId, existingSession] of Object.entries(existing.sessions)) {
      const candidateSession = candidate.sessions[agentId];
      if (candidateSession === undefined) {
        throw dataError("Role Agent session identity lineage cannot be removed.");
      }
      if (candidateSession.adapterId !== existingSession.adapterId) {
        throw dataError("Role Agent session adapter cannot change in place.");
      }
      const before = roleAgentSessionIdentities(existingSession);
      const after = roleAgentSessionIdentities(candidateSession);
      const same = before.length === after.length && before.every((identity, index) =>
        nativeSessionIdentityKeysMatch(identity, after[index])
      );
      const monotonicExtension = after.length > before.length && before.every((identity, index) =>
        nativeSessionIdentityKeysMatch(identity, after[index])
      );
      const permittedExtension = monotonicExtension && (
        allowMonotonicImport || after.length === before.length + 1
      );
      if (!same && !permittedExtension) {
        throw dataError("Role Agent session identity lineage must be preserved exactly.");
      }
    }
  }

  private listTrashedRoleSessionSets(taskId: string): TaskRoleSessionSet[] {
    return this.jsonRecordIds(this.trashedRoleSessionSetsDir(taskId))
      .map((roleName) => {
        const raw = this.readOptionalText(this.trashedRoleSessionSetFile(taskId, roleName));
        if (raw === null) return null;
        const sessionSet = parseTaskRoleSessionSet(taskId, roleName, raw);
        const roleRuntime = this.readOptionalText(this.trashedRoleFile(taskId, roleName));
        if (roleRuntime === null) {
          throw dataError(`Invalid trashed role session set: ${taskId}/${roleName}`);
        }
        const role = taskRecordCodec.decodeRole(
          taskId,
          roleName,
          roleRuntime,
          this.readOptionalText(this.trashedRoleInfoFile(taskId, roleName))
        );
        if (!sessionSetMatchesRole(sessionSet, role)) {
          throw dataError(`Invalid trashed role session set: ${taskId}/${roleName}`);
        }
        return sessionSet;
      })
      .filter((set): set is TaskRoleSessionSet => set !== null);
  }

  private writeNativeSessionIdentityLedger(
    identities: Record<string, NativeSessionIdentityClaim>
  ): void {
    const encoded = encodeCanonicalStorageValue({ schemaVersion: 3, identities });
    this.writeSnapshot(this.nativeSessionIdentityLedgerFile(), `${encoded}\n`);
  }

  private readNativeSessionIdentityLedger(): NativeSessionIdentityLedger {
    const raw = this.readOptionalText(this.nativeSessionIdentityLedgerFile());
    if (raw === null) return { schemaVersion: 3, identities: {} };
    const value = parseJson(raw, "Invalid native session identity ledger");
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, ["schemaVersion", "identities"]) ||
      value.schemaVersion !== 3 ||
      !isRecord(value.identities) ||
      snapshotNativeSessionIdentityClaims(value.identities) === null
    ) {
      throw dataError("Invalid native session identity ledger");
    }
    return value as NativeSessionIdentityLedger;
  }

  private nextRecordId(prefix: string, getRecord: (id: string) => unknown | null): string {
    let number = 1;

    while (getRecord(`${prefix}-${number}`) !== null) {
      number += 1;
    }

    return `${prefix}-${number}`;
  }

}

const TASK_READER_METHODS = [
  "getConfig",
  "nextTaskId",
  "listTrashedTaskIds",
  "readTrashedTask",
  "listTasks",
  "getTask",
  "getTaskTopics",
  "getTaskInputDraft",
  "getInputRequest",
  "listInputRequests",
  "getInputResolution",
  "listInputResolutions",
  "getOperatorDelivery",
  "listOperatorDeliveries",
  "getOfflineResolutionClock",
  "listOfflineResolutionClocks",
  "getInputResolutionWakeup",
  "listInputResolutionWakeups",
  "getPendingWakeup",
  "listPendingWakeups",
  "getLeaderFailure",
  "getOperatorNotification",
  "getTaskSchedule",
  "nextCycleId",
  "getCycle",
  "listCycles",
  "nextWorkItemId",
  "getWorkItem",
  "listWorkItems",
  "getRoleSessionSet",
  "listRoleSessionSets",
  "listAllRoleSessionSets",
  "nativeSessionIdentityClaims",
  "getGlobalRoleSessionSet",
  "listGlobalRoleSessionSets",
  "getAgentSession",
  "nextAgentRunId",
  "getAgentRun",
  "listAgentRuns",
  "getActiveAgentRun",
  "readTaskBrief",
  "readTaskTopicSummaries",
  "readTaskTimeline",
  "nextMilestoneId",
  "getMilestone",
  "listMilestones",
  "nextDecisionId",
  "getDecision",
  "listDecisions",
  "getRoleWorktree",
  "listRoles",
  "getRole",
  "getChildRole",
  "listChildRoles",
  "listGlobalRoles",
  "getGlobalRole",
  "nextCommentId",
  "listComments",
  "nextEventId",
  "listEvents",
  "readTranscript",
  "listConfiguredAgents",
  "getConfiguredAgent",
  "listConfiguredSkills",
  "getConfiguredSkill"
] as const satisfies ReadonlyArray<Exclude<keyof TaskReader, "runReadSnapshot">>;

function withBoundedTaskReader<T>(
  backing: FileTaskStore,
  execute: (reader: TaskReader) => T
): T {
  const reader = createTaskReaderFacade();
  activeTaskReaderGrants.set(reader, { backing });
  try {
    return requireSynchronousTaskReaderResult(execute(reader));
  } finally {
    activeTaskReaderGrants.delete(reader);
  }
}

function activeTaskReaderBacking(reader: TaskReader): FileTaskStore {
  const grant = activeTaskReaderGrants.get(reader);
  if (grant === undefined) {
    throw new Error("TaskMux read snapshot capability is no longer active.");
  }
  return grant.backing;
}

function createTaskReaderFacade(): TaskReader {
  const reader = objectCreate(null) as Record<string, unknown>;
  const taskReader = reader as TaskReader;
  taskReader.runReadSnapshot = <T>(execute: (nested: TaskReader) => T): T => {
    activeTaskReaderBacking(taskReader);
    return requireSynchronousTaskReaderResult(execute(taskReader));
  };
  for (const name of TASK_READER_METHODS) {
    reader[name] = (...args: unknown[]): unknown => {
      const backing = activeTaskReaderBacking(taskReader);
      const method = backing[name] as unknown as (...values: unknown[]) => unknown;
      return Reflect.apply(method, backing, args);
    };
  }
  return objectFreeze(taskReader);
}

function requireSynchronousTaskReaderResult<T>(value: T): T {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return value;
  }
  let candidate: object | null = value as object;
  while (candidate !== null) {
    if (isProxy(candidate)) {
      throw new Error("TaskMux read snapshot callback must be synchronous.");
    }
    const descriptor = objectGetOwnPropertyDescriptor(candidate, "then");
    if (descriptor !== undefined) {
      if (descriptor.get !== undefined || typeof descriptor.value === "function") {
        throw new Error("TaskMux read snapshot callback must be synchronous.");
      }
      return value;
    }
    candidate = objectGetPrototypeOf(candidate);
  }
  return value;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function parseConfiguredAgent(id: string, raw: string): ConfiguredAgent {
  const value = parseJson(raw, `Invalid agent record: ${id}`);
  const snapshot = snapshotConfiguredAgentRecord(value, id);
  if (snapshot === null) throw dataError(`Invalid agent record: ${id}`);
  return snapshot;
}

function parseGlobalRole(name: string, raw: string): GlobalRole {
  const value = parseJson(raw, `Invalid global role record: ${name}`);
  const snapshot = snapshotGlobalRoleRecord(value, name);
  if (snapshot === null) throw dataError(`Invalid global role record: ${name}`);
  return snapshot;
}

function parseChildRole(name: string, raw: string): ChildRole {
  const value = parseJson(raw, `Invalid child role record: ${name}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.name !== name ||
    value.architecture !== "child" ||
    typeof value.parentRole !== "string" ||
    typeof value.description !== "string" ||
    !isStringArray(value.responsibilities) ||
    !isStringArray(value.constraints) ||
    typeof value.expectedOutput !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid child role record: ${name}`);
  }

  return value as ChildRole;
}

function parseTaskmuxConfig(raw: string): TaskmuxConfig {
  const value = parseJson(raw, "Invalid config record");

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isOptionalString(value.defaultAgent) ||
    !isOptionalString(value.defaultWorkspace) ||
    !isOptionalString(value.currentTaskId) ||
    !isOptionalString(value.lastTaskId) ||
    !isCompletionInstallations(value.completionInstallations)
  ) {
    throw dataError("Invalid config record");
  }

  return value as TaskmuxConfig;
}

function isCompletionInstallations(value: unknown): value is TaskmuxConfig["completionInstallations"] {
  if (value === undefined) {
    return true;
  }
  if (Array.isArray(value) || !isRecord(value) || Object.keys(value).some((key) => !COMPLETION_SHELLS.includes(key as CompletionShell))) {
    return false;
  }
  return Object.values(value).every((installation) =>
    isRecord(installation) &&
    Object.keys(installation).length === 2 &&
    Object.hasOwn(installation, "scriptPath") &&
    Object.hasOwn(installation, "activationPath") &&
    typeof installation.scriptPath === "string" &&
    installation.scriptPath.length > 0 &&
    isAbsolute(installation.scriptPath) &&
    resolve(installation.scriptPath) === installation.scriptPath &&
    typeof installation.activationPath === "string" &&
    installation.activationPath.length > 0 &&
    isAbsolute(installation.activationPath) &&
    resolve(installation.activationPath) === installation.activationPath
  );
}

function parseTaskTopics(taskId: string, raw: string): TaskTopics {
  const value = parseJson(raw, `Invalid topic record: ${taskId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.customTopics) ||
    !value.customTopics.every((topic) =>
      isRecord(topic) &&
      typeof topic.id === "string" &&
      typeof topic.name === "string" &&
      typeof topic.description === "string" &&
      (topic.createdBy === "user" || topic.createdBy === "operator" || topic.createdBy === "leader") &&
      typeof topic.createdAt === "string"
    )
  ) {
    throw dataError(`Invalid topic record: ${taskId}`);
  }

  return value as TaskTopics;
}

function parseTaskInputDraft(taskId: string, raw: string): TaskInputDraft {
  const value = parseJson(raw, `Invalid input draft record: ${taskId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    typeof value.body !== "string" ||
    value.author !== "operator" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid input draft record: ${taskId}`);
  }

  return value as TaskInputDraft;
}

function parseInputRequest(taskId: string, requestId: string, raw: string): InputRequest {
  const message = `Invalid input request record: ${taskId}/${requestId}`;
  const value = parseJson(raw, message);
  if (!isInputRequestRecord(value, taskId, requestId)) {
    throw dataError(message);
  }
  return value;
}

function parseInputResolution(taskId: string, resolutionId: string, raw: string): InputResolution {
  const message = `Invalid input resolution record: ${taskId}/${resolutionId}`;
  const value = parseJson(raw, message);
  if (!isInputResolutionRecord(value, taskId, resolutionId)) {
    throw dataError(message);
  }
  return value;
}

function parseOperatorDelivery(deliveryId: string, raw: string): OperatorDelivery {
  const message = `Invalid operator delivery record: ${deliveryId}`;
  const value = parseJson(raw, message);
  if (!isOperatorDelivery(value, deliveryId)) {
    throw dataError(message);
  }
  return value;
}

function parseOfflineResolutionClock(
  taskId: string,
  requestId: string,
  raw: string
): OfflineResolutionClock {
  const message = `Invalid offline resolution clock record: ${taskId}/${requestId}`;
  const value = parseJson(raw, message);
  if (!isOfflineResolutionClock(value, taskId, requestId)) {
    throw dataError(message);
  }
  return value;
}

function parseInputResolutionWakeup(
  taskId: string,
  requestId: string,
  raw: string
): InputResolutionWakeup {
  const message = `Invalid input resolution wakeup record: ${taskId}/${requestId}`;
  const value = parseJson(raw, message);
  if (!isInputResolutionWakeup(value, taskId, requestId)) {
    throw dataError(message);
  }
  return value;
}

function parsePendingWakeup(taskId: string, raw: string): PendingWakeup {
  const value = parseJson(raw, `Invalid pending wakeup record: ${taskId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    !isStringArray(value.reasons) ||
    typeof value.requestCount !== "number" ||
    typeof value.firstRequestedAt !== "string" ||
    typeof value.lastRequestedAt !== "string"
  ) {
    throw dataError(`Invalid pending wakeup record: ${taskId}`);
  }

  return value as PendingWakeup;
}

function parseTaskSchedule(taskId: string, raw: string): TaskSchedule {
  const value = parseJson(raw, `Invalid task schedule record: ${taskId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.inactivityMinutes !== "number" ||
    typeof value.cooldownMinutes !== "number" ||
    (value.reviewAt !== undefined && typeof value.reviewAt !== "string") ||
    (value.lastLeaderWakeupAt !== undefined && typeof value.lastLeaderWakeupAt !== "string") ||
    (value.recurring !== undefined && (
      !isRecord(value.recurring) ||
      typeof value.recurring.everyMinutes !== "number" ||
      typeof value.recurring.nextAt !== "string"
    )) ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid task schedule record: ${taskId}`);
  }

  return value as TaskSchedule;
}

function parseLeaderFailure(taskId: string, raw: string): LeaderFailure {
  const value = parseJson(raw, `Invalid leader failure record: ${taskId}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    typeof value.nativeSessionId !== "string" ||
    typeof value.message !== "string" ||
    typeof value.attemptCount !== "number" ||
    typeof value.firstFailedAt !== "string" ||
    typeof value.lastFailedAt !== "string"
  ) {
    throw dataError(`Invalid leader failure record: ${taskId}`);
  }
  return value as LeaderFailure;
}

function parseOperatorNotification(taskId: string, raw: string): OperatorNotification {
  const value = parseJson(raw, `Invalid Operator notification: ${taskId}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.taskId !== taskId ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.message !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid Operator notification: ${taskId}`);
  }
  if (value.type === "leader-recovery-failed") {
    return value as OperatorNotification;
  }
  if (
    typeof value.type === "string" &&
    ["role-expiry-stop-failed", "role-expiry-identity-drift"].includes(value.type) &&
    typeof value.roleName === "string" &&
    typeof value.agentId === "string" &&
    typeof value.runId === "string"
  ) {
    return value as OperatorNotification;
  }
  throw dataError(`Invalid Operator notification: ${taskId}`);
}

function parseMilestone(taskId: string, milestoneId: string, raw: string): Milestone {
  const value = parseJson(raw, `Invalid milestone record: ${taskId}/${milestoneId}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== milestoneId ||
    value.taskId !== taskId ||
    typeof value.title !== "string" ||
    typeof value.summary !== "string" ||
    !isStringArray(value.topics) ||
    value.createdBy !== "leader" ||
    typeof value.createdAt !== "string"
  ) {
    throw dataError(`Invalid milestone record: ${taskId}/${milestoneId}`);
  }
  return value as Milestone;
}

function parseCycle(taskId: string, cycleId: string, raw: string): Cycle {
  const value = parseJson(raw, `Invalid cycle record: ${taskId}/${cycleId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== cycleId ||
    value.taskId !== taskId ||
    !["task-created", "user-comment", "schedule", "review-time", "operator-input", "role-result", "inactivity", "explicit-wake"].includes(String(value.cause)) ||
    typeof value.summary !== "string" ||
    (value.topics !== undefined && !isStringArray(value.topics)) ||
    !["active", "ended"].includes(String(value.status)) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.endedAt !== undefined && typeof value.endedAt !== "string")
  ) {
    throw dataError(`Invalid cycle record: ${taskId}/${cycleId}`);
  }

  return { ...value, topics: value.topics ?? [] } as Cycle;
}

function parseDecision(taskId: string, decisionId: string, raw: string): Decision {
  const value = parseJson(raw, `Invalid decision record: ${taskId}/${decisionId}`);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== decisionId ||
    value.taskId !== taskId ||
    typeof value.title !== "string" ||
    typeof value.rationale !== "string" ||
    !isStringArray(value.topics) ||
    !["active", "superseded"].includes(String(value.status)) ||
    (value.supersededReason !== undefined && typeof value.supersededReason !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw dataError(`Invalid decision record: ${taskId}/${decisionId}`);
  }
  return value as Decision;
}

function parseWorkItem(taskId: string, workItemId: string, raw: string): WorkItem {
  const value = parseJson(raw, `Invalid work item record: ${taskId}/${workItemId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== workItemId ||
    value.taskId !== taskId ||
    (value.cycleId !== undefined && typeof value.cycleId !== "string") ||
    typeof value.title !== "string" ||
    typeof value.assignee !== "string" ||
    !isStringArray(value.topics) ||
    !["pending", "running", "completed", "failed", "cancelled", "superseded"].includes(String(value.status)) ||
    (value.outcome !== undefined && typeof value.outcome !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.endedAt !== undefined && typeof value.endedAt !== "string")
  ) {
    throw dataError(`Invalid work item record: ${taskId}/${workItemId}`);
  }

  return value as WorkItem;
}

function parseTaskRoleSessionSet(taskId: string, roleName: string, raw: string): TaskRoleSessionSet {
  const message = `Invalid role session set: ${taskId}/${roleName}`;
  const snapshot = snapshotTaskRoleSessionSetRecord(parseJson(raw, message), taskId, roleName);
  if (snapshot === null) throw dataError(message);
  return snapshot;
}

function parseGlobalRoleSessionSet(roleName: string, raw: string): GlobalRoleSessionSet {
  const message = `Invalid global role session set: ${roleName}`;
  const snapshot = snapshotGlobalRoleSessionSetRecord(parseJson(raw, message), roleName);
  if (snapshot === null) throw dataError(message);
  return snapshot;
}

function parseRoleWorktree(taskId: string, roleName: string, raw: string): RoleWorktree {
  const value = parseJson(raw, `Invalid role worktree: ${taskId}/${roleName}`);
  const keys = [
    "schemaVersion", "taskId", "roleName", "repositoryRoot", "commonDir",
    "repositoryFingerprint", "path", "worktreeGitDir", "branchRef", "headOid",
    "ownerToken", "createdAt"
  ];
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== 2 ||
    value.taskId !== taskId ||
    value.roleName !== roleName ||
    typeof value.repositoryRoot !== "string" || !isAbsolute(value.repositoryRoot) || resolve(value.repositoryRoot) !== value.repositoryRoot ||
    typeof value.commonDir !== "string" || !isAbsolute(value.commonDir) || resolve(value.commonDir) !== value.commonDir ||
    typeof value.repositoryFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.repositoryFingerprint) ||
    typeof value.path !== "string" || !isAbsolute(value.path) || resolve(value.path) !== value.path ||
    typeof value.worktreeGitDir !== "string" || !isAbsolute(value.worktreeGitDir) || resolve(value.worktreeGitDir) !== value.worktreeGitDir ||
    typeof value.branchRef !== "string" || !isSafeGitBranchName(value.branchRef) ||
    typeof value.headOid !== "string" || !GIT_OID_PATTERN.test(value.headOid) ||
    typeof value.ownerToken !== "string" || !UUID_PATTERN.test(value.ownerToken) ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(Date.parse(value.createdAt)).toISOString() !== value.createdAt
  ) {
    throw dataError(`Invalid role worktree: ${taskId}/${roleName}`);
  }
  return value as RoleWorktree;
}

function isSafeGitBranchName(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") &&
    !value.endsWith(".") && !value.includes("..") && !value.includes("//") && !value.includes("@{") &&
    !value.endsWith(".lock") && !/[\u0000-\u0020\u007f~^:?*\[\]\\]/.test(value);
}

function parseAgentRun(taskId: string, runId: string, raw: string): AgentRun {
  const value = parseJson(raw, `Invalid agent run record: ${taskId}/${runId}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== runId ||
    value.taskId !== taskId ||
    typeof value.roleName !== "string" ||
    !["new", "resume"].includes(String(value.mode)) ||
    typeof value.input !== "string" ||
    (value.workItemId !== undefined && typeof value.workItemId !== "string") ||
    (value.topics !== undefined && !isStringArray(value.topics)) ||
    !["active", "blocked", "yielded", "failed", "expired"].includes(String(value.status)) ||
    (value.summary !== undefined && typeof value.summary !== "string") ||
    (
      value.status === "blocked" &&
      (
        !isRecord(value.blockedBy) ||
        value.blockedBy.type !== "input-request" ||
        typeof value.blockedBy.requestId !== "string" ||
        !INPUT_POINTER_ID_PATTERN.test(value.blockedBy.requestId) ||
        typeof value.blockedBy.blockedAt !== "string"
      )
    ) ||
    (value.status !== "blocked" && value.blockedBy !== undefined) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.endedAt !== undefined && typeof value.endedAt !== "string")
  ) {
    throw dataError(`Invalid agent run record: ${taskId}/${runId}`);
  }

  return value as AgentRun;
}

function parseComment(id: string, raw: string): TaskComment {
  const value = parseJson(raw, `Invalid comment record: ${id}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.body !== "string" ||
    (value.topics !== undefined && !isStringArray(value.topics)) ||
    (value.author !== undefined && !["user", "operator", "leader"].includes(String(value.author))) ||
    typeof value.createdAt !== "string"
  ) {
    throw dataError(`Invalid comment record: ${id}`);
  }

  return { ...value, topics: value.topics ?? [] } as TaskComment;
}

function parseEvent(id: string, raw: string): TaskEvent {
  const value = parseJson(raw, `Invalid event record: ${id}`);

  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    !isStringRecord(value.payload) ||
    typeof value.createdAt !== "string"
  ) {
    throw dataError(`Invalid event record: ${id}`);
  }

  return value as TaskEvent;
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw dataError(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function snapshotConfiguredAgentPatch(value: unknown): ConfiguredAgentPatch | null {
  const snapshot = lowerUnknownInertData(value);
  if (snapshot === null) return null;
  const encoded = stringifyCanonicalInertData(snapshot);
  if (encoded === null) return null;
  const inert = JSON.parse(encoded) as unknown;
  if (!isRecord(inert)) return null;
  const allowed = new Set([
    "adapterId", "command", "baseArgs", "environment", "probePin", "probePinRefreshRequired"
  ]);
  if (Object.keys(inert).some((key) => !allowed.has(key))) return null;
  if (inert.adapterId !== undefined &&
      (typeof inert.adapterId !== "string" || inert.adapterId.trim().length === 0)) return null;
  if (inert.command !== undefined &&
      (typeof inert.command !== "string" || inert.command.trim().length === 0)) return null;
  if (inert.baseArgs !== undefined && !isStringArray(inert.baseArgs)) return null;
  if (inert.environment !== undefined && !Array.isArray(inert.environment)) return null;
  if (inert.probePin !== undefined && inert.probePin !== null && !isProbeExecutablePin(inert.probePin)) return null;
  if (inert.probePinRefreshRequired !== undefined &&
      inert.probePinRefreshRequired !== null && inert.probePinRefreshRequired !== true) return null;
  if (inert.probePin !== undefined && inert.probePin !== null && inert.probePinRefreshRequired === true) return null;
  return inert as unknown as ConfiguredAgentPatch;
}

function sameConfiguredAgentOperation(left: ConfiguredAgent, right: ConfiguredAgent): boolean {
  return left.id === right.id &&
    left.adapterId === right.adapterId &&
    left.command === right.command &&
    isDeepStrictEqual(left.baseArgs, right.baseArgs) &&
    isDeepStrictEqual(left.environment, right.environment) &&
    isDeepStrictEqual(left.probePin, right.probePin) &&
    left.probePinRefreshRequired === right.probePinRefreshRequired;
}

function requireSafeStorageSegment(value: string, kind: string): string {
  if (!isSafeStorageSegment(value)) throw dataError(`Invalid ${kind} storage identity.`);
  return value;
}

function encodeCanonicalStorageValue(value: unknown): string {
  const snapshot = lowerUnknownInertData(value);
  const encoded = snapshot === null ? null : stringifyCanonicalInertData(snapshot);
  if (encoded === null) throw dataError("Invalid canonical storage value.");
  return encoded;
}

type NativeSessionIdentityOwnership = {
  key: string;
  owner: NativeSessionIdentityOwner;
};

function sessionIdentityOwnerships(
  set: GlobalRoleSessionSet | TaskRoleSessionSet
): NativeSessionIdentityOwnership[] {
  return Object.entries(set.sessions).flatMap(([agentId, session]) => {
    const owner = nativeSessionIdentityOwner(set.owner, agentId);
    return roleAgentSessionIdentities(session).map((identity) => ({
      key: nativeSessionIdentityKey(identity),
      owner
    }));
  });
}

export function nativeSessionIdentityKey(identity: NativeSessionIdentity): string {
  return encodeCanonicalStorageValue([
    identity.adapterId,
    identity.sessionRoot,
    identity.nativeSessionId
  ]);
}

export function nativeSessionIdentityOwner(
  owner: RoleSessionOwner,
  agentId: string
): NativeSessionIdentityOwner {
  return owner.scope === "global"
    ? { scope: "global", roleName: owner.roleName, agentId }
    : { scope: "task", taskId: owner.taskId, roleName: owner.roleName, agentId };
}

export function nativeSessionIdentityOwnerKey(owner: NativeSessionIdentityOwner): string {
  return encodeCanonicalStorageValue(owner.scope === "global"
    ? ["global", owner.roleName, owner.agentId]
    : ["task", owner.taskId, owner.roleName, owner.agentId]);
}

function nativeSessionIdentityOwnersMatch(
  left: NativeSessionIdentityOwner,
  right: NativeSessionIdentityOwner
): boolean {
  return nativeSessionIdentityOwnerKey(left) === nativeSessionIdentityOwnerKey(right);
}

function assertIdentityOwnershipsUnique(ownerships: NativeSessionIdentityOwnership[]): void {
  identityOwnerMap(ownerships);
}

function identityOwnerMap(
  ownerships: NativeSessionIdentityOwnership[]
): Map<string, NativeSessionIdentityOwner> {
  const owners = new Map<string, NativeSessionIdentityOwner>();
  for (const { key, owner } of ownerships) {
    const existing = owners.get(key);
    if (existing !== undefined) {
      throw dataError(nativeSessionIdentityOwnersMatch(existing, owner)
        ? "A native session identity is duplicated within one Role Agent lineage."
        : "A native session identity is already owned by another Role Agent.");
    }
    owners.set(key, owner);
  }
  return owners;
}

function compatibleIdentityOwnerMap(
  ownerships: NativeSessionIdentityOwnership[]
): Map<string, NativeSessionIdentityOwner> {
  const owners = new Map<string, NativeSessionIdentityOwner>();
  for (const { key, owner } of ownerships) {
    const existing = owners.get(key);
    if (existing !== undefined && !nativeSessionIdentityOwnersMatch(existing, owner)) {
      throw dataError("A native session identity is already owned by another Role Agent.");
    }
    owners.set(key, owner);
  }
  return owners;
}

function nativeSessionIdentityKeysMatch(
  left: NativeSessionIdentity,
  right: NativeSessionIdentity | undefined
): boolean {
  return right !== undefined && nativeSessionIdentityKey(left) === nativeSessionIdentityKey(right);
}

function isNativeSessionIdentityOwner(value: unknown): value is NativeSessionIdentityOwner {
  return isRecord(value) && (
    (
      hasExactOwnKeys(value, ["scope", "roleName", "agentId"]) &&
      value.scope === "global" &&
      isSafeStorageSegment(value.roleName) &&
      isSafeStorageSegment(value.agentId)
    ) ||
    (
      hasExactOwnKeys(value, ["scope", "taskId", "roleName", "agentId"]) &&
      value.scope === "task" &&
      isSafeStorageSegment(value.taskId) &&
      isSafeStorageSegment(value.roleName) &&
      isSafeStorageSegment(value.agentId)
    )
  );
}

export function snapshotNativeSessionIdentityClaims(
  value: unknown
): Record<string, NativeSessionIdentityClaim> | null {
  const snapshot = lowerUnknownInertData(value);
  if (snapshot === null || !isRecord(snapshot.value)) return null;
  const claims: Record<string, NativeSessionIdentityClaim> = {};
  for (const [identity, claim] of Object.entries(snapshot.value)) {
    if (!isNativeSessionIdentityKey(identity) || !isNativeSessionIdentityClaim(claim)) return null;
    claims[identity] = claim.state === "retired"
      ? { state: "retired" }
      : { state: "owned", owner: { ...claim.owner } };
  }
  return claims;
}

function nativeSessionIdentityClaimsMatch(
  left: NativeSessionIdentityClaim,
  right: NativeSessionIdentityClaim
): boolean {
  return left.state === right.state && (
    left.state === "retired" ||
    (right.state === "owned" && nativeSessionIdentityOwnersMatch(left.owner, right.owner))
  );
}

export function isNativeSessionIdentityClaim(value: unknown): value is NativeSessionIdentityClaim {
  return isRecord(value) && (
    (
      hasExactOwnKeys(value, ["state", "owner"]) &&
      value.state === "owned" &&
      isNativeSessionIdentityOwner(value.owner)
    ) ||
    (
      hasExactOwnKeys(value, ["state"]) &&
      value.state === "retired"
    )
  );
}

function isNativeSessionIdentityKey(value: string): boolean {
  try {
    const decoded = JSON.parse(value) as unknown;
    return Array.isArray(decoded) &&
      decoded.length === 3 &&
      typeof decoded[0] === "string" && hasNoSurroundingWhitespace(decoded[0]) &&
      isCanonicalNativeSessionRoot(decoded[1]) &&
      isCanonicalNativeSessionId(decoded[2]) &&
      value === encodeCanonicalStorageValue(decoded);
  } catch {
    return false;
  }
}

function withCanonicalRoleRevision<T extends Role | GlobalRole>(role: T, currentUpdatedAt: string): T {
  const currentTimestamp = Date.parse(currentUpdatedAt);
  const nextTimestamp = Math.max(
    Date.now(),
    Number.isFinite(currentTimestamp) ? currentTimestamp + 1 : Number.NEGATIVE_INFINITY
  );
  return { ...role, updatedAt: new Date(nextTimestamp).toISOString() };
}

function assertInputPointerId(value: string, label: string): void {
  if (typeof value !== "string" || !INPUT_POINTER_ID_PATTERN.test(value)) {
    throw dataError(`Invalid ${label} id`);
  }
}

function inputRecordPointers(value: unknown): { taskId: string; id: string } | null {
  try {
    if (
      !isRecord(value) ||
      typeof value.taskId !== "string" ||
      typeof value.id !== "string"
    ) {
      return null;
    }
    return { taskId: value.taskId, id: value.id };
  } catch {
    return null;
  }
}

function encodeInputRequestRecord(
  value: unknown
): { record: InputRequest; content: string } | null {
  const pointers = inputRecordPointers(value);
  if (pointers === null) {
    return null;
  }
  try {
    if (!isInputRequestRecord(value, pointers.taskId, pointers.id)) {
      return null;
    }
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized !== "string") {
      return null;
    }
    const record = JSON.parse(serialized) as unknown;
    if (!isInputRequestRecord(record, pointers.taskId, pointers.id)) {
      return null;
    }
    return { record, content: `${serialized}\n` };
  } catch {
    return null;
  }
}

function encodeInputResolutionRecord(
  value: unknown
): { record: InputResolution; content: string } | null {
  const pointers = inputRecordPointers(value);
  if (pointers === null) {
    return null;
  }
  try {
    if (!isInputResolutionRecord(value, pointers.taskId, pointers.id)) {
      return null;
    }
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized !== "string") {
      return null;
    }
    const record = JSON.parse(serialized) as unknown;
    if (!isInputResolutionRecord(record, pointers.taskId, pointers.id)) {
      return null;
    }
    return { record, content: `${serialized}\n` };
  } catch {
    return null;
  }
}
