export type FirstClassRoleAgentAdapterId = "codex" | "claude";

export type RoleAgentOptionSpec = {
  option: `--${string}`;
  fieldKey: string;
  valueLabel: string;
  arity: "value";
  repeatable: boolean;
  adapters: readonly FirstClassRoleAgentAdapterId[];
  staticValues?: readonly string[];
  fileValue?: boolean;
  allowOptionLikeValue?: boolean;
};

const BOTH_ADAPTERS = Object.freeze(["codex", "claude"] as const);
const CODEX_ONLY = Object.freeze(["codex"] as const);
const CLAUDE_ONLY = Object.freeze(["claude"] as const);

function option(spec: RoleAgentOptionSpec): Readonly<RoleAgentOptionSpec> {
  return Object.freeze({
    ...spec,
    adapters: Object.freeze([...spec.adapters]),
    ...(spec.staticValues === undefined ? {} : { staticValues: Object.freeze([...spec.staticValues]) })
  });
}

export const ROLE_AGENT_OPTION_SPECS: readonly Readonly<RoleAgentOptionSpec>[] = Object.freeze([
  option({ option: "--model", fieldKey: "model", valueLabel: "model", arity: "value", repeatable: false, adapters: BOTH_ADAPTERS }),
  option({ option: "--effort", fieldKey: "effort", valueLabel: "effort", arity: "value", repeatable: false, adapters: BOTH_ADAPTERS }),
  option({ option: "--sandbox", fieldKey: "permission.sandbox", valueLabel: "mode", arity: "value", repeatable: false, adapters: CODEX_ONLY }),
  option({ option: "--approval", fieldKey: "permission.approval", valueLabel: "policy", arity: "value", repeatable: false, adapters: CODEX_ONLY }),
  option({ option: "--permission-mode", fieldKey: "permission.mode", valueLabel: "mode", arity: "value", repeatable: false, adapters: CLAUDE_ONLY }),
  option({ option: "--allowed-tool", fieldKey: "permission.allowedTools", valueLabel: "tool", arity: "value", repeatable: true, adapters: CLAUDE_ONLY }),
  option({ option: "--disallowed-tool", fieldKey: "permission.disallowedTools", valueLabel: "tool", arity: "value", repeatable: true, adapters: CLAUDE_ONLY }),
  option({ option: "--search", fieldKey: "search", valueLabel: "true", arity: "value", repeatable: false, adapters: CODEX_ONLY }),
  option({ option: "--profile", fieldKey: "profile", valueLabel: "profile", arity: "value", repeatable: false, adapters: CODEX_ONLY }),
  option({ option: "--add-dir", fieldKey: "additionalDirectories", valueLabel: "path", arity: "value", repeatable: true, adapters: BOTH_ADAPTERS, fileValue: true }),
  option({ option: "--settings", fieldKey: "settingsFile", valueLabel: "file", arity: "value", repeatable: false, adapters: CLAUDE_ONLY, fileValue: true }),
  option({ option: "--setting-source", fieldKey: "settingsSources", valueLabel: "source", arity: "value", repeatable: true, adapters: CLAUDE_ONLY }),
  option({ option: "--raw-arg", fieldKey: "advanced.rawArgs", valueLabel: "arg", arity: "value", repeatable: true, adapters: BOTH_ADAPTERS, allowOptionLikeValue: true })
]);

export const ROLE_AGENT_INHERIT_OPTION = "--inherit" as const;

/**
 * Internal optimistic-concurrency token emitted by the foreground Role wizard.
 * It is intentionally accepted by mutation handlers but omitted from public
 * command catalog metadata and shell completion.
 */
export const ROLE_EXPECT_UPDATED_AT_OPTION = "--expect-updated-at" as const;

export const ROLE_AGENT_INHERITABLE_FIELDS: readonly string[] = Object.freeze(
  ROLE_AGENT_OPTION_SPECS.map(({ fieldKey }) => fieldKey)
);

export const ROLE_PROFILE_INHERITABLE_FIELDS: readonly string[] = Object.freeze(["systemPrompt"]);

export const ROLE_INHERITABLE_FIELDS: readonly string[] = Object.freeze([
  ...ROLE_AGENT_INHERITABLE_FIELDS,
  ...ROLE_PROFILE_INHERITABLE_FIELDS
]);

export const ROLE_AGENT_SCRIPTED_OPTIONS: readonly string[] = Object.freeze([
  ...ROLE_AGENT_OPTION_SPECS.map(({ option: optionName }) => optionName),
  ROLE_AGENT_INHERIT_OPTION
]);

export const ROLE_AGENT_FILE_OPTIONS: readonly string[] = Object.freeze(
  ROLE_AGENT_OPTION_SPECS.filter(({ fileValue }) => fileValue === true).map(({ option: optionName }) => optionName)
);

export function roleAgentOptionSpecsForAdapter(
  adapterId: FirstClassRoleAgentAdapterId
): readonly Readonly<RoleAgentOptionSpec>[] {
  return Object.freeze(ROLE_AGENT_OPTION_SPECS.filter(({ adapters }) => adapters.includes(adapterId)));
}

export function roleAgentOptionUsage(): string {
  const setFragments = ROLE_AGENT_OPTION_SPECS.map(({ option: optionName, valueLabel, repeatable }) =>
    `[${optionName} <${valueLabel}>${repeatable ? " ..." : ""}]`
  );
  return [...setFragments, `[${ROLE_AGENT_INHERIT_OPTION} <field-key> ...]`].join(" ");
}
