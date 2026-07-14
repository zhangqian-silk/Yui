import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { resolveAgent } from "../agent/agentRegistry.js";
import {
  createRoleSessionSet,
  sameNativeSessionIdentity,
  updateRoleAgentSessionStatus,
  type GlobalRoleSessionSet,
  type RoleAgentSession
} from "../executor/agentExecutor.js";
import {
  claimRuntimeOperationRecovery,
  clearRuntimeOperationClaim,
  createRoleRuntimeOperationLease,
  isRuntimeOperationRecoverable,
  listRuntimeOperationClaims,
  markGlobalRoleLaunchEffectStarted,
  readGlobalRoleRuntimeOperationClaim,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim,
  type GlobalRoleLaunchRuntimeOperationClaim
} from "../executor/executorRegistry.js";
import { dataError, usageError } from "../errors/cliError.js";
import { prepareGlobalRoleLaunch, type OperatorLaunch } from "./operatorContext.js";
import { activeRoleAgentBinding, copyGlobalRoleToTaskRole, type GlobalRole, type Role } from "../role/role.js";
import { SYSTEM_OPERATOR_ROLE } from "../role/systemRoles.js";
import { executeDomainTransaction } from "../storage/domainTransaction.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";

type GlobalRoleState = {
  role: GlobalRole;
  sessionSet: GlobalRoleSessionSet | null;
  activeRun: ReturnType<TaskStore["getActiveAgentRun"]>;
};

export type OperatorWindowLaunch = {
  role: GlobalRole;
  taskRole: Role;
  created: boolean;
  prepared: OperatorLaunch | null;
};

/**
 * The tmux Operator pane has no independent session authority. Its only
 * durable authority is the active tuple in GlobalRoleSessionSet("operator"),
 * guarded by the existing global-role runtime claim.
 */
export function launchOperatorWindow(
  rootDir: string,
  tmux: TmuxManager,
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date()
): OperatorWindowLaunch {
  recoverOperatorLaunches(rootDir, tmux, now);
  executeDomainTransaction(rootDir, `operator-launch-settle-${randomUUID()}`, (workingRoot) => {
    settleConfirmedAbsentOperatorWindow(new FileTaskStore(workingRoot), tmux, now);
  });

  const store = new FileTaskStore(rootDir);
  const state = readOperatorState(store);
  const status = probeOperatorWindow(tmux);
  if (status === "running") {
    if (!hasConfirmedOrPendingOperatorBinding(rootDir, state, tmux)) {
      throw usageError("Operator window exists without its durable GlobalRoleSessionSet binding.");
    }
    return {
      role: state.role,
      taskRole: copyGlobalRoleToTaskRole(state.role, "operator", now),
      created: false,
      prepared: null
    };
  }

  const existingClaim = readGlobalRoleRuntimeOperationClaim(rootDir, SYSTEM_OPERATOR_ROLE);
  if (existingClaim?.kind === "global-role-launch") {
    throw usageError("Operator launch recovery is pending; durable session authority is not yet confirmed.");
  }

  const binding = activeRoleAgentBinding(state.role);
  const agent = resolveAgent(binding.agentId, store.listConfiguredAgents());
  if (agent === null) {
    throw dataError(`Operator Agent is not configured: ${binding.agentId}.`);
  }

  const token = randomUUID();
  const prepared = prepareGlobalRoleLaunch(state.role, agent, {
    taskmuxHome: rootDir,
    baseEnv: environment,
    session: state.sessionSet?.sessions[state.role.activeAgentId] ?? null,
    launchToken: token
  });
  const reservedSet = reservedSessionSet(state, prepared.session, now);
  const claim = createLaunchClaim(state, prepared.session, token, now);

  executeDomainTransaction(rootDir, `operator-launch-reserve-${randomUUID()}`, (workingRoot) => {
    const transactionStore = new FileTaskStore(workingRoot);
    const actual = readOperatorState(transactionStore);
    const actualDigest = roleRuntimeStateDigest(actual);
    if (actualDigest !== claim.expectedStateDigest) {
      throw usageError("Operator state changed before session reservation.");
    }
    writeRoleRuntimeOperationClaim(workingRoot, claim, actualDigest);
    transactionStore.saveGlobalRoleSessionSet(reservedSet);
  });

  markGlobalRoleLaunchEffectStarted(
    rootDir,
    `operator-launch-effect-${randomUUID()}`,
    claim
  );

  const taskRole = copyGlobalRoleToTaskRole(state.role, "operator", now);
  const created = tmux.ensureRoleWindow("operator", taskRole, {
    command: prepared.command,
    args: prepared.args,
    env: prepared.explicitEnv
  }, {
    launchToken: claim.token
  });
  if (!created || probeOperatorWindow(tmux) !== "running" ||
      tmux.roleLaunchToken("operator", SYSTEM_OPERATOR_ROLE) !== claim.token) {
    throw usageError("Operator window creation could not be durably fenced.");
  }
  if (environment.TASKMUX_TEST_ONLY_OPERATOR_LAUNCH_FAILPOINT === "after-window") {
    throw new Error("Operator launch stopped after its tmux window effect.");
  }

  if (prepared.session !== null) {
    confirmPreparedOperatorSession(rootDir, claim.token, now);
  }

  return { role: state.role, taskRole, created, prepared };
}

/**
 * Session registration is the commit point for a Codex runtime-discovered
 * native id. It must bind to the same fenced tmux window that owns the
 * outstanding launch claim.
 */
export function confirmOperatorNativeSessionRegistration(
  store: TaskStore,
  role: GlobalRole,
  nextSessionSet: GlobalRoleSessionSet,
  launchToken: string,
  tmux: TmuxManager
): void {
  if (role.name !== SYSTEM_OPERATOR_ROLE) {
    throw usageError("Only the system Operator may confirm an Operator launch session.");
  }
  if (
    probeOperatorWindow(tmux) !== "running" ||
    tmux.roleLaunchToken("operator", SYSTEM_OPERATOR_ROLE) !== launchToken
  ) {
    throw usageError("Operator native session registration is not owned by the active tmux window.");
  }
  const claim = readGlobalRoleRuntimeOperationClaim(store.rootDirectory(), SYSTEM_OPERATOR_ROLE);
  if (claim === null || claim.kind !== "global-role-launch" ||
      claim.token !== launchToken || claim.phase !== "effect-started" ||
      claim.preparedSession !== null) {
    const current = store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
    const session = current?.sessions[role.activeAgentId];
    const candidate = nextSessionSet.sessions[role.activeAgentId];
    if (
      current?.activeAgentId === role.activeAgentId &&
      session?.status === "running" &&
      candidate?.status === "running" &&
      sameNativeSessionIdentity(session, candidate)
    ) {
      return;
    }
    throw usageError("Operator native session registration does not own a pending runtime-discovered launch.");
  }
  const expected = reservedSessionSetForClaim(claim);
  const current = store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
  if (!isDeepStrictEqual(current, expected)) {
    throw usageError("Operator native session authority changed before registration.");
  }
  store.saveGlobalRoleSessionSet(nextSessionSet);
  clearRuntimeOperationClaim(
    store.rootDirectory(),
    { scope: "global-role", roleName: SYSTEM_OPERATOR_ROLE },
    claim.token,
    claim.recoveryToken
  );
}

export function recoverOperatorLaunches(
  rootDir: string,
  tmux: TmuxManager,
  now = new Date()
): string[] {
  const recovered: string[] = [];
  for (const observed of listRuntimeOperationClaims(rootDir)) {
    if (observed.scope !== "global-role" || observed.kind !== "global-role-launch") continue;
    const status = probeOperatorWindowSafely(tmux);
    if (status === "unknown") continue;

    if (status === "running") {
      let launchToken: string | null;
      try {
        launchToken = tmux.roleLaunchToken("operator", observed.roleName);
      } catch {
        continue;
      }
      if (
        launchToken !== observed.token ||
        observed.preparedSession === null ||
        !isRuntimeOperationRecoverable(observed, now)
      ) continue;
      const claimed = claimRuntimeOperationRecovery(
        rootDir,
        `operator-launch-recover-${randomUUID()}`,
        observed,
        randomUUID(),
        now
      );
      if (claimed?.scope === "global-role" && claimed.kind === "global-role-launch") {
        confirmPreparedOperatorSession(rootDir, claimed.token, now, claimed.recoveryToken);
        recovered.push(claimed.token);
      }
      continue;
    }

    if (status !== "exited" || !isRuntimeOperationRecoverable(observed, now)) continue;
    const claimed = claimRuntimeOperationRecovery(
      rootDir,
      `operator-launch-recover-${randomUUID()}`,
      observed,
      randomUUID(),
      now
    );
    if (claimed?.scope !== "global-role" || claimed.kind !== "global-role-launch") continue;
    terminalizeReservedOperatorSession(rootDir, claimed, now);
    recovered.push(claimed.token);
  }
  return recovered;
}

function confirmPreparedOperatorSession(
  rootDir: string,
  token: string,
  now: Date,
  recoveryToken: string | null = null
): void {
  executeDomainTransaction(rootDir, `operator-launch-confirm-${randomUUID()}`, (workingRoot) => {
    const store = new FileTaskStore(workingRoot);
    const claim = readGlobalRoleRuntimeOperationClaim(workingRoot, SYSTEM_OPERATOR_ROLE);
    if (claim === null || claim.kind !== "global-role-launch" || claim.token !== token ||
        claim.recoveryToken !== recoveryToken || claim.phase !== "effect-started" ||
        claim.preparedSession === null) {
      throw usageError("Operator launch confirmation no longer owns the reserved session.");
    }
    const current = store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
    const expected = reservedSessionSetForClaim(claim);
    if (!isDeepStrictEqual(current, expected)) {
      throw usageError("Operator session authority changed before launch confirmation.");
    }
    const confirmed = updateRoleAgentSessionStatus(
      expected,
      claim.preparedState.role.activeAgentId,
      "running",
      now
    );
    store.saveGlobalRoleSessionSet(confirmed);
    clearRuntimeOperationClaim(
      workingRoot,
      { scope: "global-role", roleName: SYSTEM_OPERATOR_ROLE },
      claim.token,
      recoveryToken
    );
  });
}

function terminalizeReservedOperatorSession(
  rootDir: string,
  claim: GlobalRoleLaunchRuntimeOperationClaim,
  now: Date
): void {
  executeDomainTransaction(rootDir, `operator-launch-terminalize-${randomUUID()}`, (workingRoot) => {
    const store = new FileTaskStore(workingRoot);
    const current = readGlobalRoleRuntimeOperationClaim(workingRoot, SYSTEM_OPERATOR_ROLE);
    if (current === null || current.kind !== "global-role-launch" ||
        current.token !== claim.token || current.recoveryToken !== claim.recoveryToken) {
      return;
    }
    const expected = reservedSessionSetForClaim(current);
    if (isDeepStrictEqual(store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE), expected)) {
      const terminal = current.preparedSession === null
        ? expected
        : updateRoleAgentSessionStatus(
            expected,
            current.preparedState.role.activeAgentId,
            "stopped",
            now
          );
      store.saveGlobalRoleSessionSet(terminal);
    }
    clearRuntimeOperationClaim(
      workingRoot,
      { scope: "global-role", roleName: SYSTEM_OPERATOR_ROLE },
      current.token,
      current.recoveryToken
    );
  });
}

/**
 * Runs inside the caller's already-authoritative transaction. A confirmed
 * absent pane may only terminalize a fully confirmed active binding; launch
 * claims and partial bindings remain unknown for the caller to handle.
 */
export function settleConfirmedAbsentOperatorWindow(
  store: Pick<
    TaskStore,
    "rootDirectory" | "getGlobalRole" | "getGlobalRoleSessionSet" |
    "getActiveAgentRun" | "saveGlobalRoleSessionSet"
  >,
  tmux: Pick<TmuxManager, "probeRoleStatus">,
  now: Date
): boolean {
  if (probeOperatorWindowSafely(tmux) !== "exited") return false;
  const claim = readGlobalRoleRuntimeOperationClaim(store.rootDirectory(), SYSTEM_OPERATOR_ROLE);
  if (claim?.kind === "global-role-launch") return false;
  const role = store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
  if (role === null) return false;
  const sessionSet = store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE);
  const session = sessionSet?.sessions[role.activeAgentId];
  const binding = role.agentBindings[role.activeAgentId];
  if (
    binding === undefined ||
    sessionSet === null ||
    sessionSet.activeAgentId !== role.activeAgentId ||
    session === undefined ||
    session.agentId !== role.activeAgentId ||
    session.adapterId !== binding.adapterId ||
    session.status !== "running"
  ) {
    return false;
  }
  store.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus(
    sessionSet,
    role.activeAgentId,
    "stopped",
    now
  ));
  return true;
}

function hasConfirmedOrPendingOperatorBinding(
  rootDir: string,
  state: GlobalRoleState,
  tmux: TmuxManager
): boolean {
  const binding = activeRoleAgentBinding(state.role);
  const session = state.sessionSet?.sessions[state.role.activeAgentId];
  if (
    state.sessionSet?.activeAgentId === state.role.activeAgentId &&
    session?.agentId === state.role.activeAgentId &&
    session.adapterId === binding.adapterId &&
    session.status === "running"
  ) return true;
  const claim = readGlobalRoleRuntimeOperationClaim(rootDir, SYSTEM_OPERATOR_ROLE);
  return claim?.kind === "global-role-launch" &&
    claim.phase === "effect-started" &&
    tmux.roleLaunchToken("operator", SYSTEM_OPERATOR_ROLE) === claim.token &&
    isDeepStrictEqual(state.sessionSet, reservedSessionSetForClaim(claim));
}

function reservedSessionSet(
  state: GlobalRoleState,
  preparedSession: RoleAgentSession | null,
  now: Date
): GlobalRoleSessionSet {
  const base = state.sessionSet ?? createRoleSessionSet(
    { scope: "global", roleName: SYSTEM_OPERATOR_ROLE },
    state.role.activeAgentId,
    now
  );
  const withPrepared: GlobalRoleSessionSet = {
    ...base,
    activeAgentId: state.role.activeAgentId,
    sessions: preparedSession === null
      ? { ...base.sessions }
      : { ...base.sessions, [state.role.activeAgentId]: preparedSession },
    updatedAt: now.toISOString()
  };
  return preparedSession === null
    ? withPrepared
    : updateRoleAgentSessionStatus(withPrepared, state.role.activeAgentId, "reserved", now);
}

function reservedSessionSetForClaim(claim: GlobalRoleLaunchRuntimeOperationClaim): GlobalRoleSessionSet {
  return reservedSessionSet(
    claim.preparedState,
    claim.preparedSession,
    new Date(claim.createdAt)
  );
}

function createLaunchClaim(
  state: GlobalRoleState,
  preparedSession: RoleAgentSession | null,
  token: string,
  now: Date
): GlobalRoleLaunchRuntimeOperationClaim {
  return {
    schemaVersion: 1,
    scope: "global-role",
    kind: "global-role-launch",
    token,
    taskId: null,
    roleName: SYSTEM_OPERATOR_ROLE,
    operation: "launch",
    ownerPid: process.pid,
    preparedSession,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(state),
    recoveryToken: null,
    ...createRoleRuntimeOperationLease(now),
    phase: "prepared",
    preparedState: state
  };
}

function readOperatorState(store: Pick<TaskStore, "getGlobalRole" | "getGlobalRoleSessionSet" | "getActiveAgentRun">): GlobalRoleState {
  const role = store.getGlobalRole(SYSTEM_OPERATOR_ROLE);
  if (role === null) throw dataError("Operator role is not configured. Run taskmux setup.");
  return {
    role,
    sessionSet: store.getGlobalRoleSessionSet(SYSTEM_OPERATOR_ROLE),
    activeRun: store.getActiveAgentRun("operator", SYSTEM_OPERATOR_ROLE)
  };
}

function probeOperatorWindow(tmux: Pick<TmuxManager, "probeRoleStatus">): "running" | "exited" {
  return tmux.probeRoleStatus("operator", SYSTEM_OPERATOR_ROLE);
}

function probeOperatorWindowSafely(
  tmux: Pick<TmuxManager, "probeRoleStatus">
): "running" | "exited" | "unknown" {
  try {
    return probeOperatorWindow(tmux);
  } catch {
    return "unknown";
  }
}
