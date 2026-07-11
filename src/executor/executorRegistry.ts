import { randomUUID } from "node:crypto";
import type { Role } from "../role/role.js";
import type { RoleStatus } from "../role/role.js";
import type { AgentRun } from "../run/agentRun.js";
import {
  recordAgentSession,
  type AgentSession,
  type AgentSessionStatus,
  type ExecutorCapabilities
} from "./agentExecutor.js";
import { withTaskmuxRunEnvironment, type AgentLaunchPlan, type DispatchMode } from "./launchPlan.js";

export type PrepareExecutionInput = {
  taskId: string;
  role: Role;
  mode: DispatchMode;
  session: AgentSession | null;
  now: Date;
};

export type PreparedExecution = {
  launch: AgentLaunchPlan;
  session: AgentSession | null;
};

export type AgentRuntime = {
  dispatchRole(
    taskId: string,
    role: Role,
    launch: AgentLaunchPlan,
    input: string,
    options?: { replaceExisting?: boolean }
  ): void;
  sendRoleInput(taskId: string, roleName: string, input: string): void;
  stopRole(taskId: string, roleName: string): void;
  killRole(taskId: string, roleName: string): void;
  detectRoleStatus(taskId: string, roleName: string, fallback: RoleStatus): RoleStatus;
};

export type ExecutorDispatchInput = {
  runtime: AgentRuntime;
  taskmuxHome: string;
  taskId: string;
  role: Role;
  run: AgentRun;
  session: AgentSession | null;
  input: string;
  now: Date;
};

export type ExecutorControlInput = {
  runtime: AgentRuntime;
  taskId: string;
  role: Role;
};

export interface AgentExecutor {
  readonly id: string;
  readonly capabilities: ExecutorCapabilities;
  prepare(input: PrepareExecutionInput): PreparedExecution;
  start(input: ExecutorDispatchInput): PreparedExecution;
  recover(input: ExecutorDispatchInput): PreparedExecution;
  send(input: ExecutorControlInput & { input: string }): void;
  interrupt(input: ExecutorControlInput): void;
  stop(input: ExecutorControlInput): void;
  status(input: ExecutorControlInput): AgentSessionStatus;
  discoverNativeSessionId(session: AgentSession | null, env: NodeJS.ProcessEnv): string | null;
  attachMetadata(launch: AgentLaunchPlan, input: Omit<ExecutorDispatchInput, "runtime" | "input" | "now">): AgentLaunchPlan;
}

abstract class BaseAgentExecutor implements AgentExecutor {
  abstract readonly id: string;
  abstract readonly capabilities: ExecutorCapabilities;
  abstract prepare(input: PrepareExecutionInput): PreparedExecution;

  start(input: ExecutorDispatchInput): PreparedExecution {
    return this.dispatch(input, "new", true);
  }

  recover(input: ExecutorDispatchInput): PreparedExecution {
    return this.dispatch(input, "resume", false);
  }

  send({ runtime, taskId, role, input }: ExecutorControlInput & { input: string }): void {
    runtime.sendRoleInput(taskId, role.name, input);
  }

  interrupt({ runtime, taskId, role }: ExecutorControlInput): void {
    runtime.stopRole(taskId, role.name);
  }

  stop({ runtime, taskId, role }: ExecutorControlInput): void {
    runtime.killRole(taskId, role.name);
  }

  status({ runtime, taskId, role }: ExecutorControlInput): AgentSessionStatus {
    const status = runtime.detectRoleStatus(taskId, role.name, role.status);
    if (status === "running") {
      return "running";
    }
    if (status === "exited") {
      return "stopped";
    }
    if (status === "failed") {
      return "broken";
    }
    return "ready";
  }

  discoverNativeSessionId(session: AgentSession | null, _env: NodeJS.ProcessEnv): string | null {
    return session?.nativeSessionId ?? null;
  }

  attachMetadata(
    launch: AgentLaunchPlan,
    { taskmuxHome, role, run, session }: Omit<ExecutorDispatchInput, "runtime" | "input" | "now">
  ): AgentLaunchPlan {
    return withTaskmuxRunEnvironment(launch, taskmuxHome, role, run, session?.nativeSessionId);
  }

  private dispatch(input: ExecutorDispatchInput, mode: DispatchMode, replaceExisting: boolean): PreparedExecution {
    const prepared = this.prepare({
      taskId: input.taskId,
      role: input.role,
      mode,
      session: input.session,
      now: input.now
    });
    const launch = this.attachMetadata(prepared.launch, {
      taskmuxHome: input.taskmuxHome,
      taskId: input.taskId,
      role: input.role,
      run: input.run,
      session: prepared.session
    });
    input.runtime.dispatchRole(input.taskId, input.role, launch, input.input, { replaceExisting });
    return prepared;
  }
}

class CodexExecutor extends BaseAgentExecutor {
  readonly id = "codex";
  readonly capabilities = { recover: true, interrupt: true, nativeSessionDiscovery: true };

  prepare({ role, mode, session }: PrepareExecutionInput): PreparedExecution {
    assertMatchingRole(role, this.id);
    if (mode === "new") {
      return { launch: baseLaunch(role), session: null };
    }
    const existing = requireSession(role, session);
    return {
      launch: { ...baseLaunch(role), args: [...role.args, "resume", existing.nativeSessionId] },
      session: existing
    };
  }

  override discoverNativeSessionId(session: AgentSession | null, env: NodeJS.ProcessEnv): string | null {
    return session?.nativeSessionId ?? env.CODEX_THREAD_ID?.trim() ?? null;
  }
}

class ClaudeExecutor extends BaseAgentExecutor {
  readonly id = "claude";
  readonly capabilities = { recover: true, interrupt: true, nativeSessionDiscovery: false };

  prepare({ taskId, role, mode, session, now }: PrepareExecutionInput): PreparedExecution {
    assertMatchingRole(role, this.id);
    if (mode === "resume") {
      const existing = requireSession(role, session);
      return {
        launch: { ...baseLaunch(role), args: [...role.args, "--resume", existing.nativeSessionId] },
        session: existing
      };
    }

    const nativeSessionId = session?.status === "reserved" ? session.nativeSessionId : randomUUID();
    const created = recordAgentSession(
      taskId,
      role.name,
      role.agent,
      nativeSessionId,
      now,
      session,
      session === null ? undefined : "Leader selected a new native session."
    );
    return {
      launch: { ...baseLaunch(role), args: [...role.args, "--session-id", nativeSessionId] },
      session: created
    };
  }
}

const adapters = new Map<string, AgentExecutor>([
  ["codex", new CodexExecutor()],
  ["claude", new ClaudeExecutor()]
]);

export function resolveAgentExecutor(agent: string): AgentExecutor {
  const adapter = adapters.get(agent);
  if (adapter === undefined) {
    throw new Error(`Agent does not define an execution adapter: ${agent}.`);
  }
  return adapter;
}

export function reserveInitialAgentSession(
  taskId: string,
  role: Role,
  now: Date
): AgentSession | null {
  if (role.agent !== "claude") {
    return null;
  }
  return {
    ...recordAgentSession(taskId, role.name, role.agent, randomUUID(), now, null),
    status: "reserved"
  };
}

function baseLaunch(role: Role): AgentLaunchPlan {
  return { command: role.command, args: role.args, env: role.env };
}

function assertMatchingRole(role: Role, agent: string): void {
  if (role.agent !== agent) {
    throw new Error(`Execution adapter ${agent} cannot launch role agent ${role.agent}.`);
  }
}

function requireSession(role: Role, session: AgentSession | null): AgentSession {
  if (session === null) {
    throw new Error(`No native session is recorded for ${role.name}.`);
  }
  if (session.agent !== role.agent) {
    throw new Error(`Recorded session agent does not match role agent: ${role.name}.`);
  }
  return session;
}
