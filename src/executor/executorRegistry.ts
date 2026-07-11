import { randomUUID } from "node:crypto";
import type { Role } from "../role/role.js";
import {
  recordAgentSession,
  type AgentSession,
  type ExecutorCapabilities
} from "./agentExecutor.js";
import type { AgentLaunchPlan, DispatchMode } from "./launchPlan.js";

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

export interface AgentExecutor {
  readonly id: string;
  readonly capabilities: ExecutorCapabilities;
  prepare(input: PrepareExecutionInput): PreparedExecution;
}

class CodexExecutor implements AgentExecutor {
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
}

class ClaudeExecutor implements AgentExecutor {
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

    const nativeSessionId = randomUUID();
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
