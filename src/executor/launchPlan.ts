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

export type YuiLaunchTurn = Readonly<{
  id: string;
  taskId: string;
}>;

export function withYuiTurnEnvironment(
  launch: AgentLaunchPlan,
  yuiHome: string,
  role: YuiLaunchRole,
  turn: YuiLaunchTurn,
  nativeSessionId?: string,
  nativeSessionRoot?: string
): AgentLaunchPlan {
  return {
    ...launch,
    env: {
      ...launch.env,
      YUI_HOME: yuiHome,
      YUI_TASK_ID: turn.taskId,
      YUI_ROLE: role.name,
      YUI_AGENT_ID: role.activeAgentId ?? role.agent ?? "",
      YUI_TURN_ID: turn.id,
      YUI_WORKSPACE: role.workspace,
      ...(nativeSessionRoot === undefined ? {} : { YUI_NATIVE_SESSION_ROOT: nativeSessionRoot }),
      ...(nativeSessionId === undefined ? {} : { YUI_NATIVE_SESSION_ID: nativeSessionId })
    }
  };
}
