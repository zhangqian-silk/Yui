import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

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
import { activeRoleAgentBinding, type GlobalRole, type TaskRole } from "../role/role.js";
import type {
  RoleSessionLaunchMode,
  SchedulerRoleSession
} from "../scheduler/ports.js";
import type { TaskStore } from "../storage/taskStore.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import {
  compileRoleSessionContext,
  roleSessionKind
} from "../context/roleSessionContext.js";
import { materializeSessionBootstrap } from "../context/sessionBootstrapManifest.js";
import { prefixYuiTitleInput } from "../turn/turnIdentity.js";
import { resolveAgentAdapter } from "./agentAdapter.js";
import type { ClaudeAgentConfig, RoleAgentConfig } from "./agentAdapter.js";
import type { PlannedRoleSession, RoleLaunchPlanner } from "./executorRegistry.js";
import type {
  AgentEnvironmentRefresh,
  AgentEnvironmentRefreshPort
} from "../runtime/ports.js";
import { resolveTaskRoleSessionTitle } from "../runtime/sessionTitle.js";
import { nativeSessionIdForLaunch } from "../runtime/preallocatedNativeSession.js";
import {
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import {
  classifyWorkspacePreflight,
  formatWorkspacePreflightError,
  type WorkspacePhysicalInspector
} from "./workspacePreflightClassification.js";
import { activeLiveRoleAgentSession } from "./agentExecutor.js";
import {
  effectiveLaunchSnapshotsCompatibleForTaskSession,
  effectiveLaunchSnapshotsCompatible,
  effectiveRoleForLaunch,
  resolveEffectiveLaunch,
  type EffectiveLaunchSnapshot
} from "./effectiveLaunch.js";
import {
  YUI_CONTROL_PLANE_DESCRIPTOR,
  createExactControlPlaneDescriptor,
  exactControlPlaneDigest,
  serializeExactDescriptor,
  type ExactControlPlaneDescriptor
} from "../runtime/exactControlPlane.js";
import { detectRunningRelease } from "../release/runtimeRelease.js";
import {
  parseTaskRuntimeIsolationDescriptor,
  taskRuntimeIsolationEnvironment,
  type TaskRuntimeIsolationDescriptor
} from "../runtime/taskRuntimeIsolation.js";
import { ResourceRegistrar } from "../resources/resourceRegistrar.js";
import {
  builtinAgentDriverRegistry,
  builtinDriverIdForAdapter
} from "../runtime/builtinAgentDrivers.js";
import { managedRuntimeAdmission } from "../runtime/agentDriver.js";
import type {
  AgentHostProviderControl,
  ProviderOwnedTurn
} from "../runtime/launchBroker.js";
import type { ProviderAuthorityFence } from "../runtime/providerAuthorityFence.js";
import { currentProviderActivation } from "../runtime/providerRuntimeIdentity.js";
import {
  assertCodexLaunchOverridesAvailable,
  inspectCodexLaunchConfig
} from "./codexConfigConflict.js";

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
  runtimeGenerationId?: string;
  environment?: Readonly<Record<string, string>>;
}>;

type TaskRoleLaunchPlanInput = Parameters<RoleLaunchPlanner["plan"]>[0] & Readonly<{
  runtimeGenerationId?: string;
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
  readonly #controlPlane: ExactControlPlaneDescriptor;
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
    // Internal callbacks retain one exact command identity for receipt fencing.
    // Interactive Role commands use ordinary `yui`; their continuity is the
    // Session Manifest plus protocol/storage and durable runtime identity.
    const runningRelease = detectRunningRelease(this.#cliPath);
    this.#controlPlane = createExactControlPlaneDescriptor({
      executable: process.execPath,
      cliEntry: this.#cliPath,
      yuiHome: this.home,
      ...(runningRelease === null
        ? {}
        : {
            buildId: runningRelease.manifest.buildId,
            activeReleaseDigest: runningRelease.manifest.packageDigest
          })
    });
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

  /**
   * Commit the caller key for a task Session only after the runtime host has
   * confirmed that it created a new native process.  An ensure/resume request
   * that reuses a live host must keep the old durable hash because its process
   * still carries the old plaintext key.
   */
  commitTaskCallerKey(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    callerKey: string;
  }>): void {
    const hash = createHash("sha256").update(input.callerKey).digest("hex");
    this.store.setJobCallerKeyHash(input.taskId, input.roleName, input.agentId, hash);
  }

  plan(input: TaskRoleLaunchPlanInput): PlannedRoleSession {
    const task = this.store.getTask(input.taskId);
    if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
    if (task.status !== "active" || task.executionGate.state !== "enabled") {
      throw new Error(`Task execution is not enabled: ${input.taskId}.`);
    }
    const role = this.store.getRole(input.taskId, input.roleName);
    if (role === null) throw new Error(`Role not found: ${input.taskId}/${input.roleName}.`);
    const activeTurn = this.store.getActiveTurn(task.id, role.name);
    if (input.turnId !== undefined && activeTurn?.id !== input.turnId) {
      throw new Error(`Role Turn is no longer current: ${input.turnId}.`);
    }
    const runWorkspace = activeTurn?.workspace;
    const main = this.store.getTaskWorkspace(task.id);
    // Quick Win (EXE-04/EXE-08): classify workspace preflight failures so
    // split-brain state is never reported as a transient Provider failure.
    const preflight = classifyWorkspacePreflight(
      this.store,
      task,
      input.roleName,
      activeTurn === null ? null : { id: activeTurn.id, workspace: activeTurn.workspace },
      this.#inspectWorkspacePhysicalState
    );
    if (preflight !== null) {
      throw new Error(formatWorkspacePreflightError(preflight));
    }
    const assignedWorkItem = this.store.listWorkItems(task.id).find((item) =>
      item.assignee === role.name
      && !["completed", "failed", "retired"].includes(item.status)
    );
    // A Turn snapshot is authoritative for the live launch. In particular,
    // a Reviewer Turn must launch from its ReviewRound-owned workspace rather
    // than falling back to the WorkItem Develop workspace.  Without an
    // active snapshot, resolve the normal Role/WorkItem assignment.
    const workspace = runWorkspace !== undefined
      ? runWorkspace
      : task.projectBindings.length === 0
        ? main
        : assignedWorkItem === undefined
          ? main
          : this.store.getWorkItemWorkspace(task.id, assignedWorkItem.id);
    if (task.projectBindings.length === 0) {
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
        && !["completed", "failed", "retired"].includes(isolatedWorkItem.status)
        && (activeTurn === null
          || activeTurn.workItemId === workspace.owner.workItemId)
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
            && runWorkspace.owner.workItemId === activeTurn?.workItemId)
          || (runWorkspace.owner.type === "review-round"
            && activeTurn?.purpose === "review"
            && runWorkspace.owner.reviewRoundId === activeTurn.reviewRoundId)
          || (runWorkspace.owner.type === "execution-lane"
            && runWorkspace.owner.executionGroupId === activeTurn?.executionGroupId
            && runWorkspace.owner.executionLaneId === activeTurn?.executionLaneId
            && ((runWorkspace.owner.purpose === "review" && activeTurn?.purpose === "review")
              || (runWorkspace.owner.purpose === "execution" && activeTurn?.purpose === "execution"))));
      if (!runScoped && !sharedMain && !isolated) {
        throw new Error(`Role workspace is not ready: ${input.taskId}/${input.roleName}.`);
      }
    }
    const sessionSet = this.store.getTaskRoleSessionSet(task.id, role.name);
    const resolvedEffective = activeTurn?.effective
      ?? activeLiveRoleAgentSession(sessionSet)?.effective
      ?? resolveTaskRoleEffectiveLaunch(this.store, role);
    if (input.effective !== undefined
      && !isDeepStrictEqual(resolvedEffective, input.effective)) {
      throw new Error(`Role launch effective Turn snapshot changed: ${input.taskId}/${input.roleName}.`);
    }
    if (activeTurn !== null && input.effective === undefined) {
      throw new Error(`Role launch is missing the effective Turn snapshot: ${input.taskId}/${input.roleName}.`);
    }
    const effective = input.effective ?? resolvedEffective;
    const existing = sessionSet?.sessions[effective.agentId];
    const compatibleExisting = existing !== undefined
      && (input.mode === "resume"
        ? effectiveLaunchSnapshotsCompatibleForTaskSession(
            existing.effective,
            effective
          )
        : effectiveLaunchSnapshotsCompatible(existing.effective, effective));
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
        purpose: activeTurn?.purpose ?? "execution"
      }
    );
  }

  planGlobalRole(input: GlobalRoleLaunchPlanInput): PlannedRoleSession {
    const role = this.store.getGlobalRole(input.roleName);
    if (role === null) throw new Error(`Global Role not found: ${input.roleName}.`);
    const sessionSet = this.store.getGlobalRoleSessionSet(role.name);
    const resolvedEffective = activeLiveRoleAgentSession(sessionSet)?.effective
      ?? resolveEffectiveLaunch({ role, purpose: "execution" });
    if (input.effective !== undefined
      && !isDeepStrictEqual(resolvedEffective, input.effective)) {
      throw new Error(`Global Role launch effective snapshot changed: ${role.name}.`);
    }
    const effective = input.effective ?? resolvedEffective;
    const existing = sessionSet?.sessions[effective.agentId];
    const compatibleExisting = existing !== undefined
      && effectiveLaunchSnapshotsCompatible(existing.effective, effective);
    if (input.mode === "resume" && !compatibleExisting) {
      throw new Error(`Global Role resume effective snapshot drifted: ${role.name}.`);
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
      runtimeGenerationId?: string;
      turnId?: string;
      runtimeIsolation?: TaskRuntimeIsolationDescriptor;
      environment?: Readonly<Record<string, string>>;
    }>,
    owner: Readonly<{ scope: "task"; taskId: string } | { scope: "global" }>,
    sessionTitle: string | undefined,
    knownNativeSessionId: string | undefined,
    workspaceOverride: ManagedWorkspace | undefined,
    effective: EffectiveLaunchSnapshot,
    sessionPolicy: Readonly<{ purpose: "execution" | "review" }>
  ): PlannedRoleSession {
    const launchRole = effectiveRoleForLaunch(role, effective);
    const binding = activeRoleAgentBinding(launchRole);
    if (binding.agentId !== input.agentId || binding.adapterId !== input.adapterId) {
      throw new Error(`Role runtime generation identity changed: ${role.name}.`);
    }
    const configured = this.store.getConfiguredAgent(input.agentId);
    if (configured === null) throw new Error(`Configured Agent not found: ${input.agentId}.`);
    if (configured.adapterId !== binding.adapterId) {
      throw new Error(`Configured Agent adapter changed: ${input.agentId}.`);
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
    const agentWorkspace = nativeAgentWorkspace(effective.workspace);
    if (adapter.id === "codex" && (owner.scope !== "task" || input.turnId === undefined)) {
      const codexConfig = inspectCodexLaunchConfig({
        environment: launchEnvironment,
        workspace: agentWorkspace,
        profile: binding.config.adapterId === "codex"
          ? binding.config.profile
          : undefined,
        trustWorkspace: true
      });
      assertCodexLaunchOverridesAvailable(codexConfig, ["developerInstructions", "notify"]);
    }
    const runtimeIsolation = input.runtimeIsolation === undefined
      ? undefined
      : parseTaskRuntimeIsolationDescriptor(JSON.stringify(input.runtimeIsolation));
    if (runtimeIsolation !== undefined && (
      owner.scope !== "task"
      || runtimeIsolation.taskId !== owner.taskId
      || runtimeIsolation.workspace.root !== effectiveWorkspace
      || runtimeIsolation.generation.runtimeGenerationId !== input.runtimeGenerationId
    )) {
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
      controlPlane: this.#controlPlane
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
    const managedRun = owner.scope === "task" && input.turnId !== undefined
      ? this.store.getTurn(owner.taskId, input.turnId)
      : null;
    const driver = builtinAgentDriverRegistry().require(
      builtinDriverIdForAdapter(configured.adapterId)
    );
    if (owner.scope === "task" && input.turnId !== undefined) {
      const admission = managedRuntimeAdmission(driver.capabilities);
      if (!admission.admitted) {
        throw new Error(
          `Agent Driver ${driver.id} cannot host managed Turns; missing capabilities: `
          + admission.missing.join(", ")
        );
      }
    }
    const roleConfig = binding.config.adapterId === "claude"
      && owner.scope === "task"
      && input.turnId !== undefined
      ? managedClaudeControlPlaneConfig(
          binding.config,
          owner.taskId,
          managedRun?.workItemId,
          input.turnId
        )
      : binding.config;
    const effectiveConfig = withNativeProjectDirectories(
      roleConfig,
      nativeAdditionalDirectories(effective.workspace, agentWorkspace)
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
    // allocating a second native session for the same durable Turn.
    const resumeNativeSessionId = input.mode === "resume"
      ? requireText(input.nativeSessionId, "Native session id")
      : knownNativeSessionId;
    const launchMode: RoleSessionLaunchMode = resumeNativeSessionId === undefined
      ? "new"
      : "resume";
    const managedControl = owner.scope === "task" && input.turnId !== undefined;
    const managedProviderEnvironment: Readonly<Record<string, string>> = managedControl
      && configured.adapterId === "codex"
      ? {
          // Managed Codex Turns are non-interactive. Use the Codex execution
          // identity for provider requests while clientInfo still identifies Yui.
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_exec"
        }
      : {};
    const preallocatedNativeSessionId = binding.adapterId === "claude"
      && resumeNativeSessionId === undefined
      ? requireText(
          input.runtimeGenerationId === undefined
            ? this.#createNativeSessionId()
            : nativeSessionIdForLaunch(
                this.home,
                input.runtimeGenerationId,
                input.agentId,
                input.adapterId
              ),
          "Native session id"
        )
      : resumeNativeSessionId;
    const managedCompiled = managedControl
      ? adapter.compileManagedControl(
          compileInput,
          launchMode,
          preallocatedNativeSessionId
        )
      : undefined;
    const compiled = managedCompiled !== undefined
      ? managedCompiled
      : launchMode === "resume"
        ? adapter.compileResume({
            ...compileInput,
            nativeSessionId: resumeNativeSessionId!
          })
        : adapter.compileNew(compileInput);
    for (const path of [
      bootstrap.manifestPath,
      bootstrap.sessionCliPath,
      bootstrap.roleProfilePath,
      bootstrap.descriptorPath
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
    if (binding.adapterId === "claude" && (managedControl || owner.scope === "global")) {
      args.push("--plugin-dir", ensureClaudeLifecyclePlugin(this.home, this.#cliPath));
    }
    if (binding.adapterId === "codex") {
      // Global/interactive Codex sessions still use notify for presentation.
      // Managed Turns receive lifecycle facts through their ordinary App Server
      // subscription, avoiding a second Hook channel for the same Turn.
      if (owner.scope !== "task" || input.turnId === undefined) {
        args = addCodexSessionNotify(args, launchMode, this.#cliPath);
      }
      // Managed Codex Turns use disposable proxy clients against the shared
      // native App Server. Their Session Manifest points at the Yui Skills;
      // no Yui Hook config is installed.
      if (owner.scope === "task" && input.turnId !== undefined) {
        if (managedRun === null || managedRun.status !== "active") {
          throw new Error(`Managed Codex Turn is no longer active: ${input.turnId}.`);
        }
      }
      session = launchMode === "resume"
        ? readySession(input.agentId, binding.adapterId, resumeNativeSessionId!, effective)
        : null;
    } else if (launchMode === "new") {
      const nativeSessionId = requireText(
        preallocatedNativeSessionId,
        "Native session id"
      );
      if (!managedControl) args.push("--session-id", nativeSessionId);
      else if (!args.includes("--session-id")) args.push("--session-id", nativeSessionId);
      session = readySession(input.agentId, binding.adapterId, nativeSessionId, effective);
    } else {
      session = readySession(input.agentId, binding.adapterId, resumeNativeSessionId!, effective);
    }
    const managedClaudeRun = binding.adapterId === "claude"
      && owner.scope === "task"
      && input.turnId !== undefined;
    if (managedClaudeRun && (managedRun === null || managedRun.status !== "active")) {
      throw new Error(`Managed Claude Turn is no longer active: ${input.turnId}.`);
    }

    // Generate a candidate per-Provider-process DurableJob caller key for
    // every task-scope launch. A reused live Conversation keeps the key that
    // its process inherited; a new Host or a Conversation replacement commits
    // the fresh candidate only after Provider dispatch is observed.
    let jobCallerKey: string | undefined;
    if (owner.scope === "task" && (input.mode === "new" || input.mode === "resume")) {
      jobCallerKey = randomBytes(32).toString("hex");
    }
    // Session lifecycle and Turn submission are separate atomic operations.
    // Planning only starts or restores the exact native Session; delivery
    // submits the Turn input after that Session fact is durable.
    if (managedControl && (managedRun === null || managedRun.status !== "active")) {
      throw new Error(`Managed Turn is no longer active: ${input.turnId}.`);
    }
    const providerAuthority = managedControl
      ? this.#providerAuthorityForLaunch(
          owner.taskId,
          role.name,
          input.runtimeGenerationId,
          input.mode
        )
      : undefined;
    const providerOwnedTurn = managedControl && input.mode === "resume"
      ? this.#providerOwnedTurnForLaunch(owner.taskId, role.name, input.turnId!)
      : undefined;
    const providerNativeSessionId = binding.adapterId === "claude"
      ? preallocatedNativeSessionId
      : resumeNativeSessionId;
    const providerControl: AgentHostProviderControl | undefined = !managedControl
      ? undefined
      : input.mode === "resume"
        ? {
            schemaVersion: 1,
            adapterId: binding.adapterId,
            transport: managedCompiled!.transport,
            kind: "restore",
            mode: "resume",
            nativeSessionId: requireText(
              providerNativeSessionId,
              "Managed Provider restore native session id"
            ),
            ...(sessionTitle === undefined ? {} : { sessionTitle }),
            ...(managedCompiled!.codexThread === undefined
              ? {}
              : { codexThread: managedCompiled!.codexThread }),
            ...(providerOwnedTurn === undefined ? {} : { ownedTurn: providerOwnedTurn }),
            authority: providerAuthority!
          }
        : {
            schemaVersion: 1,
            adapterId: binding.adapterId,
            transport: managedCompiled!.transport,
            kind: "start",
            mode: "new",
            ...(providerNativeSessionId === undefined
              ? {}
              : { nativeSessionId: providerNativeSessionId }),
            ...(sessionTitle === undefined ? {} : { sessionTitle }),
            ...(managedCompiled!.codexThread === undefined
              ? {}
              : { codexThread: managedCompiled!.codexThread }),
            authority: providerAuthority!
          };
    const launch = {
      command,
      args,
      ...(providerControl === undefined ? {} : { providerControl }),
      env: {
        ...launchEnvironment,
        ...managedProviderEnvironment,
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
        ...(jobCallerKey === undefined ? {} : { YUI_JOB_CALLER_KEY: jobCallerKey }),
        ...(owner.scope !== "task"
          ? {}
          : {
              [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(this.#controlPlane)
            }),
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
        ...(input.runtimeGenerationId === undefined
          ? {}
          : { YUI_RUNTIME_GENERATION_ID: input.runtimeGenerationId }),
        // No Turn is exported into the Session environment. A native pane
        // outlives its Turn, so a Turn id frozen here would be stale for every
        // later Turn. The Agent Host sets it explicitly per spawned Provider
        // Turn, and every durable decision reads the active Turn from state.
        ...(session === null
          ? {}
          : { YUI_NATIVE_SESSION_ID: session.nativeSessionId })
      },
      childLifecycle: driver.capabilities.lifecycle.providerProcess
    };
    const scopedLaunch = owner.scope === "task"
      ? this.#applyWorkspaceScope(owner.taskId, role, launch, workspaceOverride)
      : launch;
    const sharedDaemonLaunch = owner.scope === "global" && configured.adapterId === "codex"
      ? {
          ...scopedLaunch,
          args: addCodexSharedDaemonRemote(
            scopedLaunch.args,
            launchMode,
            scopedLaunch.env
          )
        }
      : scopedLaunch;
    const ordinaryConversationLaunch = withCodexThreadEnvironment(sharedDaemonLaunch);
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
    taskId: string,
    roleName: string,
    runtimeGenerationId: string | undefined,
    mode: "new" | "resume"
  ): ProviderAuthorityFence {
    const activationId = requireText(runtimeGenerationId, "Managed Provider Activation id");
    const binding = this.store.getTaskRoleSessionSet(taskId, roleName)?.providerBinding;
    if (binding === null || binding === undefined) {
      return { epoch: 1, owner: "controller", holderId: activationId };
    }
    if (binding.authority.owner === "controller") {
      if (mode === "new") {
        const activation = currentProviderActivation(binding);
        if (activation === null || binding.authority.holderId !== activation.activationId) {
          throw new Error(`Provider Activation is not exact: ${taskId}/${roleName}.`);
        }
        // An actor-requested switch first ends the idle old Activation (+1)
        // and then binds the replacement Activation (+1).
        return {
          epoch: binding.authority.epoch + 2,
          owner: "controller",
          holderId: activationId
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
        holderId: activationId
      };
    }
    throw new Error(`Provider writer authority is unknown: ${taskId}/${roleName}.`);
  }

  #providerOwnedTurnForLaunch(
    taskId: string,
    roleName: string,
    turnId: string
  ): ProviderOwnedTurn | undefined {
    const binding = this.store.getTaskRoleSessionSet(taskId, roleName)?.providerBinding;
    if (binding === null || binding === undefined
      || binding.turn?.turnId !== turnId) return undefined;
    const turn = binding.turn;
    if (turn === null || turn.status !== "accepted") return undefined;
    if (turn.nativeTurnId === undefined) {
      throw new Error(`Active Provider Turn has no native identity: ${taskId}/${roleName}.`);
    }
    return { attemptId: turn.attemptId, turnId: turn.nativeTurnId };
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
          .find((item) => item.assignee === role.name && item.status === "running") === undefined
          ? this.store.getTaskWorkspace(taskId)
          : this.store.getWorkItemWorkspace(
            taskId,
            this.store.listWorkItems(taskId).find(
              (item) => item.assignee === role.name && item.status === "running"
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
  role: TaskRole
): EffectiveLaunchSnapshot {
  const item = store.listWorkItems(role.taskId).find((candidate) => (
    candidate.assignee === role.name
      && !["completed", "failed", "retired"].includes(candidate.status)
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

function ensureClaudeLifecyclePlugin(home: string, cliPath: string): string {
  const root = join(resolve(home), "runtime", "claude-lifecycle-plugin");
  writeTextFileAtomically(
    join(root, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "yui-runtime-lifecycle",
      description: "Yui-owned native lifecycle transport",
      version: "1.0.0"
    }, null, 2)}\n`
  );
  const command = {
    type: "command",
    command: canonicalPath(process.execPath),
    args: [canonicalPath(cliPath), "internal", "runtime-hook"]
  };
  writeTextFileAtomically(
    join(root, "hooks", "hooks.json"),
    `${JSON.stringify({
      hooks: {
        // All native names terminate at the Driver edge; core sees only
        // canonical RuntimeObservation values.
        SessionStart: [{ hooks: [command] }],
        UserPromptSubmit: [{ hooks: [command] }],
        PreToolUse: [{ hooks: [command] }],
        PermissionRequest: [{ hooks: [command] }],
        MessageDisplay: [{ hooks: [command] }],
        PostToolUse: [{ hooks: [command] }],
        PostToolUseFailure: [{ hooks: [command] }],
        SubagentStart: [{ hooks: [command] }],
        SubagentStop: [{ hooks: [command] }],
        Stop: [{ hooks: [command] }],
        StopFailure: [{ hooks: [command] }],
        SessionEnd: [{ hooks: [command] }]
      }
    }, null, 2)}\n`
  );
  return root;
}

function managedClaudeControlPlaneConfig(
  config: ClaudeAgentConfig,
  taskId: string,
  workItemId: string | undefined,
  turnId: string
): ClaudeAgentConfig {
  if (config.permission.strategy !== "configured") return config;
  const managed = [
    `Bash(yui task turn context ${taskId}/${turnId}:*)`,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

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
 * Codex invokes this argv after each completed turn and appends one JSON
 * payload. JSON arrays are valid TOML arrays for the managed config override.
 */
export function codexSessionNotifyConfig(cliPath: string): string {
  return `notify=${JSON.stringify([process.execPath, cliPath, "internal", "session-notify"])}`;
}

function addCodexSessionNotify(
  args: readonly string[],
  mode: "new" | "resume",
  cliPath: string
): string[] {
  const managed = ["--config", codexSessionNotifyConfig(cliPath)];
  if (mode === "new") return [...args, ...managed];
  if (args.length < 2 || args.at(-2) !== "resume") {
    throw new Error("Codex resume launch shape is invalid.");
  }
  return [...args.slice(0, -2), ...managed, ...args.slice(-2)];
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

/**
 * Codex 0.145 discovers lifecycle hooks from its effective config. Keep Yui's
 * two handlers invocation-local: this avoids mutating CODEX_HOME or the Task
 * workspace, while the exact launch environment supplies the durable Turn fence.
 */
function codexLifecycleHooksConfig(cliPath: string): string {
  const command = [
    shellQuote(canonicalPath(process.execPath)),
    shellQuote(canonicalPath(cliPath)),
    "internal",
    "runtime-hook"
  ].join(" ");
  const handler = `{hooks=[{type="command",command=${JSON.stringify(command)}}]}`;
  return `hooks={`
    + `SessionStart=[${handler}],`
    + `UserPromptSubmit=[${handler}],`
    + `PreToolUse=[${handler}],`
    + `PermissionRequest=[${handler}],`
    + `PostToolUse=[${handler}],`
    + `SubagentStart=[${handler}],`
    + `SubagentStop=[${handler}],`
    + `Stop=[${handler}]`
    + `}`;
}

function addCodexLifecycleHooks(
  args: readonly string[],
  mode: "new" | "resume",
  cliPath: string
): string[] {
  // Session flags are Yui-owned and exact to this launch. Hook trust bypass is
  // still explicit because these handlers execute a local command.
  const managed = [
    "--enable", "hooks",
    "--config", codexLifecycleHooksConfig(cliPath),
    "--dangerously-bypass-hook-trust"
  ];
  if (mode === "new") return [...args, ...managed];
  if (args.length < 2 || args.at(-2) !== "resume") {
    throw new Error("Codex resume launch shape is invalid.");
  }
  return [...args.slice(0, -2), ...managed, ...args.slice(-2)];
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
