import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  type BigIntStats
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import type {
  AgentDefinition,
  ProbeExecutablePin,
  ProbeFileWitness,
  ProbeInterpreterWitness
} from "../agent/agent.js";
import {
  MAX_PROBE_INTERPRETER_WITNESSES,
  MAX_PROBE_WITNESS_FILE_BYTES,
  MAX_PROBE_WITNESS_TOTAL_BYTES
} from "../agent/agent.js";
import {
  AGENT_ADAPTER_CATALOG,
  supportedAgentAdapterIds
} from "../agent/adapterCatalog.js";
import {
  ownedArgumentsForAdapter,
  validateAgentAdvancedArguments,
  validateAgentBaseArguments
} from "../agent/argumentPolicy.js";
import type {
  ClaudeRoleAgentConfig,
  CodexRoleAgentConfig,
  RoleAgentConfig
} from "../role/role.js";
import {
  comparePermissionEnvelopes,
  type ConfigFingerprint,
  type PermissionChange,
  type PermissionEnvelope
} from "./agentExecutor.js";

const CAPABILITY_COMMAND_TIMEOUT_MS = 2_000;
const CAPABILITY_MAX_BUFFER = 10 * 1024 * 1024;
const CAPABILITY_PARSE_LIMIT = 1024 * 1024;
const CLAUDE_MODEL_SUGGESTIONS = ["fable", "opus", "sonnet"];
const PROBE_SYSTEM_PATH = ["/usr/bin", "/bin"];
const PROBE_HASH_BUDGET_MS = 1_000;

export type ProbeExecutableResolutionContext = {
  searchPath: string[];
};

class UnsafeProbeOutputError extends Error {
  constructor() {
    super("Agent capability probe output failed security validation.");
    this.name = "UnsafeProbeOutputError";
  }
}

class ProbeRefreshRequiredError extends Error {
  constructor() {
    super("Agent capability probe pin requires refresh.");
    this.name = "ProbeRefreshRequiredError";
  }
}

class ProbeVerificationBudgetExceededError extends Error {
  constructor() {
    super("Agent capability probe verification exceeded its resource budget.");
    this.name = "ProbeVerificationBudgetExceededError";
  }
}

type ProbeHashBudget = {
  deadline: number;
  remainingBytes: number;
  exceeded: boolean;
};

type ProbeContext = {
  environment: NodeJS.ProcessEnv;
  processEnvironment: NodeJS.ProcessEnv;
  protectedValues: readonly string[];
  executable: string;
  cwd: string;
  verify(): boolean;
  invocation(args: string[]): ProbeInvocation;
  cleanup(): void;
};

type ProbeInvocation = {
  command: string;
  args: string[];
  stdio: Array<"ignore" | "pipe" | number>;
};

export type CapabilityChoice = {
  value: string;
  label: string;
  source: "installed-cli" | "installed-cli-bundled" | "installed-cli-help" | "adapter-baseline";
  available: boolean;
};

export type CapabilityField = {
  key: string;
  label: string;
  kind: "enum" | "boolean" | "string" | "string-list" | "path" | "path-list";
  status: "available" | "degraded" | "unavailable";
  source: CapabilityChoice["source"];
  refreshedAt: string;
  choices?: CapabilityChoice[];
  choicesByModel?: Record<string, CapabilityChoice[]>;
  defaultByModel?: Record<string, string>;
  allowInherit: true;
  allowClear: true;
  defaultPolicy: "inherit";
  allowCustom: boolean;
  unavailableReason?: string;
};

export type AgentInstallation = {
  status: "installed" | "missing" | "unsupported-version" | "probe-failed" | "unsafe-output" | "unavailable" | "refresh-required";
  command: string;
  resolvedPath?: string;
  version?: string;
  reason?: string;
  probedAt: string;
};

export type CapabilitySnapshot = {
  schemaVersion: 1;
  agentId: string;
  adapterId: string;
  installation: AgentInstallation;
  lifecycle: {
    start: boolean;
    resume: boolean;
    nativeSessionDiscovery: "runtime" | "preallocated" | "none";
    interrupt: boolean;
  };
  fields: CapabilityField[];
  warnings: string[];
  refreshedAt: string;
};

export type DiscoveryInput = {
  agent: AgentDefinition;
  version?: string;
  now: Date;
  fixtures?: { bundledModels?: string; help?: string };
  processEnvironment?: NodeJS.ProcessEnv;
  protectedValues?: readonly string[];
};

export type CompileInput<TConfig extends RoleAgentConfig = RoleAgentConfig> = {
  agent: AgentDefinition;
  config: TConfig;
  workspace: string;
  systemPrompt?: string;
  snapshot: CapabilitySnapshot;
  validationMode?: "configure" | "replay" | "unprobed";
};

export type ResumeInput<TConfig extends RoleAgentConfig = RoleAgentConfig> = CompileInput<TConfig> & {
  nativeSessionId: string;
};

export type CompiledAgentLaunch = {
  argv: string[];
  fingerprint: ConfigFingerprint;
  sessionStrategy: "runtime-discovery" | "preallocated";
};

export type FingerprintContext = {
  workspace?: string;
  systemPrompt?: string;
  agent?: AgentDefinition;
};

export interface AgentAdapter<TConfig extends RoleAgentConfig = RoleAgentConfig> {
  readonly id: string;
  readonly supportedVersion: string;
  readonly capabilities: {
    recover: boolean;
    interrupt: boolean;
    nativeSessionDiscovery: "runtime" | "preallocated" | "none";
  };
  probeInstallation(
    agent: AgentDefinition,
    now: Date,
    processEnvironment?: NodeJS.ProcessEnv
  ): AgentInstallation;
  discoverCapabilities(input: DiscoveryInput): CapabilitySnapshot;
  unavailableCapabilities(input: DiscoveryInput, reason: string): CapabilitySnapshot;
  validateConfig(input: CompileInput<TConfig>): void;
  compileNew(input: CompileInput<TConfig>): CompiledAgentLaunch;
  compileResume(input: ResumeInput<TConfig>): CompiledAgentLaunch;
  canonicalizeConfig(config: TConfig): TConfig;
  fingerprint(config: TConfig, context?: FingerprintContext): ConfigFingerprint;
  permissionEnvelope(config: TConfig): PermissionEnvelope;
  comparePermission(previous: PermissionEnvelope, candidate: PermissionEnvelope): PermissionChange;
  reservedArguments(): string[];
}

export function findReservedAgentArgument(
  adapter: AgentAdapter,
  argument: string
): string | null {
  if (argument === "--") return "--";

  const reserved = new Set(adapter.reservedArguments());
  const equalsToken = argument.split("=", 1)[0];
  if (reserved.has(argument) || reserved.has(equalsToken)) return equalsToken;

  if (!argument.startsWith("-") || argument.startsWith("--")) return null;
  const reservedShortOptions = new Set(
    [...reserved].filter((option) => /^-[^-]$/.test(option))
  );
  for (const flag of argument.slice(1)) {
    const option = `-${flag}`;
    if (reservedShortOptions.has(option)) return option;
  }
  return null;
}

abstract class BaseAdapter<TConfig extends RoleAgentConfig> implements AgentAdapter<TConfig> {
  abstract readonly id: string;
  abstract readonly supportedVersion: string;
  abstract readonly capabilities: AgentAdapter<TConfig>["capabilities"];
  abstract discoverFields(input: DiscoveryInput): CapabilityField[];
  abstract unavailableFields(now: Date, reason: string): CapabilityField[];
  abstract compileStructuredCanonical(config: TConfig): string[];
  abstract permissionEnvelopeCanonical(config: TConfig): PermissionEnvelope;
  abstract reservedArguments(): string[];

  probeInstallation(
    agent: AgentDefinition,
    now: Date,
    processEnvironment: NodeJS.ProcessEnv = process.env
  ): AgentInstallation {
    if (!hasCanonicalProbeCommand(agent, this.id)) {
      return unavailableInstallation(agent, now);
    }
    try {
      assertSafeAgentBaseArgs(this, agent);
    } catch {
      return probeFailure(agent, now, undefined, "Agent base arguments are invalid.");
    }
    const deadline = Date.now() + CAPABILITY_COMMAND_TIMEOUT_MS;
    let context: ProbeContext | null;
    try {
      context = createProbeContext(agent, processEnvironment, undefined, deadline);
    } catch (error) {
      if (error instanceof ProbeVerificationBudgetExceededError) {
        return probeFailure(agent, now, undefined, timeoutDiagnostic("Agent probe verification"));
      }
      throw error;
    }
    if (context === null) return unavailableProbePinInstallation(agent, now, processEnvironment);
    try {
      try {
        return probeInstallationWithContext(
          agent,
          now,
          this.supportedVersion,
          context,
          remainingBudget(deadline)
        );
      } catch (error) {
        if (isProbeTimeout(error)) {
          return probeFailure(agent, now, context.executable, timeoutDiagnostic("Agent version probe"));
        }
        throw error;
      }
    } finally {
      context.cleanup();
    }
  }

  discoverCapabilities(input: DiscoveryInput): CapabilitySnapshot {
    try {
      const protectedValues = input.protectedValues ?? protectedAgentValues(
        input.agent,
        input.processEnvironment ?? process.env
      );
      if (probeDataIsUnsafe([
        input.fixtures?.bundledModels,
        input.fixtures?.help
      ], protectedValues)) {
        throw new UnsafeProbeOutputError();
      }
      const discovered = snapshot(
        input.agent,
        this,
        input.version ?? this.supportedVersion,
        input.now,
        this.discoverFields(input)
      );
      assertProbeValueSafe(discovered, protectedValues);
      return {
        ...discovered,
        warnings: unique([
          ...discovered.warnings,
          ...discovered.fields.flatMap(({ status, unavailableReason }) =>
            status === "available" || unavailableReason === undefined ? [] : [unavailableReason])
        ])
      };
    } catch (error) {
      if (error instanceof UnsafeProbeOutputError) {
        return unsafeCapabilitySnapshot(input.agent, this, input.version, input.now);
      }
      return this.unavailableCapabilities(input, stableDiscoveryFailure(error));
    }
  }

  unavailableCapabilities(input: DiscoveryInput, reason: string): CapabilitySnapshot {
    const sanitized = sanitizeDiagnostic(reason);
    const result = snapshot(
      input.agent,
      this,
      input.version ?? this.supportedVersion,
      input.now,
      this.unavailableFields(input.now, sanitized)
    );
    return { ...result, warnings: unique([...result.warnings, sanitized]) };
  }

  validateConfig({ agent, config, snapshot, validationMode = "configure" }: CompileInput<TConfig>): void {
    if (agent.adapterId !== this.id || config.adapterId !== this.id || snapshot.adapterId !== this.id) {
      throw new Error(`Agent adapter identity mismatch: expected ${this.id}.`);
    }
    if (snapshot.installation.status !== "installed" &&
      !(validationMode === "replay" &&
        (snapshot.installation.status === "probe-failed" || snapshot.installation.status === "unavailable")) &&
      !(validationMode === "unprobed" && isUnprobedCustomAgent(agent, snapshot))) {
      throw new Error(`Agent installation is unavailable: ${snapshot.installation.status}.`);
    }
    validateAgentBaseArguments(this.id, agent.baseArgs, this.reservedArguments());
    const rawArgs = config.advanced?.rawArgs ?? [];
    validateAgentAdvancedArguments(this.id, rawArgs, this.reservedArguments());
    validateSelectedEnum(config, snapshot, validationMode);
  }

  compileNew(input: CompileInput<TConfig>): CompiledAgentLaunch {
    this.validateConfig(input);
    const config = this.canonicalizeConfig(input.config);
    return {
      argv: [...input.agent.baseArgs, ...this.compileStructuredCanonical(config), ...(config.advanced?.rawArgs ?? [])],
      fingerprint: this.fingerprintCanonical(config, {
        workspace: input.workspace,
        systemPrompt: input.systemPrompt,
        agent: input.agent
      }),
      sessionStrategy: this.capabilities.nativeSessionDiscovery === "preallocated" ? "preallocated" : "runtime-discovery"
    };
  }

  abstract compileResume(input: ResumeInput<TConfig>): CompiledAgentLaunch;

  canonicalizeConfig(config: TConfig): TConfig {
    if (!("additionalDirectories" in config) || config.additionalDirectories === undefined) return config;
    return {
      ...config,
      additionalDirectories: canonicalAdditionalDirectories(config.additionalDirectories)
    } as TConfig;
  }

  fingerprint(config: TConfig, context: FingerprintContext = {}): ConfigFingerprint {
    return this.fingerprintCanonical(this.canonicalizeConfig(config), context);
  }

  permissionEnvelope(config: TConfig): PermissionEnvelope {
    return this.permissionEnvelopeCanonical(this.canonicalizeConfig(config));
  }

  private fingerprintCanonical(config: TConfig, context: FingerprintContext = {}): ConfigFingerprint {
    const { replayable, sessionBound } = splitFingerprintInput(config, context);
    const normalized = canonicalize({ config, context });
    const permission = canonicalize(this.permissionEnvelopeCanonical(config));
    return {
      overall: digest(normalized),
      replayable: digest(canonicalize(replayable)),
      permission: digest(permission),
      sessionBound: digest(canonicalize(sessionBound))
    };
  }

  comparePermission(previous: PermissionEnvelope, candidate: PermissionEnvelope): PermissionChange {
    return comparePermissionEnvelopes(previous, candidate);
  }
}

function probeInstallationWithContext(
  agent: AgentDefinition,
  now: Date,
  supportedVersion: string,
  context: ProbeContext,
  timeout: number
): AgentInstallation {
  if (!context.verify()) return refreshRequiredInstallation(agent, now);
  const invocation = context.invocation(["--version"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: context.cwd,
    encoding: "utf8",
    env: context.environment,
    stdio: invocation.stdio,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: CAPABILITY_MAX_BUFFER
  });
  if (probeDataIsUnsafe([result.stdout, result.stderr, result.error?.message], context.protectedValues)) {
    return unsafeInstallation(agent, now);
  }
  if (result.error !== undefined) {
    const code = "code" in result.error ? String(result.error.code) : "";
    return {
      status: code === "ENOENT" ? "missing" : "probe-failed",
      command: agent.command,
      resolvedPath: context.executable,
      reason: code === "ETIMEDOUT"
        ? timeoutDiagnostic("Agent version probe")
        : "Agent version probe failed to start.",
      probedAt: now.toISOString()
    };
  }
  if (result.status !== 0) {
    return probeFailure(
      agent,
      now,
      context.executable,
      `Agent version probe exited with status ${result.status ?? "unknown"}.`
    );
  }
  const version = extractVersion(String(result.stdout ?? "").trim());
  if (version === undefined) {
    return probeFailure(agent, now, context.executable, "Agent version probe did not return a semantic version.");
  }
  const supported = isSupportedVersion(version, supportedVersion);
  return {
    status: supported ? "installed" : "unsupported-version",
    command: agent.command,
    resolvedPath: context.executable,
    version,
    ...(supported ? {} : { reason: `Supported version line starts at ${supportedVersion}.` }),
    probedAt: now.toISOString()
  };
}

class CodexAdapter extends BaseAdapter<CodexRoleAgentConfig> {
  readonly id = "codex";
  readonly supportedVersion = "0.144.1";
  readonly capabilities = { recover: true, interrupt: true, nativeSessionDiscovery: "runtime" as const };

  discoverFields({ agent, now, fixtures, processEnvironment, protectedValues }: DiscoveryInput): CapabilityField[] {
    const raw = fixtures?.bundledModels ?? runText(
      agent,
      ["debug", "models", "--bundled"],
      processEnvironment,
      protectedValues
    );
    const modelRecords = parseCodexModelRecords(raw);
    const choicesByModel = codexEffortChoices(modelRecords);
    const modelChoices = codexModelChoices(modelRecords);
    let help: string | undefined;
    let helpFailure: string | undefined;
    try {
      help = fixtures?.help ?? runText(agent, ["--help"], processEnvironment, protectedValues);
    } catch (error) {
      if (error instanceof UnsafeProbeOutputError) throw error;
      help = undefined;
      helpFailure = "Installed CLI help is unavailable.";
    }
    const sandboxChoices = help === undefined ? [] : extractDeclaredChoices(help, "--sandbox");
    const approvalChoices = help === undefined ? [] : extractDeclaredChoices(help, "--ask-for-approval");
    return [
      field("model", "Model", "enum", "installed-cli-bundled", now, { choices: modelChoices, allowCustom: true }),
      {
        ...field("effort", "Reasoning effort", "enum", "installed-cli-bundled", now),
        choicesByModel,
        defaultByModel: Object.fromEntries(modelRecords.flatMap((model) =>
          model.defaultReasoningLevel === undefined ? [] : [[model.slug, model.defaultReasoningLevel]]
        ))
      },
      ...codexBaselineFields(now, {
        sandbox: sandboxChoices,
        approval: approvalChoices,
        sandboxReason: sandboxChoices.length > 0 ? undefined : helpFailure ?? "Sandbox choices were not found in installed CLI help.",
        approvalReason: approvalChoices.length > 0 ? undefined : helpFailure ?? "Approval choices were not found in installed CLI help."
      })
    ];
  }

  unavailableFields(now: Date, reason: string): CapabilityField[] {
    return [
      field("model", "Model", "enum", "adapter-baseline", now, {
        status: "degraded",
        allowCustom: true,
        unavailableReason: reason
      }),
      field("effort", "Reasoning effort", "enum", "adapter-baseline", now, {
        status: "unavailable",
        unavailableReason: reason
      }),
      ...codexBaselineFields(now, { sandboxReason: reason, approvalReason: reason })
    ];
  }

  compileStructuredCanonical(config: CodexRoleAgentConfig): string[] {
    return compact([
      ...(config.model === undefined ? [] : ["--model", config.model]),
      ...(config.effort === undefined ? [] : ["--config", `model_reasoning_effort=\"${config.effort}\"`]),
      ...(config.permission?.sandbox === undefined ? [] : ["--sandbox", config.permission.sandbox]),
      ...(config.permission?.approval === undefined ? [] : ["--ask-for-approval", config.permission.approval]),
      ...(config.search === true ? ["--search"] : []),
      ...(config.profile === undefined ? [] : ["--profile", config.profile]),
      ...(config.additionalDirectories ?? []).flatMap((path) => ["--add-dir", path])
    ]);
  }

  permissionEnvelopeCanonical(config: CodexRoleAgentConfig): PermissionEnvelope {
    return {
      adapterId: "codex",
      ...(config.permission?.sandbox === undefined ? {} : { sandbox: config.permission.sandbox }),
      ...(config.permission?.approval === undefined ? {} : { approval: config.permission.approval }),
      additionalDirectoryHashes: hashLengthDelimitedStringSet(
        config.additionalDirectories ?? []
      )
    };
  }

  compileResume(input: ResumeInput<CodexRoleAgentConfig>): CompiledAgentLaunch {
    const compiled = this.compileNew(input);
    return { ...compiled, argv: [...compiled.argv, "resume", requireNativeId(input.nativeSessionId)] };
  }

  reservedArguments(): string[] {
    return [...ownedArgumentsForAdapter(this.id)];
  }
}

class ClaudeAdapter extends BaseAdapter<ClaudeRoleAgentConfig> {
  readonly id = "claude";
  readonly supportedVersion = "2.1.207";
  readonly capabilities = { recover: true, interrupt: true, nativeSessionDiscovery: "preallocated" as const };

  discoverFields({ agent, now, fixtures, processEnvironment, protectedValues }: DiscoveryInput): CapabilityField[] {
    const help = fixtures?.help ?? runText(agent, ["--help"], processEnvironment, protectedValues);
    const models = extractQuotedSuggestions(help, "--model");
    const efforts = extractOptionChoices(help, "--effort");
    const modes = extractOptionChoices(help, "--permission-mode");
    const settingsSources = extractOptionChoices(help, "--setting-sources");
    return [
      field("model", "Model", "enum", models.length > 0 ? "installed-cli-help" : "adapter-baseline", now, {
        choices: (models.length > 0 ? models : CLAUDE_MODEL_SUGGESTIONS)
          .map((value) => choice(value, value, models.length > 0 ? "installed-cli-help" : "adapter-baseline")),
        allowCustom: true,
        status: models.length > 0 ? "available" : "degraded"
      }),
      discoveredEnumField("effort", "Reasoning effort", efforts, now),
      discoveredEnumField("permission.mode", "Permission mode", modes, now),
      ...claudeBaselineFields(now, settingsSources)
    ];
  }

  unavailableFields(now: Date, reason: string): CapabilityField[] {
    return [
      field("model", "Model", "enum", "adapter-baseline", now, {
        choices: CLAUDE_MODEL_SUGGESTIONS.map((value) => choice(value, value, "adapter-baseline")),
        status: "degraded",
        allowCustom: true,
        unavailableReason: reason
      }),
      field("effort", "Reasoning effort", "enum", "adapter-baseline", now, {
        status: "unavailable",
        unavailableReason: reason
      }),
      field("permission.mode", "Permission mode", "enum", "adapter-baseline", now, {
        status: "unavailable",
        unavailableReason: reason
      }),
      ...claudeBaselineFields(now)
    ];
  }

  compileStructuredCanonical(config: ClaudeRoleAgentConfig): string[] {
    return compact([
      ...(config.model === undefined ? [] : ["--model", config.model]),
      ...(config.effort === undefined ? [] : ["--effort", config.effort]),
      ...(config.permission?.mode === undefined ? [] : ["--permission-mode", config.permission.mode]),
      ...(config.permission?.allowedTools === undefined ? [] : ["--allowed-tools", ...config.permission.allowedTools]),
      ...(config.permission?.disallowedTools === undefined ? [] : ["--disallowed-tools", ...config.permission.disallowedTools]),
      ...(config.additionalDirectories ?? []).flatMap((path) => ["--add-dir", path]),
      ...(config.settingsFile === undefined ? [] : ["--settings", config.settingsFile]),
      ...(config.settingsSources === undefined ? [] : ["--setting-sources", config.settingsSources.join(",")])
    ]);
  }

  permissionEnvelopeCanonical(config: ClaudeRoleAgentConfig): PermissionEnvelope {
    return {
      adapterId: "claude",
      ...(config.permission?.mode === undefined ? {} : { mode: config.permission.mode }),
      ...(config.permission?.allowedTools === undefined
        ? {}
        : { allowedToolHashes: hashStringSet(config.permission.allowedTools) }),
      ...(config.permission?.disallowedTools === undefined
        ? {}
        : { disallowedToolHashes: hashStringSet(config.permission.disallowedTools) }),
      additionalDirectoryHashes: hashLengthDelimitedStringSet(
        config.additionalDirectories ?? []
      )
    };
  }

  compileResume(input: ResumeInput<ClaudeRoleAgentConfig>): CompiledAgentLaunch {
    const compiled = this.compileNew(input);
    return { ...compiled, argv: [...compiled.argv, "--resume", requireNativeId(input.nativeSessionId)] };
  }

  reservedArguments(): string[] {
    return [...ownedArgumentsForAdapter(this.id)];
  }
}

const adapters = new Map<string, AgentAdapter>([
  ["codex", new CodexAdapter()],
  ["claude", new ClaudeAdapter()]
]);

for (const { id } of AGENT_ADAPTER_CATALOG) {
  if (!adapters.has(id)) throw new Error(`Agent adapter catalog has no implementation: ${id}.`);
}
if (adapters.size !== AGENT_ADAPTER_CATALOG.length) {
  throw new Error("Agent adapter implementation is missing from the adapter catalog.");
}

export { supportedAgentAdapterIds };

export function findAgentAdapter(id: string): AgentAdapter | null {
  return adapters.get(id) ?? null;
}

export function resolveAgentAdapter(id: string): AgentAdapter {
  const adapter = adapters.get(id);
  if (adapter === undefined) throw new Error(`Agent adapter is not supported: ${id}.`);
  return adapter;
}

export function inspectAgentCapabilities(
  agent: AgentDefinition,
  now = new Date(),
  processEnvironment: NodeJS.ProcessEnv = process.env
): CapabilitySnapshot {
  const adapter = resolveAgentAdapter(agent.adapterId);
  const processSnapshot = { ...processEnvironment };
  const protectedValues = protectedAgentValues(agent, processSnapshot);
  const lifecycle = {
    start: true,
    resume: adapter.capabilities.recover,
    nativeSessionDiscovery: adapter.capabilities.nativeSessionDiscovery,
    interrupt: adapter.capabilities.interrupt
  };
  const unavailableFor = (installation: AgentInstallation): CapabilitySnapshot => {
    const unavailable = adapter.unavailableCapabilities(
      {
        agent,
        version: installation.version ?? adapter.supportedVersion,
        now,
        processEnvironment: processSnapshot,
        protectedValues
      },
      installation.reason ?? `Agent installation status is ${installation.status}.`
    );
    return {
      ...unavailable,
      installation,
      lifecycle,
      warnings: unique([
        ...unavailable.warnings,
        ...(installation.reason === undefined ? [] : [sanitizeDiagnostic(installation.reason)])
      ])
    };
  };

  if (!hasCanonicalProbeCommand(agent, adapter.id)) {
    return unavailableFor(unavailableInstallation(agent, now));
  }
  try {
    assertSafeAgentBaseArgs(adapter, agent);
  } catch {
    return unavailableFor(probeFailure(agent, now, undefined, "Agent base arguments are invalid."));
  }

  const deadline = Date.now() + CAPABILITY_COMMAND_TIMEOUT_MS;
  let context: ProbeContext | null;
  try {
    context = createProbeContext(agent, processSnapshot, protectedValues, deadline);
  } catch (error) {
    return unavailableFor(probeFailure(
      agent,
      now,
      undefined,
      error instanceof ProbeVerificationBudgetExceededError
        ? timeoutDiagnostic("Agent probe verification")
        : "Agent capability probe failed to initialize."
    ));
  }
  if (context === null) return unavailableFor(unavailableProbePinInstallation(agent, now, processSnapshot));

  try {
    let installation: AgentInstallation;
    try {
      installation = probeInstallationWithContext(
        agent,
        now,
        adapter.supportedVersion,
        context,
        remainingBudget(deadline)
      );
    } catch (error) {
      if (isProbeTimeout(error)) {
        return unavailableFor(probeFailure(
          agent,
          now,
          context.executable,
          timeoutDiagnostic("Agent version probe")
        ));
      }
      throw error;
    }
    if (installation.status !== "installed" || installation.version === undefined) {
      return unavailableFor(installation);
    }

    let discovered: CapabilitySnapshot;
    try {
      if (adapter.id === "codex") {
        const bundledModels = runTextWithContext(
          ["debug", "models", "--bundled"],
          context,
          remainingBudget(deadline)
        );
        let help = "";
        try {
          help = runTextWithContext(["--help"], context, remainingBudget(deadline));
        } catch (error) {
          if (error instanceof ProbeRefreshRequiredError || error instanceof UnsafeProbeOutputError) throw error;
        }
        discovered = adapter.discoverCapabilities({
          agent,
          version: installation.version,
          now,
          fixtures: { bundledModels, help },
          processEnvironment: processSnapshot,
          protectedValues
        });
      } else {
        const help = runTextWithContext(["--help"], context, remainingBudget(deadline));
        discovered = adapter.discoverCapabilities({
          agent,
          version: installation.version,
          now,
          fixtures: { help },
          processEnvironment: processSnapshot,
          protectedValues
        });
      }
    } catch (error) {
      if (error instanceof ProbeRefreshRequiredError) {
        return unavailableFor(refreshRequiredInstallation(agent, now));
      }
      if (error instanceof UnsafeProbeOutputError) {
        discovered = unsafeCapabilitySnapshot(agent, adapter, installation.version, now);
      } else {
        discovered = adapter.unavailableCapabilities(
          {
            agent,
            version: installation.version,
            now,
            processEnvironment: processSnapshot,
            protectedValues
          },
          stableDiscoveryFailure(error)
        );
      }
    }
    return {
      ...discovered,
      installation: discovered.installation.status === "unsafe-output" ? discovered.installation : installation,
      lifecycle
    };
  } finally {
    context.cleanup();
  }
}

export function isUnprobedCustomAgent(
  agent: AgentDefinition,
  snapshot: Pick<CapabilitySnapshot, "installation">
): boolean {
  return agent.command !== agent.adapterId && snapshot.installation.status === "unavailable";
}

export async function inspectAgentCapabilitiesAsync(
  agent: AgentDefinition,
  now = new Date(),
  options: {
    budgetMs?: number;
    processEnvironment?: NodeJS.ProcessEnv;
    beforeProbeSpawn?: (args: readonly string[]) => void;
  } = {}
): Promise<CapabilitySnapshot> {
  const adapter = resolveAgentAdapter(agent.adapterId);
  const budgetMs = options.budgetMs ?? CAPABILITY_COMMAND_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(1, budgetMs);
  if (!hasCanonicalProbeCommand(agent, adapter.id)) {
    return unavailableInspection(agent, adapter, unavailableInstallation(agent, now), now);
  }
  let context: ProbeContext;
  try {
    assertSafeAgentBaseArgs(adapter, agent);
    const created = createProbeContext(
      agent,
      options.processEnvironment ?? process.env,
      undefined,
      deadline
    );
    if (created === null) {
      return unavailableInspection(
        agent,
        adapter,
        unavailableProbePinInstallation(agent, now, options.processEnvironment ?? process.env),
        now
      );
    }
    context = created;
  } catch (error) {
    const installation = probeFailure(
      agent,
      now,
      undefined,
      error instanceof ProbeVerificationBudgetExceededError
        ? timeoutDiagnostic("Agent probe verification")
        : "Agent base arguments are invalid."
    );
    return unavailableInspection(agent, adapter, installation, now);
  }
  try {
    const resolvedPath = context.executable;
    let versionOutput: string;
    try {
      const versionResult = await runCommandAsync(
        agent,
        ["--version"],
        context,
        remainingBudget(deadline),
        options.beforeProbeSpawn
      );
      versionOutput = versionResult.stdout.trim();
    } catch (error) {
      if (error instanceof ProbeRefreshRequiredError) {
        return unavailableInspection(agent, adapter, refreshRequiredInstallation(agent, now), now);
      }
      if (error instanceof UnsafeProbeOutputError) {
        return unavailableInspection(agent, adapter, unsafeInstallation(agent, now), now);
      }
      const installation = asyncProbeFailure(agent, now, resolvedPath, error);
      return unavailableInspection(agent, adapter, installation, now);
    }
    const version = extractVersion(versionOutput);
    if (version === undefined) {
      return unavailableInspection(
        agent,
        adapter,
        probeFailure(agent, now, resolvedPath, "Agent version probe did not return a semantic version."),
        now
      );
    }
    const supported = isSupportedVersion(version, adapter.supportedVersion);
    const installation: AgentInstallation = {
      status: supported ? "installed" : "unsupported-version",
      command: agent.command,
      resolvedPath,
      version,
      ...(supported ? {} : { reason: `Supported version line starts at ${adapter.supportedVersion}.` }),
      probedAt: now.toISOString()
    };
    if (!supported) return unavailableInspection(agent, adapter, installation, now);

    let discovered: CapabilitySnapshot;
    try {
      if (adapter.id === "codex") {
        const timeout = remainingBudget(deadline);
        const [bundled, help] = await Promise.allSettled([
          runCommandAsync(agent, ["debug", "models", "--bundled"], context, timeout, options.beforeProbeSpawn),
          runCommandAsync(agent, ["--help"], context, timeout, options.beforeProbeSpawn)
        ]);
        if (bundled.status === "rejected") throw bundled.reason;
        if (help.status === "rejected" && help.reason instanceof UnsafeProbeOutputError) throw help.reason;
        discovered = adapter.discoverCapabilities({
          agent,
          version,
          now,
          fixtures: {
            bundledModels: bundled.value.stdout,
            help: help.status === "fulfilled" ? help.value.stdout : ""
          },
          processEnvironment: context.processEnvironment,
          protectedValues: context.protectedValues
        });
      } else {
        const help = await runCommandAsync(
          agent,
          ["--help"],
          context,
          remainingBudget(deadline),
          options.beforeProbeSpawn
        );
        discovered = adapter.discoverCapabilities({
          agent,
          version,
          now,
          fixtures: { help: help.stdout },
          processEnvironment: context.processEnvironment,
          protectedValues: context.protectedValues
        });
      }
    } catch (error) {
      if (error instanceof ProbeRefreshRequiredError) {
        return unavailableInspection(agent, adapter, refreshRequiredInstallation(agent, now), now);
      }
      if (error instanceof UnsafeProbeOutputError) {
        discovered = unsafeCapabilitySnapshot(agent, adapter, version, now);
        return discovered;
      }
      discovered = adapter.unavailableCapabilities(
        {
          agent,
          version,
          now,
          processEnvironment: context.processEnvironment,
          protectedValues: context.protectedValues
        },
        asyncProbeDiagnostic(error, "Agent capability discovery")
      );
    }
    return {
      ...discovered,
      installation: discovered.installation.status === "unsafe-output" ? discovered.installation : installation
    };
  } finally {
    context.cleanup();
  }
}

function unavailableInspection(
  agent: AgentDefinition,
  adapter: AgentAdapter,
  installation: AgentInstallation,
  now: Date
): CapabilitySnapshot {
  const unavailable = adapter.unavailableCapabilities(
    { agent, version: installation.version ?? adapter.supportedVersion, now },
    installation.reason ?? `Agent installation status is ${installation.status}.`
  );
  return { ...unavailable, installation };
}

function remainingBudget(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("Capability inspection deadline exceeded."), { code: "ETIMEDOUT" });
  return remaining;
}

function isProbeTimeout(error: unknown): boolean {
  return isRecord(error) && error.code === "ETIMEDOUT";
}

function runCommandAsync(
  _agent: AgentDefinition,
  args: string[],
  context: ProbeContext,
  timeout: number,
  beforeSpawn?: (args: readonly string[]) => void
): Promise<{ stdout: string; stderr: string }> {
  if (!context.verify()) return Promise.reject(new ProbeRefreshRequiredError());
  const invocation = context.invocation(args);
  beforeSpawn?.([...args]);
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: context.cwd,
      env: context.environment,
      stdio: invocation.stdio,
      ...(process.platform === "win32" ? {} : { detached: true })
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let buffered = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): boolean => {
      if (settled) return false;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      callback();
      return true;
    };
    const abort = (error: Error & { code?: string; killed?: boolean }) => {
      if (!finish(() => rejectResult(error))) return;
      terminateAsyncProbe(child);
    };
    timer = setTimeout(() => {
      abort(Object.assign(new Error("Agent capability probe failed."), {
        code: "ETIMEDOUT",
        killed: true
      }));
    }, Math.max(1, timeout));
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered += value.length;
      if (buffered > CAPABILITY_MAX_BUFFER) {
        abort(Object.assign(new Error("Agent capability probe failed."), {
          code: "ENOBUFS",
          killed: true
        }));
        return;
      }
      target.push(value);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", (error) => {
      finish(() => rejectResult(stableAsyncProbeError(error)));
    });
    child.on("close", (status) => {
      finish(() => {
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (probeDataIsUnsafe([stdoutText, stderrText], context.protectedValues)) {
          rejectResult(new UnsafeProbeOutputError());
          return;
        }
        if (status !== 0) {
          rejectResult(Object.assign(new Error("Agent capability probe failed."), {
            code: status === null ? "UNKNOWN" : String(status)
          }));
          return;
        }
        resolveResult({ stdout: stdoutText, stderr: stderrText });
      });
    });
  });
}

function terminateAsyncProbe(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group may already have exited; the direct-child fallback remains safe.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Process teardown is best-effort after the bounded probe deadline.
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

function asyncProbeFailure(
  agent: AgentDefinition,
  now: Date,
  resolvedPath: string | undefined,
  error: unknown
): AgentInstallation {
  const code = isRecord(error) && (typeof error.code === "string" || typeof error.code === "number")
    ? String(error.code)
    : "";
  if (code === "ENOENT") {
    return {
      status: "missing",
      command: agent.command,
      reason: "Agent command was not found.",
      probedAt: now.toISOString()
    };
  }
  return probeFailure(agent, now, resolvedPath, asyncProbeDiagnostic(error, "Agent version probe"));
}

function asyncProbeDiagnostic(error: unknown, operation: string): string {
  const code = isRecord(error) && (typeof error.code === "string" || typeof error.code === "number")
    ? String(error.code)
    : "";
  if (code === "ETIMEDOUT") return timeoutDiagnostic(operation);
  if (isRecord(error) && typeof error.killed === "boolean" && error.killed) return timeoutDiagnostic(operation);
  return `${operation} failed.`;
}

function stableDiscoveryFailure(error: unknown): string {
  const timeout = timeoutDiagnostic("Agent capability discovery");
  return error instanceof Error && error.message === timeout
    ? timeout
    : "Agent capability discovery failed.";
}

function snapshot(
  agent: AgentDefinition,
  adapter: AgentAdapter,
  version: string,
  now: Date,
  fields: CapabilityField[]
): CapabilitySnapshot {
  const supported = isSupportedVersion(version, adapter.supportedVersion);
  return {
    schemaVersion: 1,
    agentId: agent.id,
    adapterId: adapter.id,
    installation: {
      status: supported ? "installed" : "unsupported-version",
      command: agent.command,
      version,
      ...(supported ? {} : { reason: `Supported version is ${adapter.supportedVersion}.` }),
      probedAt: now.toISOString()
    },
    lifecycle: {
      start: true,
      resume: adapter.capabilities.recover,
      nativeSessionDiscovery: adapter.capabilities.nativeSessionDiscovery,
      interrupt: adapter.capabilities.interrupt
    },
    fields,
    warnings: supported ? [] : [`Installed version ${version} is not supported by adapter ${adapter.id}.`],
    refreshedAt: now.toISOString()
  };
}

type FieldOptions = {
  choices?: CapabilityChoice[];
  allowCustom?: boolean;
  status?: CapabilityField["status"];
  unavailableReason?: string;
};

function field(
  key: string,
  label: string,
  kind: CapabilityField["kind"],
  source: CapabilityField["source"],
  now: Date,
  options: FieldOptions = {}
): CapabilityField {
  return {
    key,
    label,
    kind,
    status: options.status ?? "available",
    source,
    refreshedAt: now.toISOString(),
    ...(options.choices === undefined ? {} : { choices: options.choices }),
    allowInherit: true,
    allowClear: true,
    defaultPolicy: "inherit",
    allowCustom: options.allowCustom ?? false,
    ...(options.unavailableReason === undefined ? {} : { unavailableReason: options.unavailableReason })
  };
}

function choice(value: string, label: string, source: CapabilityChoice["source"]): CapabilityChoice {
  return { value, label, source, available: true };
}

function codexBaselineFields(
  now: Date,
  discovered: {
    sandbox?: string[];
    approval?: string[];
    sandboxReason?: string;
    approvalReason?: string;
  } = {}
): CapabilityField[] {
  const sandbox = discovered.sandbox ?? [];
  const approval = discovered.approval ?? [];
  return [
    field("permission.sandbox", "Sandbox", "enum", sandbox.length > 0 ? "installed-cli-help" : "adapter-baseline", now, {
      choices: (sandbox.length > 0 ? sandbox : ["read-only", "workspace-write", "danger-full-access"])
        .map((value) => choice(value, value, sandbox.length > 0 ? "installed-cli-help" : "adapter-baseline")),
      status: discovered.sandboxReason === undefined ? "available" : "degraded",
      unavailableReason: discovered.sandboxReason
    }),
    field("permission.approval", "Approval", "enum", approval.length > 0 ? "installed-cli-help" : "adapter-baseline", now, {
      choices: (approval.length > 0 ? approval : ["untrusted", "on-request", "never"])
        .map((value) => choice(value, value, approval.length > 0 ? "installed-cli-help" : "adapter-baseline")),
      status: discovered.approvalReason === undefined ? "available" : "degraded",
      unavailableReason: discovered.approvalReason
    }),
    field("profile", "Profile", "string", "adapter-baseline", now, { allowCustom: true }),
    field("search", "Web search", "boolean", "adapter-baseline", now, {
      choices: [choice("true", "Enabled", "adapter-baseline")]
    }),
    field("additionalDirectories", "Additional directories", "path-list", "adapter-baseline", now, { allowCustom: true })
  ];
}

function claudeBaselineFields(now: Date, discoveredSettingsSources: string[] = []): CapabilityField[] {
  const settingsSource = discoveredSettingsSources.length > 0 ? "installed-cli-help" : "adapter-baseline";
  const settingValues = discoveredSettingsSources.length > 0
    ? discoveredSettingsSources
    : ["user", "project", "local"];
  return [
    field("permission.allowedTools", "Allowed tools", "string-list", "adapter-baseline", now, { allowCustom: true }),
    field("permission.disallowedTools", "Disallowed tools", "string-list", "adapter-baseline", now, { allowCustom: true }),
    field("additionalDirectories", "Additional directories", "path-list", "adapter-baseline", now, { allowCustom: true }),
    field("settingsFile", "Settings", "path", "adapter-baseline", now, { allowCustom: true }),
    field("settingsSources", "Settings sources", "string-list", settingsSource, now, {
      choices: settingValues.map((value) => choice(value, value, settingsSource))
    })
  ];
}

function discoveredEnumField(key: string, label: string, values: string[], now: Date): CapabilityField {
  return field(key, label, "enum", values.length > 0 ? "installed-cli-help" : "adapter-baseline", now, {
    choices: values.length > 0 ? values.map((value) => choice(value, value, "installed-cli-help")) : undefined,
    status: values.length > 0 ? "available" : "unavailable",
    ...(values.length > 0 ? {} : { unavailableReason: `${label} choices were not found in installed CLI help.` })
  });
}

function codexEffortChoices(models: CodexModelRecord[]): Record<string, CapabilityChoice[]> {
  return Object.fromEntries(models.map((model) => [
    model.slug,
    model.supportedReasoningLevels.map((level) =>
      choice(level.effort, level.effort, "installed-cli-bundled"))
  ]));
}

function codexModelChoices(models: CodexModelRecord[]): CapabilityChoice[] {
  return models
    .map((model) => choice(model.slug, model.slug, "installed-cli-bundled"));
}

type CodexModelRecord = {
  slug: string;
  displayName?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: Array<{ effort: string; description?: string }>;
  priority: number;
};

function parseCodexModelRecords(raw: string): CodexModelRecord[] {
  if (Buffer.byteLength(raw, "utf8") > CAPABILITY_PARSE_LIMIT) {
    throw new Error("Codex bundled model metadata is invalid.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("Codex bundled model metadata is invalid."); }
  if (!isRecord(parsed) || !hasExactDataKeys(parsed, ["models"]) || !Array.isArray(parsed.models)) {
    throw new Error("Codex bundled model metadata is invalid.");
  }
  return parsed.models.flatMap((model) => {
    if (!isRecord(model) || !hasExactDataKeys(
      model,
      ["slug", "supported_reasoning_levels"],
      ["display_name", "default_reasoning_level", "visibility", "priority"]
    ) || typeof model.slug !== "string" || !isCanonicalProbeEnum(model.slug) ||
      !Array.isArray(model.supported_reasoning_levels)) {
      throw new Error("Codex bundled model metadata is invalid.");
    }
    if (model.visibility !== undefined && model.visibility !== "list") return [];
    const supportedReasoningLevels = model.supported_reasoning_levels.map((level) => {
      if (!isRecord(level) || !hasExactDataKeys(level, ["effort"], ["description"]) ||
        typeof level.effort !== "string" || !isCanonicalProbeEnum(level.effort)) {
        throw new Error("Codex reasoning metadata is invalid.");
      }
      return {
        effort: level.effort,
        ...(typeof level.description === "string" ? { description: level.description } : {})
      };
    });
    return [{
      slug: model.slug,
      ...(typeof model.display_name === "string" ? { displayName: model.display_name } : {}),
      ...(typeof model.default_reasoning_level === "string" && isCanonicalProbeEnum(model.default_reasoning_level)
        ? { defaultReasoningLevel: model.default_reasoning_level }
        : {}),
      supportedReasoningLevels,
      priority: typeof model.priority === "number" ? model.priority : Number.MAX_SAFE_INTEGER
    }];
  }).sort((left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug));
}

function extractOptionChoices(text: string, flag: string): string[] {
  if (Buffer.byteLength(text, "utf8") > CAPABILITY_PARSE_LIMIT) return [];
  const block = optionBlock(text, flag);
  const match = /\((?:choices:\s*)?([\s\S]*?)\)/i.exec(block);
  if (match === null) return [];
  return unique(match[1]
    .replace(/["']/g, "")
    .split(",")
    .map((value) => value.trim().replace(/\.$/, ""))
    .filter(isCanonicalProbeEnum));
}

function extractDeclaredChoices(text: string, flag: string): string[] {
  if (Buffer.byteLength(text, "utf8") > CAPABILITY_PARSE_LIMIT) return [];
  const block = optionBlock(text, flag);
  const match = /(?:\[possible values:\s*([^\]]+)\]|\(choices:\s*([^)]*)\))/i.exec(block);
  const body = match?.[1] ?? match?.[2];
  if (body !== undefined) return unique(body
    .replace(/["']/g, "")
    .split(",")
    .map((value) => value.trim().replace(/\.$/, ""))
    .filter(isCanonicalProbeEnum));
  return unique([...block.matchAll(/^\s*-\s+([A-Za-z0-9][A-Za-z0-9-]*)(?:\s*:|\s*$)/gm)]
    .map((match) => match[1])
    .filter(isCanonicalProbeEnum));
}

function extractQuotedSuggestions(text: string, flag: string): string[] {
  if (Buffer.byteLength(text, "utf8") > CAPABILITY_PARSE_LIMIT) return [];
  const block = optionBlock(text, flag);
  const explicit = extractDeclaredChoices(block, flag);
  if (explicit.length > 0) return explicit;
  const aliasExample = /alias[\s\S]*?\(e\.g\.\s*([\s\S]*?)\)\s*or\b/i.exec(block)?.[1];
  if (aliasExample === undefined) return [];
  return unique([...aliasExample.matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1].trim())
    .filter(isCanonicalProbeEnum));
}

function optionBlock(text: string, flag: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.includes(flag));
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^\s{2,}(?:-[A-Za-z](?:,\s*)?|--)[A-Za-z0-9-]/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

function runText(
  agent: AgentDefinition,
  args: string[],
  processEnvironment: NodeJS.ProcessEnv = process.env,
  protectedValues?: readonly string[]
): string {
  assertSafeAgentBaseArgs(resolveAgentAdapter(agent.adapterId), agent);
  if (!hasCanonicalProbeCommand(agent, agent.adapterId)) throw new Error("Agent capability discovery is unavailable.");
  const context = createProbeContext(agent, processEnvironment, protectedValues);
  if (context === null) throw new Error("Agent capability discovery is unavailable.");
  try {
    return runTextWithContext(args, context, CAPABILITY_COMMAND_TIMEOUT_MS);
  } finally {
    context.cleanup();
  }
}

function runTextWithContext(args: string[], context: ProbeContext, timeout: number): string {
  if (!context.verify()) throw new ProbeRefreshRequiredError();
  const invocation = context.invocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: context.cwd,
    encoding: "utf8",
    env: context.environment,
    stdio: invocation.stdio,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: CAPABILITY_MAX_BUFFER
  });
  if (probeDataIsUnsafe([result.stdout, result.stderr, result.error?.message], context.protectedValues)) {
    throw new UnsafeProbeOutputError();
  }
  if (result.error !== undefined) {
    const code = "code" in result.error ? String(result.error.code) : "";
    throw Object.assign(
      new Error(code === "ETIMEDOUT"
        ? timeoutDiagnostic("Agent capability discovery")
        : "Agent capability discovery failed to start."),
      code.length === 0 ? {} : { code }
    );
  }
  if (result.status !== 0) {
    throw new Error(`Agent capability discovery exited with status ${result.status ?? "unknown"}.`);
  }
  return String(result.stdout ?? "");
}

function assertSafeAgentBaseArgs(adapter: AgentAdapter, agent: AgentDefinition): void {
  validateAgentBaseArguments(adapter.id, agent.baseArgs, adapter.reservedArguments());
}

function extractVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function createProbeContext(
  agent: AgentDefinition,
  processEnvironment: NodeJS.ProcessEnv,
  protectedValues: readonly string[] = protectedAgentValues(agent, processEnvironment),
  verificationDeadline?: number
): ProbeContext | null {
  const processSnapshot = { ...processEnvironment };
  const pin = openVerifiedProbePin(agent, verificationDeadline);
  if (pin === null) return null;
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "taskmux-capability-probe-"));
    chmodSync(root, 0o700);
    const configHome = join(root, "xdg-config");
    const dataHome = join(root, "xdg-data");
    const cacheHome = join(root, "xdg-cache");
    const codexHome = join(root, "codex");
    const claudeConfig = join(root, "claude");
    const temporary = join(root, "tmp");
    for (const directory of [configHome, dataHome, cacheHome, codexHome, claudeConfig, temporary]) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    const execution = buildProbeExecutionPlan(pin);
    if (execution === null) throw new Error("Probe execution chain is invalid.");
    const probeRoot = root;
    return {
      environment: {
        PATH: PROBE_SYSTEM_PATH.join(delimiter),
        HOME: probeRoot,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeConfig,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary
      },
      processEnvironment: processSnapshot,
      protectedValues: [...protectedValues],
      executable: pin.executable.witness.path,
      cwd: probeRoot,
      verify() {
        return verifyOpenedProbePin(pin);
      },
      invocation(args) {
        return {
          command: execution.command,
          args: [...execution.prefixArgs, ...args],
          stdio: [...execution.stdio]
        };
      },
      cleanup() {
        closeOpenedProbePin(pin);
        rmSync(probeRoot, { recursive: true, force: true });
      }
    };
  } catch {
    closeOpenedProbePin(pin);
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    return null;
  }
}

/**
 * Enroll the executable that a first-class Agent may use for capability
 * probing. This is intentionally a configuration-time operation: later
 * probes verify this witness and never resolve the Agent command through the
 * caller's PATH.
 */
export function enrollAgentCapabilityProbePin(
  agent: Pick<AgentDefinition, "adapterId" | "command">,
  processEnvironment: NodeJS.ProcessEnv = process.env,
  resolutionContext?: ProbeExecutableResolutionContext
): ProbeExecutablePin | undefined {
  if (!hasCanonicalProbeCommand(agent, agent.adapterId) || !isFirstClassProbeAdapter(agent.adapterId)) {
    return undefined;
  }
  const resolution = resolutionContext ?? captureProbeExecutableResolutionContext(processEnvironment);
  if (resolution === undefined) return undefined;
  const executable = resolveExecutableFromContext(agent.command, resolution);
  if (executable === undefined) return undefined;
  const budget = createProbeHashBudget();
  const executableWitness = captureProbeFileWitness(executable, budget);
  if (executableWitness === undefined) return undefined;
  const classification = captureProbeInterpreterChain(executable, resolution, budget);
  if (classification === undefined) return undefined;
  return {
    executable: executableWitness,
    executableKind: classification.kind,
    interpreters: classification.interpreters
  };
}

type OpenedProbeFile = {
  witness: ProbeFileWitness;
  descriptor: number;
};

type OpenedProbePin = {
  executable: OpenedProbeFile;
  executableKind: "native" | "script";
  interpreters: Array<{ invocation: string; file: OpenedProbeFile }>;
};

function openVerifiedProbePin(agent: AgentDefinition, verificationDeadline?: number): OpenedProbePin | null {
  if (!hasCanonicalProbeCommand(agent, agent.adapterId) || !isFirstClassProbeAdapter(agent.adapterId)) {
    return null;
  }
  if (agent.probePin === undefined) return null;
  const budget = createProbeHashBudget(verificationDeadline);
  const opened: OpenedProbeFile[] = [];
  try {
    const executable = openProbeFileWitness(agent.probePin.executable);
    opened.push(executable);
    const interpreters: OpenedProbePin["interpreters"] = [];
    for (const interpreter of agent.probePin.interpreters) {
      const file = openProbeFileWitness(interpreter.file);
      opened.push(file);
      interpreters.push({ invocation: interpreter.invocation, file });
    }
    const pin: OpenedProbePin = {
      executable,
      executableKind: agent.probePin.executableKind,
      interpreters
    };
    if (!verifyOpenedProbePin(pin, true, budget)) throw new Error("Probe pin verification failed.");
    return pin;
  } catch {
    for (const file of opened) closeProbeFile(file);
    if (budget.exceeded) throw new ProbeVerificationBudgetExceededError();
    return null;
  }
}

function isFirstClassProbeAdapter(adapterId: string): boolean {
  return adapterId === "codex" || adapterId === "claude";
}

export function captureProbeExecutableResolutionContext(
  processEnvironment: NodeJS.ProcessEnv
): ProbeExecutableResolutionContext | undefined {
  const value = processEnvironment.PATH;
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768) return undefined;
  const searchPath = value.split(delimiter);
  if (
    searchPath.length === 0 ||
    searchPath.length > 256 ||
    searchPath.some((directory) =>
      directory.length === 0 ||
      directory.length > 4_096 ||
      !isAbsolute(directory) ||
      resolve(directory) !== directory ||
      /[\0\r\n]/.test(directory)
    )
  ) {
    return undefined;
  }
  return { searchPath: unique(searchPath) };
}

function resolveExecutableFromContext(
  command: string,
  resolution: ProbeExecutableResolutionContext
): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(command)) return undefined;
  for (const directory of resolution.searchPath) {
    const resolved = resolvePinnedProbeExecutable(join(directory, command));
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolvePinnedProbeExecutable(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    const resolved = realpathSync(path);
    const metadata = statSync(resolved);
    return metadata.isFile() && isExecutable(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function captureProbeFileWitness(path: string, budget: ProbeHashBudget): ProbeFileWitness | undefined {
  const metadata = readProbeFileMetadata(path);
  if (metadata === undefined) return undefined;
  const size = Number(metadata.size);
  if (!consumeProbeHashBytes(budget, size)) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(metadata.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = readProbeDescriptorMetadata(metadata.path, descriptor);
    if (before === undefined || !sameProbeFileMetadata(before, { ...metadata, sha256: "" })) return undefined;
    const sha256 = digestOpenedProbeFile(descriptor, size, budget);
    const after = readProbeDescriptorMetadata(metadata.path, descriptor);
    if (
      sha256 === undefined ||
      after === undefined ||
      !sameProbeFileMetadata(after, { ...metadata, sha256: "" })
    ) {
      return undefined;
    }
    return {
      ...metadata,
      sha256
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Enrollment descriptors are process-local and short-lived.
      }
    }
  }
}

type ProbeExecutableClassification = {
  kind: "native" | "script";
  interpreters: ProbeInterpreterWitness[];
};

type ProbeShebang =
  | { kind: "native" }
  | { kind: "invalid" }
  | { kind: "script"; interpreter: string; argument?: string };

function captureProbeInterpreterChain(
  executable: string,
  resolution: ProbeExecutableResolutionContext,
  budget: ProbeHashBudget
): ProbeExecutableClassification | undefined {
  const interpreters: ProbeInterpreterWitness[] = [];
  const visited = new Set<string>([executable]);
  const kind = appendProbeInterpreterChain(executable, resolution, interpreters, visited, budget);
  if (kind === undefined) return undefined;
  return { kind, interpreters };
}

function appendProbeInterpreterChain(
  executable: string,
  resolution: ProbeExecutableResolutionContext,
  interpreters: ProbeInterpreterWitness[],
  visited: Set<string>,
  budget: ProbeHashBudget
): "native" | "script" | undefined {
  const shebang = readProbeShebang(executable);
  if (shebang.kind === "native") return "native";
  if (shebang.kind === "invalid" || interpreters.length >= MAX_PROBE_INTERPRETER_WITNESSES) return undefined;
  const interpreter = resolvePinnedProbeExecutable(shebang.interpreter);
  const interpreterFile = interpreter === undefined ? undefined : captureProbeFileWitness(interpreter, budget);
  if (interpreter === undefined || interpreterFile === undefined || visited.has(interpreter)) return undefined;
  interpreters.push({ invocation: shebang.interpreter, file: interpreterFile });
  visited.add(interpreter);

  if (isEnvInterpreter(interpreter)) {
    if (readProbeShebang(interpreter).kind !== "native") return undefined;
    if (interpreters.length >= MAX_PROBE_INTERPRETER_WITNESSES) return undefined;
    const runtimeInvocation = parseEnvRuntimeInvocation(shebang.argument);
    const runtimeCommand = runtimeInvocation?.command;
    const runtime = runtimeCommand === undefined
      ? undefined
      : resolveExecutableFromContext(runtimeCommand, resolution);
    const runtimeFile = runtime === undefined ? undefined : captureProbeFileWitness(runtime, budget);
    if (runtimeCommand === undefined || runtime === undefined || runtimeFile === undefined || visited.has(runtime)) {
      return undefined;
    }
    interpreters.push({ invocation: runtimeCommand, file: runtimeFile });
    visited.add(runtime);
    return appendProbeInterpreterChain(runtime, resolution, interpreters, visited, budget) === undefined
      ? undefined
      : "script";
  }

  return appendProbeInterpreterChain(interpreter, resolution, interpreters, visited, budget) === undefined
    ? undefined
    : "script";
}

function readProbeShebang(executable: string): ProbeShebang {
  const header = Buffer.alloc(1024);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    const length = readSync(descriptor, header, 0, header.length, 0);
    return parseProbeShebangHeader(header.subarray(0, length));
  } catch {
    return { kind: "invalid" };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Shebang inspection descriptors are process-local and short-lived.
      }
    }
  }
}

function readOpenedProbeShebang(file: OpenedProbeFile): ProbeShebang {
  const header = Buffer.alloc(1024);
  try {
    const length = readSync(file.descriptor, header, 0, header.length, 0);
    return parseProbeShebangHeader(header.subarray(0, length));
  } catch {
    return { kind: "invalid" };
  }
}

function parseProbeShebangHeader(header: Buffer): ProbeShebang {
  if (header[0] !== 0x23 || header[1] !== 0x21) {
    return isRecognizedNativeExecutable(header) ? { kind: "native" } : { kind: "invalid" };
  }
  const firstLine = header.toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  const match = /^[ \t]*([^ \t]+)(?:[ \t]+(.*?))?[ \t]*$/.exec(firstLine.slice(2));
  if (match === null || !isAbsolute(match[1]) || /[\0\r\n]/.test(match[1])) return { kind: "invalid" };
  const argument = match[2]?.trim();
  return {
    kind: "script",
    interpreter: match[1],
    ...(argument === undefined || argument.length === 0 ? {} : { argument })
  };
}

function openProbeFileWitness(witness: ProbeFileWitness): OpenedProbeFile {
  const descriptor = openSync(witness.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const file = { witness, descriptor };
  if (descriptor <= 2 || descriptor > 1_024 || !verifyOpenedProbeFile(file, false)) {
    closeProbeFile(file);
    throw new Error("Probe file witness is stale.");
  }
  return file;
}

function verifyOpenedProbeFile(
  file: OpenedProbeFile,
  verifyDigest: boolean,
  budget?: ProbeHashBudget
): boolean {
  const pathMetadata = readProbeFileMetadata(file.witness.path);
  if (pathMetadata === undefined || !sameProbeFileMetadata(pathMetadata, file.witness)) return false;
  const before = readOpenedProbeFileMetadata(file);
  if (before === undefined || !sameProbeFileMetadata(before, file.witness)) return false;
  if (verifyDigest) {
    const size = Number(before.size);
    if (
      budget === undefined ||
      !consumeProbeHashBytes(budget, size) ||
      digestOpenedProbeFile(file.descriptor, size, budget) !== file.witness.sha256
    ) {
      return false;
    }
  }
  const after = readOpenedProbeFileMetadata(file);
  return after !== undefined && sameProbeFileMetadata(after, file.witness);
}

function readOpenedProbeFileMetadata(
  file: OpenedProbeFile
): Omit<ProbeFileWitness, "sha256"> | undefined {
  return readProbeDescriptorMetadata(file.witness.path, file.descriptor);
}

function readProbeDescriptorMetadata(
  path: string,
  descriptor: number
): Omit<ProbeFileWitness, "sha256"> | undefined {
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    return probeFileMetadata(path, metadata);
  } catch {
    return undefined;
  }
}

function digestOpenedProbeFile(
  descriptor: number,
  length: number,
  budget: ProbeHashBudget
): string | undefined {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROBE_WITNESS_FILE_BYTES) return undefined;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, length)));
  let position = 0;
  try {
    while (position < length) {
      if (Date.now() > budget.deadline) {
        budget.exceeded = true;
        return undefined;
      }
      const read = readSync(descriptor, buffer, 0, Math.min(buffer.length, length - position), position);
      if (read <= 0) return undefined;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    if (Date.now() > budget.deadline) {
      budget.exceeded = true;
      return undefined;
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function createProbeHashBudget(deadline?: number): ProbeHashBudget {
  return {
    deadline: Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + PROBE_HASH_BUDGET_MS),
    remainingBytes: MAX_PROBE_WITNESS_TOTAL_BYTES,
    exceeded: false
  };
}

function consumeProbeHashBytes(budget: ProbeHashBudget, bytes: number): boolean {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_PROBE_WITNESS_FILE_BYTES ||
    bytes > budget.remainingBytes ||
    Date.now() > budget.deadline
  ) {
    budget.exceeded = true;
    return false;
  }
  budget.remainingBytes -= bytes;
  return true;
}

function sameProbeFileMetadata(
  observed: Omit<ProbeFileWitness, "sha256">,
  witness: ProbeFileWitness
): boolean {
  return observed.path === witness.path &&
    observed.size === witness.size &&
    observed.mtimeNs === witness.mtimeNs &&
    observed.ctimeNs === witness.ctimeNs &&
    observed.birthtimeNs === witness.birthtimeNs &&
    observed.dev === witness.dev &&
    observed.ino === witness.ino &&
    observed.mode === witness.mode;
}

function probeDescriptorPath(descriptor: number): string {
  return `/proc/self/fd/${descriptor}`;
}

function closeProbeFile(file: OpenedProbeFile): void {
  try {
    closeSync(file.descriptor);
  } catch {
    // Probe descriptors are process-local and contain no mutable authority.
  }
}

function closeOpenedProbePin(pin: OpenedProbePin): void {
  closeProbeFile(pin.executable);
  for (const interpreter of pin.interpreters) closeProbeFile(interpreter.file);
}

function isRecognizedNativeExecutable(header: Buffer): boolean {
  if (header.length >= 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return true;
  }
  if (header.length < 4) return false;
  const magic = header.readUInt32BE(0);
  return [
    0xfeedface,
    0xfeedfacf,
    0xcefaedfe,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca
  ].includes(magic);
}

function isEnvInterpreter(interpreter: string): boolean {
  const systemEnv = resolvePinnedProbeExecutable("/usr/bin/env");
  return systemEnv !== undefined && interpreter === systemEnv;
}

function parseEnvRuntimeInvocation(
  argument: string | undefined
): { command: string; args: string[] } | undefined {
  if (argument === undefined) return undefined;
  const tokens = argument.split(/\s+/).filter((value) => value.length > 0);
  const commandIndex = tokens[0] === "-S" ? 1 : 0;
  if (tokens[0] !== "-S" && tokens.length !== 1) return undefined;
  const command = tokens[commandIndex];
  if (command === undefined || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(command)) return undefined;
  return { command, args: tokens[0] === "-S" ? tokens.slice(commandIndex + 1) : [] };
}

function verifyOpenedProbePin(
  pin: OpenedProbePin,
  verifyDigest = false,
  budget?: ProbeHashBudget
): boolean {
  if (!verifyOpenedProbeFile(pin.executable, verifyDigest, budget)) return false;
  if (pin.interpreters.some((interpreter) =>
    !verifyOpenedProbeFile(interpreter.file, verifyDigest, budget))) return false;
  return buildProbeExecutionPlan(pin) !== null;
}

function buildProbeExecutionPlan(
  pin: OpenedProbePin
): { command: string; prefixArgs: string[]; stdio: Array<"ignore" | "pipe" | number> } | null {
  let cursor = 0;
  const visited = new Set<number>([pin.executable.descriptor]);
  const visit = (
    executable: OpenedProbeFile,
    prefixArgs: string[]
  ): { kind: "native" | "script"; native: OpenedProbeFile; prefixArgs: string[] } | null => {
    const shebang = readOpenedProbeShebang(executable);
    if (shebang.kind === "native") return { kind: "native", native: executable, prefixArgs };
    if (shebang.kind === "invalid" || cursor >= pin.interpreters.length) return null;
    const expectedInterpreter = pin.interpreters[cursor++];
    const interpreter = resolvePinnedProbeExecutable(shebang.interpreter);
    if (
      expectedInterpreter.invocation !== shebang.interpreter ||
      interpreter !== expectedInterpreter.file.witness.path ||
      interpreter === undefined ||
      visited.has(expectedInterpreter.file.descriptor)
    ) {
      return null;
    }
    visited.add(expectedInterpreter.file.descriptor);
    if (isEnvInterpreter(interpreter)) {
      if (readOpenedProbeShebang(expectedInterpreter.file).kind !== "native" || cursor >= pin.interpreters.length) {
        return null;
      }
      const runtimeInvocation = parseEnvRuntimeInvocation(shebang.argument);
      const expectedRuntime = pin.interpreters[cursor++];
      if (
        runtimeInvocation === undefined ||
        expectedRuntime.invocation !== runtimeInvocation.command ||
        visited.has(expectedRuntime.file.descriptor)
      ) {
        return null;
      }
      visited.add(expectedRuntime.file.descriptor);
      const nested = visit(expectedRuntime.file, [
        ...runtimeInvocation.args,
        probeDescriptorPath(executable.descriptor),
        ...prefixArgs
      ]);
      return nested === null ? null : { ...nested, kind: "script" };
    }
    const nested = visit(expectedInterpreter.file, [
      ...(shebang.argument === undefined ? [] : [shebang.argument]),
      probeDescriptorPath(executable.descriptor),
      ...prefixArgs
    ]);
    return nested === null ? null : { ...nested, kind: "script" };
  };
  const execution = visit(pin.executable, []);
  if (execution === null || execution.kind !== pin.executableKind || cursor !== pin.interpreters.length) return null;
  const descriptors = [pin.executable, ...pin.interpreters.map((interpreter) => interpreter.file)]
    .map((file) => file.descriptor);
  const maximumDescriptor = Math.max(...descriptors);
  if (maximumDescriptor > 1_024) return null;
  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
  while (stdio.length <= maximumDescriptor) stdio.push("ignore");
  for (const descriptor of descriptors) stdio[descriptor] = descriptor;
  return {
    command: probeDescriptorPath(execution.native.descriptor),
    prefixArgs: execution.prefixArgs,
    stdio
  };
}

function readProbeFileMetadata(path: string): Omit<ProbeFileWitness, "sha256"> | undefined {
  const resolved = resolvePinnedProbeExecutable(path);
  if (resolved === undefined) return undefined;
  try {
    const metadata = statSync(resolved, { bigint: true });
    return probeFileMetadata(resolved, metadata);
  } catch {
    return undefined;
  }
}

function probeFileMetadata(
  path: string,
  metadata: BigIntStats
): Omit<ProbeFileWitness, "sha256"> | undefined {
  if (
    !metadata.isFile() ||
    metadata.size < 0n ||
    metadata.size > BigInt(MAX_PROBE_WITNESS_FILE_BYTES) ||
    metadata.dev < 0n ||
    metadata.ino < 0n ||
    metadata.mode < 0n ||
    metadata.mtimeNs < 0n ||
    metadata.ctimeNs < 0n ||
    metadata.birthtimeNs < 0n
  ) {
    return undefined;
  }
  return {
    path,
    size: metadata.size.toString(10),
    mtimeNs: metadata.mtimeNs.toString(10),
    ctimeNs: metadata.ctimeNs.toString(10),
    birthtimeNs: metadata.birthtimeNs.toString(10),
    dev: metadata.dev.toString(10),
    ino: metadata.ino.toString(10),
    mode: metadata.mode.toString(10)
  };
}

function hasCanonicalProbeCommand(agent: Pick<AgentDefinition, "command">, adapterId: string): boolean {
  return agent.command === adapterId;
}

function protectedAgentValues(agent: AgentDefinition, processEnvironment: NodeJS.ProcessEnv): string[] {
  return unique(agent.environment.flatMap(({ sourceName }) => {
    const value = processEnvironment[sourceName];
    return value === undefined || value.length === 0 ? [] : [value];
  }));
}

function probeDataIsUnsafe(values: readonly unknown[], protectedValues: readonly string[]): boolean {
  if (protectedValues.length === 0) return false;
  return values.some((value) => typeof value === "string" && stringContainsProtectedData(value, protectedValues));
}

function stringContainsProtectedData(value: string, protectedValues: readonly string[]): boolean {
  const compact = compactProbeText(value);
  for (const protectedValue of protectedValues) {
    for (const variant of protectedVariants(protectedValue)) {
      if (variant.length > 0 && (value.includes(variant) || compact.includes(compactProbeText(variant)))) {
        return true;
      }
    }
  }
  return false;
}

function protectedVariants(value: string): string[] {
  return unique([
    value,
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
    Buffer.from(value, "utf8").toString("hex"),
    encodeURIComponent(value)
  ]);
}

function compactProbeText(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLocaleLowerCase();
}

function assertProbeValueSafe(value: unknown, protectedValues: readonly string[]): void {
  if (protectedValues.length === 0) return;
  const visit = (candidate: unknown, ancestors: Set<object>): void => {
    if (typeof candidate === "string") {
      if (stringContainsProtectedData(candidate, protectedValues)) throw new UnsafeProbeOutputError();
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (utilTypes.isProxy(candidate) || ancestors.has(candidate)) throw new UnsafeProbeOutputError();
    ancestors.add(candidate);
    try {
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string" || stringContainsProtectedData(key, protectedValues)) {
          throw new UnsafeProbeOutputError();
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !("value" in descriptor)) throw new UnsafeProbeOutputError();
        visit(descriptor.value, ancestors);
      }
    } finally {
      ancestors.delete(candidate);
    }
  };
  visit(value, new Set());
}

function stableAsyncProbeError(error: unknown): Error & { code?: string; killed?: boolean } {
  const code = isRecord(error) && (typeof error.code === "string" || typeof error.code === "number")
    ? String(error.code)
    : undefined;
  const killed = isRecord(error) && error.killed === true;
  return Object.assign(new Error("Agent capability probe failed."), {
    ...(code === undefined ? {} : { code }),
    ...(killed ? { killed: true } : {})
  });
}

function unsafeCapabilitySnapshot(
  agent: AgentDefinition,
  adapter: AgentAdapter,
  version: string | undefined,
  now: Date
): CapabilitySnapshot {
  const reason = "Agent capability probe output failed security validation.";
  const unavailable = adapter.unavailableCapabilities(
    { agent, version: version ?? adapter.supportedVersion, now, protectedValues: [] },
    reason
  );
  return { ...unavailable, installation: unsafeInstallation(agent, now), warnings: [] };
}

function probeFailure(
  agent: AgentDefinition,
  now: Date,
  resolvedPath: string | undefined,
  reason: string
): AgentInstallation {
  return {
    status: "probe-failed",
    command: agent.command,
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
    reason,
    probedAt: now.toISOString()
  };
}

function unavailableInstallation(agent: AgentDefinition, now: Date): AgentInstallation {
  return {
    status: "unavailable",
    command: agent.command,
    reason: "Configured Agent commands are not eligible for live capability probing.",
    probedAt: now.toISOString()
  };
}

function refreshRequiredInstallation(agent: AgentDefinition, now: Date): AgentInstallation {
  return {
    status: "refresh-required",
    command: agent.command,
    reason: "Refresh the Agent capability probe pin.",
    probedAt: now.toISOString()
  };
}

function unavailableProbePinInstallation(
  agent: AgentDefinition,
  now: Date,
  processEnvironment: NodeJS.ProcessEnv
): AgentInstallation {
  if (agent.probePinRefreshRequired === true) {
    return refreshRequiredInstallation(agent, now);
  }
  if (agent.probePin === undefined) {
    const resolution = captureProbeExecutableResolutionContext(processEnvironment);
    if (resolution === undefined || resolveExecutableFromContext(agent.command, resolution) === undefined) {
      return {
        status: "missing",
        command: agent.command,
        reason: "Agent command is not installed for capability probe enrollment.",
        probedAt: now.toISOString()
      };
    }
  }
  return refreshRequiredInstallation(agent, now);
}

function unsafeInstallation(agent: AgentDefinition, now: Date): AgentInstallation {
  return {
    status: "unsafe-output",
    command: agent.command,
    reason: "Agent capability probe output failed security validation.",
    probedAt: now.toISOString()
  };
}

function timeoutDiagnostic(operation: string): string {
  return `${operation} timed out after ${CAPABILITY_COMMAND_TIMEOUT_MS} ms.`;
}

function validateSelectedEnum(
  config: RoleAgentConfig,
  snapshot: CapabilitySnapshot,
  validationMode: "configure" | "replay" | "unprobed"
): void {
  const model = "model" in config ? config.model : undefined;
  const effort = "effort" in config ? config.effort : undefined;
  if (effort !== undefined) {
    const effortField = snapshot.fields.find((field) => field.key === "effort");
    if (!(validationMode === "replay" && effortField?.status !== "available")) {
      const available = model !== undefined && effortField?.choicesByModel !== undefined
        ? effortField.choicesByModel[model]
        : effortField?.choices;
      if (available === undefined || !available.some((choice) => choice.available && choice.value === effort)) {
        throw new Error(model === undefined
          ? `Reasoning effort is not available: ${effort}.`
          : `Reasoning effort ${effort} is not available for model ${model}.`);
      }
    }
  }
  if ("permission" in config && config.permission !== undefined) {
    const permission = config.permission as { sandbox?: string; approval?: string; mode?: string };
    validateFieldChoice(snapshot, "permission.sandbox", permission.sandbox, validationMode);
    validateFieldChoice(snapshot, "permission.approval", permission.approval, validationMode);
    validateFieldChoice(snapshot, "permission.mode", permission.mode, validationMode);
  }
  if ("search" in config && config.search !== undefined) {
    validateFieldChoice(snapshot, "search", String(config.search));
  }
}

function isSupportedVersion(version: string, minimum: string): boolean {
  const detected = parseSemanticVersion(version);
  const baseline = parseSemanticVersion(minimum);
  return detected !== null && baseline !== null &&
    detected.major === baseline.major &&
    detected.minor === baseline.minor &&
    detected.patch >= baseline.patch;
}

function parseSemanticVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function validateFieldChoice(
  snapshot: CapabilitySnapshot,
  key: string,
  value: string | undefined,
  validationMode: "configure" | "replay" | "unprobed" = "configure"
): void {
  if (value === undefined) return;
  const field = snapshot.fields.find((candidate) => candidate.key === key);
  if (validationMode === "replay" && field?.status !== "available") return;
  if (field?.choices === undefined || !field.choices.some((choice) => choice.available && choice.value === value)) {
    throw new Error(`${key} value is not available: ${value}.`);
  }
}

function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/([?&](?:access_token|api_key|token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");
}

function requireNativeId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Native session id is required.");
  return trimmed;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashStringSet(values: string[]): string[] {
  return [...new Set(values.map((value) => digest(value)))].sort();
}

function hashLengthDelimitedStringSet(values: string[]): string[] {
  return [...new Set(values.map((value) => digest(`${Buffer.byteLength(value, "utf8")}:${value}`)))].sort();
}

function canonicalAdditionalDirectories(values: string[] | undefined): string[] {
  const canonical: string[] = [];
  for (const value of values ?? []) {
    let realpath: string;
    try {
      realpath = realpathSync(value);
    } catch {
      throw new Error("Additional directory does not exist or cannot be resolved.");
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(realpath).isDirectory();
    } catch {
      throw new Error("Additional directory cannot be inspected.");
    }
    if (!isDirectory) throw new Error("Additional directory is not a directory.");
    canonical.push(realpath);
  }
  return [...new Set(canonical)].sort();
}

function splitFingerprintInput(
  config: RoleAgentConfig,
  context: FingerprintContext
): { replayable: unknown; sessionBound: unknown } {
  const normalizedContext = {
    workspace: context.workspace === undefined ? undefined : resolve(context.workspace),
    systemPrompt: context.systemPrompt,
    agent: context.agent === undefined ? undefined : {
      id: context.agent.id,
      adapterId: context.agent.adapterId,
      command: context.agent.command,
      baseArgs: context.agent.baseArgs,
      environment: context.agent.environment
    }
  };
  if (config.adapterId === "codex") {
    const { profile, advanced, permission: _permission, ...replayable } = config as CodexRoleAgentConfig;
    return {
      replayable: { ...replayable, adapterId: undefined },
      sessionBound: { adapterId: config.adapterId, profile, advanced, ...normalizedContext }
    };
  }
  if (config.adapterId === "claude") {
    const { settingsFile, settingsSources, advanced, permission: _permission, ...replayable } = config as ClaudeRoleAgentConfig;
    return {
      replayable: { ...replayable, adapterId: undefined },
      sessionBound: { adapterId: config.adapterId, settingsFile, settingsSources, advanced, ...normalizedContext }
    };
  }
  return unreachableRoleAgentConfig(config);
}

function unreachableRoleAgentConfig(config: never): never {
  throw new Error(`Role Agent config is unsupported: ${String(config)}.`);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compact(values: string[]): string[] {
  return values;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCanonicalProbeEnum(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,127}$/.test(value);
}

function hasExactDataKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  if (utilTypes.isProxy(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key): key is string => typeof key === "string" &&
    (required.includes(key) || optional.includes(key)))) return false;
  if (!required.every((key) => Object.hasOwn(value, key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}
