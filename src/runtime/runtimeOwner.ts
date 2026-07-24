import { requireSafeIdentity } from "./validation.js";

export type GlobalRuntimeOwner = Readonly<{
  scope: "global";
  roleName: string;
}>;

export type TaskRuntimeOwner = Readonly<{
  scope: "task";
  taskId: string;
  roleName: string;
}>;

export type RuntimeOwner = GlobalRuntimeOwner | TaskRuntimeOwner;

export function normalizeRuntimeOwner(owner: RuntimeOwner): RuntimeOwner {
  const roleName = requireSafeIdentity(owner.roleName, "Role name");
  if (owner.scope === "global") return { scope: "global", roleName };
  if (owner.scope === "task") {
    return {
      scope: "task",
      taskId: requireSafeIdentity(owner.taskId, "Task id"),
      roleName
    };
  }
  throw new Error("Runtime owner scope is invalid.");
}
