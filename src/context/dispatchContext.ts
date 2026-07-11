import type { Role } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";

export function compileDispatchInput(
  store: TaskStore,
  taskId: string,
  role: Role,
  input: string
): string {
  const profileLines = [
    role.description === undefined ? null : `Description: ${role.description}`,
    ...(role.responsibilities ?? []).map((item) => `Responsibility: ${item}`),
    ...(role.constraints ?? []).map((item) => `Constraint: ${item}`),
    role.expectedOutput === undefined ? null : `Expected output: ${role.expectedOutput}`,
    role.systemPrompt === undefined ? null : `Role instruction: ${role.systemPrompt}`
  ].filter((line): line is string => line !== null);
  const childSections = store.listChildRoles(taskId)
    .filter((child) => child.parentRole === role.name)
    .map((child) => [
      `Child role constraint: ${child.name}`,
      `Description: ${child.description}`,
      ...child.responsibilities.map((item) => `Responsibility: ${item}`),
      ...child.constraints.map((item) => `Constraint: ${item}`),
      `Expected output: ${child.expectedOutput}`
    ].join("\n"));

  if (profileLines.length === 0 && childSections.length === 0) {
    return input;
  }

  return [
    ...profileLines,
    ...childSections,
    "TaskMux dispatch:",
    input
  ].join("\n\n");
}
