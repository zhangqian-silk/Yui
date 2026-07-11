export const SYSTEM_OPERATOR_ROLE = "operator";
export const SYSTEM_ASSISTANT_ROLE = "assistant";
export const SYSTEM_LEADER_ROLE = "leader";

export const SYSTEM_ROLE_NAMES = [SYSTEM_OPERATOR_ROLE, SYSTEM_LEADER_ROLE] as const;

export function isSystemRoleName(name: string): boolean {
  return name === SYSTEM_ASSISTANT_ROLE || SYSTEM_ROLE_NAMES.includes(name as (typeof SYSTEM_ROLE_NAMES)[number]);
}

export function systemRoleDescription(name: string): string {
  if (name === SYSTEM_OPERATOR_ROLE || name === SYSTEM_ASSISTANT_ROLE) {
    return "global user-facing CLI operator";
  }

  if (name === SYSTEM_LEADER_ROLE) {
    return "task leader and role coordinator";
  }

  return "";
}
