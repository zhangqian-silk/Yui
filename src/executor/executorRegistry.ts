import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveAgentEnvironment, type AgentDefinition } from "../agent/agent.js";
import { activeRoleAgentBinding, type Role, type RoleAgentBinding, type RoleStatus } from "../role/role.js";
import type { AgentRun } from "../run/agentRun.js";
import {
  createRoleAgentSession,
  createRoleSessionSet,
  classifyRoleAgentSessionResume,
  recordRoleAgentSession,
  type AgentSessionStatus,
  type ExecutorCapabilities,
  type PermissionEnvelope,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "./agentExecutor.js";
import { resolveAgentAdapter } from "./agentAdapter.js";
export { resolveAgentAdapter } from "./agentAdapter.js";
import { withTaskmuxRunEnvironment, type AgentLaunchPlan, type DispatchMode } from "./launchPlan.js";
import { canonicalizeNativeSessionRoot } from "./nativeSessionIdentity.js";
export {
  claimRoleRuntimeOperation,
  claimRuntimeOperationRecovery,
  clearRoleRuntimeOperationClaim,
  clearRuntimeOperationClaim,
  createRoleRuntimeOperationLease,
  isRuntimeOperationRecoverable,
  isRoleRuntimeOperationRecoverable,
  listRoleRuntimeOperationClaims,
  listRuntimeOperationClaims,
  markGlobalRoleLaunchEffectStarted,
  markTaskLifecycleOperationEffectStarted,
  markRoleRuntimeOperationEffectStarted,
  readRoleRuntimeOperationClaim,
  readGlobalRoleRuntimeOperationClaim,
  readRuntimeOperationClaim,
  readTaskRuntimeOperationClaim,
  readRoleRuntimeStateSnapshot,
  recoverAbandonedRoleRuntimeOperations,
  releaseRoleRuntimeOperationClaim,
  releaseRuntimeOperationClaim,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim,
  writeTaskLifecycleEffectPlan
} from "./roleRuntimeOperationClaim.js";
export type {
  GlobalRoleRuntimeOperationClaim,
  GlobalRoleLaunchRuntimeOperationClaim,
  GlobalRoleMutationRuntimeOperationClaim,
  RoleLaunchRuntimeOperationClaim,
  RoleRuntimeOperationClaim,
  RoleRuntimeStateSnapshot,
  RoleStopRuntimeOperationClaim,
  RuntimeOperationClaim,
  RuntimeOperationOwner,
  TaskLifecycleEffectPlan,
  TaskLifecyclePreparedState,
  TaskLifecycleRuntimeOperationClaim
} from "./roleRuntimeOperationClaim.js";

export type ExactRoleInputDeliveryOutcome = "applied" | "receipt-present" | "fenced";

export type AgentRuntime = {
  dispatchRole(
    taskId: string,
    role: Role,
    launch: AgentLaunchPlan,
    input: string,
    options: { replaceExisting?: boolean; launchToken: string }
  ): boolean;
  sendRoleInput(taskId: string, roleName: string, input: string): void;
  sendExactRoleInputOnce(
    expected: ExactRoleInputTarget,
    deliveryId: string,
    input: string
  ): ExactRoleInputDeliveryOutcome;
  stopRole(taskId: string, roleName: string): void;
  killRole(taskId: string, roleName: string): void;
  detectRoleStatus(taskId: string, roleName: string, fallback: RoleStatus): RoleStatus;
};

export type PostCommitRoleDispatchRuntime = Pick<AgentRuntime, "dispatchRole"> & {
  killRoleLaunchAndConfirmStopped(taskId: string, roleName: string, launchToken: string): boolean;
};

export type PostCommitRoleDispatch = {
  taskId: string;
  role: Role;
  launch: AgentLaunchPlan;
  input: string;
  replaceExisting: boolean;
  launchToken: string;
};

export function executePostCommitRoleDispatch<T>(
  runtime: PostCommitRoleDispatchRuntime,
  dispatch: PostCommitRoleDispatch,
  persist: () => T,
  intent: { claim?: () => void; release?: () => void } = {}
): T {
  intent.claim?.();
  let created = false;
  try {
    created = runtime.dispatchRole(
      dispatch.taskId,
      dispatch.role,
      dispatch.launch,
      dispatch.input,
      { replaceExisting: dispatch.replaceExisting, launchToken: dispatch.launchToken }
    );
  } catch (error) {
    try {
      intent.release?.();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Role launch failed and its dispatch intent could not be released: ${dispatch.role.name}.`
      );
    }
    throw error;
  }
  try {
    if (
      process.env.NODE_ENV === "test" &&
      process.env.TASKMUX_TEST_ONLY_ROLE_LAUNCH_FAILPOINT === "after-launch"
    ) {
      throw new Error("Role launch stopped after the native window was created.");
    }
    return persist();
  } catch (error) {
    let cleanupError: unknown;
    if (created) {
      try {
        runtime.killRoleLaunchAndConfirmStopped(
          dispatch.taskId,
          dispatch.role.name,
          dispatch.launchToken
        );
      } catch (caught) {
        cleanupError = caught;
      }
    }
    if (cleanupError === undefined) {
      try {
        intent.release?.();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Role launch persistence failed and its dispatch intent could not be released: ${dispatch.role.name}.`
        );
      }
      throw error;
    }
    throw new AggregateError(
      [error, cleanupError],
      `Role launch persistence failed and the native window could not be confirmed stopped: ${dispatch.role.name}.`
    );
  }
}

export type PostCommitRoleControl = {
  action: "stop" | "kill";
  taskId: string;
  roleName: string;
  token: string;
};

export type PostCommitRoleControlRuntime = {
  stopRoleWithOperationToken(taskId: string, roleName: string, token: string): void;
  killRoleWithOperationToken(taskId: string, roleName: string, token: string): void;
};

export function executeReplayableRoleRuntimeOperation<T>(
  effect: () => void,
  persist: () => T,
  operation: { claim: () => void; beginEffect: () => void }
): T {
  operation.claim();
  operation.beginEffect();
  effect();
  if (
    process.env.NODE_ENV === "test" &&
    process.env.TASKMUX_TEST_ONLY_ROLE_CONTROL_FAILPOINT === "after-effect"
  ) {
    throw new Error("Role control stopped after its external effect.");
  }
  return persist();
}

export function executePostCommitRoleControl<T>(
  runtime: PostCommitRoleControlRuntime,
  control: PostCommitRoleControl,
  persist: () => T,
  operation: { claim: () => void; beginEffect: () => void }
): T {
  return executeReplayableRoleRuntimeOperation(() => {
    if (control.action === "stop") {
      runtime.stopRoleWithOperationToken(control.taskId, control.roleName, control.token);
    } else {
      runtime.killRoleWithOperationToken(control.taskId, control.roleName, control.token);
    }
  }, persist, operation);
}

export type PrepareExecutionInput = {
  taskId: string;
  role: Role;
  agent: AgentDefinition;
  mode: DispatchMode;
  session: RoleAgentSession | null;
  now: Date;
  processEnv?: NodeJS.ProcessEnv;
  permissionBroadeningConfirmed?: boolean;
  worktreeRoot?: string;
};

export type PreparedExecution = { launch: AgentLaunchPlan; session: RoleAgentSession | null };

export type ExecutorDispatchInput = {
  runtime: AgentRuntime;
  taskmuxHome: string;
  taskId: string;
  role: Role;
  agent: AgentDefinition;
  run: AgentRun;
  session: RoleAgentSession | null;
  input: string;
  now: Date;
  processEnv?: NodeJS.ProcessEnv;
  permissionBroadeningConfirmed?: boolean;
  worktreeRoot?: string;
};

export type ExecutorDispatchPlanInput = Omit<ExecutorDispatchInput, "runtime">;

export type ExecutorControlInput = { runtime: AgentRuntime; taskId: string; role: Role };
export type ExecutorSendInput = {
  runtime: Pick<AgentRuntime, "sendRoleInput">;
  taskId: string;
  role: Role;
  input: string;
};

/**
 * A user-visible delivery must name the immutable native session tuple it was
 * prepared for. The runtime transport owns the final pane-level comparison,
 * so a same-name replacement pane is not a valid fallback.
 */
export type ExactRoleInputTarget = {
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  sessionRoot: string;
  nativeSessionId: string;
  agentRunId: string;
};

export type ExecutorExactSendInput = {
  runtime: Pick<AgentRuntime, "sendExactRoleInputOnce">;
  target: ExactRoleInputTarget;
  role: Role;
  deliveryId: string;
  input: string;
};

export interface AgentExecutor {
  readonly id: string;
  readonly capabilities: ExecutorCapabilities;
  prepare(input: PrepareExecutionInput): PreparedExecution;
  plan(input: ExecutorDispatchPlanInput): PreparedExecution;
  start(input: ExecutorDispatchInput): PreparedExecution;
  recover(input: ExecutorDispatchInput): PreparedExecution;
  send(input: ExecutorSendInput): void;
  sendExact(input: ExecutorExactSendInput): ExactRoleInputDeliveryOutcome;
  interrupt(input: ExecutorControlInput): void;
  stop(input: ExecutorControlInput): void;
  status(input: ExecutorControlInput): AgentSessionStatus;
  discoverNativeSessionId(session: RoleAgentSession | null, env: NodeJS.ProcessEnv): string | null;
}

class AdapterBackedExecutor implements AgentExecutor {
  readonly capabilities: ExecutorCapabilities;

  constructor(readonly id: string) {
    const adapter = resolveAgentAdapter(id);
    this.capabilities = {
      recover: adapter.capabilities.recover,
      interrupt: adapter.capabilities.interrupt,
      nativeSessionDiscovery: adapter.capabilities.nativeSessionDiscovery === "runtime"
    };
  }

  prepare(input: PrepareExecutionInput): PreparedExecution {
    assertTaskRoleOwnership(input.taskId, input.role);
    const binding = activeRoleAgentBinding(input.role);
    if (binding.adapterId !== this.id || input.agent.adapterId !== this.id || binding.agentId !== input.agent.id) {
      throw new Error(`Execution adapter ${this.id} cannot launch Role binding ${binding.agentId}.`);
    }
    const adapter = resolveAgentAdapter(this.id);
    const canonicalConfig = adapter.canonicalizeConfig(binding.config);
    const installation = adapter.probeInstallation(input.agent, input.now);
    if (installation.status !== "installed" &&
      installation.status !== "probe-failed" &&
      installation.status !== "unavailable") {
      throw new Error(installation.reason ?? `Agent installation is unavailable: ${input.agent.id}.`);
    }
    const snapshot = installation.status === "installed" && installation.version !== undefined
      ? adapter.discoverCapabilities({ agent: input.agent, version: installation.version, now: input.now })
      : {
          ...adapter.unavailableCapabilities(
            { agent: input.agent, version: adapter.supportedVersion, now: input.now },
            installation.reason ?? "Agent installation probe failed."
          ),
          installation
        };
    const compiled = input.mode === "resume"
        ? adapter.compileResume({
          agent: input.agent,
          config: canonicalConfig,
          workspace: input.role.workspace,
          systemPrompt: input.role.systemPrompt,
          snapshot,
          validationMode: "replay",
          nativeSessionId: requireSession(input.role, input.session).nativeSessionId
        })
        : adapter.compileNew({
          agent: input.agent,
          config: canonicalConfig,
          workspace: input.role.workspace,
          systemPrompt: input.role.systemPrompt,
          snapshot,
          validationMode: "replay"
        });
    const processEnvironment = input.processEnv ?? process.env;
    const environment = resolveAgentLaunchEnvironment(input.agent, processEnvironment);
    const effectiveEnvironment = { ...processEnvironment, ...environment };
    let session = input.session;
    let argv = compiled.argv;
    if (input.mode === "new" && adapter.capabilities.nativeSessionDiscovery === "preallocated") {
      const nativeSessionId = session?.status === "reserved" ? session.nativeSessionId : randomUUID();
      session = createRoleAgentSession({
        agentId: binding.agentId,
        adapterId: binding.adapterId,
        nativeSessionId,
        policy: input.role.name === "leader" ? "fixed" : "leader-controlled",
        status: "ready",
        sessionRoot: resolveAgentSessionRoot(this.id, effectiveEnvironment),
        ...(input.session?.worktreeRoot === undefined
          ? input.worktreeRoot === undefined ? {} : { worktreeRoot: resolve(input.worktreeRoot) }
          : { worktreeRoot: input.session.worktreeRoot }),
        configFingerprint: compiled.fingerprint,
        permissionEnvelope: adapter.permissionEnvelope(canonicalConfig),
        ...(input.session === null || input.session.nativeSessionId === nativeSessionId
          ? {}
          : { replacementReason: "A new native session was explicitly selected." })
      }, input.now, input.session);
      argv = [...argv, "--session-id", nativeSessionId];
    }
    if (input.mode === "resume") {
      const existing = requireSession(input.role, session);
      assertResumeRoots(
        existing,
        this.id,
        input.role.workspace,
        effectiveEnvironment,
        input.worktreeRoot
      );
      const permissionEnvelope = adapter.permissionEnvelope(canonicalConfig);
      const assessment = classifyRoleAgentSessionResume(existing, compiled.fingerprint, permissionEnvelope);
      if (assessment.decision === "requires-replacement") {
        throw new Error(`Role Agent session configuration changed at a session-bound boundary: ${existing.agentId}.`);
      }
      if (assessment.decision === "requires-confirmation" && input.permissionBroadeningConfirmed !== true) {
        throw new Error(`Role Agent permission change requires explicit confirmation: ${existing.agentId}.`);
      }
      session = {
        ...existing,
        lastLaunchConfigHash: { ...compiled.fingerprint },
        permissionEnvelope,
        updatedAt: input.now.toISOString()
      };
    }
    return { launch: { command: input.agent.command, args: argv, env: environment }, session };
  }

  plan(input: ExecutorDispatchPlanInput): PreparedExecution {
    return this.prepareDispatch(input, input.run.mode);
  }
  start(input: ExecutorDispatchInput): PreparedExecution { return this.dispatch(input, "new", true); }
  recover(input: ExecutorDispatchInput): PreparedExecution { return this.dispatch(input, "resume", false); }
  send({ runtime, taskId, role, input }: ExecutorSendInput): void {
    assertTaskRoleOwnership(taskId, role);
    runtime.sendRoleInput(taskId, role.name, input);
  }
  sendExact({ runtime, target, role, deliveryId, input }: ExecutorExactSendInput): ExactRoleInputDeliveryOutcome {
    assertTaskRoleOwnership(target.taskId, role);
    const binding = activeRoleAgentBinding(role);
    if (
      target.roleName !== role.name ||
      target.agentId !== binding.agentId ||
      target.adapterId !== binding.adapterId ||
      !hasNonEmptyText(target.sessionRoot) ||
      !hasNonEmptyText(target.nativeSessionId) ||
      !hasNonEmptyText(target.agentRunId) ||
      !hasNonEmptyText(deliveryId)
    ) {
      throw new Error(`Exact input target does not match Role binding: ${role.name}.`);
    }
    return runtime.sendExactRoleInputOnce(target, deliveryId, input);
  }
  interrupt({ runtime, taskId, role }: ExecutorControlInput): void {
    assertTaskRoleOwnership(taskId, role);
    runtime.stopRole(taskId, role.name);
  }
  stop({ runtime, taskId, role }: ExecutorControlInput): void {
    assertTaskRoleOwnership(taskId, role);
    runtime.killRole(taskId, role.name);
  }
  status({ runtime, taskId, role }: ExecutorControlInput): AgentSessionStatus {
    assertTaskRoleOwnership(taskId, role);
    const status = runtime.detectRoleStatus(taskId, role.name, role.status);
    return status === "running" ? "running" : status === "exited" ? "stopped" : status === "failed" ? "broken" : "ready";
  }
  discoverNativeSessionId(session: RoleAgentSession | null, env: NodeJS.ProcessEnv): string | null {
    return session?.nativeSessionId ?? (this.id === "codex" ? env.CODEX_THREAD_ID?.trim() ?? null : null);
  }

  private dispatch(input: ExecutorDispatchInput, mode: DispatchMode, replaceExisting: boolean): PreparedExecution {
    const prepared = this.prepareDispatch(input, mode);
    input.runtime.dispatchRole(input.taskId, input.role, prepared.launch, input.input, {
      replaceExisting,
      launchToken: randomUUID()
    });
    return prepared;
  }

  private prepareDispatch(input: ExecutorDispatchPlanInput, mode: DispatchMode): PreparedExecution {
    assertTaskRoleOwnership(input.taskId, input.role);
    if (input.run.taskId !== input.taskId || input.run.roleName !== input.role.name) {
      throw new Error(`AgentRun ownership does not match TaskRole: ${input.role.name}.`);
    }
    const prepared = this.prepare({ ...input, mode });
    const effectiveEnvironment = { ...(input.processEnv ?? process.env), ...prepared.launch.env };
    const launch = withTaskmuxRunEnvironment(
      prepared.launch,
      input.taskmuxHome,
      input.role,
      input.run,
      prepared.session?.nativeSessionId,
      resolveAgentSessionRoot(this.id, effectiveEnvironment)
    );
    return { ...prepared, launch };
  }
}

const executors = new Map<string, AgentExecutor>([
  ["codex", new AdapterBackedExecutor("codex")],
  ["claude", new AdapterBackedExecutor("claude")]
]);

export function resolveAgentExecutor(adapterId: string): AgentExecutor {
  const executor = executors.get(adapterId);
  if (executor === undefined) throw new Error(`Agent does not define an execution adapter: ${adapterId}.`);
  return executor;
}

function hasNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function reserveInitialAgentSession(
  taskId: string,
  role: Role,
  agent: AgentDefinition,
  now: Date,
  worktreeRoot?: string,
  processEnvironment: NodeJS.ProcessEnv = process.env
): TaskRoleSessionSet | null {
  assertTaskRoleOwnership(taskId, role);
  const binding = activeRoleAgentBinding(role);
  const adapter = resolveAgentAdapter(binding.adapterId);
  if (adapter.capabilities.nativeSessionDiscovery !== "preallocated") return null;
  const canonicalConfig = adapter.canonicalizeConfig(binding.config);
  const launchEnvironment = {
    ...processEnvironment,
    ...resolveAgentLaunchEnvironment(agent, processEnvironment)
  };
  const fingerprint = adapter.fingerprint(canonicalConfig, {
    workspace: role.workspace,
    systemPrompt: role.systemPrompt,
    agent
  });
  let set = createRoleSessionSet({ scope: "task", taskId, roleName: role.name }, role.activeAgentId, now);
  set = recordRoleAgentSession(set, {
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    nativeSessionId: randomUUID(),
    policy: role.name === "leader" ? "fixed" : "leader-controlled",
    status: "reserved",
    sessionRoot: resolveAgentSessionRoot(binding.adapterId, launchEnvironment),
    ...(worktreeRoot === undefined ? {} : { worktreeRoot: resolve(worktreeRoot) }),
    configFingerprint: fingerprint,
    permissionEnvelope: adapter.permissionEnvelope(canonicalConfig)
  }, now);
  if (agent.id !== binding.agentId || agent.adapterId !== binding.adapterId) {
    throw new Error(`Cannot reserve session for mismatched AgentDefinition: ${agent.id}.`);
  }
  return set;
}

export function permissionEnvelopeForBinding(binding: RoleAgentBinding): PermissionEnvelope {
  if (binding.adapterId !== binding.config.adapterId) {
    throw new Error(`Role Agent binding adapter is inconsistent: ${binding.agentId}.`);
  }
  if (binding.config.adapterId === "codex") {
    return {
      adapterId: "codex",
      ...(binding.config.permission?.sandbox === undefined
        ? {}
        : { sandbox: binding.config.permission.sandbox }),
      ...(binding.config.permission?.approval === undefined
        ? {}
        : { approval: binding.config.permission.approval }),
      additionalDirectoryHashes: hashPermissionTools(binding.config.additionalDirectories ?? [])
    };
  }
  return {
    adapterId: "claude",
    ...(binding.config.permission?.mode === undefined
      ? {}
      : { mode: binding.config.permission.mode }),
    ...(binding.config.permission?.allowedTools === undefined
      ? {}
      : { allowedToolHashes: hashPermissionTools(binding.config.permission.allowedTools) }),
    ...(binding.config.permission?.disallowedTools === undefined
      ? {}
      : { disallowedToolHashes: hashPermissionTools(binding.config.permission.disallowedTools) }),
    additionalDirectoryHashes: hashPermissionTools(binding.config.additionalDirectories ?? [])
  };
}

function hashPermissionTool(tool: string): string {
  return createHash("sha256").update(tool).digest("hex");
}

function hashPermissionTools(tools: string[]): string[] {
  return [...new Set(tools.map(hashPermissionTool))].sort();
}

function requireSession(role: Role, session: RoleAgentSession | null): RoleAgentSession {
  if (session === null) throw new Error(`No native session is recorded for ${role.name}.`);
  const binding = activeRoleAgentBinding(role);
  if (session.agentId !== binding.agentId || session.adapterId !== binding.adapterId) {
    throw new Error(`Recorded session Agent does not match active Role binding: ${role.name}.`);
  }
  return session;
}

function assertTaskRoleOwnership(taskId: string, role: Role): void {
  if (taskId !== role.taskId) throw new Error(`TaskRole ownership does not match Task: ${role.name}.`);
}

export function resolveAgentSessionRoot(adapterId: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || homedir();
  return canonicalizeNativeSessionRoot(resolve(adapterId === "codex"
    ? env.CODEX_HOME ?? `${home}/.codex`
    : env.CLAUDE_CONFIG_DIR ?? `${home}/.claude`));
}

export function resolveAgentLaunchEnvironment(
  agent: AgentDefinition,
  processEnvironment: NodeJS.ProcessEnv
): Record<string, string> {
  const agentEnvironment = resolveAgentEnvironment(agent, processEnvironment);
  const effective = { ...processEnvironment, ...agentEnvironment };
  const home = effective.HOME?.trim() || homedir();
  const sessionRoot = resolveAgentSessionRoot(agent.adapterId, { ...effective, HOME: home });
  return {
    ...agentEnvironment,
    HOME: home,
    ...(effective.PATH === undefined ? {} : { PATH: effective.PATH }),
    ...(agent.adapterId === "codex"
      ? { CODEX_HOME: sessionRoot }
      : { CLAUDE_CONFIG_DIR: sessionRoot })
  };
}

function assertResumeRoots(
  session: RoleAgentSession,
  adapterId: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  expectedWorktreeRoot?: string
): void {
  if (session.sessionRoot !== resolveAgentSessionRoot(adapterId, env)) {
    throw new Error(`Native session root changed for Agent: ${session.agentId}.`);
  }
  if (session.worktreeRoot !== undefined && resolve(session.worktreeRoot) !== resolve(workspace)) {
    throw new Error(`Role worktree root changed for Agent session: ${session.agentId}.`);
  }
  if (expectedWorktreeRoot !== undefined && session.worktreeRoot !== resolve(expectedWorktreeRoot)) {
    throw new Error(`Role Agent session is missing its owned worktree root: ${session.agentId}.`);
  }
}
