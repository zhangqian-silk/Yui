import type { Role } from "../role/role.js";

export type DispatchContextStore = Readonly<Record<string, never>>;

export type BuildRoleContextInput = Readonly<{
  taskId: string;
  role: Role;
  input: string;
}>;

/** Compatibility entry point used by the restored Task workflow. */
export function compileDispatchInput(
  _store: DispatchContextStore,
  taskId: string,
  role: Role,
  input: string
): string {
  return buildRoleContext({ taskId, role, input });
}

export function buildRoleContext(context: BuildRoleContextInput): string {
  return context.role.name === "leader"
    ? buildLeaderContext(context)
    : buildWorkerContext(context);
}

export function buildLeaderContext(context: BuildRoleContextInput): string {
  return renderDispatchContext("leader", context);
}

export function buildWorkerContext(context: BuildRoleContextInput): string {
  return renderDispatchContext("worker", context);
}

function renderDispatchContext(
  kind: "leader" | "worker",
  context: BuildRoleContextInput
): string {
  const profile = context.role;
  const profileLines = [
    `Task: ${context.taskId}`,
    `Role: ${profile.name}`,
    `Active Agent: ${profile.activeAgentId}`,
    profile.description === undefined ? null : `Description: ${profile.description}`,
    ...(profile.responsibilities ?? []).map((item) => `Responsibility: ${item}`),
    ...(profile.constraints ?? []).map((item) => `Constraint: ${item}`),
    profile.expectedOutput === undefined ? null : `Expected output: ${profile.expectedOutput}`
  ].filter((line): line is string => line !== null);
  return [
    `Follow the injected yui-${kind} Skill for this Yui dispatch.`,
    profileLines.join("\n"),
    "Yui dispatch:",
    requireText(context.input, "dispatch input")
  ].filter(Boolean).join("\n\n");
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
