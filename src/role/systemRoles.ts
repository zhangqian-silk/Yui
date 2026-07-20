export const SYSTEM_OPERATOR_ROLE = "operator";
export const SYSTEM_LEADER_ROLE = "leader";
export const SYSTEM_WORKER_ROLE = "worker";

export const SYSTEM_ROLE_NAMES = [
  SYSTEM_OPERATOR_ROLE,
  SYSTEM_LEADER_ROLE,
  SYSTEM_WORKER_ROLE
] as const;

export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

export function isSystemRoleName(name: string): name is SystemRoleName {
  return SYSTEM_ROLE_NAMES.includes(name as SystemRoleName);
}

export function systemRoleDescription(name: string): string {
  if (name === SYSTEM_OPERATOR_ROLE) return "global user-facing CLI operator";
  if (name === SYSTEM_LEADER_ROLE) return "task leader and role coordinator";
  if (name === SYSTEM_WORKER_ROLE) return "task worker executing delegated work";
  return "";
}
