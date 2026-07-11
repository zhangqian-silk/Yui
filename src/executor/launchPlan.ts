import type { AgentSession } from "./agentExecutor.js";
import type { Role } from "../role/role.js";

export type DispatchMode = "new" | "resume";

export type AgentLaunchPlan = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function buildAgentLaunchPlan(
  role: Role,
  mode: DispatchMode,
  session: AgentSession | null
): AgentLaunchPlan {
  if (mode === "new") {
    return { command: role.command, args: role.args, env: role.env };
  }

  if (session === null) {
    throw new Error(`No native session is recorded for ${role.name}.`);
  }

  if (session.agent !== role.agent) {
    throw new Error(`Recorded session agent does not match role agent: ${role.name}.`);
  }

  if (role.agent === "codex") {
    return {
      command: role.command,
      args: [...role.args, "resume", session.nativeSessionId],
      env: role.env
    };
  }

  if (role.agent === "claude") {
    return {
      command: role.command,
      args: [...role.args, "--resume", session.nativeSessionId],
      env: role.env
    };
  }

  throw new Error(`Agent does not define a recovery adapter: ${role.agent}.`);
}
