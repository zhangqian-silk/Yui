import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runPurposeAdmitsTaskState } from "../agentRun/agentRun.js";
import { assertExecutionEnvironmentCurrent } from "../runtime/executionEnvironment.js";
import { taskOwnsManagedWorkspace } from "../task/task.js";

import {
  configuredAgentToDefinition,
  resolveAgentEnvironment
} from "../agent/agent.js";
import {
  NATIVE_AGENT_ENVIRONMENT_NAMES,
  nativeAgentEnvironmentNames,
  operationalAgentEnvironment,
  selectEnvironment
} from "../agent/launchEnvironment.js";
import {
  compileRoleSessionContext,
  roleSessionKind
} from "../context/roleSessionContext.js";
import {
  materializeSessionBootstrap,
  type SessionEntryPoint
} from "../context/sessionBootstrapManifest.js";
import { ResourceRegistrar } from "../resources/resourceRegistrar.js";
import { activeRoleAgentBinding, type GlobalRole, type TaskRole } from "../role/role.js";
import { managedRuntimeAdmission } from "../runtime/agentDriver.js";
import {
  builtinAgentEndpointImplementation,
  validateAgentEndpointImplementation
} from "../runtime/agentEndpointIdentity.js";
import {
  builtinAgentDriverRegistry,
  builtinDriverIdForAdapter
} from "../runtime/builtinAgentDrivers.js";
import type {
  AgentHostProviderControl,
  ProviderOwnedTurn
} from "../runtime/launchBroker.js";
import type {
  AgentEnvironmentRefresh,
  AgentEnvironmentRefreshPort
} from "../runtime/ports.js";
import type { ProviderAuthorityFence } from "../runtime/providerAuthorityFence.js";
import {
  assertProviderConversationReplaceable
} from "../runtime/providerRuntimeIdentity.js";
import { resolveTaskRoleSessionTitle } from "../runtime/sessionTitle.js";
import {
  parseTaskRuntimeIsolationDescriptor,
  taskRuntimeIsolationEnvironment,
  type TaskRuntimeIsolationDescriptor
} from "../runtime/taskRuntimeIsolation.js";
import type {
  RoleSessionLaunchMode,
  SchedulerRoleSession
} from "../scheduler/ports.js";
import { planningRuntimeCwd } from "../storage/homeLayout.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import type { ClaudeAgentConfig, RoleAgentConfig } from "./agentAdapter.js";
import { resolveAgentAdapter } from "./agentAdapter.js";
import { activeLiveRoleAgentSession, taskRoleControlTarget } from "./agentExecutor.js";
import {
  assertCodexLaunchOverridesAvailable,
  inspectCodexLaunchConfig
} from "./codexConfigConflict.js";
import {
  effectiveRoleForLaunch,
  resolveEffectiveLaunch,
  roleSessionMayContinue,
  type EffectiveLaunchSnapshot
} from "./effectiveLaunch.js";
import type { PlannedRoleSession, RoleLaunchPlanner } from "./executorRegistry.js";
import {
  classifyWorkspacePreflight,
  formatWorkspacePreflightError,
  type WorkspacePhysicalInspector
} from "./workspacePreflightClassification.js";

export type FileRoleLaunchPlannerOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  createNativeSessionId?: () => string;
  cliPath?: string;
  inspectWorkspacePhysicalState?: WorkspacePhysicalInspector;
}>;

export type GlobalRoleLaunchPlanInput = Readonly<{
  roleName: string;
  agentId: string;
  adapterId: string;
  effective?: EffectiveLaunchSnapshot;
  mode: RoleSessionLaunchMode;
  nativeSessionId?: string;
  environment?: Readonly<Record<string, string>>;
}>;

type TaskRoleLaunchPlanInput = Parameters<RoleLaunchPlanner["plan"]>[0] & Readonly<{
  environment?: Readonly<Record<string, string>>;
}>;

/** Builds managed native Agent launches from the authoritative Task records. */
export class FileRoleLaunchPlanner implements RoleLaunchPlanner, AgentEnvironmentRefreshPort {
  readonly #operationalEnvironment: NodeJS.ProcessEnv;
  #agentEnvironment: NodeJS.ProcessEnv;
  #nativeAgentEnvironment: NodeJS.ProcessEnv;
  readonly #createNativeSessionId: () => string;
  readonly #cliPath: string;
  readonly #inspectWorkspacePhysicalState: WorkspacePhysicalInspector;
  readonly #entryPoint: SessionEntryPoint;
  #resourceRegistrarValue: ResourceRegistrar | undefined;

  constructor(
    readonly home: string,
    readonly store: TaskStore,
    options: FileRoleLaunchPlannerOptions = {}
  ) {
    // Operational launch context is stable for the Controller lifetime. Agent
    // binding sources are a separate replaceable snapshot so an unset/removed
    // secret cannot survive a later configuration refresh.
    const sourceEnvironment = { ...(options.environment ?? process.env) };
    this.#operationalEnvironment = { ...sourceEnvironment };
    for (const name of NATIVE_AGENT_ENVIRONMENT_NAMES) {
      delete this.#operationalEnvironment[name];
    }
    this.#agentEnvironment = this.#selectConfiguredAgentEnvironment(
      sourceEnvironment
    );
    this.#nativeAgentEnvironment = this.#selectConfiguredNativeEnvironment(
      sourceEnvironment
    );
    this.#createNativeSessionId = options.createNativeSessionId ?? randomUUID;
    this.#inspectWorkspacePhysicalState = options.inspectWorkspacePhysicalState
      ?? inspectWorkspacePhysicalState;
    this.#cliPath = canonicalPath(options.cliPath
      ?? fileURLToPath(new URL("../cli.js", import.meta.url)));
    // Where a managed Session's commands run. Continuity is the Session
    // Manifest plus protocol/storage and durable runtime identity, so no
    // package or build identity belongs in this entry point.
    this.#entryPoint = { executable: process.execPath, cliEntry: this.#cliPath };
  }

  #resourceRegistrar(): ResourceRegistrar {
    return this.#resourceRegistrarValue ??= new ResourceRegistrar(this.home);
  }

  refreshAgentEnvironment(refresh: AgentEnvironmentRefresh): void {
    this.#agentEnvironment = patchEnvironment(
      this.#agentEnvironment,
      refresh.sourceNames,
      refresh.sources
    );
    this.#nativeAgentEnvironment = patchEnvironment(
      this.#nativeAgentEnvironment,
      refresh.nativeNames,
      refresh.nativeSources
    );
  }

  /** Recovery addresses the recorded Agent/Session, independent of delivery
   * admission, a missing worktree, or the old Endpoint code generation. */
  planNativeControl(taskId: string, roleName: string): import("../runtime/nativeSessionControl.js").NativeControlConnection {
    const set = this.store.getTaskRoleSessionSet(taskId, roleName);
    const session = taskRoleControlTarget(set);
    if (session?.adapterId !== "codex") throw new Error("Native metadata control requires a recorded Codex Session.");
    const configured = this.store.getConfiguredAgent(session.agentId);
    if (configured === null || configured.adapterId !== session.adapterId) {
      throw new Error("The recorded native Agent connection is unavailable.");
    }
    const agent = configuredAgentToDefinition(configured);
    const connection = this.store.listEvents(taskId).find(event => event.type === "runtime.native-connection-bound"
      && event.payload.roleName === roleName && event.payload.agentId === session.agentId
      && event.payload.nativeSessionId === session.nativeSessionId)?.payload;
    return {
      command: configured.command, args: [...agent.baseArgs, "app-server", "proxy"], cwd: this.home,
      expectedAccountHome: connection?.nativeAccountHome,
      environment: {
        ...operationalAgentEnvironment("codex", { ...this.#operationalEnvironment, ...this.#nativeAgentEnvironment }),
        ...resolveAgentEnvironment(agent, this.#agentEnvironment),
        ...(connection === undefined ? {} : { HOME: connection.home, CODEX_HOME: connection.codexHome })
      }
    };
  }

  plan(input: TaskRoleLaunchPlanInput): PlannedRoleSession {
    const task = this.store.getTask(input.taskId);
    if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
    const role = this.store.getRole(input.taskId, input.roleName);
    if (role === null) throw new Error(`Role not found: ${input.taskId}/${input.roleName}.`);
    const activeRun = this.store.getActiveRun(task.id, role.name);
    if (input.runId !== undefined && activeRun?.id !== input.runId) {
      throw new Error(`Role AgentRun is no longer current: ${input.runId}.`);
    }
    const purpose = activeRun?.purpose
      ?? (task.status === "draft" && role.name === "leader" ? "planning" : "execution");
    if (!runPurposeAdmitsTaskState(purpose, task)) {
      throw new Error(`Task execution is not enabled: ${input.taskId}.`);
    }
    // A launch owns no managed workspace in two cases: a Draft planning
    // conversation, and a Task activated with an empty environment plan. Both
    // run with no Project entries, so there is nothing to preflight and no
    // worktree to wait for. Every other fence — live Session, replaceable
    // Conversation, configured Agent, Context protocol identity, adopted
    // execution environment — still applies.
    const planningDraft = purpose === "planning" && task.status === "draft";
    // A planning cwd is a disposable per-Task runtime resource, not a delivery
    // workspace. Materialize only the exact directory selected at creation.
    if (planningDraft && resolve(role.workspace) === resolve(planningRuntimeCwd(this.home, task.id))) {
      mkdirSync(role.workspace, { recursive: true, mode: 0o700 });
    }
    const workspaceFree = planningDraft || !taskOwnsManagedWorkspace(task);
    // An empty resource plan is a legal Task shape, but it does not make a
    // shared directory a legal cwd. Once such a Task is active it can name the
    // directory it means through the existing environment plan, so require that
    // instead of silently running in whatever workspace the Role inherited with
    // isolation skipped.
    if (workspaceFree && !planningDraft && role.executionEnvironment === undefined) {
      throw new Error(
        `Task ${task.id} owns no workspace and no adopted execution environment, so Role `
        + `${role.name} has no directory of its own to run in. Request activation with a `
        + "`scratch` or `local` environment plan, or bind an adopted environment with "
        + "`environment.bind`, instead of inheriting a shared workspace."
      );
    }
    const runWorkspace = activeRun?.workspace;
    const main = this.store.getTaskWorkspace(task.id);
    // Quick Win (EXE-04/EXE-08): classify workspace preflight failures so
    // split-brain state is never reported as a transient Provider failure.
    const preflight = workspaceFree ? null : classifyWorkspacePreflight(
      this.store,
      task,
      input.roleName,
      activeRun === null ? null : { id: activeRun.id, workspace: activeRun.workspace },
      this.#inspectWorkspacePhysicalState
    );
    if (preflight !== null) {
      throw new Error(formatWorkspacePreflightError(preflight));
    }
    const assignedWorkItem = this.store.listWorkItems(task.id).find((item) =>
      item.assignee === role.name
      && !["accepted", "retired"].includes(item.status)
    );
    // A AgentRun snapshot is authoritative for the live launch. In particular,
    // a Reviewer AgentRun must launch from its ReviewRound-owned workspace rather
    // than falling back to the WorkItem Develop workspace.  Without an
    // active snapshot, resolve the normal Role/WorkItem assignment.
    const workspace = runWorkspace !== undefined
      ? runWorkspace
      : task.projectBindings.length === 0
        ? main
        : assignedWorkItem === undefined
          ? main
          : this.store.getWorkItemWorkspace(task.id, assignedWorkItem.id);
    if (workspaceFree) {
      if (workspace !== null && !isDeepStrictEqual(workspace, main)) {
        throw new Error(`Role workspace is not ready: ${input.taskId}/${input.roleName}.`);
      }
    } else if (task.projectBindings.length === 0) {
      if (workspace === null || !isDeepStrictEqual(workspace, main)) {
        throw new Error(`Role workspace is not ready: ${input.taskId}/${input.roleName}.`);
      }
    } else {
      const sharedMain = main !== null
        && (workspace === null || workspace.owner.type === "task")
        && sameWorkspaceProjects(main, task.projectBindings.map(({ projectId }) => projectId))
        && (role.name === "leader" || role.workspace === main.root);
      const isolatedWorkItem = workspace?.owner.type === "work-item"
        ? this.store.getWorkItem(task.id, workspace.owner.workItemId)
        : null;
      const isolated = workspace !== null
        && workspace.owner.type === "work-item"
        && isolatedWorkItem !== null
        && (isolatedWorkItem.assignee === undefined || isolatedWorkItem.assignee === role.name)
        && !["accepted", "retired"].includes(isolatedWorkItem.status)
        && (activeRun === null
          || activeRun.workItemId === workspace.owner.workItemId)
        && sameWorkspaceProjects(workspace, task.projectBindings.map(({ projectId }) => projectId))
        && sameWritableProjects(workspace, isolatedWorkItem.writeProjectIds);
      const runScoped = runWorkspace !== undefined
        && runWorkspace.owner.taskId === task.id
        && sameWorkspaceProjects(
          runWorkspace,
          task.projectBindings.map(({ projectId }) => projectId)
        )
        && (runWorkspace.owner.type === "task"
          || (runWorkspace.owner.type === "work-item"
            && runWorkspace.owner.workItemId === activeRun?.workItemId)
          || (runWorkspace.owner.type === "review-round"
            && activeRun?.purpose === "review"
            && runWorkspace.owner.reviewRoundId === activeRun.reviewRoundId)
          || (runWorkspace.owner.type === "execution-lane"
            && runWorkspace.owner.executionGroupId === activeRun?.executionGroupId
            && runWorkspace.owner.executionLaneId === activeRun?.executionLaneId
            && ((runWorkspace.owner.purpose === "review" && activeRun?.purpose === "review")
              || (runWorkspace.owner.purpose === "execution" && activeRun?.purpose === "execution"))));
      if (!runScoped && !sharedMain && !isolated) {
        throw new Error(`Role workspace is not ready: ${input.taskId}/${input.roleName}.`);
      }
    }
    const sessionSet = this.store.getTaskRoleSessionSet(task.id, role.name);
    const resolvedEffective = activeRun?.effective
      ?? activeLiveRoleAgentSession(sessionSet)?.effective
      ?? resolveTaskRoleEffectiveLaunch(this.store, role, planningDraft ? "planning" : "execution");
    if (input.effective !== undefined
      && !isDeepStrictEqual(resolvedEffective, input.effective)) {
      throw new Error(`Role launch effective AgentRun snapshot changed: ${input.taskId}/${input.roleName}.`);
    }
    if (activeRun !== null && input.effective === undefined) {
      throw new Error(`Role launch is missing the effective AgentRun snapshot: ${input.taskId}/${input.roleName}.`);
    }
    const effective = input.effective ?? resolvedEffective;
    const existing = sessionSet?.sessions[effective.agentId];
    const compatibleExisting = existing !== undefined
      && roleSessionMayContinue(existing.effective, effective);
    if (input.mode === "resume" && !compatibleExisting) {
      throw new Error(
        `Task Role resume effective snapshot drifted: ${task.id}/${role.name}.`
      );
    }
    if (input.mode === "new" && sessionSet !== null
      && activeLiveRoleAgentSession(sessionSet) !== null) {
      throw new Error(
        `Task Role still has a live Session: ${task.id}/${role.name}.`
      );
    }
    if (input.mode === "new" && sessionSet?.providerBinding !== null
      && sessionSet?.providerBinding !== undefined) {
      // Planning precedes broker tickets, Provider processes and native
      // Conversation creation. An ended Host is not proof that its input
      // attempt was rejected, cancelled, or completed.
      assertProviderConversationReplaceable(sessionSet.providerBinding);
    }
    return this.#compile(
      role,
      input,
      { scope: "task", taskId: task.id },
      resolveTaskRoleSessionTitle(
        input.mode === "resume" ? existing?.title : undefined,
        task,
        role.name
      ),
      input.mode === "resume" && compatibleExisting ? existing.nativeSessionId : undefined,
      runWorkspace,
      effective,
      {
        purpose
      }
    );
  }

  planGlobalRole(input: GlobalRoleLaunchPlanInput): PlannedRoleSession {
    const role = this.store.getGlobalRole(input.roleName);
    if (role === null) throw new Error(`Global Role not found: ${input.roleName}.`);
    const sessionSet = this.store.getGlobalRoleSessionSet(role.name);
    if (activeLiveRoleAgentSession(sessionSet) !== null && sessionSet?.providerBinding == null) {
      throw new Error("Global Role has an unmanaged live Session. Stop that exact Session before opening controlled input; it will not be silently replaced.");
    }
    const resolvedEffective = activeLiveRoleAgentSession(sessionSet)?.effective
      ?? resolveEffectiveLaunch({ role, purpose: "execution" });
    if (input.effective !== undefined
      && !isDeepStrictEqual(resolvedEffective, input.effective)) {
      throw new Error(`Global Role launch effective snapshot changed: ${role.name}.`);
    }
    const effective = input.effective ?? resolvedEffective;
    const existing = sessionSet?.sessions[effective.agentId];
    const compatibleExisting = existing !== undefined
      && roleSessionMayContinue(existing.effective, effective);
    if (input.mode === "resume" && !compatibleExisting) {
      throw new Error(`Global Role resume effective snapshot drifted: ${role.name}.`);
    }
    if (input.mode === "new" && sessionSet?.providerBinding != null) {
      assertProviderConversationReplaceable(sessionSet.providerBinding);
    }
    return this.#compile(
      role,
      input,
      { scope: "global" },
      undefined,
      input.mode === "resume" && compatibleExisting ? existing.nativeSessionId : undefined,
      undefined,
      effective,
      { purpose: "execution" }
    );
  }

  #compile(
    role: TaskRole | GlobalRole,
    input: Readonly<{
      roleName: string;
      agentId: string;
      adapterId: string;
      mode: RoleSessionLaunchMode;
      nativeSessionId?: string;
      runId?: string;
      runtimeIsolation?: TaskRuntimeIsolationDescriptor;
      environment?: Readonly<Record<string, string>>;
    }>,
    owner: Readonly<{ scope: "task"; taskId: string } | { scope: "global" }>,
    sessionTitle: string | undefined,
    knownNativeSessionId: string | undefined,
    workspaceOverride: ManagedWorkspace | undefined,
    effective: EffectiveLaunchSnapshot,
    sessionPolicy: Readonly<{ purpose: "execution" | "review" | "planning" }>
  ): PlannedRoleSession {
    const launchRole = effectiveRoleForLaunch(role, effective);
    const binding = activeRoleAgentBinding(launchRole);
    if (binding.agentId !== input.agentId || binding.adapterId !== input.adapterId) {
      throw new Error(`Role runtime identity changed: ${role.name}.`);
    }
    const existingSession = owner.scope === "task"
      ? this.store.getTaskRoleSessionSet(owner.taskId, role.name)?.sessions[input.agentId]
      : this.store.getGlobalRoleSessionSet(role.name)?.sessions[input.agentId];
    // A resume carries the Session's recorded generation forward unchanged. This
    // planner runs in the Controller, which after an upgrade is already the new
    // code, so it cannot speak for the still-running Agent Host that owns the
    // Session: rejecting here would end live Sessions on Controller upgrade,
    // while rewriting to current code would silently move a Session onto code it
    // never started on. The Host that actually executes the implementation makes
    // the decision — a reused live Host accepts its own generation, and a newly
    // started Host running different code fails closed
    // (`agentEndpointOwnership.pin` -> `requireBuiltinAgentEndpointImplementation`).
    const endpointImplementation = input.mode === "resume"
      ? validateAgentEndpointImplementation(existingSession!.endpointImplementation)
      : builtinAgentEndpointImplementation(binding.adapterId);
    const configured = this.store.getConfiguredAgent(input.agentId);
    if (configured === null) throw new Error(`Configured Agent not found: ${input.agentId}.`);
    if (configured.adapterId !== binding.adapterId) {
      throw new Error(`Configured Agent adapter changed: ${input.agentId}.`);
    }
    // The command below comes from the Agent record while the product identity
    // stamped onto this Session comes from the pinned snapshot. Checking only
    // the adapter lets those disagree whenever two products share a plan, which
    // is exactly the ACP case: the launch would run the newly configured
    // executable and label it with the product the Session was pinned to. The
    // update path refuses this change on a referenced Agent, so reaching here
    // means the record was altered some other way — still not something to
    // launch through.
    if (configured.component !== binding.component) {
      throw new Error(`Configured Agent execution component changed: ${input.agentId}.`);
    }

    const agent = configuredAgentToDefinition(configured);
    const agentSourceEnvironment = input.environment ?? this.#agentEnvironment;
    const operationalSourceEnvironment = input.environment ?? {
      ...this.#operationalEnvironment,
      ...this.#nativeAgentEnvironment
    };
    const resolvedAgentEnvironment = resolveAgentEnvironment(agent, agentSourceEnvironment);
    const inheritedLaunchEnvironment = {
      ...operationalAgentEnvironment(configured.adapterId, operationalSourceEnvironment),
      ...resolvedAgentEnvironment
    };
    const launchEnvironment = { ...inheritedLaunchEnvironment };
    const adapter = resolveAgentAdapter(binding.adapterId);
    const effectiveWorkspace = effective.workspace.root;
    if (effective.executionEnvironment !== undefined) {
      if (owner.scope !== "task") throw new Error("Global Roles cannot adopt a Task execution environment.");
      assertExecutionEnvironmentCurrent(this.store, owner.taskId, effective.executionEnvironment);
      if ((binding.config.advanced?.rawArgs?.length ?? 0) > 0) {
        throw new Error("Adopted environments do not accept raw Agent arguments; use structured configuration.");
      }
      if ((binding.config.additionalDirectories?.length ?? 0) > 0) {
        throw new Error("Adopted environments cannot implicitly include additional directories.");
      }
    }
    const agentWorkspace = effective.executionEnvironment?.directory.path
      ?? nativeAgentWorkspace(effective.workspace);
    if (adapter.id === "codex" && (owner.scope !== "task" || input.runId === undefined)) {
      const codexConfig = inspectCodexLaunchConfig({
        environment: launchEnvironment,
        workspace: agentWorkspace,
        profile: binding.config.adapterId === "codex"
          ? binding.config.profile
          : undefined,
        trustWorkspace: true
      });
      assertCodexLaunchOverridesAvailable(codexConfig, owner.scope === "global"
        ? ["developerInstructions"]
        : ["developerInstructions", "notify"]);
    }
    const runtimeIsolation = input.runtimeIsolation === undefined
      ? undefined
      : parseTaskRuntimeIsolationDescriptor(JSON.stringify(input.runtimeIsolation));
    if (runtimeIsolation !== undefined && (owner.scope !== "task" || runtimeIsolation.taskId !== owner.taskId || runtimeIsolation.workspace.root !== effectiveWorkspace)) {
      throw new Error("Role launch does not match its Task runtime isolation descriptor.");
    }
    Object.assign(
      launchEnvironment,
      runtimeIsolation === undefined
        ? {}
        : taskRuntimeIsolationEnvironment(runtimeIsolation)
    );
    const baseSessionContext = compileRoleSessionContext(
      this.home,
      launchRole,
      owner,
      sessionPolicy
    );
    const bootstrap = materializeSessionBootstrap({
      yuiHome: this.home,
      role: launchRole,
      owner,
      roleKind: roleSessionKind(launchRole, owner, sessionPolicy.purpose),
      skills: baseSessionContext.skills,
      entryPoint: this.#entryPoint
    });
    if (effective.contextProtocolVersion !== bootstrap.manifest.schemaVersion
      || effective.sessionManifestCompatibilityDigest
        !== bootstrap.manifest.compatibilityDigest) {
      throw new Error(
        "Effective launch Context protocol identity does not match the materialized Session Manifest."
      );
    }
    const sessionContext = {
      ...baseSessionContext,
      developerInstructions: `Read and follow the exact Yui Session Manifest at ${bootstrap.manifestPath}.`,
      managedContextFile: bootstrap.manifestPath,
      sessionManifestPath: bootstrap.manifestPath,
      sessionManifestDigest: bootstrap.manifest.digest,
      sessionCliPath: bootstrap.sessionCliPath
    };
    const managedRun = owner.scope === "task" && input.runId !== undefined
      ? this.store.getRun(owner.taskId, input.runId)
      : null;
    const driver = builtinAgentDriverRegistry().require(
      builtinDriverIdForAdapter(configured.adapterId)
    );
    if (owner.scope === "task" && input.runId !== undefined) {
      const admission = managedRuntimeAdmission(driver.capabilities);
      if (!admission.admitted) {
        throw new Error(
          `Agent Driver ${driver.id} cannot host managed AgentRuns; missing capabilities: `
          + admission.missing.join(", ")
        );
      }
    }
    const roleConfig = binding.config.adapterId === "claude"
      && owner.scope === "task"
      && input.runId !== undefined
      ? managedClaudeControlPlaneConfig(
          binding.config,
          owner.taskId,
          managedRun?.workItemId,
          input.runId
        )
      : binding.config;
    const effectiveConfig = withNativeProjectDirectories(
      roleConfig,
      effective.executionEnvironment === undefined
        ? nativeAdditionalDirectories(effective.workspace, agentWorkspace)
        : []
    );
    const compileInput = {
      agent,
      config: effectiveConfig,
      workspace: agentWorkspace,
      ...(sessionTitle === undefined ? {} : { sessionTitle }),
      ...sessionContext
    };
    if (
      input.mode === "resume"
      && knownNativeSessionId !== undefined
      && input.nativeSessionId !== knownNativeSessionId
    ) {
      throw new Error(`Role resume changed the fixed native session id: ${role.name}.`);
    }
    // A previous attempt may have persisted a preallocated/discovered ID
    // before its receipt was committed. Reuse that fixed session rather than
    // allocating a second native session for the same durable AgentRun.
    const resumeNativeSessionId = input.mode === "resume"
      ? requireText(input.nativeSessionId, "Native session id")
      : knownNativeSessionId;
    const launchMode: RoleSessionLaunchMode = resumeNativeSessionId === undefined
      ? "new"
      : "resume";
    // Only an Agent that accepts a caller-chosen Session id can have one
    // preallocated. Keying this on the adapter name instead of the declared
    // capability meant every non-Claude adapter was assumed to accept one.
    const preallocatedNativeSessionId = adapter.capabilities.nativeSessionDiscovery === "preallocated"
      && resumeNativeSessionId === undefined
      ? requireText(
          this.#createNativeSessionId(),
          "Native session id"
        )
      : resumeNativeSessionId;
    const managedCompiled = adapter.compileManagedControl(
      compileInput, launchMode, preallocatedNativeSessionId);
    const compiled = managedCompiled;
    for (const path of [
      bootstrap.manifestPath,
      bootstrap.sessionCliPath,
      bootstrap.roleProfilePath
    ]) {
      this.#resourceRegistrar().registerSessionContext(
        path,
        {
          home: resolve(this.home),
          ...(owner.scope === "task" ? { taskId: owner.taskId } : {}),
          basis: "descriptor"
        }
      );
    }

    let args = [...compiled.argv];
    let command = configured.command;
    let session: SchedulerRoleSession | null;
    // Managed Claude owns a serialized stream with exact attempt correlation.
    // Its native Hooks carry no such request fence and must not compete with
    // the Host for acceptance, completion, or attachment lifecycle facts.
    // Provider tool permissions remain in compiled config, not this observer.
    if (binding.adapterId === "codex") {
      // Interactive Task sessions may use notify for presentation.
      // Managed AgentRuns receive lifecycle facts through their ordinary App Server
      // subscription, avoiding a second Hook channel for the same AgentRun.
      // Managed Codex Turns use disposable proxy clients against the shared
      // native App Server. Their Session Manifest points at the Yui Skills;
      // no Yui Hook config is installed.
      if (owner.scope === "task" && input.runId !== undefined) {
        if (managedRun === null || managedRun.status !== "active") {
          throw new Error(`Managed Codex AgentRun is no longer active: ${input.runId}.`);
        }
      }
      session = launchMode === "resume"
        ? readySession(input.agentId, binding.adapterId, resumeNativeSessionId!, effective)
        : null;
    } else if (launchMode === "new") {
      if (adapter.capabilities.nativeSessionDiscovery === "preallocated") {
        const nativeSessionId = requireText(
          preallocatedNativeSessionId,
          "Native session id"
        );
        if (!args.includes("--session-id")) args.push("--session-id", nativeSessionId);
        session = readySession(input.agentId, binding.adapterId, nativeSessionId, effective);
      } else {
        // A runtime-discovered Session id does not exist until the Agent
        // answers, so there is no ready Session to record at plan time and no
        // id to pass on the command line. Same shape as a new Codex launch.
        session = null;
      }
    } else {
      session = readySession(input.agentId, binding.adapterId, resumeNativeSessionId!, effective);
    }
    const managedClaudeRun = binding.adapterId === "claude"
      && owner.scope === "task"
      && input.runId !== undefined;
    if (managedClaudeRun && (managedRun === null || managedRun.status !== "active")) {
      throw new Error(`Managed Claude AgentRun is no longer active: ${input.runId}.`);
    }

    // Session lifecycle and AgentRun submission are separate atomic operations.
    // Planning only starts or restores the exact native Session; delivery
    // submits the AgentRun input after that Session fact is durable.
    if (owner.scope === "task" && input.runId !== undefined && (managedRun === null || managedRun.status !== "active")) {
      throw new Error(`Managed AgentRun is no longer active: ${input.runId}.`);
    }
    const providerAuthority = this.#providerAuthorityForLaunch(
          owner.scope === "task" ? owner.taskId : undefined,
          role.name,
          input.mode
        );
    let providerOwnedRun = owner.scope === "task" && input.mode === "resume" && input.runId !== undefined
      ? this.#providerOwnedRunForLaunch(owner.taskId, role.name, input.runId!)
      : undefined;
    if (owner.scope === "global" && input.mode === "resume") {
      const turn = this.store.getGlobalRoleSessionSet(role.name)?.providerBinding?.run;
      if (turn?.status === "accepted") {
        if (binding.adapterId !== "codex" || turn.nativeTurnId === undefined) {
          throw new Error("This Global active Turn cannot be restored with exact native identity.");
        }
        providerOwnedRun = { attemptId: turn.attemptId, turnId: turn.nativeTurnId };
      } else if (turn != null && ["submitting", "delivery-unknown"].includes(turn.status)) {
        throw new Error("Global input delivery is unconfirmed; resolve its exact current attempt before restoring.");
      }
    }
    const providerNativeSessionId = binding.adapterId === "claude"
      ? preallocatedNativeSessionId
      : resumeNativeSessionId;
    const providerControl: AgentHostProviderControl = input.mode === "resume"
        ? {
            schemaVersion: 1,
            adapterId: binding.adapterId,
            // The product identity is pinned by the snapshot this launch was
            // resolved from, and the check above proves the Agent record still
            // names it. Carrying only the adapter would leave the runtime with
            // two products sharing one plan and no way to tell them apart.
            component: binding.component,
            transport: managedCompiled!.transport,
            endpointImplementation,
            kind: "restore",
            sessionOnly: input.runId === undefined,
            mode: "resume",
            nativeSessionId: requireText(
              providerNativeSessionId,
              "Managed Provider restore native session id"
            ),
            ...(sessionTitle === undefined ? {} : { sessionTitle }),
            ...(managedCompiled!.codexThread === undefined
              ? {}
              : { codexThread: managedCompiled!.codexThread }),
            ...(providerOwnedRun === undefined ? {} : { ownedTurn: providerOwnedRun }),
            ...(managedCompiled!.acpSession === undefined
              ? {}
              : { acpSession: managedCompiled!.acpSession }),
            authority: providerAuthority!
          }
        : {
            schemaVersion: 1,
            adapterId: binding.adapterId,
            component: binding.component,
            transport: managedCompiled!.transport,
            endpointImplementation,
            kind: "start",
            sessionOnly: input.runId === undefined,
            mode: "new",
            ...(providerNativeSessionId === undefined
              ? {}
              : { nativeSessionId: providerNativeSessionId }),
            ...(sessionTitle === undefined ? {} : { sessionTitle }),
            ...(managedCompiled!.codexThread === undefined
              ? {}
              : { codexThread: managedCompiled!.codexThread }),
            ...(managedCompiled!.acpSession === undefined
              ? {}
              : { acpSession: managedCompiled!.acpSession }),
            authority: providerAuthority!
          };
    const launch = {
      command,
      args,
      ...(effective.executionEnvironment === undefined ? {} : {
        executionEnvironment: structuredClone(effective.executionEnvironment)
      }),
      providerControl,
      env: {
        ...launchEnvironment,
        YUI_HOME: resolve(this.home),
        YUI_SESSION_SCOPE: owner.scope,
        ...(owner.scope === "task" ? { YUI_TASK_ID: owner.taskId } : {}),
        YUI_ROLE: role.name,
        YUI_AGENT_ID: configured.id,
        YUI_ADAPTER_ID: configured.adapterId,
        YUI_DRIVER_ID: driver.id,
        YUI_WORKSPACE: effectiveWorkspace,
        YUI_SESSION_MANIFEST: sessionContext.sessionManifestPath,
        YUI_SESSION_CLI: sessionContext.sessionCliPath,
        ...(configured.adapterId === "codex"
          ? { YUI_AGENT_BASE_ARGS: JSON.stringify(configured.baseArgs) }
          : {}),
        ...(sessionTitle === undefined
          ? {}
          : {
              YUI_SESSION_TITLE: sessionTitle,
              ...(configured.adapterId === "codex"
                ? {
                    YUI_AGENT_COMMAND: configured.command,
                    YUI_AGENT_BASE_ARGS: JSON.stringify(configured.baseArgs)
                  }
                : {})
            }),
        // No AgentRun is exported into the Session environment. A native pane
        // outlives its AgentRun, so a AgentRun id frozen here would be stale for every
        // later AgentRun. The Agent Host sets it explicitly per spawned Provider
        // AgentRun, and every durable decision reads the active AgentRun from state.
        ...(session === null
          ? {}
          : { YUI_NATIVE_SESSION_ID: session.nativeSessionId })
      },
      childLifecycle: driver.capabilities.lifecycle.providerProcess
    };
    const scopedLaunch = owner.scope === "task"
      ? this.#applyWorkspaceScope(owner.taskId, role, launch, workspaceOverride)
      : launch;
    const ordinaryConversationLaunch = withCodexThreadEnvironment(scopedLaunch);
    return {
      role: {
        name: role.name,
        workspace: effectiveWorkspace,
        ...(agentWorkspace === effectiveWorkspace ? {} : { cwd: agentWorkspace })
      },
      launch: ordinaryConversationLaunch,
      session,
      ...(sessionTitle === undefined ? {} : { sessionTitle })
    };
  }

  #providerAuthorityForLaunch(
    taskId: string | undefined,
    roleName: string,
    mode: "new" | "resume"
  ): ProviderAuthorityFence {
    const binding = (taskId === undefined
      ? this.store.getGlobalRoleSessionSet(roleName)
      : this.store.getTaskRoleSessionSet(taskId, roleName))?.providerBinding;
    if (binding === null || binding === undefined) {
      return { epoch: 1, owner: "controller", holderId: "controller" };
    }
    if (binding.authority.owner === "controller") {
      if (mode === "new") {
        return {
          epoch: binding.authority.epoch + 1,
          owner: "controller",
          holderId: "controller"
        };
      }
      return {
        epoch: binding.authority.epoch,
        owner: "controller",
        holderId: binding.authority.holderId!
      };
    }
    if (binding.authority.owner === "human") {
      throw new Error(`Provider writer is held by a human: ${taskId}/${roleName}.`);
    }
    if (binding.authority.owner === "none") {
      return {
        epoch: binding.authority.epoch + 1,
        owner: "controller",
        holderId: "controller"
      };
    }
    throw new Error(`Provider writer authority is unknown: ${taskId}/${roleName}.`);
  }

  #providerOwnedRunForLaunch(
    taskId: string,
    roleName: string,
    runId: string
  ): ProviderOwnedTurn | undefined {
    const binding = this.store.getTaskRoleSessionSet(taskId, roleName)?.providerBinding;
    if (binding === null || binding === undefined
      || binding.run?.runId !== runId) return undefined;
    const run = binding.run;
    if (run === null || run.status !== "accepted") return undefined;
    if (run.nativeTurnId === undefined) {
      throw new Error(`Active Provider AgentRun has no native identity: ${taskId}/${roleName}.`);
    }
    return { attemptId: run.attemptId, turnId: run.nativeTurnId };
  }

  #applyWorkspaceScope(
    taskId: string,
    role: TaskRole | GlobalRole,
    launch: Readonly<{
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      providerControl?: AgentHostProviderControl;
      childLifecycle: "persistent" | "per-turn";
      deferProviderStart?: boolean;
    }>,
    workspaceOverride?: ManagedWorkspace
  ): typeof launch {
    const workspace = workspaceOverride
      ?? (role.name === "leader"
        ? this.store.getTaskWorkspace(taskId)
        : this.store.listWorkItems(taskId)
          .find((item) => item.assignee === role.name && item.status === "open") === undefined
          ? this.store.getTaskWorkspace(taskId)
          : this.store.getWorkItemWorkspace(
            taskId,
            this.store.listWorkItems(taskId).find(
              (item) => item.assignee === role.name && item.status === "open"
            )!.id
          ));
    if (workspace === null || workspace === undefined) return launch;
    return {
      ...launch,
      env: {
        ...workspaceScopeEnvironment(launch.env, workspace)
      }
    };
  }

  #selectConfiguredAgentEnvironment(
    source: Readonly<Record<string, string | undefined>>
  ): NodeJS.ProcessEnv {
    const selected: NodeJS.ProcessEnv = {};
    for (const agent of this.store.listConfiguredAgents()) {
      for (const binding of agent.environment) {
        const value = source[binding.sourceName];
        if (value !== undefined) selected[binding.sourceName] = value;
      }
    }
    return selected;
  }

  #selectConfiguredNativeEnvironment(
    source: Readonly<Record<string, string | undefined>>
  ): NodeJS.ProcessEnv {
    const names = new Set(this.store.listConfiguredAgents().flatMap((agent) => (
      nativeAgentEnvironmentNames(agent.adapterId)
    )));
    return selectEnvironment(source, names);
  }
}

export function nativeAgentWorkspace(
  workspace: EffectiveLaunchSnapshot["workspace"]
): string {
  return workspace.entries.length === 1
    ? workspace.entries[0].path
    : workspace.root;
}

export function nativeAdditionalDirectories(
  workspace: EffectiveLaunchSnapshot["workspace"],
  agentWorkspace: string
): string[] {
  return [workspace.root, ...workspace.entries.map(({ path }) => path)]
    .filter((path) => path !== agentWorkspace);
}

export function withNativeProjectDirectories<T extends RoleAgentConfig>(
  config: T,
  projectDirectories: readonly string[]
): T {
  if (projectDirectories.length === 0) return config;
  return {
    ...config,
    additionalDirectories: [...new Set([
      ...(config.additionalDirectories ?? []),
      ...projectDirectories
    ])]
  } as T;
}

function resolveTaskRoleEffectiveLaunch(
  store: TaskStore,
  role: TaskRole,
  purpose: "execution" | "planning" = "execution"
): EffectiveLaunchSnapshot {
  if (purpose === "planning") {
    // Planning has no WorkItem assignment and no managed workspace, so it
    // resolves the Role's own configured workspace with no writable Project.
    return resolveEffectiveLaunch({ role, purpose: "planning" });
  }
  const item = store.listWorkItems(role.taskId).find((candidate) => (
    candidate.assignee === role.name
      && !["accepted", "retired"].includes(candidate.status)
  )) ?? null;
  const workspace = (item === null
    ? store.getTaskWorkspace(role.taskId)
    : store.getWorkItemWorkspace(role.taskId, item.id))
    ?? store.getTaskWorkspace(role.taskId)
    ?? undefined;
  return resolveEffectiveLaunch({
    role,
    purpose: "execution",
    ...(workspace === undefined ? {} : { workspace }),
    ...(item === null ? {} : { workItemWriteProjectIds: item.writeProjectIds })
  });
}

function workspaceScopeEnvironment(
  environment: Readonly<Record<string, string>>,
  workspace: ManagedWorkspace
): Readonly<Record<string, string>> {
  return {
    ...environment,
    YUI_WRITABLE_PROJECT_IDS: JSON.stringify(
      workspace.entries
        .filter(({ access }) => access === "write")
        .map(({ projectId }) => projectId)
    ),
    YUI_CONTEXT_PROJECT_IDS: JSON.stringify(
      workspace.entries
        .filter(({ access }) => access === "read")
        .map(({ projectId }) => projectId)
    ),
    YUI_WORKSPACE_PROJECTS: JSON.stringify(Object.fromEntries(
      workspace.entries.map(({ projectId, directory, access, path }) => [
        projectId,
        { directory, access, path }
      ])
    ))
  };
}

function managedClaudeControlPlaneConfig(
  config: ClaudeAgentConfig,
  taskId: string,
  workItemId: string | undefined,
  runId: string
): ClaudeAgentConfig {
  if (config.permission.strategy !== "configured") return config;
  const managed = [
    `Bash(yui task run context ${taskId}/${runId}:*)`,
    `Bash(yui --json task context ${taskId})`,
    `Bash(yui --json task work list ${taskId})`,
    ...(workItemId === undefined
      ? []
      : [`Bash(yui --json task work show ${workItemId})`])
  ];
  const existing = (config.permission.allowedTools ?? [])
    .filter((rule) => !isManagedYuiBashRule(rule));
  return {
    ...config,
    permission: {
      ...config.permission,
      allowedTools: [...new Set([...existing, ...managed])]
    }
  };
}

function isManagedYuiBashRule(rule: string): boolean {
  const normalized = rule.trim();
  return /^Bash\(yui(?:\s|:\*|\*|\))/u.test(normalized)
    // Yui no longer writes a control-plane digest into a managed rule; this
    // shape only clears one an earlier release left in a Provider config.
    || /^Bash\(.*\s--yui-control\s/u.test(normalized);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

const inspectWorkspacePhysicalState: WorkspacePhysicalInspector = (entry) => {
  const headResult = spawnSync(
    "git",
    ["-C", entry.path, "rev-parse", "HEAD"],
    { encoding: "utf8", shell: false, timeout: 5_000 }
  );
  if (headResult.error !== undefined || headResult.status !== 0) {
    throw new Error(
      `Managed workspace physical HEAD could not be inspected: ${entry.projectId} @ ${entry.path}.`
    );
  }
  const physicalCommit = headResult.stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(physicalCommit)) {
    throw new Error(`Managed workspace physical HEAD is invalid: ${entry.projectId}.`);
  }
  const ancestorResult = spawnSync(
    "git",
    ["-C", entry.path, "merge-base", "--is-ancestor", entry.baseCommit, physicalCommit],
    { encoding: "utf8", shell: false, timeout: 5_000 }
  );
  if (ancestorResult.error !== undefined
    || (ancestorResult.status !== 0 && ancestorResult.status !== 1)) {
    throw new Error(
      `Managed workspace lineage could not be inspected: ${entry.projectId} @ ${entry.path}.`
    );
  }
  return {
    physicalCommit,
    recordedBaseIsAncestor: ancestorResult.status === 0
  };
};


function patchEnvironment(
  current: NodeJS.ProcessEnv,
  names: readonly string[],
  values: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  const next = { ...current };
  for (const name of names) delete next[name];
  for (const [name, value] of Object.entries(values)) next[name] = value;
  return next;
}

/**
 * Global Codex keeps its native TUI, but the TUI is only a client attachment
 * to the user's shared App Server. The daemon owns the Thread and its writer,
 * so Desktop can open the same Yui-created Thread without a second rollout
 * writer or a Yui-specific takeover.
 */
export function addCodexSharedDaemonRemote(
  args: readonly string[],
  mode: "new" | "resume",
  environment: Readonly<Record<string, string>> = {}
): string[] {
  const sessionEnvironment = Object.fromEntries(Object.entries(environment).filter(
    ([name]) => name.startsWith("YUI_")
  ));
  const remote = [
    "--remote",
    "unix://",
    ...(Object.keys(sessionEnvironment).length === 0
      ? []
      : ["--config", codexShellEnvironmentConfig(sessionEnvironment)])
  ];
  if (mode === "new") return [...args, ...remote];
  if (args.length < 2 || args.at(-2) !== "resume") {
    throw new Error("Codex resume launch shape is invalid.");
  }
  return [...args.slice(0, -2), ...remote, ...args.slice(-2)];
}

function codexShellEnvironmentConfig(
  environment: Readonly<Record<string, string>>
): string {
  const entries = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`);
  return `shell_environment_policy.set={${entries.join(",")}}`;
}



function withCodexThreadEnvironment<T extends Readonly<{
  env: Readonly<Record<string, string>>;
  providerControl?: AgentHostProviderControl;
}>>(launch: T): T {
  const control = launch.providerControl;
  if (control?.adapterId !== "codex" || control.codexThread === undefined) return launch;
  const set = Object.fromEntries(Object.entries(launch.env).filter(([key]) => (
    key.startsWith("YUI_")
    || ["TMPDIR", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]
      .includes(key)
  )));
  return {
    ...launch,
    providerControl: {
      ...control,
      codexThread: {
        ...control.codexThread,
        config: {
          ...(control.codexThread.config ?? {}),
          shell_environment_policy: { set }
        }
      }
    }
  };
}

function readySession(
  agentId: string,
  adapterId: string,
  nativeSessionId: string,
  effective: EffectiveLaunchSnapshot
): SchedulerRoleSession {
  return {
    agentId,
    adapterId,
    nativeSessionId: requireText(nativeSessionId, "Native session id"),
    status: "active",
    effective
  };
}

function requireText(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function sameWorkspaceProjects(
  workspace: ManagedWorkspace,
  projectIds: readonly string[]
): boolean {
  const actual = workspace.entries.map(({ projectId }) => projectId).sort();
  const expected = [...projectIds].sort();
  return actual.length === expected.length
    && actual.every((projectId, index) => projectId === expected[index]);
}

function sameWritableProjects(
  workspace: ManagedWorkspace,
  projectIds: readonly string[]
): boolean {
  const actual = workspace.entries
    .filter(({ access }) => access === "write")
    .map(({ projectId }) => projectId)
    .sort();
  const expected = [...projectIds].sort();
  return actual.length === expected.length
    && actual.every((projectId, index) => projectId === expected[index]);
}
