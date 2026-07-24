import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  configuredAgentToDefinition,
  resolveAgentEnvironment
} from "../agent/agent.js";
import { operationalAgentEnvironment } from "../agent/launchEnvironment.js";
import { activeRoleAgentBinding, type GlobalRole, type TaskRole } from "../role/role.js";
import type {
  RoleSessionLaunchMode,
  SchedulerRoleSession
} from "../scheduler/ports.js";
import type { TaskStore } from "../storage/taskStore.js";
import { compileRoleSessionContext } from "../context/roleSessionContext.js";
import { resolveAgentAdapter } from "./agentAdapter.js";
import { inspectCodexLaunchConfig } from "./codexConfigConflict.js";
import type { PlannedRoleSession, RoleLaunchPlanner } from "./executorRegistry.js";
import type { AgentEnvironmentRefreshPort } from "../runtime/ports.js";

export type FileRoleLaunchPlannerOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  createNativeSessionId?: () => string;
  cliPath?: string;
}>;

export type GlobalRoleLaunchPlanInput = Readonly<{
  roleName: string;
  agentId: string;
  adapterId: string;
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
  readonly #createNativeSessionId: () => string;
  readonly #cliPath: string;

  constructor(
    readonly home: string,
    readonly store: TaskStore,
    options: FileRoleLaunchPlannerOptions = {}
  ) {
    // Operational launch context is stable for the Controller lifetime. Agent
    // binding sources are a separate replaceable snapshot so an unset/removed
    // secret cannot survive a later configuration refresh.
    this.#operationalEnvironment = { ...(options.environment ?? process.env) };
    this.#agentEnvironment = this.#selectConfiguredAgentEnvironment(
      this.#operationalEnvironment
    );
    this.#createNativeSessionId = options.createNativeSessionId ?? randomUUID;
    this.#cliPath = options.cliPath
      ?? fileURLToPath(new URL("../cli.js", import.meta.url));
  }

  replaceAgentEnvironment(values: Readonly<Record<string, string>>): void {
    this.#agentEnvironment = this.#selectConfiguredAgentEnvironment(values);
  }

  plan(input: TaskRoleLaunchPlanInput): PlannedRoleSession {
    const task = this.store.getTask(input.taskId);
    if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
    if (task.status !== "active") throw new Error(`Task is not active: ${input.taskId}.`);
    const role = this.store.getRole(input.taskId, input.roleName);
    if (role === null) throw new Error(`Role not found: ${input.taskId}/${input.roleName}.`);
    if (task.repositoryId !== undefined) {
      const workspace = this.store.getRoleWorkspace(task.id, role.name);
      if (
        task.cwd === undefined
        || workspace === null
        || workspace.repositoryId !== task.repositoryId
        || workspace.path !== role.workspace
      ) {
        throw new Error(`Role workspace is not ready: ${input.taskId}/${input.roleName}.`);
      }
    }
    return this.#compile(
      role,
      input,
      { scope: "task", taskId: task.id },
      this.store.getRoleSession(task.id, role.name)?.nativeSessionId
    );
  }

  planGlobalRole(input: GlobalRoleLaunchPlanInput): PlannedRoleSession {
    const role = this.store.getGlobalRole(input.roleName);
    if (role === null) throw new Error(`Global Role not found: ${input.roleName}.`);
    return this.#compile(
      role,
      input,
      { scope: "global" },
      this.store.getGlobalRoleSessionSet(role.name)?.sessions[role.activeAgentId]?.nativeSessionId
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
      environment?: Readonly<Record<string, string>>;
    }>,
    owner: Readonly<{ scope: "task"; taskId: string } | { scope: "global" }>,
    knownNativeSessionId?: string
  ): PlannedRoleSession {
    const binding = activeRoleAgentBinding(role);
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
    const operationalSourceEnvironment = input.environment ?? this.#operationalEnvironment;
    const resolvedAgentEnvironment = resolveAgentEnvironment(agent, agentSourceEnvironment);
    const launchEnvironment = {
      ...operationalAgentEnvironment(configured.adapterId, operationalSourceEnvironment),
      ...resolvedAgentEnvironment
    };
    const adapter = resolveAgentAdapter(binding.adapterId);
    const sessionContext = compileRoleSessionContext(this.home, role, owner);
    const codexConfig = binding.config.adapterId === "codex"
      ? inspectCodexLaunchConfig({
          environment: {
            ...operationalSourceEnvironment,
            ...agentSourceEnvironment,
            ...launchEnvironment
          },
          workspace: role.workspace,
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
    const compileInput = {
      agent,
      config: binding.config,
      workspace: role.workspace,
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
        ? readySession(input.agentId, binding.adapterId, resumeNativeSessionId!)
        : null;
    } else if (launchMode === "new") {
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
      session = readySession(input.agentId, binding.adapterId, nativeSessionId);
    } else {
      session = readySession(input.agentId, binding.adapterId, resumeNativeSessionId!);
    }

    return {
      role: {
        name: role.name,
        workspace: role.workspace,
        ...(owner.scope === "task" ? { status: (role as TaskRole).status } : {})
      },
      launch: {
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
          YUI_WORKSPACE: role.workspace,
          ...(input.launchId === undefined
            ? {}
            : { YUI_LAUNCH_ID: input.launchId })
        }
      },
      session
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
  nativeSessionId: string
): SchedulerRoleSession {
  return {
    agentId,
    adapterId,
    nativeSessionId: requireText(nativeSessionId, "Native session id"),
    status: "ready"
  };
}

function requireText(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}
