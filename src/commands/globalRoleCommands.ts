import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { prepareGlobalRoleLaunch } from "../operator/operatorContext.js";
import { confirmOperatorNativeSessionRegistration } from "../operator/operatorLaunchAuthority.js";
import { roleConflict, roleNotFound, usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  activeRoleAgentBinding,
  createGlobalRole,
  switchActiveRoleAgent,
  updateGlobalRole
} from "../role/role.js";
import type { GlobalRole } from "../role/role.js";
import {
  isSystemRoleName,
  SYSTEM_OPERATOR_ROLE,
  SYSTEM_ROLE_NAMES,
  systemRoleDescription
} from "../role/systemRoles.js";
import { resolveAgent, supportedAgentIds } from "../agent/agentRegistry.js";
import {
  ROLE_EXPECT_UPDATED_AT_OPTION,
  ROLE_PROFILE_INHERITABLE_FIELDS
} from "../cli/roleOptionCatalog.js";
import { FileTaskStore, type TaskReader, type TaskStore } from "../storage/taskStore.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession,
  sameNativeSessionIdentity,
  updateRoleAgentSessionStatus,
  type GlobalRoleSessionSet
} from "../executor/agentExecutor.js";
import { resolveAgentAdapter } from "../executor/agentAdapter.js";
import {
  isCanonicalNativeSessionId,
  isCanonicalNativeSessionRoot
} from "../executor/nativeSessionIdentity.js";
import {
  claimRoleRuntimeOperation,
  claimRuntimeOperationRecovery,
  clearRuntimeOperationClaim,
  createRoleRuntimeOperationLease,
  isRuntimeOperationRecoverable,
  listRuntimeOperationClaims,
  readGlobalRoleRuntimeOperationClaim,
  releaseRuntimeOperationClaim,
  resolveAgentLaunchEnvironment,
  resolveAgentSessionRoot,
  roleRuntimeStateDigest,
  type GlobalRoleMutationRuntimeOperationClaim,
  type GlobalRoleRuntimeOperationClaim
} from "../executor/executorRegistry.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import { createAgentRun, type AgentRun } from "../run/agentRun.js";
import {
  executeDomainTransaction,
  hasActiveDomainTransactionAuthority
} from "../storage/domainTransaction.js";
import { parseRoleCommandOptions } from "./roleAgentOptions.js";
import type { ManualSessionRegistration } from "./sessionRegistration.js";
import { presentRole } from "../output/roleAgentPresentation.js";

const GLOBAL_ROLE_ADD_OPTIONS = [
  { option: "--agent" },
  { option: "--workspace" },
  { option: "--description" },
  { option: "--responsibility", repeatable: true },
  { option: "--constraint", repeatable: true },
  { option: "--expected-output" },
  { option: "--system-prompt" },
  { option: "--skill", repeatable: true }
] as const;

const GLOBAL_ROLE_UPDATE_OPTIONS = [
  { option: ROLE_EXPECT_UPDATED_AT_OPTION },
  { option: "--agent" },
  { option: "--active-agent" },
  { option: "--workspace" },
  { option: "--system-prompt" }
] as const;

type GlobalRoleCommandOptions = {
  taskmuxHome?: string;
  env?: NodeJS.ProcessEnv;
  tmux?: TmuxManager;
  sessionRegistration?: ManualSessionRegistration;
  requireManualSessionRegistration?: boolean;
};

export function runGlobalRoleCommand(
  args: string[],
  store: TaskStore,
  options: GlobalRoleCommandOptions = {}
): string {
  const [command, ...rest] = args;

  switch (command) {
    case "add":
      return addGlobalRoleCommand(rest, store);
    case "list":
      return listGlobalRoleCommand(store);
    case "show":
      return showGlobalRoleCommand(rest, store);
    case "update":
      return updateGlobalRoleCommand(rest, store, options);
    case "remove":
      return removeGlobalRoleCommand(rest, store, options);
    case "enter":
      return enterGlobalRoleCommand(rest, store, options);
    case "session":
      return globalRoleSessionCommand(rest, store, options);
    default:
      throw usageError(command === undefined ? "Role command is required." : `Unknown command: role ${command}`);
  }
}

export function runGlobalRoleReadCommand(args: string[], store: TaskReader): string {
  if (args[0] !== "list" && args[0] !== "show") {
    throw usageError(args[0] === undefined ? "Role command is required." : `Unknown command: role ${args[0]}`);
  }
  return runGlobalRoleCommand(args, store as TaskStore);
}

function addGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [name, ...rest] = args;
  const roleName = parseGlobalRoleName(name);
  const parsed = parseRoleCommandOptions(rest, GLOBAL_ROLE_ADD_OPTIONS, {
    profileInheritableFields: ROLE_PROFILE_INHERITABLE_FIELDS
  });
  assertSystemPromptSelection(parsed);
  const agentId = requiredOption(parsed.value("--agent"), "--agent");
  const workspace = parsed.value("--workspace")?.trim() ?? store.getConfig().defaultWorkspace ?? process.cwd();
  const agent = resolveAgent(agentId, store.listConfiguredAgents());

  if (agent === null) {
    throwUnsupportedAgent(agentId, store);
  }

  const binding = parsed.createBinding(agent, workspace);
  const role = createGlobalRole(roleName, [binding], agent.id, workspace, new Date(), {
    description: parsed.value("--description")?.trim(),
    responsibilities: parsed.values("--responsibility").map((value) => value.trim()),
    constraints: parsed.values("--constraint").map((value) => value.trim()),
    expectedOutput: parsed.value("--expected-output")?.trim(),
    systemPrompt: parsed.value("--system-prompt")?.trim(),
    skills: parsed.values("--skill").map((value) => value.trim())
  });
  const created = store.createGlobalRoleIfAbsent(role);
  if (created === null) throw roleConflict(role.name);

  return renderGlobalRole(`Added role ${created.name}`, created);
}

function listGlobalRoleCommand(store: TaskStore): string {
  const rows = listGlobalRoleRows(store);

  if (rows.length === 0) {
    return "No roles configured.\n";
  }

  return `${renderTable(
    "Roles",
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Workspace", minWidth: 9, maxWidth: 54 },
      { header: "Kind", minWidth: 6, maxWidth: 34 }
    ],
    rows.map((row) => [row.name, row.agent, row.workspace, row.kind]),
    defaultTableWidth()
  )}\n`;
}

function showGlobalRoleCommand(args: string[], store: TaskStore): string {
  const [name] = args;
  const roleName = parseGlobalRoleName(name);
  const role = store.getGlobalRole(roleName);

  if (role === null) {
    if (isSystemRoleName(roleName)) {
      return renderMissingSystemRole(roleName);
    }

    throw roleNotFound(roleName);
  }

  return renderGlobalRole(`Role: ${role.name}`, role);
}

function updateGlobalRoleCommand(
  args: string[],
  store: TaskStore,
  options: GlobalRoleCommandOptions = {}
): string {
  const [name, ...rest] = args;
  const roleName = parseGlobalRoleName(name);
  const role = store.getGlobalRole(roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }

  const parsed = parseRoleCommandOptions(rest, GLOBAL_ROLE_UPDATE_OPTIONS, {
    profileInheritableFields: ROLE_PROFILE_INHERITABLE_FIELDS
  });
  assertExpectedRoleRevision(role, parsed.value(ROLE_EXPECT_UPDATED_AT_OPTION));
  assertSystemPromptSelection(parsed);
  const agentId = parsed.value("--agent")?.trim();
  const activeAgentId = parsed.value("--active-agent")?.trim();
  const workspace = parsed.value("--workspace")?.trim();
  const patch: Partial<Pick<GlobalRole, "activeAgentId" | "agentBindings" | "workspace">> = {};
  const profileChanged = parsed.has("--system-prompt") || parsed.inherits("systemPrompt");
  let bindings = role.agentBindings;

  if (agentId !== undefined) {
    if (agentId.length === 0) {
      throw usageError("--agent is required.");
    }

    const agent = resolveAgent(agentId, store.listConfiguredAgents());

    if (agent === null) {
      throwUnsupportedAgent(agentId, store);
    }

    const binding = parsed.createBinding(agent, workspace ?? role.workspace, role.agentBindings[agent.id]);
    bindings = { ...bindings, [agent.id]: binding };
    patch.activeAgentId = agent.id;
    patch.agentBindings = bindings;
  } else if (parsed.hasStructuredChanges) {
    const targetAgentId = activeAgentId ?? role.activeAgentId;
    if (role.agentBindings[targetAgentId] === undefined) {
      throw usageError(`Role agent is not bound: ${targetAgentId}.`);
    }
    const agent = resolveAgent(targetAgentId, store.listConfiguredAgents());
    if (agent === null) throwUnsupportedAgent(targetAgentId, store);
    bindings = {
      ...bindings,
      [agent.id]: parsed.createBinding(agent, workspace ?? role.workspace, role.agentBindings[agent.id])
    };
    patch.agentBindings = bindings;
  }

  if (activeAgentId !== undefined) {
    if (activeAgentId.length === 0) throw usageError("--active-agent is required.");
    if (bindings[activeAgentId] === undefined) {
      throw usageError(`Role agent is not bound: ${activeAgentId}.`);
    }
    patch.activeAgentId = activeAgentId;
  }

  if (workspace !== undefined) {
    if (workspace.length === 0) {
      throw usageError("--workspace is required.");
    }

    patch.workspace = workspace;
  }

  if (Object.keys(patch).length === 0 && !profileChanged) {
    throw usageError("At least one role update option is required.");
  }

  const profiledRole = applySystemPrompt(role, parsed.value("--system-prompt"), parsed.inherits("systemPrompt"));
  const requestedActiveAgentId = patch.activeAgentId;
  let updatedRole = updateGlobalRole(
    profiledRole,
    { ...patch, activeAgentId: role.activeAgentId },
    new Date()
  );
  let switchedSessions: GlobalRoleSessionSet | null = null;
  let expectedSessionSet: GlobalRoleSessionSet | null = null;
  if (requestedActiveAgentId !== undefined && requestedActiveAgentId !== role.activeAgentId) {
    if (options.tmux === undefined) {
      throw usageError("Tmux manager is required to switch a GlobalRole Agent.");
    }
    const nativeProcessRunning = options.tmux.probeRoleStatus("operator", role.name) === "running";
    try {
      expectedSessionSet = store.getGlobalRoleSessionSet(roleName);
      const switched = switchActiveRoleAgent(
        updatedRole,
        expectedSessionSet ?? createRoleSessionSet(
          { scope: "global", roleName },
          role.activeAgentId,
          new Date()
        ),
        requestedActiveAgentId,
        {
          activeRun: store.getActiveAgentRun("operator", role.name) !== null,
          nativeProcessRunning
        },
        new Date()
      );
      updatedRole = switched.role;
      switchedSessions = switched.sessions as GlobalRoleSessionSet;
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
  }
  const storedRole = executeGlobalRoleMutation(
    roleName,
    "update",
    store,
    (transactionStore) => switchedSessions === null
      ? transactionStore.compareAndSwapGlobalRole(role.updatedAt, updatedRole)
      : transactionStore.compareAndSwapGlobalRoleWithSessionSet(
          role.updatedAt,
          expectedSessionSet,
          updatedRole,
          switchedSessions
        )
  );
  if (storedRole === null) throw roleConflict(role.name);

  return renderGlobalRole(`Updated role ${storedRole.name}`, storedRole);
}

function globalRoleSessionCommand(
  args: string[],
  store: TaskStore,
  options: GlobalRoleCommandOptions
): string {
  const [command, name, ...rest] = args;
  const roleName = parseGlobalRoleName(name);
  if (command !== "record" && command !== "replace") {
    throw usageError("Role session usage: taskmux role session record|replace <role> --native-id <id> [--reason <reason>].");
  }
  const role = store.getGlobalRole(roleName);
  if (role === null) throw roleNotFound(roleName);
  const nativeSessionId = readOption(rest, "--native-id");
  if (!isCanonicalNativeSessionId(nativeSessionId)) {
    throw usageError("Native session id must not contain surrounding whitespace.");
  }
  const environment = options.env ?? process.env;
  assertGlobalSessionRegistrationProvenance(command, role, nativeSessionId, environment);
  const binding = activeRoleAgentBinding(role);
  const agent = resolveAgent(binding.agentId, store.listConfiguredAgents());
  if (agent === null) throwUnsupportedAgent(binding.agentId, store);
  const adapter = resolveAgentAdapter(binding.adapterId);
  const canonicalConfig = adapter.canonicalizeConfig(binding.config);
  const existingSet = store.getGlobalRoleSessionSet(roleName) ?? createRoleSessionSet(
    { scope: "global", roleName },
    role.activeAgentId,
    new Date()
  );
  const existing = existingSet.sessions[role.activeAgentId] ?? null;
  if (options.requireManualSessionRegistration === true && options.sessionRegistration === undefined) {
    throw usageError("Controller session registration provenance is required.");
  }
  if (options.sessionRegistration !== undefined && (
    options.sessionRegistration.scope !== "global" ||
    options.sessionRegistration.roleName !== roleName ||
    options.sessionRegistration.agentId !== binding.agentId ||
    options.sessionRegistration.adapterId !== binding.adapterId ||
    options.sessionRegistration.agentDefinitionUpdatedAt !== agent.updatedAt
  )) {
    throw usageError("Controller session registration provenance does not match the active GlobalRole binding.");
  }
  const sessionRoot = options.sessionRegistration === undefined
    ? resolveAgentSessionRoot(binding.adapterId, {
        ...environment,
        ...resolveAgentLaunchEnvironment(agent, environment)
      })
    : options.sessionRegistration.sessionRoot;
  const provenanceSessionRoot = environment.TASKMUX_NATIVE_SESSION_ROOT?.trim();
  if (provenanceSessionRoot !== undefined && provenanceSessionRoot !== sessionRoot) {
    throw usageError("Native session registration root does not match the Agent environment.");
  }
  if (!isCanonicalNativeSessionRoot(sessionRoot)) {
    throw usageError("Native session registration root is invalid.");
  }
  const fingerprint = adapter.fingerprint(canonicalConfig, {
    workspace: role.workspace,
    systemPrompt: role.systemPrompt,
    agent
  });
  const sessionInput = (replacementReason?: string) => ({
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    nativeSessionId,
    policy: "fixed" as const,
    status: environment.TASKMUX_ROLE === roleName ? "running" as const : "ready" as const,
    sessionRoot,
    configFingerprint: fingerprint,
    permissionEnvelope: adapter.permissionEnvelope(canonicalConfig),
    ...(replacementReason === undefined ? {} : { replacementReason })
  });

  if (command === "record") {
    const candidateIdentity = { adapterId: binding.adapterId, sessionRoot, nativeSessionId };
    if (existing !== null && !sameNativeSessionIdentity(existing, candidateIdentity)) {
      throw usageError("GlobalRole session replacement must be explicit.");
    }
    const next = recordRoleAgentSession(existingSet, sessionInput(), new Date());
    if (roleName === SYSTEM_OPERATOR_ROLE && environment.TASKMUX_ROLE === roleName) {
      const launchToken = environment.TASKMUX_OPERATOR_LAUNCH_TOKEN?.trim();
      if (launchToken === undefined || launchToken.length === 0 || options.tmux === undefined) {
        throw usageError("Running Operator native session registration requires its fenced launch token.");
      }
      confirmOperatorNativeSessionRegistration(store, role, next, launchToken, options.tmux);
    } else {
      store.saveGlobalRoleSessionSet(next);
    }
    return `Recorded native session for role ${roleName}\n`;
  }

  if (existing === null) throw usageError("Native session replacement requires an existing native session.");
  const candidateIdentity = { adapterId: binding.adapterId, sessionRoot, nativeSessionId };
  if (sameNativeSessionIdentity(existing, candidateIdentity)) {
    throw usageError("Native session replacement requires a different native session identity.");
  }
  if (existing.previousIdentities.some((identity) => sameNativeSessionIdentity(identity, candidateIdentity))) {
    throw usageError("A historical native session identity cannot be reused.");
  }
  if (options.tmux === undefined) {
    throw usageError("Tmux manager is required to replace a GlobalRole session.");
  }
  if (options.tmux.probeRoleStatus("operator", roleName) === "running") {
    throw usageError("Native session replacement is blocked while the native Agent process is running.");
  }
  const reason = readOption(rest, "--reason").trim();
  if (reason.length === 0) throw usageError("Session replacement reason is required.");
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(existingSet, sessionInput(reason), new Date()));
  return `Replaced native session for role ${roleName}\n`;
}

function assertGlobalSessionRegistrationProvenance(
  command: string,
  role: GlobalRole,
  nativeSessionId: string,
  environment: NodeJS.ProcessEnv
): void {
  const values = [
    environment.TASKMUX_ROLE,
    environment.TASKMUX_AGENT_ID,
    environment.TASKMUX_ADAPTER_ID,
    environment.TASKMUX_NATIVE_SESSION_ROOT
  ];
  if (values.every((value) => value === undefined)) return;
  if (values.some((value) => value === undefined || value.trim().length === 0)) {
    throw usageError("Native session registration provenance is incomplete.");
  }
  if (command !== "record") throw usageError("A running Agent may record only its current native session.");
  const binding = activeRoleAgentBinding(role);
  if (
    environment.TASKMUX_ROLE !== role.name ||
    environment.TASKMUX_AGENT_ID !== binding.agentId ||
    environment.TASKMUX_ADAPTER_ID !== binding.adapterId
  ) {
    throw usageError("Native session registration does not match the active GlobalRole binding.");
  }
  if (binding.adapterId === "codex" && environment.CODEX_THREAD_ID?.trim() !== nativeSessionId) {
    throw usageError("Native session id does not match CODEX_THREAD_ID.");
  }
  if (
    role.name === SYSTEM_OPERATOR_ROLE &&
    environment.TASKMUX_NATIVE_SESSION_ID !== undefined &&
    environment.TASKMUX_NATIVE_SESSION_ID.trim() !== nativeSessionId
  ) {
    throw usageError("Native session id does not match the fenced Operator launch identity.");
  }
  if (role.name === SYSTEM_OPERATOR_ROLE &&
      (environment.TASKMUX_OPERATOR_LAUNCH_TOKEN?.trim().length ?? 0) === 0) {
    throw usageError("Running Operator native session registration requires its fenced launch token.");
  }
}

function assertExpectedRoleRevision(role: GlobalRole, expected: string | undefined): void {
  if (expected !== undefined && role.updatedAt !== expected) {
    throw roleConflict(role.name);
  }
}

function removeGlobalRoleCommand(
  args: string[],
  store: TaskStore,
  options: GlobalRoleCommandOptions
): string {
  const [name] = args;
  const roleName = parseGlobalRoleName(name);

  if (isSystemRoleName(roleName)) {
    throw usageError(`System role cannot be removed: ${roleName}`);
  }

  const role = store.getGlobalRole(roleName);
  if (role === null) throw roleNotFound(roleName);
  const activeRun = store.getActiveAgentRun("operator", roleName);
  const session = store.getGlobalRoleSessionSet(roleName)?.sessions[role.activeAgentId];
  if (activeRun !== null || session?.status === "running") {
    throw usageError(`GlobalRole is active and cannot be removed: ${roleName}.`);
  }
  if (options.tmux === undefined) {
    throw usageError("Tmux manager is required to verify GlobalRole removal.");
  }
  if (options.tmux.probeRoleStatus("operator", roleName) === "running") {
    throw usageError(`GlobalRole native process is running: ${roleName}.`);
  }

  if (!executeGlobalRoleMutation(
    roleName,
    "remove",
    store,
    (transactionStore) => transactionStore.removeGlobalRole(roleName)
  )) {
    throw roleNotFound(roleName);
  }

  return `Removed role ${roleName}\n`;
}

function readGlobalRoleRuntimeState(store: TaskStore, roleName: string): {
  role: GlobalRole;
  sessionSet: GlobalRoleSessionSet | null;
  activeRun: ReturnType<TaskStore["getActiveAgentRun"]>;
} {
  const role = store.getGlobalRole(roleName);
  if (role === null) throw roleNotFound(roleName);
  return {
    role,
    sessionSet: store.getGlobalRoleSessionSet(roleName),
    activeRun: store.getActiveAgentRun("operator", roleName)
  };
}

export function isExactPreparedGlobalRoleMutationClaim(
  expected: GlobalRoleMutationRuntimeOperationClaim,
  current: GlobalRoleRuntimeOperationClaim | null
): boolean {
  return current !== null &&
    current.kind === "global-role-mutation" &&
    current.phase === "prepared" &&
    current.recoveryToken === null &&
    roleRuntimeStateDigest(current) === roleRuntimeStateDigest(expected);
}

function releasePreparedGlobalRoleMutationClaim(
  rootDir: string,
  expected: GlobalRoleMutationRuntimeOperationClaim
): void {
  executeDomainTransaction(
    rootDir,
    `global-role-${expected.operation}-release-${randomUUID()}`,
    (workingRoot) => {
      const current = readGlobalRoleRuntimeOperationClaim(workingRoot, expected.roleName);
      if (!isExactPreparedGlobalRoleMutationClaim(expected, current)) {
        throw usageError(`GlobalRole prepared operation ownership changed: ${expected.roleName}.`);
      }
      clearRuntimeOperationClaim(
        workingRoot,
        { scope: "global-role", roleName: expected.roleName },
        expected.token
      );
    }
  );
}

function executeGlobalRoleMutation<T>(
  roleName: string,
  operation: "update" | "remove",
  store: TaskStore,
  finalize: (transactionStore: TaskStore) => T,
  now = new Date()
): T {
  if (
    !(store instanceof FileTaskStore) ||
    hasActiveDomainTransactionAuthority(store.rootDirectory())
  ) {
    throw usageError("GlobalRole mutations require the canonical post-commit coordinator.");
  }
  const rootDir = store.rootDirectory();
  recoverGlobalRoleRuntimeOperations(rootDir, now);
  const preparedState = readGlobalRoleRuntimeState(store, roleName);
  const claim: GlobalRoleMutationRuntimeOperationClaim = {
    schemaVersion: 1,
    scope: "global-role",
    kind: "global-role-mutation",
    token: randomUUID(),
    taskId: null,
    roleName,
    operation,
    ownerPid: process.pid,
    preparedSession: null,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(preparedState),
    recoveryToken: null,
    ...createRoleRuntimeOperationLease(now),
    phase: "prepared",
    preparedState
  };
  claimRoleRuntimeOperation(
    rootDir,
    `global-role-${operation}-claim-${randomUUID()}`,
    claim,
    (workingRoot) => roleRuntimeStateDigest(readGlobalRoleRuntimeState(
      FileTaskStore.forDomainTransactionWorkspace(workingRoot),
      roleName
    ))
  );
  try {
    return store.runDomainTransaction(`global-role-${operation}-finalize-${randomUUID()}`, (workingRoot) => {
      const current = readGlobalRoleRuntimeOperationClaim(workingRoot, roleName);
      if (
        current === null || current.token !== claim.token || current.recoveryToken !== null ||
        roleRuntimeStateDigest(readGlobalRoleRuntimeState(
          FileTaskStore.forDomainTransactionWorkspace(workingRoot),
          roleName
        )) !== current.expectedStateDigest
      ) {
        throw usageError(`GlobalRole state changed before ${operation}: ${roleName}.`);
      }
      const result = finalize(FileTaskStore.forDomainTransactionWorkspace(workingRoot, current.token));
      clearRuntimeOperationClaim(
        workingRoot,
        { scope: "global-role", roleName },
        current.token
      );
      return result;
    });
  } catch (error) {
    releasePreparedGlobalRoleMutationClaim(rootDir, claim);
    throw error;
  }
}

export function recoverGlobalRoleRuntimeOperations(rootDir: string, now = new Date()): string[] {
  const recovered: string[] = [];
  for (const observed of listRuntimeOperationClaims(rootDir)) {
    if (
      observed.scope !== "global-role" ||
      observed.kind !== "global-role-mutation" ||
      !isRuntimeOperationRecoverable(observed, now)
    ) continue;
    const recoveryToken = randomUUID();
    const claimed = claimRuntimeOperationRecovery(
      rootDir,
      `global-role-recover-${randomUUID()}`,
      observed,
      recoveryToken,
      now
    );
    if (claimed === null || claimed.scope !== "global-role") continue;
    releaseRuntimeOperationClaim(
      rootDir,
      `global-role-release-${randomUUID()}`,
      claimed,
      recoveryToken
    );
    recovered.push(claimed.token);
  }
  return recovered;
}

function enterGlobalRoleCommand(
  args: string[],
  store: TaskStore,
  options: GlobalRoleCommandOptions
): string {
  const [name] = args;
  const roleName = parseGlobalRoleName(name);
  const role = store.getGlobalRole(roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }

  const agent = resolveAgent(role.activeAgentId, store.listConfiguredAgents());
  if (agent === null) throwUnsupportedAgent(role.activeAgentId, store);
  const sessionSet = store.getGlobalRoleSessionSet(role.name);
  const launch = prepareGlobalRoleLaunch(role, agent, {
    taskmuxHome: options.taskmuxHome,
    baseEnv: options.env,
    session: sessionSet?.sessions[role.activeAgentId] ?? null
  });
  const runClaim = claimGlobalRoleRun(store, role, launch.mode);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(launch.command, launch.args, {
      cwd: role.workspace,
      env: launch.env,
      stdio: "inherit"
    });
  } finally {
    finalizeGlobalRoleRun(store, role, launch.session, runClaim);
  }

  if (result.error !== undefined) {
    throw usageError(`Failed to enter role ${roleName}: ${result.error.message}`);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw usageError(`Role ${roleName} exited with status ${result.status}`);
  }

  return `Exited role ${roleName}\n`;
}

function claimGlobalRoleRun(
  store: TaskStore,
  role: GlobalRole,
  mode: "new" | "resume"
): AgentRun {
  const now = new Date();
  const claim = createAgentRun(
    `global-role-enter-${randomUUID()}`,
    "operator",
    role.name,
    mode,
    `Interactive GlobalRole entry: ${role.name}`,
    now
  );
  executeDomainTransaction(
    store.rootDirectory(),
    `global-role-enter-claim-${randomUUID()}`,
    (workingRoot) => {
      const transactionStore = new FileTaskStore(workingRoot);
      const currentRole = transactionStore.getGlobalRole(role.name);
      if (
        currentRole === null ||
        currentRole.updatedAt !== role.updatedAt ||
        currentRole.activeAgentId !== role.activeAgentId
      ) {
        throw roleConflict(role.name);
      }
      if (transactionStore.getActiveAgentRun("operator", role.name) !== null) {
        throw usageError(`${role.name} already has an active AgentRun.`);
      }
      transactionStore.saveActiveAgentRun(claim);
    }
  );
  return claim;
}

function finalizeGlobalRoleRun(
  store: TaskStore,
  role: GlobalRole,
  session: GlobalRoleSessionSet["sessions"][string] | null,
  claim: AgentRun
): void {
  executeDomainTransaction(
    store.rootDirectory(),
    `global-role-enter-release-${randomUUID()}`,
    (workingRoot) => {
      const transactionStore = new FileTaskStore(workingRoot);
      const activeRun = transactionStore.getActiveAgentRun("operator", role.name);
      if (activeRun === null) return;
      if (activeRun.id !== claim.id) {
        throw usageError(`GlobalRole active-run ownership changed: ${role.name}.`);
      }
      if (session !== null) {
        const currentRole = transactionStore.getGlobalRole(role.name);
        if (currentRole !== null && currentRole.activeAgentId === role.activeAgentId) {
          const now = new Date();
          const baseSet = transactionStore.getGlobalRoleSessionSet(role.name) ?? createRoleSessionSet(
            { scope: "global", roleName: role.name },
            role.activeAgentId,
            now
          );
          transactionStore.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus({
            ...baseSet,
            activeAgentId: role.activeAgentId,
            sessions: { ...baseSet.sessions, [role.activeAgentId]: session },
            updatedAt: now.toISOString()
          }, role.activeAgentId, "stopped", now));
        }
      }
      transactionStore.clearActiveAgentRun("operator", role.name);
    }
  );
}

type GlobalRoleRow = {
  name: string;
  agent: string;
  workspace: string;
  kind: string;
};

function listGlobalRoleRows(store: TaskStore): GlobalRoleRow[] {
  const configured = store.listGlobalRoles();
  const rows = new Map<string, GlobalRoleRow>();

  for (const name of SYSTEM_ROLE_NAMES) {
    const role = store.getGlobalRole(name);

    rows.set(name, role === null
      ? { name, agent: "?", workspace: "?", kind: `system:${systemRoleDescription(name)}` }
      : { name: role.name, agent: role.activeAgentId, workspace: role.workspace, kind: `system:${systemRoleDescription(name)}` });
  }

  for (const role of configured) {
    if (!rows.has(role.name)) {
      rows.set(role.name, {
        name: role.name,
        agent: role.activeAgentId,
        workspace: role.workspace,
        kind: "custom"
      });
    }
  }

  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function renderGlobalRole(title: string, role: GlobalRole): string {
  const presented = presentRole(role);
  const rows = presented.bindings.map((binding) => [
    binding.agentId,
    binding.active ? "yes" : "no",
    binding.adapterId,
    binding.configuration,
    binding.arguments
  ]);
  return [
    title,
    `Active agent: ${presented.activeAgentId}`,
    `Bound agents: ${presented.boundAgentCount}`,
    `Workspace: ${presented.workspace}`,
    `Description: ${presented.profile.description}`,
    `Responsibilities: ${presented.profile.responsibilities}`,
    `Constraints: ${presented.profile.constraints}`,
    `Expected output: ${presented.profile.expectedOutput}`,
    `Prompt: ${presented.profile.systemPrompt}`,
    `Skills: ${presented.profile.skills}`,
    "",
    renderTable(
      "Agent bindings",
      [
        { header: "Agent", minWidth: 5, maxWidth: 20 },
        { header: "Active", minWidth: 6, maxWidth: 6 },
        { header: "Adapter", minWidth: 7, maxWidth: 12 },
        { header: "Configuration", minWidth: 13, maxWidth: 24 },
        { header: "Arguments", minWidth: 9, maxWidth: 18 }
      ],
      rows,
      defaultTableWidth()
    )
  ].join("\n").concat("\n");
}

function renderMissingSystemRole(name: string): string {
  return [
    `Role: ${name}`,
    `System: ${systemRoleDescription(name)}`,
    "Agent: ?",
    "Configuration: unavailable",
    "Workspace: ?"
  ].join("\n").concat("\n");
}

function parseGlobalRoleName(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw usageError("Role name is required.");
  }

  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw usageError("Role name may only contain letters, numbers, hyphens, and underscores.");
  }

  return value.trim();
}

function readOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index === -1 || args[index + 1] === undefined || args[index + 1].startsWith("--")) {
    throw usageError(`${name} is required.`);
  }
  return args[index + 1];
}

function requiredOption(value: string | undefined, option: string): string {
  if (value === undefined || value.trim().length === 0) throw usageError(`${option} is required.`);
  return value.trim();
}

function assertSystemPromptSelection(parsed: ReturnType<typeof parseRoleCommandOptions>): void {
  if (parsed.has("--system-prompt") && parsed.inherits("systemPrompt")) {
    throw usageError("Role field cannot be set and inherited together: systemPrompt.");
  }
}

function applySystemPrompt<T extends GlobalRole>(role: T, value: string | undefined, inherit: boolean): T {
  if (inherit) {
    const { systemPrompt: _removed, ...remaining } = role;
    return remaining as T;
  }
  return value === undefined ? role : { ...role, systemPrompt: value.trim() };
}

function throwUnsupportedAgent(agent: string, store: TaskStore): never {
  const supportedAgents = supportedAgentIds(store.listConfiguredAgents());
  const supportedText = supportedAgents.length === 0
    ? "none configured. Run taskmux agent add <agent-id> --adapter <adapter-id> --command <command>."
    : supportedAgents.join(", ");

  throw usageError(`Unsupported agent: ${agent}\nSupported agents: ${supportedText}`);
}
