import {
  activeRoleAgentSession,
  type RoleSessionSet
} from "../executor/agentExecutor.js";
import type { GlobalRole, Role, RoleAgentBinding } from "../role/role.js";
import { defaultTableWidth, renderTable } from "./table.js";

type PresentedRole = GlobalRole | Role;

export function activeRoleSummary(role: PresentedRole): Readonly<{
  agent: string;
  model: string;
  effort: string;
}> {
  const binding = role.agentBindings[role.activeAgentId];
  return {
    agent: role.activeAgentId,
    model: binding?.config.model ?? "CLI default",
    effort: binding?.config.effort ?? "CLI default"
  };
}

export function renderRoleDetails(
  title: string,
  role: PresentedRole,
  input: Readonly<{ kind: "system" | "global" | "task"; sessions?: RoleSessionSet | null }>
): string {
  const bindings = Object.values(role.agentBindings)
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  const effective = activeRoleAgentSession(input.sessions ?? null)?.effective;
  const profile = [
    `  Description      ${present(role.description)}`,
    `  Responsibilities ${presentList(role.responsibilities)}`,
    `  Constraints      ${presentList(role.constraints)}`,
    `  Expected output  ${present(role.expectedOutput)}`,
    `  System prompt    ${present(role.systemPrompt)}`,
    `  Skills           ${presentList(role.skills)}`
  ];
  const overview = [
    `  Kind             ${input.kind}`,
    `  Active Agent     ${role.activeAgentId}`,
    ...("status" in role ? [`  Status           ${role.status}`] : []),
    `  Workspace        ${role.workspace}`,
    `  Desired launch   r${role.launchRevision}; access ceiling=${role.defaultAccess}`,
    `  Effective launch ${effective === undefined
      ? "not started"
      : `${effective.agentId}/${effective.adapterId}; r${effective.sourceDesiredRevision}; access=${effective.access}; permission=${effective.permission.strategy}`}`,
    `  Desired drift    ${effective === undefined
      ? "-"
      : effective.sourceDesiredRevision === role.launchRevision
        ? "none"
        : "pending next launch"}`
  ];
  return [
    title,
    "",
    "Role settings",
    ...overview,
    "",
    "Profile",
    ...profile,
    "",
    renderTable(
      "Agent settings",
      [
        { header: "Agent", minWidth: 5, maxWidth: 20 },
        { header: "Active", minWidth: 6, maxWidth: 6 },
        { header: "Adapter", minWidth: 7, maxWidth: 10 },
        { header: "Model", minWidth: 8, maxWidth: 24 },
        { header: "Effort", minWidth: 8, maxWidth: 16 },
        { header: "Permission", minWidth: 10, maxWidth: 34 },
        { header: "Search", minWidth: 6, maxWidth: 11 },
        { header: "Session", minWidth: 7, maxWidth: 12 }
      ],
      bindings.map((binding) => bindingRow(binding, role, input.sessions)),
      defaultTableWidth()
    )
  ].join("\n").concat("\n");
}

function bindingRow(
  binding: RoleAgentBinding,
  role: PresentedRole,
  sessions: RoleSessionSet | null | undefined
): string[] {
  return [
    binding.agentId,
    binding.agentId === role.activeAgentId ? "yes" : "",
    binding.adapterId,
    binding.config.model ?? "CLI default",
    binding.config.effort ?? "CLI default",
    permission(binding),
    binding.config.adapterId === "codex"
      ? binding.config.search === true ? "enabled" : "CLI default"
      : "-",
    sessions?.sessions[binding.agentId]?.status ?? "not started"
  ];
}

function permission(binding: RoleAgentBinding): string {
  if (binding.config.adapterId === "codex") {
    const permission = binding.config.permission;
    if (permission === undefined || permission.strategy === "default") return "CLI default";
    if (permission.strategy === "bypass") return "bypass";
    return `sandbox=${permission.sandbox}, approval=${permission.approval}`;
  }
  const permission = binding.config.permission;
  if (permission === undefined || permission.strategy === "default") return "CLI default";
  if (permission.strategy === "bypass") return "bypass";
  const rules = [
    `mode=${permission.mode}`,
    permission.allowedTools === undefined
      ? undefined
      : `allow=${permission.allowedTools.join(", ")}`,
    permission.disallowedTools === undefined
      ? undefined
      : `deny=${permission.disallowedTools.join(", ")}`
  ].filter((value): value is string => value !== undefined);
  return rules.join("; ");
}

function present(value: string | undefined): string {
  return value === undefined || value.length === 0 ? "-" : value;
}

function presentList(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0 ? "-" : values.join("; ");
}
