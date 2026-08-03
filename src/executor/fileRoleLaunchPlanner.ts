import { createHash, randomUUID } from "node:crypto";
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
import { compileRoleSessionContext } from "../context/roleSessionContext.js";
import { resolveAgentAdapter } from "./agentAdapter.js";
import type { ClaudeAgentConfig } from "./agentAdapter.js";
import { inspectCodexLaunchConfig } from "./codexConfigConflict.js";
import type { PlannedRoleSession, RoleLaunchPlanner } from "./executorRegistry.js";
import type {
  AgentEnvironmentRefresh,
  AgentEnvironmentRefreshPort
} from "../runtime/ports.js";
import { taskRoleSessionTitle } from "../runtime/sessionTitle.js";
import type { RoleWorkspace } from "../worktree/roleWorkspace.js";
import { activeLiveRoleAgentSession } from "./agentExecutor.js";
import {
  effectiveLaunchSnapshotsCompatible,
  effectiveRoleForLaunch,
  resolveEffectiveLaunch,
  type EffectiveLaunchSnapshot
} from "./effectiveLaunch.js";

export type FileRoleLaunchPlannerOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  createNativeSessionId?: () => string;
  cliPath?: string;
}>;

export type GlobalRoleLaunchPlanInput = Readonly<{
  roleName: string;
  agentId: string;
  adapterId: string;
  effective?: EffectiveLaunchSnapshot;
  mode: RoleSessionLaunchMode;
  nativeSessionId?: string;
  launchId?: string;
  environment?: Readonly<Record<string, string>>;
}>;

type TaskRoleLaunchPlanInput = Parameters<RoleLaunchPlanner["plan"]>[0] & Readonly<{
  launchId?: string;
  environment?: Readonly<Record<string, string>>;
}>;

/** Builds managed native Agent launches from the authoritative Task records. */
export class FileRoleLaunchPlanner implements RoleLaunchPlanner, AgentEnvironmentRefreshPort {
  readonly #operationalEnvironment: NodeJS.ProcessEnv;
  #agentEnvironment: NodeJS.ProcessEnv;
  #nativeAgentEnvironment: NodeJS.ProcessEnv;
  readonly #createNativeSessionId: () => string;
  readonly #cliPath: string;
  readonly #managedBinPath: string;

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
    this.#cliPath = canonicalPath(options.cliPath
      ?? fileURLToPath(new URL("../cli.js", import.meta.url)));
    this.#managedBinPath = ensureManagedYuiLauncher(this.home, this.#cliPath);
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

  plan(input: TaskRoleLaunchPlanInput): PlannedRoleSession {
    const task = this.store.getTask(input.taskId);
    if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
    if (task.status !== "active") throw new Error(`Task is not active: ${input.taskId}.`);
    const role = this.store.getRole(input.taskId, input.roleName);
    if (role === null) throw new Error(`Role not found: ${input.taskId}/${input.roleName}.`);
      const activeRun = this.store.getActiveAgentRun(task.id, role.name);
    if (input.runId !== undefined && activeRun?.id !== input.runId) {
      throw new Error(`Role Run is no longer current: ${input.runId}.`);
    }
    const runWorkspace = activeRun?.workspace;
    if (task.projectBindings.length > 0) {
      const workspace = this.store.getRoleWorkspace(task.id, role.name);
      const main = this.store.getRoleWorkspace(task.id, "leader");
      const sharedMain = (workspace === null || workspace.owner.type === "task")
        && main?.owner.type === "task"
        && sameWorkspaceProjects(main, task.projectBindings.map(({ projectId }) => projectId))
        && role.workspace === main.root;
      const isolatedWorkItem = workspace?.owner.type === "work-item"
        ? this.store.getWorkItem(task.id, workspace.owner.workItemId)
        : null;
      const isolated = workspace !== null
        && workspace.owner.type === "work-item"
        && isolatedWorkItem !== null
        && isolatedWorkItem.assignee === role.name
        && !["completed", "failed", "retired"].includes(isolatedWorkItem.status)
        && (activeRun === null
          || activeRun.workItemId === workspace.owner.workItemId)
        && sameWorkspaceProjects(workspace, task.projectBindings.map(({ projectId }) => projectId))
        && sameWritableProjects(workspace, isolatedWorkItem.writeProjectIds)
        && workspace.root === role.workspace;
      const runScoped = runWorkspace !== undefined
        && runWorkspace.taskId === task.id
        && sameWorkspaceProjects(
          runWorkspace,
          task.projectBindings.map(({ projectId }) => projectId)
        )
        && (runWorkspace.owner.type === "task"
          || (runWorkspace.owner.type === "work-item"
            && runWorkspace.owner.workItemId === activeRun?.workItemId)
          || (runWorkspace.owner.type === "review-round"
            && runWorkspace.owner.reviewRoundId === activeRun?.reviewRoundId));
      if (task.cwd === undefined || main === null || (!runScoped && !sharedMain && !isolated)) {
        throw new Error(`Role workspace is not ready: ${input.taskId}/${input.roleName}.`);
      }
    }
    const sessionSet = this.store.getTaskRoleSessionSet(task.id, role.name);
    const resolvedEffective = activeRun?.effective
      ?? activeLiveRoleAgentSession(sessionSet)?.effective
      ?? resolveTaskRoleEffectiveLaunch(this.store, role);
    if (input.effective !== undefined
      && !isDeepStrictEqual(resolvedEffective, input.effective)) {
      throw new Error(`Role launch effective Run snapshot changed: ${input.taskId}/${input.roleName}.`);
    }
    if (activeRun !== null && input.effective === undefined) {
      throw new Error(`Role launch is missing the effective Run snapshot: ${input.taskId}/${input.roleName}.`);
    }
    const effective = input.effective ?? resolvedEffective;
    const existing = sessionSet?.sessions[effective.agentId];
    const compatibleExisting = existing !== undefined
      && effectiveLaunchSnapshotsCompatible(existing.effective, effective);
    if (input.mode === "resume" && !compatibleExisting) {
      throw new Error(
        `Task Role resume effective snapshot drifted: ${task.id}/${role.name}.`
      );
    }
    return this.#compile(
      role,
      input,
      { scope: "task", taskId: task.id },
      taskRoleSessionTitle(task, role.name),
      compatibleExisting ? existing.nativeSessionId : undefined,
      runWorkspace,
      effective
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
      compatibleExisting ? existing.nativeSessionId : undefined,
      undefined,
      effective
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
      launchId?: string;
      runId?: string;
      environment?: Readonly<Record<string, string>>;
    }>,
    owner: Readonly<{ scope: "task"; taskId: string } | { scope: "global" }>,
    sessionTitle: string | undefined,
    knownNativeSessionId: string | undefined,
    workspaceOverride: RoleWorkspace | undefined,
    effective: EffectiveLaunchSnapshot
  ): PlannedRoleSession {
    const launchRole = effectiveRoleForLaunch(role, effective);
    const binding = activeRoleAgentBinding(launchRole);
    if (binding.agentId !== input.agentId || binding.adapterId !== input.adapterId) {
      throw new Error(`Role launch identity changed: ${role.name}.`);
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
    const launchEnvironment = {
      ...inheritedLaunchEnvironment,
      PATH: [
        this.#managedBinPath,
        inheritedLaunchEnvironment.PATH
      ].filter((value): value is string => value !== undefined && value.length > 0)
        .join(delimiter)
    };
    const adapter = resolveAgentAdapter(binding.adapterId);
    const effectiveWorkspace = effective.workspace.root;
    const sessionContext = compileRoleSessionContext(this.home, launchRole, owner);
    const codexConfig = binding.config.adapterId === "codex"
      ? inspectCodexLaunchConfig({
          environment: {
            ...operationalSourceEnvironment,
            ...agentSourceEnvironment,
            ...launchEnvironment
          },
          workspace: effectiveWorkspace,
          profile: binding.config.profile
        })
      : undefined;
    if (codexConfig?.notify.status === "configured") {
      throw new Error(
        "Codex notify is already configured by "
        + `${codexConfig.notify.source}; Yui requires exclusive ownership of the structured `
        + "notify callback and refuses to replace or be replaced by native configuration."
      );
    }
    const managedRun = owner.scope === "task" && input.runId !== undefined
      ? this.store.getAgentRun(owner.taskId, input.runId)
      : null;
    const effectiveConfig = binding.config.adapterId === "claude"
      && owner.scope === "task"
      && input.runId !== undefined
      ? managedClaudeControlPlaneConfig(
          binding.config,
          owner.taskId,
          managedRun?.workItemId,
          input.runId
        )
      : binding.config;
    const compileInput = {
      agent,
      config: effectiveConfig,
      workspace: effectiveWorkspace,
      ...(sessionTitle === undefined ? {} : { sessionTitle }),
      ...sessionContext,
      ...(codexConfig === undefined
        ? {}
        : { codexDeveloperInstructions: codexConfig.developerInstructions })
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
    const compiled = launchMode === "resume"
      ? adapter.compileResume({
          ...compileInput,
          nativeSessionId: resumeNativeSessionId!
        })
      : adapter.compileNew(compileInput);

    let args = [...compiled.argv];
    let session: SchedulerRoleSession | null;
    if (binding.adapterId === "codex") {
      args = addCodexSessionNotify(args, launchMode, this.#cliPath);
      session = launchMode === "resume"
        ? readySession(input.agentId, binding.adapterId, resumeNativeSessionId!, effective)
        : null;
    } else if (launchMode === "new") {
      if (owner.scope === "task" && input.runId !== undefined) {
        args.push(
          "--plugin-dir",
          ensureManagedClaudeLifecyclePlugin(this.home, this.#cliPath)
        );
      }
      const nativeSessionId = requireText(
        input.launchId === undefined
          ? this.#createNativeSessionId()
          : nativeSessionIdForLaunch(
              this.home,
              input.launchId,
              input.agentId,
              input.adapterId
            ),
        "Native session id"
      );
      args.push("--session-id", nativeSessionId);
      session = readySession(input.agentId, binding.adapterId, nativeSessionId, effective);
    } else {
      if (owner.scope === "task" && input.runId !== undefined) {
        args.push(
          "--plugin-dir",
          ensureManagedClaudeLifecyclePlugin(this.home, this.#cliPath)
        );
      }
      session = readySession(input.agentId, binding.adapterId, resumeNativeSessionId!, effective);
    }

    const launch = {
      command: configured.command,
      args,
      env: {
        ...launchEnvironment,
        YUI_HOME: resolve(this.home),
        YUI_SESSION_SCOPE: owner.scope,
        ...(owner.scope === "task" ? { YUI_TASK_ID: owner.taskId } : {}),
        YUI_ROLE: role.name,
        YUI_AGENT_ID: configured.id,
        YUI_ADAPTER_ID: configured.adapterId,
        YUI_WORKSPACE: effectiveWorkspace,
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
        ...(input.launchId === undefined
          ? {}
          : { YUI_LAUNCH_ID: input.launchId }),
        ...(input.runId === undefined ? {} : { YUI_RUN_ID: input.runId }),
        ...(configured.adapterId !== "claude" || session === null
          ? {}
          : { YUI_NATIVE_SESSION_ID: session.nativeSessionId })
      }
    };
    const scopedLaunch = owner.scope === "task"
      ? this.#applyWorkspaceScope(owner.taskId, role, launch, workspaceOverride)
      : launch;
    return {
      role: {
        name: role.name,
        workspace: effectiveWorkspace,
        ...(owner.scope === "task" ? { status: (role as TaskRole).status } : {})
      },
      launch: scopedLaunch,
      session
    };
  }

  #applyWorkspaceScope(
    taskId: string,
    role: TaskRole | GlobalRole,
    launch: Readonly<{
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
    }>,
    workspaceOverride?: RoleWorkspace
  ): typeof launch {
    const workspace = workspaceOverride ?? this.store.getRoleWorkspace(taskId, role.name);
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

function resolveTaskRoleEffectiveLaunch(
  store: TaskStore,
  role: TaskRole
): EffectiveLaunchSnapshot {
  const workspace = store.getRoleWorkspace(role.taskId, role.name)
    ?? store.getRoleWorkspace(role.taskId, "leader")
    ?? undefined;
  const item = workspace?.owner.type === "work-item"
    ? store.getWorkItem(role.taskId, workspace.owner.workItemId)
    : null;
  return resolveEffectiveLaunch({
    role,
    purpose: "execution",
    ...(workspace === undefined ? {} : { workspace }),
    ...(item === null ? {} : { workItemWriteProjectIds: item.writeProjectIds })
  });
}

function workspaceScopeEnvironment(
  environment: Readonly<Record<string, string>>,
  workspace: RoleWorkspace
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

function ensureManagedYuiLauncher(home: string, cliPath: string): string {
  const binPath = join(resolve(home), "runtime", "bin");
  const launcherPath = join(binPath, "yui");
  writeTextFileAtomically(
    launcherPath,
    [
      "#!/bin/sh",
      `exec ${shellQuote(canonicalPath(process.execPath))} ${shellQuote(cliPath)} "$@"`,
      ""
    ].join("\n")
  );
  chmodSync(launcherPath, 0o700);
  return binPath;
}

function ensureManagedClaudeLifecyclePlugin(home: string, cliPath: string): string {
  const root = join(resolve(home), "runtime", "claude-lifecycle-plugin");
  writeTextFileAtomically(
    join(root, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "yui-runtime-lifecycle",
      description: "Yui-owned exact Run lifecycle transport",
      version: "1.0.0"
    }, null, 2)}\n`
  );
  const command = {
    type: "command",
    command: canonicalPath(process.execPath),
    args: [canonicalPath(cliPath), "internal", "claude-hook"]
  };
  writeTextFileAtomically(
    join(root, "hooks", "hooks.json"),
    `${JSON.stringify({
      hooks: {
        StopFailure: [{ hooks: [command] }]
      }
    }, null, 2)}\n`
  );
  return root;
}

function managedClaudeControlPlaneConfig(
  config: ClaudeAgentConfig,
  taskId: string,
  workItemId: string | undefined,
  runId: string
): ClaudeAgentConfig {
  if (config.permission.strategy !== "configured") return config;
  const managed = [
    `Bash(yui --json task context ${taskId})`,
    `Bash(yui --json task work list ${taskId})`,
    ...(workItemId === undefined
      ? []
      : [`Bash(yui --json task work show ${workItemId})`]),
    `Bash(yui task run yield ${runId} --summary-file -:*)`
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
  return /^Bash\(yui(?:\s|:\*|\*|\))/u.test(rule.trim());
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

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

function nativeSessionIdForLaunch(
  home: string,
  launchId: string,
  agentId: string,
  adapterId: string
): string {
  const hex = createHash("sha256").update(JSON.stringify([
    resolve(home),
    requireText(launchId, "Launch id"),
    requireText(agentId, "Agent id"),
    requireText(adapterId, "Agent adapter id")
  ])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
    status: "ready",
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
  workspace: RoleWorkspace,
  projectIds: readonly string[]
): boolean {
  const actual = workspace.entries.map(({ projectId }) => projectId).sort();
  const expected = [...projectIds].sort();
  return actual.length === expected.length
    && actual.every((projectId, index) => projectId === expected[index]);
}

function sameWritableProjects(
  workspace: RoleWorkspace,
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
