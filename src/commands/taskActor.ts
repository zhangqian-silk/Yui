import type { TaskCompletedBy } from "../task/task.js";
import { usageError } from "../errors/cliError.js";

export function taskActor(
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string
): TaskCompletedBy {
  const env = environment ?? {};
  if (
    env.YUI_SESSION_SCOPE === "task"
    && env.YUI_TASK_ID === taskId
    && env.YUI_ROLE === "leader"
  ) {
    return "leader";
  }
  if (env.YUI_SESSION_SCOPE === "task") {
    throw usageError(
      `A managed Task Session may perform this action only as the matching Leader: ${taskId}.`
    );
  }
  if (env.YUI_SESSION_SCOPE === "global") {
    if (env.YUI_ROLE === "operator") return "operator";
    throw usageError("A managed global Session may perform this action only as Operator.");
  }
  if (
    env.YUI_ROLE !== undefined
    || env.YUI_AGENT_ID !== undefined
    || env.YUI_RUN_ID !== undefined
    || env.YUI_NATIVE_SESSION_ID !== undefined
  ) {
    throw usageError("Managed Agent identity is incomplete; refusing to infer user authority.");
  }
  return "user";
}
