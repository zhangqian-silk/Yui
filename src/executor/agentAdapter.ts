import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentDefinition } from "../agent/agent.js";
import { supportedAgentAdapterIds, type AgentAdapterId } from "../agent/adapterCatalog.js";
import {
  ownedArgumentsForAdapter,
  validateAgentAdvancedArguments,
  validateAgentBaseArguments
} from "../agent/argumentPolicy.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import {
  inspectCodexDeveloperInstructions,
  type CodexDeveloperInstructionsInspection
} from "./codexConfigConflict.js";
import type {
  AgentConfigurationCatalog,
  AgentConfigurationDiscoveryInput
} from "./agentConfigurationCatalog.js";
import {
  discoverClaudeConfiguration,
  discoverCodexConfiguration
} from "./agentConfigurationProbe.js";
import {
  preInputReadinessCapability
} from "../lifecycle/providerLifecycleMapping.js";
import type { PreInputReadinessCapability } from "../lifecycle/canonicalLifecycleEvent.js";

export type AdvancedAgentConfig = Readonly<{ rawArgs?: readonly string[] }>;
export type PermissionStrategy = "default" | "bypass" | "configured";
export type CodexPermissionConfig =
  | Readonly<{ strategy: "default" }>
  | Readonly<{ strategy: "bypass" }>
  | Readonly<{
      strategy: "configured";
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      approval?: "untrusted" | "on-request" | "never";
    }>;
export type ClaudePermissionConfig =
  | Readonly<{ strategy: "default" }>
  | Readonly<{ strategy: "bypass" }>
  | Readonly<{
      strategy: "configured";
      mode?: string;
      allowedTools?: readonly string[];
      disallowedTools?: readonly string[];
    }>;
export type CodexAgentConfig = Readonly<{
  adapterId: "codex";
  model?: string;
  effort?: string;
  permission: CodexPermissionConfig;
  search?: boolean;
  profile?: string;
  additionalDirectories?: readonly string[];
  advanced?: AdvancedAgentConfig;
}>;
export type ClaudeAgentConfig = Readonly<{
  adapterId: "claude";
  model?: string;
  effort?: string;
  permission: ClaudePermissionConfig;
  additionalDirectories?: readonly string[];
  settingsFile?: string;
  settingsSources?: readonly string[];
  advanced?: AdvancedAgentConfig;
}>;
export type RoleAgentConfig = CodexAgentConfig | ClaudeAgentConfig;
export type CodexRoleAgentConfig = CodexAgentConfig;
export type ClaudeRoleAgentConfig = ClaudeAgentConfig;

export type CapabilityField = Readonly<{
  key: string;
  kind: "enum" | "boolean" | "string" | "string-list" | "path" | "path-list";
  status: "available" | "degraded" | "unavailable";
  choices?: readonly string[];
  allowCustom: boolean;
}>;
export type AgentInstallation = Readonly<{
  status: "installed" | "missing" | "unsupported-version" | "probe-failed";
  command: string;
  version?: string;
  reason?: string;
  probedAt: string;
}>;
export type CapabilitySnapshot = Readonly<{
  schemaVersion: 1;
  agentId: string;
  adapterId: AgentAdapterId;
  installation: AgentInstallation;
  lifecycle: Readonly<{
    start: true;
    resume: true;
    nativeSessionDiscovery: "runtime" | "preallocated";
    interrupt: true;
    /**
     * Whether this provider emits a native event proven to occur before the
     * first prompt that Yui may map to pre-input readiness. Explicit and fail
     * closed when unsupported — never a provider-name default.
     */
    preInputReadiness: PreInputReadinessCapability;
  }>;
  fields: readonly CapabilityField[];
  warnings: readonly string[];
  refreshedAt: string;
}>;
export type AgentProbeResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}>;
export type AgentProbeRunner = (command: string, args: readonly string[]) => AgentProbeResult;
export type CapabilityInspectionOptions = Readonly<{ now?: Date; run?: AgentProbeRunner }>;

export type CompileInput<TConfig extends RoleAgentConfig = RoleAgentConfig> = Readonly<{
  agent: AgentDefinition;
  config: TConfig;
  workspace: string;
  sessionTitle?: string;
  developerInstructions?: string;
  skills?: readonly Readonly<{ id: string; path: string; content: string }>[];
  managedContextFile?: string;
  codexDeveloperInstructions?: CodexDeveloperInstructionsInspection;
}>;
export type ResumeInput<TConfig extends RoleAgentConfig = RoleAgentConfig> =
  CompileInput<TConfig> & Readonly<{ nativeSessionId: string }>;
export type CompiledAgentLaunch = Readonly<{
  argv: readonly string[];
  sessionStrategy: "runtime-discovery" | "preallocated";
}>;

export interface AgentAdapter<TConfig extends RoleAgentConfig = RoleAgentConfig> {
  readonly id: AgentAdapterId;
  readonly label: string;
  readonly supportedVersion: string;
  readonly capabilities: Readonly<{
    recover: true;
    interrupt: true;
    nativeSessionDiscovery: "runtime" | "preallocated";
    preInputReadiness: PreInputReadinessCapability;
  }>;
  validateConfig(input: CompileInput<TConfig>): void;
  compileNew(input: CompileInput<TConfig>): CompiledAgentLaunch;
  compileResume(input: ResumeInput<TConfig>): CompiledAgentLaunch;
  canonicalizeConfig(config: TConfig): TConfig;
  reservedArguments(): readonly string[];
  discoverConfiguration(input: AgentConfigurationDiscoveryInput): Promise<AgentConfigurationCatalog>;
}

const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
const APPROVALS = ["untrusted", "on-request", "never"] as const;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_MAX_BYTES = 1024 * 1024;
const CODEX_TESTED_THROUGH_VERSION = "0.145.0";

abstract class BaseAdapter<TConfig extends RoleAgentConfig> implements AgentAdapter<TConfig> {
  abstract readonly id: AgentAdapterId;
  abstract readonly label: string;
  abstract readonly supportedVersion: string;
  abstract readonly capabilities: AgentAdapter<TConfig>["capabilities"];
  abstract validateStructured(config: TConfig): void;
  abstract structuredArgs(config: TConfig): string[];
  abstract compileResume(input: ResumeInput<TConfig>): CompiledAgentLaunch;
  abstract discoverConfiguration(
    input: AgentConfigurationDiscoveryInput
  ): Promise<AgentConfigurationCatalog>;

  launchContextArgs(_input: CompileInput<TConfig>): string[] {
    return [];
  }

  validateConfig(input: CompileInput<TConfig>): void {
    if (input.agent.adapterId !== this.id || input.config.adapterId !== this.id) {
      throw new Error(`Agent adapter identity mismatch: expected ${this.id}.`);
    }
    validateAgentBaseArguments(this.id, input.agent.baseArgs);
    this.validateStructured(input.config);
  }

  compileNew(input: CompileInput<TConfig>): CompiledAgentLaunch {
    this.validateConfig(input);
    const config = this.canonicalizeConfig(input.config);
    return {
      argv: [
        ...input.agent.baseArgs,
        ...this.structuredArgs(config),
        ...this.launchContextArgs(input),
        ...(config.advanced?.rawArgs ?? [])
      ],
      sessionStrategy: this.capabilities.nativeSessionDiscovery === "runtime"
        ? "runtime-discovery"
        : "preallocated"
    };
  }

  canonicalizeConfig(config: TConfig): TConfig {
    this.validateStructured(config);
    const directories = config.additionalDirectories === undefined
      ? undefined
      : canonicalDirectories(config.additionalDirectories);
    return cloneConfig(config, directories) as TConfig;
  }

  reservedArguments(): readonly string[] {
    return ownedArgumentsForAdapter(this.id);
  }
}

class CodexAdapter extends BaseAdapter<CodexAgentConfig> {
  readonly id = "codex" as const;
  readonly label = "Codex";
  readonly supportedVersion = "0.144.1";
  readonly capabilities = {
    recover: true,
    interrupt: true,
    nativeSessionDiscovery: "runtime",
    preInputReadiness: preInputReadinessCapability("codex")
  } as const;

  discoverConfiguration(input: AgentConfigurationDiscoveryInput): Promise<AgentConfigurationCatalog> {
    return discoverCodexConfiguration(input);
  }

  validateStructured(config: CodexAgentConfig): void {
    exact(config, ["adapterId", "model", "effort", "permission", "search", "profile",
      "additionalDirectories", "advanced"], "Codex Agent config");
    if (config.adapterId !== "codex") throw new Error("Codex Agent config adapter is invalid.");
    optionalText(config.model, "Codex model");
    optionalText(config.effort, "Codex effort");
    optionalText(config.profile, "Codex profile");
    if (config.search !== undefined && typeof config.search !== "boolean") {
      throw new Error("Codex search must be boolean.");
    }
    validatePaths(config.additionalDirectories, "Codex additional directory");
    if (config.permission === undefined) {
      throw new Error("Codex permission strategy is required.");
    }
    if (config.permission.strategy === "configured") {
      exact(config.permission, ["strategy", "sandbox", "approval"], "Codex permission config");
      if (config.permission.sandbox !== undefined
        && !SANDBOXES.includes(config.permission.sandbox)) {
        throw new Error("Codex sandbox is invalid.");
      }
      if (config.permission.approval !== undefined
        && !APPROVALS.includes(config.permission.approval)) {
        throw new Error("Codex approval is invalid.");
      }
      requireConfiguredPermissionOption(config.permission, "Codex");
    } else {
      exact(config.permission, ["strategy"], "Codex permission config");
      validateSimplePermissionStrategy(config.permission.strategy, "Codex permission strategy");
    }
    advanced(this.id, config.advanced);
  }

  structuredArgs(config: CodexAgentConfig): string[] {
    return [
      // Yui launches Codex in a detached tmux window. Disable the startup
      // updater so an unrelated native prompt cannot consume managed input.
      "--config", "check_for_update_on_startup=false",
      ...(config.model === undefined ? [] : ["--model", config.model]),
      ...(config.effort === undefined ? [] : ["--config", `model_reasoning_effort=\"${config.effort}\"`]),
      ...(config.permission.strategy === "bypass"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : config.permission.strategy === "configured"
          ? [
              ...(config.permission.sandbox === undefined
                ? [] : ["--sandbox", config.permission.sandbox]),
              ...(config.permission.approval === undefined
                ? [] : ["--ask-for-approval", config.permission.approval])
            ]
          : []),
      ...(config.search === true ? ["--search"] : []),
      ...(config.profile === undefined ? [] : ["--profile", config.profile]),
      ...(config.additionalDirectories ?? []).flatMap((path) => ["--add-dir", path])
    ];
  }

  override launchContextArgs(input: CompileInput<CodexAgentConfig>): string[] {
    // Yui has already scoped and authorized this exact workspace. Declare that
    // invocation-local trust explicitly so Codex does not place its interactive
    // directory trust prompt in front of the managed first input. This does not
    // mutate the user's Codex config or trust any parent/sibling directory.
    const workspaceTrust = [
      "--config",
      `projects={${JSON.stringify(resolve(input.workspace))}={trust_level="trusted"}}`
    ];
    const instructions = [
      input.developerInstructions,
      ...(input.skills === undefined || input.skills.length === 0
        ? []
        : [
            "Yui Role Skills are available at the paths below. Before performing work governed by one, read and follow its SKILL.md on demand; do not treat this list as a user message.",
            ...input.skills.map((skill) => `- ${skill.id}: ${skill.path}/SKILL.md`)
        ])
    ].filter((value): value is string => value !== undefined && value.trim().length > 0);
    if (instructions.length === 0) return workspaceTrust;
    const nativeInstructions = input.codexDeveloperInstructions
      ?? inspectCodexDeveloperInstructions({
        workspace: input.workspace,
        profile: input.config.profile,
        trustWorkspace: true
      });
    if (nativeInstructions.status === "configured") {
      throw new Error(
        "Codex developer_instructions is already configured by "
        + `${nativeInstructions.source}; Yui refuses to replace native developer instructions.`
      );
    }
    return [
      ...workspaceTrust,
      "--config",
      `developer_instructions=${tomlString(instructions.join("\n"))}`
    ];
  }

  compileResume(input: ResumeInput<CodexAgentConfig>): CompiledAgentLaunch {
    const launch = this.compileNew(input);
    return { ...launch, argv: [...launch.argv, "resume", nativeId(input.nativeSessionId)] };
  }
}

class ClaudeAdapter extends BaseAdapter<ClaudeAgentConfig> {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly supportedVersion = "2.1.207";
  readonly capabilities = {
    recover: true,
    interrupt: true,
    nativeSessionDiscovery: "preallocated",
    preInputReadiness: preInputReadinessCapability("claude")
  } as const;

  discoverConfiguration(input: AgentConfigurationDiscoveryInput): Promise<AgentConfigurationCatalog> {
    return discoverClaudeConfiguration(input);
  }

  validateStructured(config: ClaudeAgentConfig): void {
    exact(config, ["adapterId", "model", "effort", "permission", "additionalDirectories",
      "settingsFile", "settingsSources", "advanced"], "Claude Agent config");
    if (config.adapterId !== "claude") throw new Error("Claude Agent config adapter is invalid.");
    optionalText(config.model, "Claude model");
    optionalText(config.effort, "Claude effort");
    validatePaths(config.additionalDirectories, "Claude additional directory");
    if (config.settingsFile !== undefined) absolutePath(config.settingsFile, "Claude settings file");
    optionalTexts(config.settingsSources, "Claude settings source");
    if (config.settingsSources !== undefined && new Set(config.settingsSources).size !== config.settingsSources.length) {
      throw new Error("Claude settings sources contain duplicates.");
    }
    if (config.permission === undefined) {
      throw new Error("Claude permission strategy is required.");
    }
    if (config.permission.strategy === "configured") {
      exact(config.permission, ["strategy", "mode", "allowedTools", "disallowedTools"], "Claude permission config");
      optionalText(config.permission.mode, "Claude permission mode");
      optionalTexts(config.permission.allowedTools, "Claude allowed tool");
      optionalTexts(config.permission.disallowedTools, "Claude disallowed tool");
      if (config.permission.allowedTools?.length === 0
        || config.permission.disallowedTools?.length === 0) {
        throw new Error("Claude configured tool lists must not be empty.");
      }
      requireConfiguredPermissionOption(config.permission, "Claude");
    } else {
      exact(config.permission, ["strategy"], "Claude permission config");
      validateSimplePermissionStrategy(config.permission.strategy, "Claude permission strategy");
    }
    advanced(this.id, config.advanced);
  }

  structuredArgs(config: ClaudeAgentConfig): string[] {
    return [
      ...(config.model === undefined ? [] : ["--model", config.model]),
      ...(config.effort === undefined ? [] : ["--effort", config.effort]),
      ...(config.permission.strategy === "bypass"
        ? ["--dangerously-skip-permissions"]
        : config.permission.strategy === "configured"
          && config.permission.mode !== undefined
          ? ["--permission-mode", config.permission.mode]
          : []),
      ...(config.permission.strategy !== "configured"
        || config.permission.allowedTools === undefined
        ? [] : ["--allowed-tools", ...config.permission.allowedTools]),
      ...(config.permission.strategy !== "configured"
        || config.permission.disallowedTools === undefined
        ? [] : ["--disallowed-tools", ...config.permission.disallowedTools]),
      ...(config.additionalDirectories ?? []).flatMap((path) => ["--add-dir", path]),
      ...(config.settingsFile === undefined ? [] : ["--settings", config.settingsFile]),
      ...(config.settingsSources === undefined ? [] : ["--setting-sources", config.settingsSources.join(",")])
    ];
  }

  override compileNew(input: CompileInput<ClaudeAgentConfig>): CompiledAgentLaunch {
    const launch = super.compileNew(input);
    return input.sessionTitle === undefined
      ? launch
      : {
          ...launch,
          argv: [...launch.argv, "--name", sessionTitle(input.sessionTitle)]
        };
  }

  override launchContextArgs(input: CompileInput<ClaudeAgentConfig>): string[] {
    const sections = [
      input.developerInstructions,
      ...(input.skills ?? []).map((skill) => [
        `# Yui Skill: ${skill.id}`,
        skill.content
      ].join("\n\n"))
    ].filter((value): value is string => value !== undefined && value.trim().length > 0);
    if (sections.length === 0) return [];
    const context = sections.join("\n\n");
    if (input.managedContextFile === undefined) {
      throw new Error(
        "Claude session context requires a managed context file under YUI_HOME."
      );
    }
    writeTextFileAtomically(input.managedContextFile, context);
    return ["--append-system-prompt-file", input.managedContextFile];
  }

  compileResume(input: ResumeInput<ClaudeAgentConfig>): CompiledAgentLaunch {
    const launch = super.compileNew(input);
    return { ...launch, argv: [...launch.argv, "--resume", nativeId(input.nativeSessionId)] };
  }
}

const ADAPTERS: Readonly<Record<AgentAdapterId, AgentAdapter<any>>> = {
  codex: new CodexAdapter(), claude: new ClaudeAdapter()
};

function tomlString(value: string): string {
  if (value.includes("\0")) throw new Error("Agent launch context cannot contain NUL bytes.");
  return JSON.stringify(value);
}

function sessionTitle(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Agent session title is invalid.");
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error("Agent session title is invalid.");
  }
  return normalized;
}
export { supportedAgentAdapterIds };
export function findAgentAdapter(id: string): AgentAdapter | null {
  return id === "codex" || id === "claude" ? ADAPTERS[id] : null;
}
export function resolveAgentAdapter(id: string): AgentAdapter {
  const adapter = findAgentAdapter(id);
  if (adapter === null) throw new Error(`Agent adapter is unsupported: ${id}.`);
  return adapter;
}

export function inspectAgentCapabilities(
  agent: AgentDefinition,
  optionsOrNow: CapabilityInspectionOptions | Date = {}
): CapabilitySnapshot {
  const options = optionsOrNow instanceof Date ? { now: optionsOrNow } : optionsOrNow;
  const now = options.now ?? new Date();
  const run = options.run ?? runProbe;
  const at = now.toISOString();
  const adapter = resolveAgentAdapter(agent.adapterId);
  validateAgentBaseArguments(agent.adapterId, agent.baseArgs);
  const versionRun = run(agent.command, ["--version"]);
  const failure = failed(versionRun);
  if (failure !== undefined) {
    const missing = versionRun.error?.code === "ENOENT";
    return snapshot(agent, adapter, {
      status: missing ? "missing" : "probe-failed", command: agent.command,
      reason: missing ? "Agent command was not found." : failure, probedAt: at
    }, baseline(agent.adapterId), at);
  }
  const version = /(?:^|\D)(\d+\.\d+\.\d+)(?:\D|$)/m
    .exec(output(versionRun.stdout, versionRun.stderr))?.[1];
  if (version === undefined) {
    return snapshot(agent, adapter, {
      status: "probe-failed", command: agent.command,
      reason: "Agent version probe did not return a semantic version.", probedAt: at
    }, baseline(agent.adapterId), at);
  }
  const supported = supports(version, adapter);
  let fields = baseline(agent.adapterId);
  const warnings: string[] = [];
  if (!supported) {
    return snapshot(agent, adapter, {
      status: "unsupported-version", command: agent.command, version,
      reason: adapter.id === "codex"
        ? `Minimum supported version is ${adapter.supportedVersion}.`
        : `Supported version line starts at ${adapter.supportedVersion}.`,
      probedAt: at
    }, fields, at, [`Installed version ${version} is not supported by adapter ${adapter.id}.`]);
  }

  const help = run(agent.command, ["--help"]);
  const helpFailure = failed(help);
  if (adapter.id === "codex" && helpFailure !== undefined) {
    return snapshot(agent, adapter, {
      status: "probe-failed", command: agent.command, version,
      reason: `Required Codex capability probe failed: ${helpFailure}`, probedAt: at
    }, fields, at);
  }
  if (helpFailure === undefined) {
    const helpOutput = output(help.stdout, help.stderr);
    fields = fromHelp(agent.adapterId, helpOutput);
    if (adapter.id === "codex") {
      const missing = missingCodexCapabilities(helpOutput);
      if (missing.length > 0) {
        return snapshot(agent, adapter, {
          status: "unsupported-version", command: agent.command, version,
          reason: `Codex CLI is missing required capabilities: ${missing.join(", ")}.`,
          probedAt: at
        }, fields, at);
      }
      if (compareVersions(version, CODEX_TESTED_THROUGH_VERSION) > 0) {
        warnings.push(
          `Installed Codex version ${version} is newer than the latest tested version `
          + `${CODEX_TESTED_THROUGH_VERSION}; required capabilities were detected.`
        );
      }
    }
  }
  return snapshot(agent, adapter, {
    status: "installed", command: agent.command, version, probedAt: at
  }, fields, at, warnings);
}

function baseline(id: AgentAdapterId): CapabilityField[] {
  if (id === "codex") return [
    field("model", "enum", "degraded", true), field("effort", "enum", "unavailable", true),
    field("permission.strategy", "enum", "available", false, ["default", "bypass", "configured"]),
    field("permission.sandbox", "enum", "available", false, SANDBOXES),
    field("permission.approval", "enum", "available", false, APPROVALS),
    field("profile", "string", "available", true), field("search", "boolean", "available", false, ["true"]),
    field("additionalDirectories", "path-list", "available", true)
  ];
  return [
    field("model", "enum", "degraded", true, ["fable", "opus", "sonnet"]),
    field("effort", "enum", "unavailable", true),
    field("permission.strategy", "enum", "available", false, ["default", "bypass", "configured"]),
    field("permission.mode", "enum", "unavailable", true),
    field("permission.allowedTools", "string-list", "available", true),
    field("permission.disallowedTools", "string-list", "available", true),
    field("additionalDirectories", "path-list", "available", true), field("settingsFile", "path", "available", true),
    field("settingsSources", "string-list", "degraded", false, ["user", "project", "local"])
  ];
}

function fromHelp(id: AgentAdapterId, help: string): CapabilityField[] {
  const fields = baseline(id);
  const replacements = id === "codex"
    ? [permissionStrategyField(help, "--dangerously-bypass-approvals-and-sandbox"),
        choiceField("permission.sandbox", help, "--sandbox", SANDBOXES),
        choiceField("permission.approval", help, "--ask-for-approval", APPROVALS)]
    : [choiceField("model", help, "--model", ["fable", "opus", "sonnet"], true),
        choiceField("effort", help, "--effort", [], true),
        permissionStrategyField(help, "--dangerously-skip-permissions"),
        choiceField("permission.mode", help, "--permission-mode", [], true),
        choiceField("settingsSources", help, "--setting-sources", ["user", "project", "local"])];
  const byKey = new Map(replacements.map((value) => [value.key, value]));
  return fields.map((value) => byKey.get(value.key) ?? value);
}

function permissionStrategyField(help: string, bypassFlag: string): CapabilityField {
  const choices = [
    "default",
    ...(help.includes(bypassFlag) ? ["bypass"] : []),
    "configured"
  ];
  return field(
    "permission.strategy",
    "enum",
    choices.includes("bypass") ? "available" : "degraded",
    false,
    choices
  );
}

function choiceField(key: string, help: string, flag: string, fallback: readonly string[], custom = false): CapabilityField {
  const choices = helpChoices(help, flag);
  return field(key, key === "settingsSources" ? "string-list" : "enum",
    choices.length > 0 ? "available" : fallback.length > 0 ? "degraded" : "unavailable",
    custom, choices.length > 0 ? choices : fallback);
}
function field(key: string, kind: CapabilityField["kind"], status: CapabilityField["status"],
  allowCustom: boolean, choices?: readonly string[]): CapabilityField {
  return { key, kind, status, allowCustom, ...(choices === undefined ? {} : { choices: [...choices] }) };
}
function helpChoices(help: string, flag: string): string[] {
  const lines = help.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.includes(flag));
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length && !/^\s{2,}(?:-[A-Za-z](?:,\s*)?|--)[\w-]/.test(lines[end])) end += 1;
  const body = /(?:\[possible values:\s*([^\]]+)\]|\(choices:\s*([^)]*)\)|\(([^)]*)\))/i
    .exec(lines.slice(start, end).join("\n"));
  return [...new Set((body?.[1] ?? body?.[2] ?? body?.[3] ?? "").replace(/["']/g, "").split(",")
    .map((value) => value.trim().replace(/\.$/, "")).filter((value) => /^[\w.+-]+$/.test(value)))];
}

function snapshot(agent: AgentDefinition, adapter: AgentAdapter, installation: AgentInstallation,
  fields: CapabilityField[], at: string, warnings: string[] = []): CapabilitySnapshot {
  return { schemaVersion: 1, agentId: agent.id, adapterId: agent.adapterId, installation,
    lifecycle: { start: true, resume: true, nativeSessionDiscovery: adapter.capabilities.nativeSessionDiscovery,
      interrupt: true, preInputReadiness: adapter.capabilities.preInputReadiness }, fields, warnings, refreshedAt: at };
}
function runProbe(command: string, args: readonly string[]): AgentProbeResult {
  const result = spawnSync(command, [...args], { encoding: "utf8", shell: false, timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""),
    ...(result.error === undefined ? {} : { error: result.error }) };
}
function failed(result: AgentProbeResult): string | undefined {
  if (result.error !== undefined) return result.error.code === "ETIMEDOUT"
    ? `Agent probe timed out after ${PROBE_TIMEOUT_MS} ms.` : "Agent probe failed to start.";
  return result.status === 0 ? undefined : `Agent probe exited with status ${result.status ?? "unknown"}.`;
}
function output(stdout: string, stderr: string): string {
  const value = `${stdout}\n${stderr}`;
  if (Buffer.byteLength(value, "utf8") > PROBE_MAX_BYTES) throw new Error("Agent probe output exceeded 1 MiB.");
  return value;
}
function supports(version: string, adapter: AgentAdapter): boolean {
  if (adapter.id === "codex") return compareVersions(version, adapter.supportedVersion) >= 0;
  const left = version.split(".").map(Number), right = adapter.supportedVersion.split(".").map(Number);
  return left[0] === right[0] && left[1] === right[1] && left[2] >= right[2];
}

function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = leftVersion.split(".").map(Number);
  const right = rightVersion.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function missingCodexCapabilities(help: string): string[] {
  const required: readonly (readonly [RegExp, string])[] = [
    [/(?:^|\s)--config(?:\s|[=<,]|$)/m, "--config"],
    [/^\s*resume(?:\s|$)/m, "resume"]
  ];
  return required.flatMap(([pattern, label]) => pattern.test(help) ? [] : [label]);
}

function cloneConfig(config: RoleAgentConfig, paths: readonly string[] | undefined): RoleAgentConfig {
  const advancedConfig = config.advanced?.rawArgs === undefined ? config.advanced : { rawArgs: [...config.advanced.rawArgs] };
  if (config.adapterId === "codex") return { ...config,
    permission: { ...config.permission },
    ...(paths === undefined ? {} : { additionalDirectories: [...paths] }),
    ...(advancedConfig === undefined ? {} : { advanced: advancedConfig }) };
  return { ...config,
    permission: config.permission.strategy === "configured"
      ? { ...config.permission,
          ...(config.permission.allowedTools === undefined ? {} : { allowedTools: [...config.permission.allowedTools] }),
          ...(config.permission.disallowedTools === undefined ? {} : { disallowedTools: [...config.permission.disallowedTools] }) }
      : { ...config.permission },
    ...(paths === undefined ? {} : { additionalDirectories: [...paths] }),
    ...(config.settingsSources === undefined ? {} : { settingsSources: [...config.settingsSources] }),
    ...(advancedConfig === undefined ? {} : { advanced: advancedConfig }) };
}

export function defaultRoleAgentConfig(adapterId: AgentAdapterId): RoleAgentConfig {
  return adapterId === "codex"
    ? { adapterId: "codex", permission: { strategy: "bypass" } }
    : { adapterId: "claude", permission: { strategy: "bypass" } };
}

function validateSimplePermissionStrategy(value: unknown, label: string): void {
  if (value !== "default" && value !== "bypass") {
    throw new Error(`${label} is invalid.`);
  }
}

function requireConfiguredPermissionOption(
  permission: Readonly<Record<string, unknown>>,
  provider: string
): void {
  if (Object.keys(permission).every((key) => key === "strategy")) {
    throw new Error(
      `${provider} configured permission requires at least one provider-native option.`
    );
  }
}
function advanced(id: AgentAdapterId, value: AdvancedAgentConfig | undefined): void {
  if (value === undefined) return;
  exact(value, ["rawArgs"], "Advanced Agent config");
  validateAgentAdvancedArguments(id, value.rawArgs ?? []);
}
function validatePaths(values: readonly string[] | undefined, label: string): void {
  optionalTexts(values, label);
  for (const value of values ?? []) absolutePath(value, label);
}
function canonicalDirectories(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => {
    absolutePath(value, "Additional directory");
    let path: string;
    try { path = realpathSync(value); } catch { throw new Error("Additional directory does not exist or cannot be resolved."); }
    if (!statSync(path).isDirectory()) throw new Error("Additional directory is not a directory.");
    return path;
  }))].sort();
}
function absolutePath(value: string, label: string): void {
  text(value, label);
  if (!isAbsolute(value) || resolve(value) !== value || /[\r\n\0{}]/.test(value)) {
    throw new Error(`${label} must be an absolute canonical path.`);
  }
}
function optionalText(value: unknown, label: string): void {
  if (value !== undefined) text(value, label);
}
function optionalTexts(values: readonly string[] | undefined, label: string): void {
  if (values === undefined) return;
  if (!Array.isArray(values)) throw new Error(`${label} list must be an array.`);
  values.forEach((value) => text(value, label));
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}
function exact(value: object, keys: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains an unsupported field.`);
}
function nativeId(value: string): string {
  text(value, "Native session id");
  if (value.trim() !== value) throw new Error("Native session id must not contain surrounding whitespace.");
  return value;
}
