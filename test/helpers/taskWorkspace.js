import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

/** Build the durable Task-owned workspace required by every managed Task Run. */
export function taskOwnedWorkspace(task, now, entries = []) {
  if (task.cwd === undefined) {
    throw new Error(`Task fixture is missing cwd: ${task.id}.`);
  }
  return createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: task.cwd,
    entries
  }, now);
}
