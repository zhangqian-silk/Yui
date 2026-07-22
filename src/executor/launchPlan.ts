export type DispatchMode = "new" | "resume";

export type AgentLaunchPlan = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

export type YuiLaunchRole = Readonly<{
  name: string;
  workspace: string;
  activeAgentId?: string;
  agent?: string;
}>;

export type YuiLaunchRun = Readonly<{
  id: string;
  taskId: string;
}>;

export function withYuiRunEnvironment(
  launch: AgentLaunchPlan,
  yuiHome: string,
  role: YuiLaunchRole,
  run: YuiLaunchRun,
  nativeSessionId?: string,
  nativeSessionRoot?: string
): AgentLaunchPlan {
  return {
    ...launch,
    env: {
      ...launch.env,
      YUI_HOME: yuiHome,
      YUI_TASK_ID: run.taskId,
      YUI_ROLE: role.name,
      YUI_AGENT_ID: role.activeAgentId ?? role.agent ?? "",
      YUI_RUN_ID: run.id,
      YUI_WORKSPACE: role.workspace,
      ...(nativeSessionRoot === undefined ? {} : { YUI_NATIVE_SESSION_ROOT: nativeSessionRoot }),
      ...(nativeSessionId === undefined ? {} : { YUI_NATIVE_SESSION_ID: nativeSessionId })
    }
  };
}
