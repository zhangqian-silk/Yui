import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { dataError, usageError } from "../errors/cliError.js";
import type { GlobalRole, Role } from "../role/role.js";
import type { AgentRun } from "../run/agentRun.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { RoleWorktree } from "../worktree/worktree.js";
import type { GitWorktreeCreatePlan, GitWorktreeRemovePlan } from "../worktree/gitWorktreeManager.js";
import { executeDomainTransaction } from "../storage/domainTransaction.js";
import {
  isSafeStorageSegment,
  isGlobalRoleRecord,
  isGlobalRoleSessionSetRecord,
  isTaskRoleRecord,
  isTaskRoleSessionSetRecord,
  sessionSetMatchesRole
} from "../storage/recordValidation.js";
import type { GlobalRoleSessionSet, RoleAgentSession, TaskRoleSessionSet } from "./agentExecutor.js";
import { isRoleAgentSessionRecord } from "../storage/recordValidation.js";
import type { AgentLaunchPlan } from "./launchPlan.js";
import {
  digestInertDataSnapshot,
  lowerUnknownInertData,
  stringifyCanonicalInertData
} from "../storage/inertData.js";

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ROLE_RUNTIME_OPERATION_LEASE_MS = 2 * 60 * 1_000;
const activeOperationTokens = new Set<string>();

export type RoleRuntimeStateSnapshot = {
  role: Role | null;
  sessionSet: TaskRoleSessionSet | null;
  activeRun: AgentRun | null;
  selectedWorkItem: WorkItem | null;
  pendingRun: { id: string; existing: AgentRun | null } | null;
};

export type PendingRoleAgentRun = {
  id: string;
  taskId: string;
  roleName: string;
};

type RuntimeOperationClaimBase = {
  schemaVersion: 1;
  token: string;
  ownerPid: number;
  expectedStateDigest: string;
  selectedWorkItem: WorkItem | null;
  pendingRun: PendingRoleAgentRun | null;
  recoveryToken: string | null;
  createdAt: string;
  leaseExpiresAt: string;
};

type TaskRoleRuntimeOperationClaimBase = RuntimeOperationClaimBase & {
  scope: "task-role";
  taskId: string;
  roleName: string;
};

export type RoleLaunchRuntimeOperationClaim = TaskRoleRuntimeOperationClaimBase & {
  kind: "launch";
  operation: "dispatch" | "leader-wakeup" | "enter";
  preparedSession: RoleAgentSession | null;
};

export type RoleStopRuntimeOperationClaim = TaskRoleRuntimeOperationClaimBase & {
  kind: "stop" | "restart";
  operation: "ttl-stop" | "native-registration-timeout" | "manual-stop" | "manual-kill" | "manual-restart";
  preparedSession: RoleAgentSession | null;
  phase: "prepared" | "effect-started";
  targetLaunchToken: string | null;
  preparedRole: Role;
  restartLaunch: AgentLaunchPlan | null;
};

export type RoleRuntimeOperationClaim =
  | RoleLaunchRuntimeOperationClaim
  | RoleStopRuntimeOperationClaim;

export type TaskLifecyclePreparedState = {
  task: Task;
  roles: Role[];
  sessionSets: TaskRoleSessionSet[];
  activeRuns: AgentRun[];
  pendingRuns: AgentRun[];
  workItems: WorkItem[];
  worktrees: RoleWorktree[];
  dependencyGraphDigest: string;
};

export type TaskRuntimeWindowEffect = {
  roleName: string;
  launchToken: string | null;
};

export type TaskLifecycleEffectPlan =
  | { kind: "stop-roles"; windows: TaskRuntimeWindowEffect[] }
  | { kind: "detach-role"; roleName: string }
  | { kind: "rename-role"; oldName: string; newName: string; launchToken: string | null }
  | GitWorktreeCreatePlan
  | GitWorktreeRemovePlan;

export type TaskLifecycleRuntimeOperationClaim = RuntimeOperationClaimBase & {
  scope: "task";
  kind: "task-lifecycle";
  taskId: string;
  roleName: null;
  operation: "archive" | "delete" | "role-detach" | "role-remove" | "role-rename" | "worktree-create" | "worktree-remove";
  preparedSession: null;
  phase: "prepared" | "effect-started";
  preparedState: TaskLifecyclePreparedState;
  effectPlan: TaskLifecycleEffectPlan | null;
  targetRoleName: string | null;
  newRoleName: string | null;
  archiveMetadata: {
    by: "user" | "operator" | "leader";
    reason: string | null;
    summary: string | null;
  } | null;
  worktreeRequest: {
    roleName: string;
    path: string | null;
    branch: string | null;
    base: string | null;
  } | null;
};

export type GlobalRoleRuntimeOperationClaim = RuntimeOperationClaimBase & {
  scope: "global-role";
  kind: "global-role-mutation";
  taskId: null;
  roleName: string;
  operation: "update" | "remove";
  preparedSession: null;
  phase: "prepared";
  preparedState: {
    role: GlobalRole;
    sessionSet: GlobalRoleSessionSet | null;
    activeRun: AgentRun | null;
  };
};

export type RuntimeOperationClaim =
  | RoleRuntimeOperationClaim
  | TaskLifecycleRuntimeOperationClaim
  | GlobalRoleRuntimeOperationClaim;

export type RuntimeOperationOwner =
  | { scope: "task"; taskId: string }
  | { scope: "task-role"; taskId: string; roleName: string }
  | { scope: "global-role"; roleName: string };

export function createRoleRuntimeOperationLease(now = new Date()): {
  createdAt: string;
  leaseExpiresAt: string;
} {
  return {
    createdAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + ROLE_RUNTIME_OPERATION_LEASE_MS).toISOString()
  };
}

export function readRoleRuntimeStateSnapshot(
  store: Pick<
    TaskStore,
    "getRole" | "getRoleSessionSet" | "getActiveAgentRun" | "getWorkItem" | "getAgentRun"
  >,
  taskId: string,
  roleName: string,
  context: { workItemId?: string; pendingRunId?: string } = {}
): RoleRuntimeStateSnapshot {
  return {
    role: store.getRole(taskId, roleName),
    sessionSet: store.getRoleSessionSet(taskId, roleName),
    activeRun: store.getActiveAgentRun(taskId, roleName),
    selectedWorkItem: context.workItemId === undefined
      ? null
      : store.getWorkItem(taskId, context.workItemId),
    pendingRun: context.pendingRunId === undefined
      ? null
      : { id: context.pendingRunId, existing: store.getAgentRun(taskId, context.pendingRunId) }
  };
}

export function roleRuntimeStateDigest(snapshot: unknown): string {
  const inert = lowerUnknownInertData(snapshot);
  const digest = inert === null ? null : digestInertDataSnapshot(inert);
  if (digest === null) throw dataError("Invalid Role runtime state snapshot.");
  return digest;
}

export function writeRoleRuntimeOperationClaim(
  rootDir: string,
  claim: RuntimeOperationClaim,
  actualStateDigest: string
): void {
  const owner = ownerOfClaim(claim);
  assertOwner(owner);
  assertRuntimeOperationClaim(claim);
  if (!DIGEST_PATTERN.test(actualStateDigest) || actualStateDigest !== claim.expectedStateDigest) {
    throw usageError(`Runtime state changed before operation reservation: ${renderOwner(owner)}.`);
  }
  const conflict = listRuntimeOperationClaims(rootDir).find((candidate) =>
    runtimeOperationClaimsConflict(claim, candidate)
  );
  if (conflict !== undefined) {
    throw usageError(
      `Runtime operation conflict: ${renderOwner(owner)} is already covered by ${renderOwner(ownerOfClaim(conflict))}.`
    );
  }
  const runConflict = claim.pendingRun === null || claim.taskId === null
    ? null
    : listRuntimeOperationClaims(rootDir).find((candidate) =>
        candidate.taskId !== null &&
        candidate.taskId === claim.pendingRun!.taskId &&
        candidate.pendingRun?.id === claim.pendingRun!.id
      );
  if (runConflict !== null && runConflict !== undefined) {
    throw usageError(`AgentRun allocation is already reserved: ${claim.pendingRun!.taskId}/${claim.pendingRun!.id}.`);
  }
  writeClaimFile(rootDir, claim, "wx");
}

export function claimRoleRuntimeOperation(
  rootDir: string,
  transactionId: string,
  claim: RuntimeOperationClaim,
  readActualStateDigest: (workingRoot: string) => string
): void {
  executeDomainTransaction(rootDir, transactionId, (workingRoot) => {
    writeRoleRuntimeOperationClaim(workingRoot, claim, readActualStateDigest(workingRoot));
  });
  activeOperationTokens.add(claim.token);
}

export function markRoleRuntimeOperationEffectStarted(
  rootDir: string,
  transactionId: string,
  claim: Pick<RoleStopRuntimeOperationClaim, "taskId" | "roleName" | "token">,
  recoveryToken: string | null = null
): void {
  executeDomainTransaction(rootDir, transactionId, (workingRoot) => {
    const current = readRoleRuntimeOperationClaim(workingRoot, claim.taskId, claim.roleName);
    if (
      current === null ||
      current.kind === "launch" ||
      current.token !== claim.token ||
      current.recoveryToken !== recoveryToken
    ) {
      throw usageError(`Operation token does not own Role control intent: ${claim.taskId}/${claim.roleName}.`);
    }
    if (current.phase === "effect-started") return;
    writeClaimFile(workingRoot, { ...current, phase: "effect-started" }, "w");
  });
}

export function writeTaskLifecycleEffectPlan(
  rootDir: string,
  claim: Pick<TaskLifecycleRuntimeOperationClaim, "taskId" | "token">,
  effectPlan: TaskLifecycleEffectPlan,
  recoveryToken: string | null = null
): TaskLifecycleRuntimeOperationClaim {
  const current = readTaskRuntimeOperationClaim(rootDir, claim.taskId);
  if (
    current === null || current.token !== claim.token ||
    current.recoveryToken !== recoveryToken
  ) {
    throw usageError(`Operation token does not own Task lifecycle intent: ${claim.taskId}.`);
  }
  if (current.phase === "effect-started") {
    if (roleRuntimeStateDigest(current.effectPlan) !== roleRuntimeStateDigest(effectPlan)) {
      throw usageError(`Task lifecycle effect plan is immutable: ${claim.taskId}.`);
    }
    return current;
  }
  const started: TaskLifecycleRuntimeOperationClaim = {
    ...current,
    phase: "effect-started",
    effectPlan
  };
  assertRuntimeOperationClaim(started, { scope: "task", taskId: claim.taskId });
  writeClaimFile(rootDir, started, "w");
  return started;
}

export function markTaskLifecycleOperationEffectStarted(
  rootDir: string,
  transactionId: string,
  claim: Pick<TaskLifecycleRuntimeOperationClaim, "taskId" | "token">,
  effectPlan: TaskLifecycleEffectPlan,
  recoveryToken: string | null = null
): TaskLifecycleRuntimeOperationClaim {
  return executeDomainTransaction(rootDir, transactionId, (workingRoot) =>
    writeTaskLifecycleEffectPlan(workingRoot, claim, effectPlan, recoveryToken));
}

export function readRoleRuntimeOperationClaim(
  rootDir: string,
  taskId: string,
  roleName: string
): RoleRuntimeOperationClaim | null {
  const claim = readRuntimeOperationClaim(rootDir, { scope: "task-role", taskId, roleName });
  if (claim === null) return null;
  if (claim.scope !== "task-role") throw dataError("Invalid Role runtime operation claim.");
  return claim;
}

export function readTaskRuntimeOperationClaim(
  rootDir: string,
  taskId: string
): TaskLifecycleRuntimeOperationClaim | null {
  const claim = readRuntimeOperationClaim(rootDir, { scope: "task", taskId });
  if (claim === null) return null;
  if (claim.scope !== "task") throw dataError("Invalid Task runtime operation claim.");
  return claim;
}

export function readGlobalRoleRuntimeOperationClaim(
  rootDir: string,
  roleName: string
): GlobalRoleRuntimeOperationClaim | null {
  const claim = readRuntimeOperationClaim(rootDir, { scope: "global-role", roleName });
  if (claim === null) return null;
  if (claim.scope !== "global-role") throw dataError("Invalid GlobalRole runtime operation claim.");
  return claim;
}

export function readRuntimeOperationClaim(
  rootDir: string,
  owner: RuntimeOperationOwner
): RuntimeOperationClaim | null {
  assertOwner(owner);
  const target = runtimeOperationClaimFile(rootDir, owner);
  assertClaimPath(rootDir, target);
  if (!existsSync(target)) return null;
  assertNoSymlinkPath(target);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(target, "utf8")) as unknown;
  } catch {
    throw dataError(`Invalid runtime operation claim: ${renderOwner(owner)}.`);
  }
  assertRuntimeOperationClaim(value, owner);
  return structuredClone(value);
}

export function listRoleRuntimeOperationClaims(rootDir: string): RoleRuntimeOperationClaim[] {
  return listRuntimeOperationClaims(rootDir)
    .filter((claim): claim is RoleRuntimeOperationClaim => claim.scope === "task-role");
}

export function listRuntimeOperationClaims(rootDir: string): RuntimeOperationClaim[] {
  const directory = roleRuntimeOperationClaimDirectory(rootDir);
  assertNoSymlinkPath(dirname(directory));
  if (!existsSync(directory)) return [];
  assertNoSymlinkPath(directory);
  const claims: RuntimeOperationClaim[] = [];
  for (const taskId of readdirSync(directory)) {
    if (taskId === "global-roles") {
      const globalDirectory = join(directory, taskId);
      if (!lstatSync(globalDirectory).isDirectory()) throw dataError("Invalid runtime operation owner.");
      assertNoSymlinkPath(globalDirectory);
      for (const entry of readdirSync(globalDirectory)) {
        if (!entry.endsWith(".json")) throw dataError("Invalid runtime operation owner.");
        const roleName = entry.slice(0, -5);
        const claim = readGlobalRoleRuntimeOperationClaim(rootDir, roleName);
        if (claim !== null) claims.push(claim);
      }
      continue;
    }
    if (!isSafeStorageSegment(taskId)) throw dataError("Invalid runtime operation owner.");
    const taskDirectory = join(directory, taskId);
    if (!lstatSync(taskDirectory).isDirectory()) throw dataError("Invalid runtime operation owner.");
    assertNoSymlinkPath(taskDirectory);
    const taskClaim = readTaskRuntimeOperationClaim(rootDir, taskId);
    if (taskClaim !== null) claims.push(taskClaim);
    const rolesDirectory = join(taskDirectory, "roles");
    if (!existsSync(rolesDirectory)) continue;
    if (!lstatSync(rolesDirectory).isDirectory()) throw dataError("Invalid runtime operation owner.");
    assertNoSymlinkPath(rolesDirectory);
    for (const entry of readdirSync(rolesDirectory)) {
      if (!entry.endsWith(".json")) throw dataError("Invalid runtime operation owner.");
      const roleName = entry.slice(0, -5);
      const roleClaim = readRoleRuntimeOperationClaim(rootDir, taskId, roleName);
      if (roleClaim !== null) claims.push(roleClaim);
    }
  }
  return claims.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function clearRoleRuntimeOperationClaim(
  rootDir: string,
  taskId: string,
  roleName: string,
  token: string,
  recoveryToken: string | null = null
): void {
  clearRuntimeOperationClaim(
    rootDir,
    { scope: "task-role", taskId, roleName },
    token,
    recoveryToken
  );
}

export function clearRuntimeOperationClaim(
  rootDir: string,
  owner: RuntimeOperationOwner,
  token: string,
  recoveryToken: string | null = null
): void {
  const existing = readRuntimeOperationClaim(rootDir, owner);
  if (existing === null) {
    throw usageError(`Runtime operation claim is missing: ${renderOwner(owner)}.`);
  }
  if (existing.token !== token) {
    throw usageError(`Operation token does not own runtime operation: ${renderOwner(owner)}.`);
  }
  if (existing.recoveryToken !== recoveryToken) {
    throw usageError(`Recovery token does not own runtime operation: ${renderOwner(owner)}.`);
  }
  rmSync(runtimeOperationClaimFile(rootDir, owner), { force: true });
  activeOperationTokens.delete(token);
}

export function releaseRoleRuntimeOperationClaim(
  rootDir: string,
  transactionId: string,
  claim: Pick<RoleRuntimeOperationClaim, "taskId" | "roleName" | "token">,
  recoveryToken: string | null = null
): void {
  executeDomainTransaction(rootDir, transactionId, (workingRoot) => {
    clearRoleRuntimeOperationClaim(
      workingRoot,
      claim.taskId,
      claim.roleName,
      claim.token,
      recoveryToken
    );
  });
  activeOperationTokens.delete(claim.token);
}

export function releaseRuntimeOperationClaim(
  rootDir: string,
  transactionId: string,
  claim: Pick<RuntimeOperationClaim, "scope" | "taskId" | "roleName" | "token">,
  recoveryToken: string | null = null
): void {
  const owner = ownerOfClaim(claim as RuntimeOperationClaim);
  executeDomainTransaction(rootDir, transactionId, (workingRoot) => {
    clearRuntimeOperationClaim(workingRoot, owner, claim.token, recoveryToken);
  });
  activeOperationTokens.delete(claim.token);
}

export function isRuntimeOperationRecoverable(
  claim: RuntimeOperationClaim,
  now = new Date()
): boolean {
  if (now.getTime() >= Date.parse(claim.leaseExpiresAt)) return true;
  if (activeOperationTokens.has(claim.token)) return false;
  return !isProcessAlive(claim.ownerPid);
}

export function claimRuntimeOperationRecovery(
  rootDir: string,
  transactionId: string,
  observed: RuntimeOperationClaim,
  recoveryToken: string,
  now = new Date()
): RuntimeOperationClaim | null {
  return executeDomainTransaction(rootDir, transactionId, (workingRoot) => {
    const owner = ownerOfClaim(observed);
    const current = readRuntimeOperationClaim(workingRoot, owner);
    if (
      current === null || current.token !== observed.token ||
      !isRuntimeOperationRecoverable(current, now)
    ) {
      return null;
    }
    const claimed: RuntimeOperationClaim = {
      ...current,
      recoveryToken,
      ownerPid: process.pid,
      leaseExpiresAt: new Date(now.getTime() + ROLE_RUNTIME_OPERATION_LEASE_MS).toISOString()
    };
    assertRuntimeOperationClaim(claimed, owner);
    writeClaimFile(workingRoot, claimed, "w");
    return claimed;
  });
}

export function isRoleRuntimeOperationRecoverable(
  claim: RoleRuntimeOperationClaim,
  now = new Date()
): boolean {
  if (now.getTime() >= Date.parse(claim.leaseExpiresAt)) return true;
  if (activeOperationTokens.has(claim.token)) return false;
  return !isProcessAlive(claim.ownerPid);
}

export function recoverAbandonedRoleRuntimeOperations(
  rootDir: string,
  cleanup: (claim: RoleRuntimeOperationClaim) => void | "finalized",
  options: {
    now?: Date;
    eligible?: (claim: RoleRuntimeOperationClaim) => boolean;
  } = {}
): string[] {
  const now = options.now ?? new Date();
  const recovered: string[] = [];
  for (const observed of listRoleRuntimeOperationClaims(rootDir)) {
    if (options.eligible?.(observed) === false) continue;
    if (!isRoleRuntimeOperationRecoverable(observed, now)) continue;
    const recoveryToken = randomUUID();
    const claimed = claimRoleRuntimeOperationRecovery(
      rootDir,
      `role-runtime-recover-${randomUUID()}`,
      observed,
      recoveryToken,
      now
    );
    if (claimed === null) continue;
    const outcome = cleanup(claimed);
    if (outcome !== "finalized") {
      releaseRoleRuntimeOperationClaim(
        rootDir,
        `role-runtime-release-${randomUUID()}`,
        claimed,
        recoveryToken
      );
    }
    recovered.push(claimed.token);
  }
  return recovered;
}

function claimRoleRuntimeOperationRecovery(
  rootDir: string,
  transactionId: string,
  observed: RoleRuntimeOperationClaim,
  recoveryToken: string,
  now: Date
): RoleRuntimeOperationClaim | null {
  return executeDomainTransaction(rootDir, transactionId, (workingRoot) => {
    const current = readRoleRuntimeOperationClaim(workingRoot, observed.taskId, observed.roleName);
    if (
      current === null ||
      current.token !== observed.token ||
      !isRoleRuntimeOperationRecoverable(current, now)
    ) {
      return null;
    }
    const claimed = {
      ...current,
      recoveryToken,
      ownerPid: process.pid,
      leaseExpiresAt: new Date(now.getTime() + ROLE_RUNTIME_OPERATION_LEASE_MS).toISOString()
    };
    writeClaimFile(workingRoot, claimed, "w");
    return claimed;
  });
}

function writeClaimFile(
  rootDir: string,
  claim: RuntimeOperationClaim,
  flag: "w" | "wx"
): void {
  const target = runtimeOperationClaimFile(rootDir, ownerOfClaim(claim));
  assertClaimPath(rootDir, target);
  mkdirSync(dirname(target), { recursive: true });
  const inert = lowerUnknownInertData(claim);
  const serialized = inert === null ? null : stringifyCanonicalInertData(inert);
  if (serialized === null) throw dataError("Invalid runtime operation claim.");
  writeFileSync(target, `${serialized}\n`, { flag, mode: 0o600 });
}

function assertOwner(owner: RuntimeOperationOwner): void {
  if (
    (owner.scope === "task" && !isSafeStorageSegment(owner.taskId)) ||
    (owner.scope === "task-role" && (
      !isSafeStorageSegment(owner.taskId) || !isSafeStorageSegment(owner.roleName)
    )) ||
    (owner.scope === "global-role" && !isSafeStorageSegment(owner.roleName))
  ) {
    throw dataError("Invalid runtime operation owner.");
  }
}

function assertRuntimeOperationClaim(
  value: unknown,
  owner?: RuntimeOperationOwner
): asserts value is RuntimeOperationClaim {
  if (!isStrictJsonValue(value) || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw dataError("Invalid runtime operation claim.");
  }
  const scope = Object.getOwnPropertyDescriptor(value, "scope")?.value;
  if (scope === "task-role") {
    assertTaskRoleRuntimeOperationClaim(value, owner);
    return;
  }
  if (scope === "task") {
    assertTaskLifecycleRuntimeOperationClaim(value, owner);
    return;
  }
  if (scope === "global-role") {
    assertGlobalRoleRuntimeOperationClaim(value, owner);
    return;
  }
  throw dataError("Invalid runtime operation claim.");
}

function assertTaskRoleRuntimeOperationClaim(
  value: object,
  owner?: RuntimeOperationOwner
): asserts value is RoleRuntimeOperationClaim {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const commonKeys = [
    "schemaVersion",
    "scope",
    "kind",
    "token",
    "taskId",
    "roleName",
    "operation",
    "ownerPid",
    "preparedSession",
    "selectedWorkItem",
    "pendingRun",
    "expectedStateDigest",
    "recoveryToken",
    "createdAt",
    "leaseExpiresAt"
  ];
  const kind = descriptors.kind?.value;
  const expectedKeys = kind === "launch"
    ? commonKeys
    : [...commonKeys, "phase", "targetLaunchToken", "preparedRole", "restartLaunch"];
  if (
    Object.keys(descriptors).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)
  ) {
    throw dataError("Invalid Role runtime operation claim.");
  }
  const claim = value as Record<string, unknown>;
  const kindAndOperationValid =
    (claim.kind === "launch" && typeof claim.operation === "string" &&
      ["dispatch", "leader-wakeup", "enter"].includes(claim.operation)) ||
    (claim.kind === "stop" && typeof claim.operation === "string" &&
      ["ttl-stop", "native-registration-timeout", "manual-stop", "manual-kill"].includes(claim.operation)) ||
    (claim.kind === "restart" && claim.operation === "manual-restart");
  const preparedSession = claim.preparedSession;
  const preparedSessionValid = claim.kind === "launch"
    ? preparedSession === null || safelyValidate(() => isRoleAgentSessionRecord(preparedSession))
    : claim.kind === "restart"
      ? preparedSession === null || (
          safelyValidate(() => isRoleAgentSessionRecord(preparedSession)) &&
          typeof claim.preparedRole === "object" && claim.preparedRole !== null &&
          "activeAgentId" in claim.preparedRole &&
          (preparedSession as RoleAgentSession).agentId === claim.preparedRole.activeAgentId
        )
      : preparedSession === null;
  const controlIntentValid = claim.kind === "launch" || (
    typeof claim.phase === "string" && ["prepared", "effect-started"].includes(claim.phase) &&
    (claim.targetLaunchToken === null || (
      typeof claim.targetLaunchToken === "string" && TOKEN_PATTERN.test(claim.targetLaunchToken)
    )) &&
    safelyValidate(() => isTaskRoleRecord(
      claim.preparedRole,
      claim.taskId as string,
      claim.roleName as string
    )) &&
    (claim.kind === "restart" ? isAgentLaunchPlan(claim.restartLaunch) : claim.restartLaunch === null)
  );
  if (
    claim.schemaVersion !== 1 ||
    claim.scope !== "task-role" ||
    !kindAndOperationValid ||
    typeof claim.token !== "string" || !TOKEN_PATTERN.test(claim.token) ||
    typeof claim.taskId !== "string" || !isSafeStorageSegment(claim.taskId) ||
    typeof claim.roleName !== "string" || !isSafeStorageSegment(claim.roleName) ||
    typeof claim.ownerPid !== "number" || !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid <= 0 ||
    !preparedSessionValid ||
    !controlIntentValid ||
    (claim.selectedWorkItem !== null && !isWorkItemSnapshot(claim.selectedWorkItem, claim.taskId)) ||
    (claim.pendingRun !== null && !isPendingRoleAgentRun(claim.pendingRun, claim.taskId, claim.roleName)) ||
    typeof claim.expectedStateDigest !== "string" || !DIGEST_PATTERN.test(claim.expectedStateDigest) ||
    (claim.recoveryToken !== null && (typeof claim.recoveryToken !== "string" || !TOKEN_PATTERN.test(claim.recoveryToken))) ||
    typeof claim.createdAt !== "string" || !isCanonicalTimestamp(claim.createdAt) ||
    typeof claim.leaseExpiresAt !== "string" || !isCanonicalTimestamp(claim.leaseExpiresAt) ||
    Date.parse(claim.leaseExpiresAt) <= Date.parse(claim.createdAt) ||
    (owner !== undefined && (
      owner.scope !== "task-role" ||
      claim.taskId !== owner.taskId ||
      claim.roleName !== owner.roleName
    ))
  ) {
    throw dataError("Invalid Role runtime operation claim.");
  }
}

function assertTaskLifecycleRuntimeOperationClaim(
  value: object,
  owner?: RuntimeOperationOwner
): asserts value is TaskLifecycleRuntimeOperationClaim {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = [
    "schemaVersion", "scope", "kind", "token", "taskId", "roleName", "operation",
    "ownerPid", "preparedSession", "selectedWorkItem", "pendingRun", "expectedStateDigest",
    "recoveryToken", "createdAt", "leaseExpiresAt", "phase", "preparedState", "effectPlan",
    "targetRoleName", "newRoleName", "archiveMetadata", "worktreeRequest"
  ];
  if (
    Object.keys(descriptors).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)
  ) {
    throw dataError("Invalid Task runtime operation claim.");
  }
  const claim = value as Record<string, unknown>;
  const taskId = claim.taskId;
  const operation = claim.operation;
  const targetValid =
    (["archive", "delete"].includes(String(operation)) &&
      claim.targetRoleName === null && claim.newRoleName === null) ||
    (["role-detach", "role-remove"].includes(String(operation)) &&
      typeof claim.targetRoleName === "string" && isSafeStorageSegment(claim.targetRoleName) &&
      claim.newRoleName === null) ||
    (operation === "role-rename" &&
      typeof claim.targetRoleName === "string" && isSafeStorageSegment(claim.targetRoleName) &&
      typeof claim.newRoleName === "string" && isSafeStorageSegment(claim.newRoleName) &&
      claim.targetRoleName !== claim.newRoleName) ||
    (["worktree-create", "worktree-remove"].includes(String(operation)) &&
      typeof claim.targetRoleName === "string" && isSafeStorageSegment(claim.targetRoleName) &&
      claim.newRoleName === null);
  const phaseAndPlanValid =
    (claim.phase === "prepared" && claim.effectPlan === null) ||
    (claim.phase === "effect-started" && isTaskLifecycleEffectPlan(
      claim.effectPlan,
      operation,
      claim.token,
      claim.targetRoleName,
      claim.newRoleName,
      claim.preparedState
    ));
  const archiveMetadataValid = operation === "archive"
    ? isArchiveMetadata(claim.archiveMetadata)
    : claim.archiveMetadata === null;
  const worktreeRequestValid = operation === "worktree-create"
    ? isWorktreeRequest(claim.worktreeRequest, true, claim.targetRoleName)
    : operation === "worktree-remove"
      ? isWorktreeRequest(claim.worktreeRequest, false, claim.targetRoleName)
      : claim.worktreeRequest === null;
  if (
    claim.schemaVersion !== 1 ||
    claim.scope !== "task" ||
    claim.kind !== "task-lifecycle" ||
    typeof claim.token !== "string" || !TOKEN_PATTERN.test(claim.token) ||
    typeof taskId !== "string" || !isSafeStorageSegment(taskId) ||
    claim.roleName !== null ||
    typeof operation !== "string" ||
    !["archive", "delete", "role-detach", "role-remove", "role-rename", "worktree-create", "worktree-remove"].includes(operation) ||
    typeof claim.ownerPid !== "number" || !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid <= 0 ||
    claim.preparedSession !== null || claim.selectedWorkItem !== null || claim.pendingRun !== null ||
    typeof claim.expectedStateDigest !== "string" || !DIGEST_PATTERN.test(claim.expectedStateDigest) ||
    (claim.recoveryToken !== null && (
      typeof claim.recoveryToken !== "string" || !TOKEN_PATTERN.test(claim.recoveryToken)
    )) ||
    typeof claim.createdAt !== "string" || !isCanonicalTimestamp(claim.createdAt) ||
    typeof claim.leaseExpiresAt !== "string" || !isCanonicalTimestamp(claim.leaseExpiresAt) ||
    Date.parse(claim.leaseExpiresAt) <= Date.parse(claim.createdAt) ||
    !targetValid || !phaseAndPlanValid || !archiveMetadataValid || !worktreeRequestValid ||
    !isTaskLifecyclePreparedState(claim.preparedState, taskId) ||
    roleRuntimeStateDigest(claim.preparedState) !== claim.expectedStateDigest ||
    (owner !== undefined && (owner.scope !== "task" || owner.taskId !== taskId))
  ) {
    throw dataError("Invalid Task runtime operation claim.");
  }
}

function isWorktreeRequest(value: unknown, create: boolean, targetRoleName: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== 4 ||
    !["roleName", "path", "branch", "base"].every((key) => Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined) ||
    typeof descriptors.roleName?.value !== "string" || !isSafeStorageSegment(descriptors.roleName.value) ||
    descriptors.roleName.value !== targetRoleName
  ) return false;
  if (!create) {
    return descriptors.path?.value === null && descriptors.branch?.value === null && descriptors.base?.value === null;
  }
  return typeof descriptors.path?.value === "string" && descriptors.path.value.length > 0 &&
    typeof descriptors.branch?.value === "string" && descriptors.branch.value.length > 0 &&
    (descriptors.base?.value === null || typeof descriptors.base?.value === "string");
}

function isArchiveMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === 3 &&
    ["by", "reason", "summary"].every((key) => Object.hasOwn(descriptors, key)) &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    ["user", "operator", "leader"].includes(String(descriptors.by?.value)) &&
    [descriptors.reason?.value, descriptors.summary?.value].every((item) =>
      item === null || typeof item === "string");
}

function assertGlobalRoleRuntimeOperationClaim(
  value: object,
  owner?: RuntimeOperationOwner
): asserts value is GlobalRoleRuntimeOperationClaim {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = [
    "schemaVersion", "scope", "kind", "token", "taskId", "roleName", "operation",
    "ownerPid", "preparedSession", "selectedWorkItem", "pendingRun", "expectedStateDigest",
    "recoveryToken", "createdAt", "leaseExpiresAt", "phase", "preparedState"
  ];
  const claim = value as Record<string, unknown>;
  if (
    Object.keys(descriptors).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined) ||
    claim.schemaVersion !== 1 || claim.scope !== "global-role" ||
    claim.kind !== "global-role-mutation" || claim.taskId !== null ||
    typeof claim.roleName !== "string" || !isSafeStorageSegment(claim.roleName) ||
    (claim.operation !== "update" && claim.operation !== "remove") ||
    typeof claim.token !== "string" || !TOKEN_PATTERN.test(claim.token) ||
    typeof claim.ownerPid !== "number" || !Number.isSafeInteger(claim.ownerPid) || claim.ownerPid <= 0 ||
    claim.preparedSession !== null || claim.selectedWorkItem !== null || claim.pendingRun !== null ||
    typeof claim.expectedStateDigest !== "string" || !DIGEST_PATTERN.test(claim.expectedStateDigest) ||
    (claim.recoveryToken !== null && (
      typeof claim.recoveryToken !== "string" || !TOKEN_PATTERN.test(claim.recoveryToken)
    )) ||
    typeof claim.createdAt !== "string" || !isCanonicalTimestamp(claim.createdAt) ||
    typeof claim.leaseExpiresAt !== "string" || !isCanonicalTimestamp(claim.leaseExpiresAt) ||
    Date.parse(claim.leaseExpiresAt) <= Date.parse(claim.createdAt) ||
    claim.phase !== "prepared" ||
    !isGlobalRolePreparedState(claim.preparedState, claim.roleName) ||
    (owner !== undefined && (owner.scope !== "global-role" || owner.roleName !== claim.roleName))
  ) {
    throw dataError("Invalid GlobalRole runtime operation claim.");
  }
}

function isGlobalRolePreparedState(value: unknown, roleName: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== 3 ||
    !["role", "sessionSet", "activeRun"].every((key) => Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)
  ) return false;
  const role = descriptors.role?.value;
  const sessionSet = descriptors.sessionSet?.value;
  const activeRun = descriptors.activeRun?.value;
  return safelyValidate(() => isGlobalRoleRecord(role, roleName)) &&
    (sessionSet === null || (
      safelyValidate(() => isGlobalRoleSessionSetRecord(sessionSet, roleName)) &&
      safelyValidate(() => sessionSetMatchesRole(sessionSet, role as GlobalRole))
    )) &&
    (activeRun === null || (
      isAgentRunSnapshot(activeRun, "operator") &&
      activeRun.roleName === roleName && activeRun.status === "active"
    ));
}

function isTaskLifecyclePreparedState(
  value: unknown,
  taskId: string
): value is TaskLifecyclePreparedState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    "task", "roles", "sessionSets", "activeRuns", "pendingRuns", "workItems", "worktrees",
    "dependencyGraphDigest"
  ];
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)
  ) return false;
  const field = (key: string): unknown => descriptors[key]?.value;
  const task = field("task");
  const roles = field("roles");
  const sessionSets = field("sessionSets");
  const activeRuns = field("activeRuns");
  const pendingRuns = field("pendingRuns");
  const workItems = field("workItems");
  const worktrees = field("worktrees");
  if (!(isTaskSnapshot(task, taskId) &&
    Array.isArray(roles) && roles.every((role) =>
      typeof role === "object" && role !== null && "name" in role &&
      typeof role.name === "string" && safelyValidate(() => isTaskRoleRecord(role, taskId, role.name))) &&
    isStrictlySorted(roles, (role) => role.name) &&
    Array.isArray(sessionSets) && sessionSets.every((set) =>
      typeof set === "object" && set !== null && "owner" in set &&
      typeof set.owner === "object" && set.owner !== null && "roleName" in set.owner &&
      typeof set.owner.roleName === "string" &&
      safelyValidate(() => isTaskRoleSessionSetRecord(set, taskId, set.owner.roleName))) &&
    isStrictlySorted(sessionSets, (set) => set.owner.roleName) &&
    Array.isArray(activeRuns) && activeRuns.every((run) => isAgentRunSnapshot(run, taskId)) &&
    isStrictlySorted(activeRuns, (run) => run.roleName) &&
    Array.isArray(pendingRuns) && pendingRuns.every((run) => isAgentRunSnapshot(run, taskId)) &&
    isStrictlySorted(pendingRuns, (run) => run.id) &&
    Array.isArray(workItems) && workItems.every((item) => isWorkItemSnapshot(item, taskId)) &&
    isStrictlySorted(workItems, (item) => item.id) &&
    Array.isArray(worktrees) && worktrees.every((item) => isRoleWorktreeSnapshot(item, taskId)) &&
    isStrictlySorted(worktrees, (item) => item.roleName) &&
    typeof field("dependencyGraphDigest") === "string" &&
    DIGEST_PATTERN.test(field("dependencyGraphDigest") as string))) return false;

  const rolesByName = new Map(roles.map((role) => [role.name, role]));
  return sessionSets.every((set) => {
    const role = rolesByName.get(set.owner.roleName);
    return role !== undefined && safelyValidate(() => sessionSetMatchesRole(set, role));
  }) && activeRuns.every((run) => rolesByName.has(run.roleName)) &&
    pendingRuns.every((run) => rolesByName.has(run.roleName)) &&
    worktrees.every((worktree) => rolesByName.has(worktree.roleName));
}

function isTaskLifecycleEffectPlan(
  value: unknown,
  operation: unknown,
  operationToken: unknown,
  targetRoleName: unknown,
  newRoleName: unknown,
  preparedState: unknown
): value is TaskLifecycleEffectPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
    return false;
  }
  if (operation === "role-rename") {
    return Object.keys(descriptors).length === 4 &&
      ["kind", "oldName", "newName", "launchToken"].every((key) => Object.hasOwn(descriptors, key)) &&
      descriptors.kind?.value === "rename-role" &&
      typeof descriptors.oldName?.value === "string" && isSafeStorageSegment(descriptors.oldName.value) &&
      typeof descriptors.newName?.value === "string" && isSafeStorageSegment(descriptors.newName.value) &&
      descriptors.oldName.value !== descriptors.newName.value &&
      descriptors.oldName.value === targetRoleName && descriptors.newName.value === newRoleName &&
      isNullableToken(descriptors.launchToken?.value);
  }
  if (operation === "role-detach") {
    return Object.keys(descriptors).length === 2 &&
      ["kind", "roleName"].every((key) => Object.hasOwn(descriptors, key)) &&
      descriptors.kind?.value === "detach-role" &&
      descriptors.roleName?.value === targetRoleName &&
      typeof descriptors.roleName?.value === "string" &&
      isSafeStorageSegment(descriptors.roleName.value);
  }
  if (operation === "worktree-create") {
    return isGitWorktreeCreatePlan(value) && value.roleName === targetRoleName &&
      value.ownerToken === operationToken;
  }
  if (operation === "worktree-remove") {
    return isGitWorktreeRemovePlan(value) && value.roleName === targetRoleName;
  }
  if (!Array.isArray((preparedState as TaskLifecyclePreparedState | null)?.roles)) return false;
  const preparedRoles = (preparedState as TaskLifecyclePreparedState).roles;
  const windows = descriptors.windows?.value;
  return Object.keys(descriptors).length === 2 &&
    Object.hasOwn(descriptors, "kind") && Object.hasOwn(descriptors, "windows") &&
    descriptors.kind?.value === "stop-roles" && Array.isArray(windows) &&
    windows.every(isTaskRuntimeWindowEffect) &&
    windows.every((window, index) => index === 0 || windows[index - 1].roleName < window.roleName) &&
    windows.every((window) => preparedRoles.some((role) => role.name === window.roleName)) &&
    (operation !== "role-remove" || windows.every((window) => window.roleName === targetRoleName));
}

function isGitWorktreeCreatePlan(value: unknown): value is GitWorktreeCreatePlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    "kind", "roleName", "repositoryRoot", "commonDir", "repositoryFingerprint",
    "targetPath", "baseOid", "requestedBranch", "temporaryBranch", "ownerToken", "markerPath"
  ];
  const field = (key: string): unknown => descriptors[key]?.value;
  return Object.keys(descriptors).length === keys.length &&
    keys.every((key) => Object.hasOwn(descriptors, key)) &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    field("kind") === "git-worktree-create" &&
    typeof field("roleName") === "string" && isSafeStorageSegment(field("roleName")) &&
    ["repositoryRoot", "commonDir", "targetPath", "markerPath"].every((key) => isCanonicalAbsolutePath(field(key))) &&
    typeof field("repositoryFingerprint") === "string" && DIGEST_PATTERN.test(field("repositoryFingerprint") as string) &&
    typeof field("baseOid") === "string" && GIT_OID_PATTERN.test(field("baseOid") as string) &&
    typeof field("requestedBranch") === "string" && isSafeGitBranchName(field("requestedBranch") as string) &&
    typeof field("temporaryBranch") === "string" &&
    typeof field("ownerToken") === "string" && TOKEN_PATTERN.test(field("ownerToken") as string) &&
    field("temporaryBranch") === `taskmux-op-${field("ownerToken") as string}` &&
    field("markerPath") === join(
      field("commonDir") as string,
      "taskmux-worktree-owners",
      `${field("ownerToken") as string}.json`
    );
}

function isGitWorktreeRemovePlan(value: unknown): value is GitWorktreeRemovePlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    "kind", "roleName", "repositoryRoot", "commonDir", "repositoryFingerprint",
    "targetPath", "worktreeGitDir", "ownerToken", "branchRef", "headOid", "markerPath"
  ];
  const field = (key: string): unknown => descriptors[key]?.value;
  return Object.keys(descriptors).length === keys.length &&
    keys.every((key) => Object.hasOwn(descriptors, key)) &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    field("kind") === "git-worktree-remove" &&
    typeof field("roleName") === "string" && isSafeStorageSegment(field("roleName")) &&
    ["repositoryRoot", "commonDir", "targetPath", "worktreeGitDir", "markerPath"].every((key) => isCanonicalAbsolutePath(field(key))) &&
    typeof field("repositoryFingerprint") === "string" && DIGEST_PATTERN.test(field("repositoryFingerprint") as string) &&
    typeof field("ownerToken") === "string" && TOKEN_PATTERN.test(field("ownerToken") as string) &&
    typeof field("branchRef") === "string" && isSafeGitBranchName(field("branchRef") as string) &&
    typeof field("headOid") === "string" && GIT_OID_PATTERN.test(field("headOid") as string) &&
    field("markerPath") === join(
      field("commonDir") as string,
      "taskmux-worktree-owners",
      `${field("ownerToken") as string}.json`
    );
}

function isRoleWorktreeSnapshot(value: unknown, taskId: string): value is RoleWorktree {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    "schemaVersion", "taskId", "roleName", "repositoryRoot", "commonDir",
    "repositoryFingerprint", "path", "worktreeGitDir", "branchRef", "headOid",
    "ownerToken", "createdAt"
  ];
  const field = (key: string): unknown => descriptors[key]?.value;
  return Object.keys(descriptors).length === keys.length && keys.every((key) => Object.hasOwn(descriptors, key)) &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    field("schemaVersion") === 2 && field("taskId") === taskId &&
    typeof field("roleName") === "string" && isSafeStorageSegment(field("roleName")) &&
    ["repositoryRoot", "commonDir", "path", "worktreeGitDir"].every((key) => isCanonicalAbsolutePath(field(key))) &&
    typeof field("repositoryFingerprint") === "string" && DIGEST_PATTERN.test(field("repositoryFingerprint") as string) &&
    typeof field("branchRef") === "string" && isSafeGitBranchName(field("branchRef") as string) &&
    typeof field("headOid") === "string" && GIT_OID_PATTERN.test(field("headOid") as string) &&
    typeof field("ownerToken") === "string" && TOKEN_PATTERN.test(field("ownerToken") as string) &&
    typeof field("createdAt") === "string" && isCanonicalTimestamp(field("createdAt") as string);
}

function isCanonicalAbsolutePath(value: unknown): boolean {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function isSafeGitBranchName(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") &&
    !value.endsWith(".") && !value.includes("..") && !value.includes("//") && !value.includes("@{") &&
    !value.endsWith(".lock") && !/[\u0000-\u0020\u007f~^:?*\[\]\\]/.test(value);
}

function isStrictlySorted<T>(values: readonly T[], identity: (value: T) => string): boolean {
  return values.every((value, index) => index === 0 || identity(values[index - 1]) < identity(value));
}

function isTaskRuntimeWindowEffect(value: unknown): value is TaskRuntimeWindowEffect {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === 2 &&
    Object.hasOwn(descriptors, "roleName") && Object.hasOwn(descriptors, "launchToken") &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    typeof descriptors.roleName?.value === "string" && isSafeStorageSegment(descriptors.roleName.value) &&
    isNullableToken(descriptors.launchToken?.value);
}

function isNullableToken(value: unknown): boolean {
  return value === null || (typeof value === "string" && TOKEN_PATTERN.test(value));
}

function isTaskSnapshot(value: unknown, taskId: string): value is Task {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const required = ["schemaVersion", "id", "title", "archived", "createdAt", "updatedAt"];
  const optional = [
    "description", "priority", "tags", "dueAt", "archivedAt", "archivedBy",
    "archiveReason", "archiveSummary"
  ];
  const keys = Object.keys(descriptors);
  const field = (key: string): unknown => descriptors[key]?.value;
  return required.every((key) => Object.hasOwn(descriptors, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key)) &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    field("schemaVersion") === 1 && field("id") === taskId &&
    typeof field("title") === "string" && typeof field("archived") === "boolean" &&
    typeof field("createdAt") === "string" && isCanonicalTimestamp(field("createdAt") as string) &&
    typeof field("updatedAt") === "string" && isCanonicalTimestamp(field("updatedAt") as string) &&
    ["description", "dueAt", "archivedAt", "archiveReason", "archiveSummary"].every((key) =>
      field(key) === undefined || typeof field(key) === "string") &&
    (field("priority") === undefined || ["low", "medium", "high", "urgent"].includes(String(field("priority")))) &&
    (field("tags") === undefined || (
      Array.isArray(field("tags")) && (field("tags") as unknown[]).every((tag) => typeof tag === "string")
    )) &&
    (field("archivedBy") === undefined || ["user", "operator", "leader"].includes(String(field("archivedBy"))));
}

function isAgentRunSnapshot(value: unknown, taskId: string): value is AgentRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const required = [
    "schemaVersion", "id", "taskId", "roleName", "mode", "input", "status", "createdAt", "updatedAt"
  ];
  const optional = ["workItemId", "topics", "summary", "endedAt"];
  const keys = Object.keys(descriptors);
  const field = (key: string): unknown => descriptors[key]?.value;
  return required.every((key) => Object.hasOwn(descriptors, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key)) &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    field("schemaVersion") === 1 && field("taskId") === taskId &&
    typeof field("id") === "string" && isSafeStorageSegment(field("id") as string) &&
    typeof field("roleName") === "string" && isSafeStorageSegment(field("roleName") as string) &&
    (field("mode") === "new" || field("mode") === "resume") && typeof field("input") === "string" &&
    ["active", "yielded", "failed", "expired"].includes(String(field("status"))) &&
    typeof field("createdAt") === "string" && isCanonicalTimestamp(field("createdAt") as string) &&
    typeof field("updatedAt") === "string" && isCanonicalTimestamp(field("updatedAt") as string) &&
    ["workItemId", "summary", "endedAt"].every((key) =>
      field(key) === undefined || typeof field(key) === "string") &&
    (field("topics") === undefined || (
      Array.isArray(field("topics")) && (field("topics") as unknown[]).every((topic) => typeof topic === "string")
    ));
}

function isAgentLaunchPlan(value: unknown): value is AgentLaunchPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== 3 ||
    !["command", "args", "env"].every((key) => Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)
  ) return false;
  const command = descriptors.command?.value;
  const args = descriptors.args?.value;
  const env = descriptors.env?.value;
  if (typeof command !== "string" || command.trim().length === 0 ||
      !Array.isArray(args) || !args.every((item) => typeof item === "string") ||
      typeof env !== "object" || env === null || Array.isArray(env)) return false;
  const environment = Object.getOwnPropertyDescriptors(env);
  return Object.keys(environment).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) &&
    Object.values(environment).every((descriptor) =>
      descriptor.get === undefined && descriptor.set === undefined &&
      descriptor.enumerable === true && typeof descriptor.value === "string");
}

function isPendingRoleAgentRun(value: unknown, taskId: unknown, roleName: unknown): value is PendingRoleAgentRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === 3 &&
    ["id", "taskId", "roleName"].every((key) => Object.hasOwn(descriptors, key)) &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    typeof descriptors.id?.value === "string" && isSafeStorageSegment(descriptors.id.value) &&
    descriptors.taskId?.value === taskId &&
    descriptors.roleName?.value === roleName;
}

function isWorkItemSnapshot(value: unknown, taskId: unknown): value is WorkItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const required = [
    "schemaVersion", "id", "taskId", "title", "assignee", "topics", "status", "createdAt", "updatedAt"
  ];
  const optional = ["cycleId", "outcome", "endedAt"];
  const keys = Object.keys(descriptors);
  const field = (key: string): unknown => descriptors[key]?.value;
  const status = field("status");
  return required.every((key) => Object.hasOwn(descriptors, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key)) &&
    Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined) &&
    field("schemaVersion") === 1 &&
    typeof field("id") === "string" && isSafeStorageSegment(field("id")) &&
    field("taskId") === taskId &&
    (field("cycleId") === undefined || typeof field("cycleId") === "string") &&
    typeof field("title") === "string" &&
    typeof field("assignee") === "string" &&
    Array.isArray(field("topics")) && (field("topics") as unknown[]).every((item) => typeof item === "string") &&
    typeof status === "string" &&
    ["pending", "running", "completed", "failed", "cancelled", "superseded"].includes(status) &&
    (field("outcome") === undefined || typeof field("outcome") === "string") &&
    typeof field("createdAt") === "string" && isCanonicalTimestamp(String(field("createdAt"))) &&
    typeof field("updatedAt") === "string" && isCanonicalTimestamp(String(field("updatedAt"))) &&
    (field("endedAt") === undefined || (typeof field("endedAt") === "string" && isCanonicalTimestamp(String(field("endedAt")))));
}

function isStrictJsonValue(value: unknown): boolean {
  return lowerUnknownInertData(value) !== null;
}

function safelyValidate(validate: () => boolean): boolean {
  try {
    return validate();
  } catch {
    return false;
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function roleRuntimeOperationClaimDirectory(rootDir: string): string {
  return join(rootDir, "runtime", "role-runtime-operations");
}

function runtimeOperationClaimFile(rootDir: string, owner: RuntimeOperationOwner): string {
  const directory = roleRuntimeOperationClaimDirectory(rootDir);
  if (owner.scope === "task") return join(directory, owner.taskId, "task.json");
  if (owner.scope === "task-role") {
    return join(directory, owner.taskId, "roles", `${owner.roleName}.json`);
  }
  return join(directory, "global-roles", `${owner.roleName}.json`);
}

function ownerOfClaim(claim: RuntimeOperationClaim): RuntimeOperationOwner {
  if (claim.scope === "task") return { scope: "task", taskId: claim.taskId };
  if (claim.scope === "task-role") {
    return { scope: "task-role", taskId: claim.taskId, roleName: claim.roleName };
  }
  return { scope: "global-role", roleName: claim.roleName };
}

function renderOwner(owner: RuntimeOperationOwner): string {
  if (owner.scope === "task") return `task:${owner.taskId}`;
  if (owner.scope === "task-role") return `task-role:${owner.taskId}/${owner.roleName}`;
  return `global-role:${owner.roleName}`;
}

export function runtimeOperationClaimsConflict(
  left: RuntimeOperationClaim,
  right: RuntimeOperationClaim
): boolean {
  const leftOwner = ownerOfClaim(left);
  const rightOwner = ownerOfClaim(right);
  if (leftOwner.scope === "global-role" || rightOwner.scope === "global-role") {
    return leftOwner.scope === "global-role" && rightOwner.scope === "global-role" &&
      leftOwner.roleName === rightOwner.roleName;
  }
  if (leftOwner.taskId !== rightOwner.taskId) return false;
  if (leftOwner.scope === "task" || rightOwner.scope === "task") return true;
  return leftOwner.roleName === rightOwner.roleName;
}

export function assertRuntimeOperationAllowsMutation(
  rootDir: string,
  owner: RuntimeOperationOwner,
  token?: string,
  recoveryToken?: string
): void {
  const conflict = listRuntimeOperationClaims(rootDir).find((claim) => {
    const claimOwner = ownerOfClaim(claim);
    if (owner.scope === "global-role") {
      return claimOwner.scope === "global-role" && claimOwner.roleName === owner.roleName;
    }
    if (claimOwner.scope === "global-role") return false;
    if (claimOwner.taskId !== owner.taskId) return false;
    if (claimOwner.scope === "task" || owner.scope === "task") return true;
    return claimOwner.roleName === owner.roleName;
  });
  if (conflict === undefined) return;
  if (conflict.token !== token) {
    throw usageError(`Runtime state is reserved by an active operation: ${renderOwner(owner)}.`);
  }
  if (conflict.recoveryToken !== null && conflict.recoveryToken !== recoveryToken) {
    throw usageError(`Runtime operation is being recovered: ${renderOwner(owner)}.`);
  }
}

function assertClaimPath(rootDir: string, target: string): void {
  const directory = roleRuntimeOperationClaimDirectory(rootDir);
  assertNoSymlinkPath(dirname(directory));
  assertNoSymlinkPath(directory);
  let current = dirname(target);
  while (current.startsWith(directory)) {
    assertNoSymlinkPath(current);
    if (current === directory) break;
    current = dirname(current);
  }
}

function assertNoSymlinkPath(target: string): void {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw dataError("Role runtime operation storage cannot contain symbolic links.");
  }
}
