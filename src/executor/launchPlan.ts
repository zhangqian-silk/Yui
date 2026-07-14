import type { AgentRun } from "../run/agentRun.js";
import type { Role } from "../role/role.js";

export type DispatchMode = "new" | "resume";

export type AgentLaunchPlan = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function withTaskmuxRunEnvironment(
  launch: AgentLaunchPlan,
  taskmuxHome: string,
  role: Role,
  run: AgentRun,
  nativeSessionId?: string,
  nativeSessionRoot?: string
): AgentLaunchPlan {
  return {
    ...launch,
    env: {
      ...launch.env,
      TASKMUX_HOME: taskmuxHome,
      TASKMUX_TASK_ID: run.taskId,
      TASKMUX_ROLE: role.name,
      TASKMUX_AGENT_ID: role.activeAgentId,
      TASKMUX_ADAPTER_ID: role.agentBindings[role.activeAgentId]?.adapterId ?? "",
      TASKMUX_RUN_ID: run.id,
      TASKMUX_WORKSPACE: role.workspace,
      ...(nativeSessionRoot === undefined ? {} : { TASKMUX_NATIVE_SESSION_ROOT: nativeSessionRoot }),
      ...(nativeSessionId === undefined ? {} : { TASKMUX_NATIVE_SESSION_ID: nativeSessionId })
    }
  };
}
