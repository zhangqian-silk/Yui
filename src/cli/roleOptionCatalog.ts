export type RoleOption = Readonly<{
  id: string;
  name: string;
  kind: string;
}>;

export type FirstClassRoleAgentAdapterId = "codex" | "claude";

export type RoleAgentOptionSpec = Readonly<{
  option: `--${string}`;
  fieldKey: string;
  valueLabel: string;
  arity: "value";
  repeatable: boolean;
  adapters: readonly FirstClassRoleAgentAdapterId[];
  staticValues?: readonly string[];
  fileValue?: boolean;
  allowOptionLikeValue?: boolean;
}>;

const BOTH_ADAPTERS = Object.freeze(["codex", "claude"] as const);
const CODEX_ONLY = Object.freeze(["codex"] as const);
const CLAUDE_ONLY = Object.freeze(["claude"] as const);

export const ROLE_AGENT_OPTION_SPECS: readonly RoleAgentOptionSpec[] = Object.freeze([
  roleAgentOption("--model", "model", "model", false, BOTH_ADAPTERS),
  roleAgentOption("--effort", "effort", "effort", false, BOTH_ADAPTERS),
  roleAgentOption("--permission-strategy", "permission.strategy", "strategy", false, BOTH_ADAPTERS,
    { staticValues: ["default", "bypass", "configured"] }),
  roleAgentOption("--sandbox", "permission.sandbox", "mode", false, CODEX_ONLY),
  roleAgentOption("--approval", "permission.approval", "policy", false, CODEX_ONLY),
  roleAgentOption("--permission-mode", "permission.mode", "mode", false, CLAUDE_ONLY),
  roleAgentOption("--allowed-tool", "permission.allowedTools", "tool", true, CLAUDE_ONLY),
  roleAgentOption("--disallowed-tool", "permission.disallowedTools", "tool", true, CLAUDE_ONLY),
  roleAgentOption("--search", "search", "true", false, CODEX_ONLY, { staticValues: ["true"] }),
  roleAgentOption("--profile", "profile", "profile", false, CODEX_ONLY),
  roleAgentOption("--add-dir", "additionalDirectories", "path", true, BOTH_ADAPTERS, { fileValue: true }),
  roleAgentOption("--settings", "settingsFile", "file", false, CLAUDE_ONLY, { fileValue: true }),
  roleAgentOption("--setting-source", "settingsSources", "source", true, CLAUDE_ONLY),
  roleAgentOption("--raw-arg", "advanced.rawArgs", "arg", true, BOTH_ADAPTERS, { allowOptionLikeValue: true })
]);

export const ROLE_AGENT_INHERIT_OPTION = "--inherit" as const;
export const ROLE_EXPECT_UPDATED_AT_OPTION = "--expect-updated-at" as const;
export const ROLE_AGENT_INHERITABLE_FIELDS = Object.freeze(
  ROLE_AGENT_OPTION_SPECS.map(({ fieldKey }) => fieldKey)
);
export const ROLE_PROFILE_INHERITABLE_FIELDS = Object.freeze(["systemPrompt"]);
export const ROLE_INHERITABLE_FIELDS = Object.freeze([
  ...ROLE_AGENT_INHERITABLE_FIELDS,
  ...ROLE_PROFILE_INHERITABLE_FIELDS
]);
export const ROLE_AGENT_SCRIPTED_OPTIONS = Object.freeze([
  ...ROLE_AGENT_OPTION_SPECS.map(({ option }) => option),
  ROLE_AGENT_INHERIT_OPTION
]);
export const ROLE_AGENT_FILE_OPTIONS = Object.freeze(
  ROLE_AGENT_OPTION_SPECS.filter(({ fileValue }) => fileValue === true).map(({ option }) => option)
);

export function roleAgentOptionSpecsForAdapter(
  adapterId: FirstClassRoleAgentAdapterId
): readonly RoleAgentOptionSpec[] {
  return ROLE_AGENT_OPTION_SPECS.filter(({ adapters }) => adapters.includes(adapterId));
}

export function roleAgentOptionUsage(): string {
  return [
    ...ROLE_AGENT_OPTION_SPECS.map(({ option, valueLabel, repeatable }) =>
      `[${option} <${valueLabel}>${repeatable ? " ..." : ""}]`),
    `[${ROLE_AGENT_INHERIT_OPTION} <field-key> ...]`
  ].join(" ");
}

function roleAgentOption(
  option: `--${string}`,
  fieldKey: string,
  valueLabel: string,
  repeatable: boolean,
  adapters: readonly FirstClassRoleAgentAdapterId[],
  extra: Pick<RoleAgentOptionSpec, "staticValues" | "fileValue" | "allowOptionLikeValue"> = {}
): RoleAgentOptionSpec {
  return Object.freeze({ option, fieldKey, valueLabel, arity: "value", repeatable, adapters, ...extra });
}

export const FIRST_CLASS_AGENT_OPTIONS = Object.freeze([
  Object.freeze({ id: "codex", label: "Codex" }),
  Object.freeze({ id: "claude", label: "Claude" })
]);

export function orderRoleOptions<T extends { kind?: string; name?: string; id?: string }>(
  roles: readonly T[]
): T[] {
  return [...roles].sort((left, right) => {
    const rank = roleRank(left) - roleRank(right);
    if (rank !== 0) return rank;
    return roleName(left).localeCompare(roleName(right));
  });
}

function roleRank(role: { kind?: string; name?: string; id?: string }): number {
  const kind = role.kind?.toLowerCase();
  const name = roleName(role).toLowerCase();
  if (kind === "operator" || name === "operator") return 0;
  if (kind === "leader" || name === "leader") return 1;
  return 2;
}

function roleName(role: { name?: string; id?: string }): string {
  return role.name ?? role.id ?? "";
}
