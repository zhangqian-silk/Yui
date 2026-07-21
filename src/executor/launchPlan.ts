export type DispatchMode = "new" | "resume";

export type AgentLaunchPlan = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

export type TaskmuxLaunchRole = Readonly<{
  name: string;
  workspace: string;
  activeAgentId?: string;
  agent?: string;
}>;

export type TaskmuxLaunchRun = Readonly<{
  id: string;
  taskId: string;
}>;

export function withTaskmuxRunEnvironment(
  launch: AgentLaunchPlan,
  taskmuxHome: string,
  role: TaskmuxLaunchRole,
  run: TaskmuxLaunchRun,
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
      TASKMUX_AGENT_ID: role.activeAgentId ?? role.agent ?? "",
      TASKMUX_RUN_ID: run.id,
      TASKMUX_WORKSPACE: role.workspace,
      ...(nativeSessionRoot === undefined ? {} : { TASKMUX_NATIVE_SESSION_ROOT: nativeSessionRoot }),
      ...(nativeSessionId === undefined ? {} : { TASKMUX_NATIVE_SESSION_ID: nativeSessionId })
    }
  };
}
