import { usageError } from "../errors/cliError.js";
import {
  defaultRoleAgentConfig,
  resolveAgentAdapter,
  type PermissionStrategy,
  type RoleAgentConfig
} from "../executor/agentAdapter.js";
import type { RoleAgentBinding, RoleProfile } from "../role/role.js";

export type RoleOptionKind = "flag" | "value" | "repeatable";

export type ParsedRoleOptions = Readonly<{
  seen: ReadonlySet<string>;
  has(option: string): boolean;
  one(option: string): string | undefined;
  many(option: string): string[];
}>;

const PROFILE_OPTIONS: readonly [string, RoleOptionKind][] = [
  ["--description", "value"],
  ["--responsibility", "repeatable"],
  ["--constraint", "repeatable"],
  ["--expected-output", "value"],
  ["--system-prompt", "value"],
  ["--skill", "repeatable"]
];

const PROFILE_CLEAR_OPTIONS: readonly [string, RoleOptionKind][] = [
  ["--clear-description", "flag"],
  ["--clear-responsibilities", "flag"],
  ["--clear-constraints", "flag"],
  ["--clear-expected-output", "flag"],
  ["--clear-system-prompt", "flag"],
  ["--clear-skills", "flag"]
];

const AGENT_VALUE_OPTIONS: readonly [string, RoleOptionKind][] = [
  ["--model", "value"],
  ["--effort", "value"],
  ["--permission-strategy", "value"],
  ["--sandbox", "value"],
  ["--approval", "value"],
  ["--permission-mode", "value"],
  ["--search", "value"]
];

const AGENT_REPEATABLE_OPTIONS: readonly [string, RoleOptionKind][] = [
  ["--allowed-tool", "repeatable"],
  ["--disallowed-tool", "repeatable"]
];

const AGENT_CLEAR_OPTIONS: readonly [string, RoleOptionKind][] = [
  ["--clear-model", "flag"],
  ["--clear-effort", "flag"],
  ["--clear-allowed-tools", "flag"],
  ["--clear-disallowed-tools", "flag"],
  ["--clear-search", "flag"],
  ["--clear-agent-config", "flag"]
];

const AGENT_CONFIG_OPTIONS = new Set([
  ...AGENT_VALUE_OPTIONS.map(([option]) => option),
  ...AGENT_REPEATABLE_OPTIONS.map(([option]) => option),
  ...AGENT_CLEAR_OPTIONS.map(([option]) => option)
]);

export function roleOptionSpecs(input: Readonly<{
  update: boolean;
  includeAgent?: boolean;
  includeWorkspace?: boolean;
  agentOptions?: "all" | "execution";
}>): ReadonlyMap<string, RoleOptionKind> {
  const agentValueOptions = input.agentOptions === "execution"
    ? AGENT_VALUE_OPTIONS.filter(([option]) => option === "--model" || option === "--effort")
    : AGENT_VALUE_OPTIONS;
  const agentClearOptions = input.agentOptions === "execution"
    ? AGENT_CLEAR_OPTIONS.filter(([option]) => (
        option === "--clear-model"
        || option === "--clear-effort"
        || option === "--clear-agent-config"
      ))
    : AGENT_CLEAR_OPTIONS;
  const agentRepeatableOptions = input.agentOptions === "execution"
    ? []
    : AGENT_REPEATABLE_OPTIONS;
  return new Map<string, RoleOptionKind>([
    ...(input.includeAgent === true ? [["--agent", "value"] as const] : []),
    ...(input.includeWorkspace === true ? [["--workspace", "value"] as const] : []),
    ...PROFILE_OPTIONS,
    ...agentValueOptions,
    ...agentRepeatableOptions,
    ...(input.update ? [...PROFILE_CLEAR_OPTIONS, ...agentClearOptions] : [])
  ]);
}

export function parseRoleOptions(
  args: readonly string[],
  specs: ReadonlyMap<string, RoleOptionKind>,
  usage?: string
): ParsedRoleOptions {
  const values = new Map<string, string[]>();
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index] ?? "";
    const kind = specs.get(option);
    if (kind === undefined) {
      throw usageError(option.startsWith("--")
        ? `Unsupported option: ${option}`
        : `Unexpected argument: ${option}`, usage);
    }
    if (kind !== "repeatable" && seen.has(option)) {
      throw usageError(`Option may only be specified once: ${option}`, usage);
    }
    seen.add(option);
    if (kind === "flag") continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`${option} is required.`, usage);
    }
    values.set(option, [...(values.get(option) ?? []), value]);
    index += 1;
  }
  return {
    seen,
    has: (option) => seen.has(option),
    one: (option) => values.get(option)?.[0],
    many: (option) => [...(values.get(option) ?? [])]
  };
}

export function roleProfileFrom(parsed: ParsedRoleOptions): RoleProfile {
  return {
    ...(parsed.has("--description") ? { description: requiredText(parsed.one("--description")) } : {}),
    responsibilities: parsed.many("--responsibility").map(requiredText),
    constraints: parsed.many("--constraint").map(requiredText),
    ...(parsed.has("--expected-output")
      ? { expectedOutput: requiredText(parsed.one("--expected-output")) } : {}),
    ...(parsed.has("--system-prompt")
      ? { systemPrompt: requiredText(parsed.one("--system-prompt")) } : {}),
    skills: parsed.many("--skill").map(requiredText)
  };
}

export function roleProfilePatch(parsed: ParsedRoleOptions): RoleProfile {
  assertPairs(parsed, [
    ["--description", "--clear-description"],
    ["--responsibility", "--clear-responsibilities"],
    ["--constraint", "--clear-constraints"],
    ["--expected-output", "--clear-expected-output"],
    ["--system-prompt", "--clear-system-prompt"],
    ["--skill", "--clear-skills"]
  ]);
  return {
    ...(parsed.has("--description") ? { description: requiredText(parsed.one("--description")) } : {}),
    ...(parsed.has("--clear-description") ? { description: undefined } : {}),
    ...(parsed.has("--responsibility")
      ? { responsibilities: parsed.many("--responsibility").map(requiredText) } : {}),
    ...(parsed.has("--clear-responsibilities") ? { responsibilities: [] } : {}),
    ...(parsed.has("--constraint")
      ? { constraints: parsed.many("--constraint").map(requiredText) } : {}),
    ...(parsed.has("--clear-constraints") ? { constraints: [] } : {}),
    ...(parsed.has("--expected-output")
      ? { expectedOutput: requiredText(parsed.one("--expected-output")) } : {}),
    ...(parsed.has("--clear-expected-output") ? { expectedOutput: undefined } : {}),
    ...(parsed.has("--system-prompt")
      ? { systemPrompt: requiredText(parsed.one("--system-prompt")) } : {}),
    ...(parsed.has("--clear-system-prompt") ? { systemPrompt: undefined } : {}),
    ...(parsed.has("--skill") ? { skills: parsed.many("--skill").map(requiredText) } : {}),
    ...(parsed.has("--clear-skills") ? { skills: [] } : {})
  };
}

export function hasAgentConfigOptions(parsed: ParsedRoleOptions): boolean {
  return [...parsed.seen].some((option) => AGENT_CONFIG_OPTIONS.has(option));
}

export function patchRoleAgentBinding(
  binding: RoleAgentBinding,
  parsed: ParsedRoleOptions
): RoleAgentBinding {
  assertAgentOptionConflicts(parsed);
  assertAdapterOptions(binding.adapterId, parsed);
  if (parsed.has("--clear-agent-config")) {
    return { ...binding, config: defaultRoleAgentConfig(binding.adapterId) };
  }

  const config = structuredClone(binding.config) as unknown as Record<string, unknown>;
  patchText(config, parsed, "--model", "--clear-model", "model");
  patchText(config, parsed, "--effort", "--clear-effort", "effort");
  config.permission = permissionPatch(binding, parsed);

  if (parsed.has("--search")) {
    if (parsed.one("--search") !== "true") {
      throw usageError("--search supports true only; use --clear-search to follow the CLI default.");
    }
    config.search = true;
  }
  if (parsed.has("--clear-search")) delete config.search;

  try {
    const canonical = resolveAgentAdapter(binding.adapterId).canonicalizeConfig(
      config as unknown as RoleAgentConfig
    );
    return { ...binding, config: canonical };
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

function permissionPatch(
  binding: RoleAgentBinding,
  parsed: ParsedRoleOptions
): Record<string, unknown> {
  const selected = parsed.has("--permission-strategy")
    ? permissionStrategy(parsed.one("--permission-strategy"))
    : undefined;
  const nativeOptions = [
    "--sandbox", "--approval", "--permission-mode",
    "--allowed-tool", "--clear-allowed-tools",
    "--disallowed-tool", "--clear-disallowed-tools"
  ].some((option) => parsed.has(option));
  if (selected === "default" || selected === "bypass") {
    if (nativeOptions) {
      throw usageError(
        `--permission-strategy ${selected} cannot be combined with provider permission options.`
      );
    }
    return { strategy: selected };
  }
  const current = binding.config.permission;
  if (selected !== "configured" && !nativeOptions) {
    return structuredClone(current ?? { strategy: "bypass" }) as Record<string, unknown>;
  }
  const permission = current?.strategy === "configured"
    ? structuredClone(current) as unknown as Record<string, unknown>
    : { strategy: "configured" } as Record<string, unknown>;
  permission.strategy = "configured";
  if (binding.adapterId === "codex") {
    if (parsed.has("--sandbox")) permission.sandbox = requiredText(parsed.one("--sandbox"));
    if (parsed.has("--approval")) permission.approval = requiredText(parsed.one("--approval"));
  } else {
    if (parsed.has("--permission-mode")) {
      permission.mode = requiredText(parsed.one("--permission-mode"));
    }
    patchTexts(permission, parsed, "--allowed-tool", "--clear-allowed-tools", "allowedTools");
    patchTexts(
      permission,
      parsed,
      "--disallowed-tool",
      "--clear-disallowed-tools",
      "disallowedTools"
    );
  }
  return permission;
}

function permissionStrategy(value: string | undefined): PermissionStrategy {
  const strategy = requiredText(value);
  if (strategy !== "default" && strategy !== "bypass" && strategy !== "configured") {
    throw usageError(
      "--permission-strategy must be default, bypass, or configured."
    );
  }
  return strategy;
}

function patchText(
  target: Record<string, unknown>,
  parsed: ParsedRoleOptions,
  valueOption: string,
  clearOption: string,
  key: string
): void {
  if (parsed.has(valueOption)) target[key] = requiredText(parsed.one(valueOption));
  if (parsed.has(clearOption)) delete target[key];
}

function patchTexts(
  target: Record<string, unknown>,
  parsed: ParsedRoleOptions,
  valueOption: string,
  clearOption: string,
  key: string
): void {
  if (parsed.has(valueOption)) target[key] = parsed.many(valueOption).map(requiredText);
  if (parsed.has(clearOption)) delete target[key];
}

function assertAgentOptionConflicts(parsed: ParsedRoleOptions): void {
  assertPairs(parsed, [
    ["--model", "--clear-model"],
    ["--effort", "--clear-effort"],
    ["--allowed-tool", "--clear-allowed-tools"],
    ["--disallowed-tool", "--clear-disallowed-tools"],
    ["--search", "--clear-search"]
  ]);
  if (parsed.has("--clear-agent-config")
    && [...parsed.seen].some((option) => option !== "--clear-agent-config" && AGENT_CONFIG_OPTIONS.has(option))) {
    throw usageError("--clear-agent-config cannot be combined with another Agent setting.");
  }
}

function assertAdapterOptions(adapterId: string, parsed: ParsedRoleOptions): void {
  const codex = ["--sandbox", "--approval", "--search", "--clear-search"];
  const claude = [
    "--permission-mode",
    "--allowed-tool", "--clear-allowed-tools",
    "--disallowed-tool", "--clear-disallowed-tools"
  ];
  if (adapterId !== "codex" && codex.some((option) => parsed.has(option))) {
    throw usageError("Sandbox, approval, and search settings are only supported by Codex.");
  }
  if (adapterId !== "claude" && claude.some((option) => parsed.has(option))) {
    throw usageError("Permission mode and tool rules are only supported by Claude.");
  }
}

function assertPairs(parsed: ParsedRoleOptions, pairs: readonly (readonly [string, string])[]): void {
  for (const [valueOption, clearOption] of pairs) {
    if (parsed.has(valueOption) && parsed.has(clearOption)) {
      throw usageError(`${valueOption} and ${clearOption} cannot be used together.`);
    }
  }
}

function requiredText(value: string | undefined): string {
  const result = value?.trim();
  if (result === undefined || result.length === 0) throw usageError("Role option values must not be empty.");
  return result;
}
