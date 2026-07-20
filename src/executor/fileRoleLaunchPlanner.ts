import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  configuredAgentToDefinition,
  resolveAgentEnvironment
} from "../agent/agent.js";
import { activeRoleAgentBinding, type GlobalRole, type TaskRole } from "../role/role.js";
import type {
  RoleSessionLaunchMode,
  SchedulerRoleSession
} from "../scheduler/ports.js";
import type { TaskStore } from "../storage/taskStore.js";
import { resolveAgentAdapter } from "./agentAdapter.js";
import type { PlannedRoleSession, RoleLaunchPlanner } from "./executorRegistry.js";

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
}>;

/** Builds managed native Agent launches from the authoritative Task records. */
export class FileRoleLaunchPlanner implements RoleLaunchPlanner {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #createNativeSessionId: () => string;
  readonly #cliPath: string;

  constructor(
    readonly home: string,
    readonly store: TaskStore,
    options: FileRoleLaunchPlannerOptions = {}
  ) {
    this.#environment = options.environment ?? process.env;
    this.#createNativeSessionId = options.createNativeSessionId ?? randomUUID;
    this.#cliPath = options.cliPath
      ?? fileURLToPath(new URL("../cli.js", import.meta.url));
  }

  plan(input: Parameters<RoleLaunchPlanner["plan"]>[0]): PlannedRoleSession {
    const task = this.store.getTask(input.taskId);
    if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
    if (task.status !== "active") throw new Error(`Task is not active: ${input.taskId}.`);
    if (task.repositoryId !== undefined && task.cwd === undefined) {
      throw new Error(`Task workspace is not ready: ${input.taskId}.`);
    }
    const role = this.store.getRole(input.taskId, input.roleName);
    if (role === null) throw new Error(`Role not found: ${input.taskId}/${input.roleName}.`);
    if (task.cwd !== undefined && role.workspace !== task.cwd) {
      throw new Error(`Role workspace is not synchronized with its Task: ${input.taskId}/${input.roleName}.`);
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
    const adapter = resolveAgentAdapter(binding.adapterId);
    const compileInput = {
      agent,
      config: binding.config,
      workspace: role.workspace,
      systemPrompt: role.systemPrompt
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
      const nativeSessionId = requireText(this.#createNativeSessionId(), "Native session id");
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
          ...resolveAgentEnvironment(agent, this.#environment),
          TASKMUX_HOME: resolve(this.home),
          TASKMUX_SESSION_SCOPE: owner.scope,
          ...(owner.scope === "task" ? { TASKMUX_TASK_ID: owner.taskId } : {}),
          TASKMUX_ROLE: role.name,
          TASKMUX_AGENT_ID: configured.id,
          TASKMUX_ADAPTER_ID: configured.adapterId,
          TASKMUX_WORKSPACE: role.workspace
        }
      },
      session
    };
  }
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
