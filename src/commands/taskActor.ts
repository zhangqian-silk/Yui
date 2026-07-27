import type { TaskCompletedBy } from "../task/task.js";

export function taskActor(
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string
): TaskCompletedBy {
  if (
    environment?.YUI_SESSION_SCOPE === "task"
    && environment.YUI_TASK_ID === taskId
    && environment.YUI_ROLE === "leader"
  ) {
    return "leader";
  }
  return environment?.YUI_SESSION_SCOPE === "global"
    && environment.YUI_ROLE === "operator" ? "operator" : "user";
}
