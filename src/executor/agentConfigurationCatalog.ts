import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ConfiguredAgent } from "../agent/agent.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import { resolveAgentAdapter, type RoleAgentConfig } from "./agentAdapter.js";

export type AgentConfigurationChoice = Readonly<{
  value: string;
  label: string;
  description?: string;
}>;

export type AgentModelChoice = Readonly<{
  value: string;
  label: string;
  description?: string;
  resolvedModel?: string;
  isDefault: boolean;
  defaultEffort?: string;
  efforts: readonly AgentConfigurationChoice[];
  serviceTiers?: readonly AgentConfigurationChoice[];
  defaultServiceTier?: string;
}>;

export type AgentConfigurationField = Readonly<{
  key: string;
  choices: readonly AgentConfigurationChoice[];
  allowCustom: boolean;
  available?: boolean;
  reason?: string;
}>;

export type AgentConfigurationCatalog = Readonly<{
  schemaVersion: 1;
  agentId: string;
  adapterId: AgentAdapterId;
  cliVersion?: string;
  models: readonly AgentModelChoice[];
  fields: readonly AgentConfigurationField[];
  warnings: readonly string[];
}>;

export type AgentConfigurationDiscoveryInput = Readonly<{
  agent: ConfiguredAgent;
  cwd: string;
  config?: RoleAgentConfig;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
}>;

export type AgentConfigurationDiscovery = (
  input: AgentConfigurationDiscoveryInput
) => Promise<AgentConfigurationCatalog>;

export type AgentConfigurationFailure = Readonly<{
  code: "timeout" | "missing-command" | "probe-failed";
  message: string;
}>;

export type ResolvedAgentConfigurationCatalog = Readonly<{
  source: "live" | "cache" | "fallback";
  attemptedAt: string;
  fetchedAt?: string;
  catalog: AgentConfigurationCatalog;
  failure?: AgentConfigurationFailure;
}>;

export type ResolveAgentConfigurationInput = Readonly<{
  agent: ConfiguredAgent;
  cwd: string;
  config?: RoleAgentConfig;
}>;

export type AgentConfigurationCatalogServiceOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
  discover?: AgentConfigurationDiscovery;
}>;

type CachedCatalog = Readonly<{
  schemaVersion: 1;
  fingerprint: string;
  fetchedAt: string;
  catalog: AgentConfigurationCatalog;
}>;

const DEFAULT_TIMEOUT_MS = 8_000;

export class AgentConfigurationCatalogService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #discover: AgentConfigurationDiscovery;
  readonly #requests = new Map<string, Promise<ResolvedAgentConfigurationCatalog>>();

  constructor(
    private readonly yuiHome: string,
    options: AgentConfigurationCatalogServiceOptions = {}
  ) {
    this.#environment = options.environment ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
    this.#discover = options.discover ?? ((input) =>
      resolveAgentAdapter(input.agent.adapterId).discoverConfiguration(input));
  }

  resolve(input: ResolveAgentConfigurationInput): Promise<ResolvedAgentConfigurationCatalog> {
    const fingerprint = catalogFingerprint(input, this.#environment);
    const existing = this.#requests.get(fingerprint);
    if (existing !== undefined) return existing;
    const request = this.#resolve(input, fingerprint);
    this.#requests.set(fingerprint, request);
    return request;
  }

  async #resolve(
    input: ResolveAgentConfigurationInput,
    fingerprint: string
  ): Promise<ResolvedAgentConfigurationCatalog> {
    const attemptedAt = this.#now().toISOString();
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const discovered = await Promise.race([
        this.#discover({
          ...input,
          environment: this.#environment,
          signal: controller.signal
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(Object.assign(
              new Error(`Agent capability discovery timed out after ${this.#timeoutMs}ms.`),
              { code: "ETIMEDOUT" }
            ));
          }, this.#timeoutMs);
        })
      ]);
      const catalog = validateCatalog(discovered, input.agent);
      const fetchedAt = this.#now().toISOString();
      try {
        writeTextFileAtomically(
          cachePath(this.yuiHome, input.agent.id, fingerprint),
          `${JSON.stringify({
            schemaVersion: 1,
            fingerprint,
            fetchedAt,
            catalog
          } satisfies CachedCatalog, null, 2)}\n`
        );
        return { source: "live", attemptedAt, fetchedAt, catalog };
      } catch {
        return {
          source: "live",
          attemptedAt,
          fetchedAt,
          catalog: {
            ...catalog,
            warnings: [
              ...catalog.warnings,
              "The runtime catalog cache could not be updated."
            ]
          }
        };
      }
    } catch (error) {
      const failure = catalogFailure(error);
      const cached = readCachedCatalog(
        cachePath(this.yuiHome, input.agent.id, fingerprint),
        fingerprint,
        input.agent
      );
      if (cached !== null) {
        return {
          source: "cache",
          attemptedAt,
          fetchedAt: cached.fetchedAt,
          catalog: cached.catalog,
          failure
        };
      }
      return {
        source: "fallback",
        attemptedAt,
        catalog: fallbackAgentConfigurationCatalog(input.agent),
        failure
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    }
  }
}

export function fallbackAgentConfigurationCatalog(
  agent: Pick<ConfiguredAgent, "id" | "adapterId">
): AgentConfigurationCatalog {
  const choice = (value: string): AgentConfigurationChoice => ({ value, label: value });
  const common = [
    field("model", [], true),
    field("effort", [], true)
  ];
  return agent.adapterId === "codex"
    ? {
        schemaVersion: 1,
        agentId: agent.id,
        adapterId: "codex",
        models: [],
        fields: [
          ...common,
          field("yolo", [choice("true")], false),
          field("permission.sandbox", [
            "read-only", "workspace-write", "danger-full-access"
          ].map(choice), false),
          field("permission.approval", [
            "untrusted", "on-request", "never"
          ].map(choice), false),
          field("search", [choice("true")], false),
          field("profile", [], true),
          field("additionalDirectories", [], true)
        ],
        warnings: ["Runtime configuration catalog is unavailable."]
      }
    : {
        schemaVersion: 1,
        agentId: agent.id,
        adapterId: "claude",
        models: [],
        fields: [
          ...common,
          field("yolo", [choice("true")], false),
          field("permission.mode", [
            "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"
          ].map(choice), true),
          field("permission.allowedTools", [], true),
          field("permission.disallowedTools", [], true),
          field("settingsSources", ["user", "project", "local"].map(choice), false),
          field("settingsFile", [], true),
          field("additionalDirectories", [], true)
        ],
        warnings: ["Runtime configuration catalog is unavailable."]
      };
}

export function configurationField(
  catalog: AgentConfigurationCatalog,
  key: string
): AgentConfigurationField | undefined {
  return catalog.fields.find((candidate) => candidate.key === key);
}

export function defaultModel(
  catalog: AgentConfigurationCatalog
): AgentModelChoice | undefined {
  return catalog.models.find((model) => model.isDefault);
}

export function modelChoice(
  catalog: AgentConfigurationCatalog,
  value: string | undefined
): AgentModelChoice | undefined {
  return value === undefined
    ? defaultModel(catalog)
    : catalog.models.find((model) => model.value === value);
}

function field(
  key: string,
  choices: readonly AgentConfigurationChoice[],
  allowCustom: boolean
): AgentConfigurationField {
  return { key, choices, allowCustom };
}

function catalogFingerprint(
  input: ResolveAgentConfigurationInput,
  environment: NodeJS.ProcessEnv
): string {
  const bindings = input.agent.environment.map((binding) => ({
    target: binding.target,
    sourceName: binding.sourceName,
    value: environment[binding.sourceName] ?? null
  }));
  const nativeRoot = input.agent.adapterId === "codex"
    ? environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), ".codex")
    : environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), ".claude");
  const context = input.config?.adapterId === "codex"
    ? { profile: input.config.profile ?? null }
    : input.config?.adapterId === "claude"
      ? {
          settingsFile: input.config.settingsFile ?? null,
          settingsSources: input.config.settingsSources ?? null
        }
      : null;
  return createHash("sha256").update(JSON.stringify({
    adapterId: input.agent.adapterId,
    command: input.agent.command,
    baseArgs: input.agent.baseArgs,
    bindings,
    nativeRoot,
    cwd: input.cwd,
    context
  })).digest("hex");
}

function cachePath(yuiHome: string, agentId: string, fingerprint: string): string {
  return join(
    yuiHome,
    "cache",
    "agent-capabilities",
    "v1",
    agentId,
    `${fingerprint}.json`
  );
}

function readCachedCatalog(
  path: string,
  fingerprint: string,
  agent: ConfiguredAgent
): CachedCatalog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!record(parsed)
    || parsed.schemaVersion !== 1
    || parsed.fingerprint !== fingerprint
    || typeof parsed.fetchedAt !== "string") {
    return null;
  }
  try {
    return {
      schemaVersion: 1,
      fingerprint,
      fetchedAt: parsed.fetchedAt,
      catalog: validateCatalog(parsed.catalog, agent)
    };
  } catch {
    return null;
  }
}

function validateCatalog(
  value: unknown,
  agent: Pick<ConfiguredAgent, "id" | "adapterId">
): AgentConfigurationCatalog {
  if (!record(value)
    || value.schemaVersion !== 1
    || value.agentId !== agent.id
    || value.adapterId !== agent.adapterId
    || !Array.isArray(value.models)
    || value.models.length === 0
    || !Array.isArray(value.fields)
    || !Array.isArray(value.warnings)) {
    throw new Error("Agent configuration model catalog is incomplete.");
  }
  const models = value.models.map(validateModel);
  unique(models.map(({ value: model }) => model), "model");
  const fields = value.fields.map(validateField);
  unique(fields.map(({ key }) => key), "configuration field");
  const warnings = value.warnings.map((warning) => text(warning, "catalog warning"));
  return {
    schemaVersion: 1,
    agentId: agent.id,
    adapterId: agent.adapterId,
    ...(typeof value.cliVersion === "string"
      ? { cliVersion: text(value.cliVersion, "CLI version") } : {}),
    models,
    fields,
    warnings
  };
}

function validateModel(value: unknown): AgentModelChoice {
  if (!record(value) || typeof value.isDefault !== "boolean" || !Array.isArray(value.efforts)) {
    throw new Error("Agent configuration model entry is invalid.");
  }
  const efforts = value.efforts.map(validateChoice);
  unique(efforts.map(({ value: effort }) => effort), "effort");
  const serviceTiers = value.serviceTiers === undefined
    ? undefined
    : array(value.serviceTiers, "service tiers").map(validateChoice);
  if (serviceTiers !== undefined) {
    unique(serviceTiers.map(({ value: tier }) => tier), "service tier");
  }
  return {
    value: text(value.value, "model value"),
    label: text(value.label, "model label"),
    ...(typeof value.description === "string"
      ? { description: text(value.description, "model description") } : {}),
    ...(typeof value.resolvedModel === "string"
      ? { resolvedModel: text(value.resolvedModel, "resolved model") } : {}),
    isDefault: value.isDefault,
    ...(typeof value.defaultEffort === "string"
      ? { defaultEffort: text(value.defaultEffort, "default effort") } : {}),
    efforts,
    ...(serviceTiers === undefined ? {} : { serviceTiers }),
    ...(typeof value.defaultServiceTier === "string"
      ? { defaultServiceTier: text(value.defaultServiceTier, "default service tier") } : {})
  };
}

function validateField(value: unknown): AgentConfigurationField {
  if (!record(value) || !Array.isArray(value.choices) || typeof value.allowCustom !== "boolean") {
    throw new Error("Agent configuration field entry is invalid.");
  }
  const choices = value.choices.map(validateChoice);
  unique(choices.map(({ value: choice }) => choice), "field choice");
  return {
    key: text(value.key, "field key"),
    choices,
    allowCustom: value.allowCustom,
    ...(typeof value.available === "boolean" ? { available: value.available } : {}),
    ...(typeof value.reason === "string"
      ? { reason: text(value.reason, "field reason") } : {})
  };
}

function validateChoice(value: unknown): AgentConfigurationChoice {
  if (!record(value)) throw new Error("Agent configuration choice is invalid.");
  return {
    value: text(value.value, "choice value"),
    label: text(value.label, "choice label"),
    ...(typeof value.description === "string"
      ? { description: text(value.description, "choice description") } : {})
  };
}

function catalogFailure(error: unknown): AgentConfigurationFailure {
  const candidate = error instanceof Error ? error : new Error(String(error));
  const code = "code" in candidate ? String(candidate.code) : "";
  return {
    code: code === "ETIMEDOUT" || candidate.name === "AbortError"
      ? "timeout"
      : code === "ENOENT" ? "missing-command" : "probe-failed",
    message: candidate.message || "Agent capability discovery failed."
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Agent configuration ${label} are invalid.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Agent configuration ${label} is invalid.`);
  }
  return value.trim();
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Agent configuration ${label} entries contain duplicates.`);
  }
}
