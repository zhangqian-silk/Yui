import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parse } from "smol-toml";

import { configuredAgentLaunchEnvironment } from "../agent/launchEnvironment.js";
import type {
  AgentConfigurationCatalog,
  AgentConfigurationChoice,
  AgentConfigurationDiscoveryInput,
  AgentConfigurationField,
  AgentModelChoice
} from "./agentConfigurationCatalog.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 100;
const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
const CODEX_APPROVALS = ["untrusted", "on-request", "never"] as const;

export async function discoverCodexConfiguration(
  input: AgentConfigurationDiscoveryInput
): Promise<AgentConfigurationCatalog> {
  const environment = configuredAgentLaunchEnvironment(input.agent, input.environment);
  const profile = input.config?.adapterId === "codex" ? input.config.profile : undefined;
  const globalArgs = [
    ...input.agent.baseArgs,
    ...(profile === undefined ? [] : ["--profile", profile])
  ];
  const client = JsonRpcProcess.start(
    input.agent.command,
    [...globalArgs, "app-server", "--stdio"],
    input.cwd,
    environment,
    input.signal
  );
  try {
    const [version, help] = await Promise.all([
      runTextProcess(
        input.agent.command,
        [...input.agent.baseArgs, "--version"],
        input.cwd,
        environment,
        input.signal
      ),
      runTextProcess(
        input.agent.command,
        [...input.agent.baseArgs, "--help"],
        input.cwd,
        environment,
        input.signal
      ),
      client.request("initialize", {
        clientInfo: { name: "yui", title: "Yui", version: "0.2.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }).then(() => { client.notify("initialized", {}); })
    ]);
    const [models, requirementsResult, providerCapabilities] = await Promise.all([
      listCodexModels(client),
      client.request("configRequirements/read", {}),
      client.request("modelProvider/capabilities/read", {})
    ]);
    const requirements = object(requirementsResult)?.requirements;
    const requirementRecord = object(requirements);
    const allowedSandboxes = optionalStrings(requirementRecord?.allowedSandboxModes);
    const allowedApprovals = optionalStrings(requirementRecord?.allowedApprovalPolicies);
    const allowedWebSearchModes = optionalStrings(requirementRecord?.allowedWebSearchModes);
    const capabilityRecord = object(providerCapabilities);
    const webSearch = capabilityRecord?.webSearch === true
      && (allowedWebSearchModes === undefined || allowedWebSearchModes.includes("live"));
    const bypass = configurationFlagAvailable(
      help,
      "--dangerously-bypass-approvals-and-sandbox"
    );
    const sandboxChoices = intersectChoices(
      configurationHelpChoices(help, "--sandbox", CODEX_SANDBOXES),
      allowedSandboxes
    );
    const approvalChoices = intersectChoices(
      configurationHelpChoices(help, "--ask-for-approval", CODEX_APPROVALS),
      allowedApprovals
    );
    return {
      schemaVersion: 1,
      agentId: input.agent.id,
      adapterId: "codex",
      ...(semanticVersion(version) === undefined ? {} : { cliVersion: semanticVersion(version) }),
      models,
      fields: [
        field("model", [], true),
        field("effort", [], true),
        field("permission.strategy", [
          choice("default"),
          ...(bypass ? [choice("bypass")] : []),
          choice("configured")
        ], false, true, bypass ? undefined : "Codex bypass strategy is unavailable."),
        field("permission.sandbox", sandboxChoices.map(choice), false),
        field("permission.approval", approvalChoices.map(choice), false),
        field("search", webSearch ? [choice("true")] : [], false, webSearch,
          webSearch ? undefined : "Live web search is unavailable or disallowed."),
        field("profile", codexProfileChoices(environment).map(choice), true),
        field("additionalDirectories", [], true)
      ],
      warnings: client.warnings()
    };
  } finally {
    client.close();
  }
}

export async function discoverClaudeConfiguration(
  input: AgentConfigurationDiscoveryInput
): Promise<AgentConfigurationCatalog> {
  const environment = {
    ...configuredAgentLaunchEnvironment(input.agent, input.environment),
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts"
  };
  const config = input.config?.adapterId === "claude" ? input.config : undefined;
  const initializationArgs = [
    ...input.agent.baseArgs,
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--no-session-persistence",
    ...(config?.settingsSources === undefined
      ? [] : [`--setting-sources=${config.settingsSources.join(",")}`]),
    ...(config?.settingsFile === undefined ? [] : ["--settings", config.settingsFile])
  ];
  const [version, help, initialization] = await Promise.all([
    runTextProcess(
      input.agent.command,
      [...input.agent.baseArgs, "--version"],
      input.cwd,
      environment,
      input.signal
    ),
    runTextProcess(
      input.agent.command,
      [...input.agent.baseArgs, "--help"],
      input.cwd,
      environment,
      input.signal
    ),
    requestClaudeInitialization(
      input.agent.command,
      initializationArgs,
      input.cwd,
      environment,
      input.signal
    )
  ]);
  const initialized = object(initialization);
  const models = array(initialized?.models, "Claude model catalog").map(claudeModel);
  const permissionModes = configurationHelpChoices(help, "--permission-mode", []);
  const bypass = configurationFlagAvailable(help, "--dangerously-skip-permissions");
  const settingsSources = configurationHelpChoices(
    help,
    "--setting-sources",
    ["user", "project", "local"]
  );
  return {
    schemaVersion: 1,
    agentId: input.agent.id,
    adapterId: "claude",
    ...(semanticVersion(version) === undefined ? {} : { cliVersion: semanticVersion(version) }),
    models,
    fields: [
      field("model", [], true),
      field("effort", [], true),
      field("permission.strategy", [
        choice("default"),
        ...(bypass ? [choice("bypass")] : []),
        choice("configured")
      ], false, true, bypass ? undefined : "Claude bypass strategy is unavailable."),
      field("permission.mode", permissionModes.map(choice), true),
      field("permission.allowedTools", [], true),
      field("permission.disallowedTools", [], true),
      field("settingsSources", settingsSources.map(choice), false),
      field("settingsFile", [], true),
      field("additionalDirectories", [], true)
    ],
    warnings: []
  };
}

async function listCodexModels(client: JsonRpcProcess): Promise<AgentModelChoice[]> {
  const models: AgentModelChoice[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = object(await client.request("model/list", {
      limit: 100,
      includeHidden: false,
      ...(cursor === undefined ? {} : { cursor })
    }));
    for (const raw of array(result?.data, "Codex model catalog")) {
      models.push(codexModel(raw));
    }
    const next = result?.nextCursor;
    if (next === null || next === undefined) return models;
    if (typeof next !== "string" || next.length === 0) {
      throw new Error("Codex model catalog returned an invalid cursor.");
    }
    cursor = next;
  }
  throw new Error("Codex model catalog exceeded the pagination limit.");
}

function codexModel(value: unknown): AgentModelChoice {
  const model = requiredObject(value, "Codex model");
  const rawEfforts = array(model.supportedReasoningEfforts, "Codex model efforts");
  const efforts = rawEfforts.map((raw): AgentConfigurationChoice => {
    const effort = requiredObject(raw, "Codex effort");
    const value = requiredString(effort.reasoningEffort, "Codex effort value");
    return {
      value,
      label: value,
      ...(typeof effort.description === "string" && effort.description.trim().length > 0
        ? { description: effort.description.trim() } : {})
    };
  });
  const serviceTiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.map((raw): AgentConfigurationChoice => {
        const tier = requiredObject(raw, "Codex service tier");
        return {
          value: requiredString(tier.id, "Codex service tier id"),
          label: requiredString(tier.name, "Codex service tier name"),
          ...(typeof tier.description === "string" && tier.description.trim().length > 0
            ? { description: tier.description.trim() } : {})
        };
      })
    : undefined;
  return {
    value: requiredString(model.model ?? model.id, "Codex model value"),
    label: requiredString(model.displayName ?? model.model ?? model.id, "Codex model label"),
    ...(typeof model.description === "string" && model.description.trim().length > 0
      ? { description: model.description.trim() } : {}),
    isDefault: model.isDefault === true,
    ...(typeof model.defaultReasoningEffort === "string"
      ? { defaultEffort: model.defaultReasoningEffort } : {}),
    efforts,
    ...(serviceTiers === undefined ? {} : { serviceTiers }),
    ...(typeof model.defaultServiceTier === "string"
      ? { defaultServiceTier: model.defaultServiceTier } : {})
  };
}

function claudeModel(value: unknown): AgentModelChoice {
  const model = requiredObject(value, "Claude model");
  const modelValue = requiredString(model.value, "Claude model value");
  const effortValues = Array.isArray(model.supportedEffortLevels)
    ? model.supportedEffortLevels.map((effort) => requiredString(effort, "Claude effort"))
    : [];
  return {
    value: modelValue,
    label: requiredString(model.displayName ?? modelValue, "Claude model label"),
    ...(typeof model.description === "string" && model.description.trim().length > 0
      ? { description: model.description.trim() } : {}),
    ...(typeof model.resolvedModel === "string" && model.resolvedModel.trim().length > 0
      ? { resolvedModel: model.resolvedModel.trim() } : {}),
    isDefault: modelValue === "default",
    efforts: effortValues.map(choice)
  };
}

async function requestClaudeInitialization(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<unknown> {
  const requestId = `yui-catalog-${process.pid}`;
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const output = createInterface({ input: child.stdout });
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      output.close();
      terminateProcess(child);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const abort = (): void => finish(abortError());
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (!settled) finish(new Error(
        `Claude configuration probe exited before initialization (${code ?? exitSignal ?? "unknown"}).`
      ));
    });
    output.on("line", (line) => {
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(new Error("Claude configuration probe exceeded the output limit."));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      const envelope = object(message);
      const response = object(envelope?.response);
      if (envelope?.type !== "control_response" || response?.request_id !== requestId) return;
      if (response.subtype !== "success") {
        finish(new Error(typeof response.error === "string"
          ? response.error : "Claude configuration initialization failed."));
        return;
      }
      finish(undefined, response.response);
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(`${JSON.stringify({
      request_id: requestId,
      type: "control_request",
      request: { subtype: "initialize" }
    })}\n`);
  });
}

async function runTextProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<string> {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(`${stdout}\n${stderr}`);
    };
    const abort = (): void => {
      terminateProcess(child);
      finish(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", finish);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        terminateProcess(child);
        finish(new Error("Agent configuration probe exceeded the output limit."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        terminateProcess(child);
        finish(new Error("Agent configuration probe exceeded the output limit."));
      }
    });
    child.on("exit", (code, exitSignal) => {
      if (code === 0) finish();
      else finish(new Error(
        `Agent configuration probe exited (${code ?? exitSignal ?? "unknown"}).`
      ));
    });
  });
}

class JsonRpcProcess {
  readonly #pending = new Map<number, Readonly<{
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>>();
  readonly #stderr: string[] = [];
  #nextId = 1;
  #closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    signal: AbortSignal
  ) {
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => { this.#receive(line); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr.push(chunk);
      while (this.#stderr.join("").length > 16_384) this.#stderr.shift();
    });
    child.stdin.on("error", (error) => { this.#failAll(error); });
    const abort = (): void => {
      this.#failAll(abortError());
      this.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => { this.#failAll(error); });
    child.on("exit", (code, exitSignal) => {
      signal.removeEventListener("abort", abort);
      if (this.#closed) return;
      this.#failAll(new Error(
        `Codex App Server exited (${code ?? exitSignal ?? "unknown"}).`
      ));
    });
  }

  static start(
    command: string,
    args: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal
  ): JsonRpcProcess {
    return new JsonRpcProcess(spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
    }), signal);
  }

  request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Codex App Server is closed."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params: Readonly<Record<string, unknown>>): void {
    this.#write({ method, params });
  }

  warnings(): string[] {
    return this.#stderr.join("").split(/\r?\n/)
      .some((line) => /\b(?:warn|error|failed)\b/i.test(line))
      ? ["Codex App Server reported warnings during catalog discovery."]
      : [];
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    terminateProcess(this.child);
    this.#failAll(new Error("Codex App Server was closed."));
  }

  #receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const response = object(message);
    if (typeof response?.id !== "number") return;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    const error = object(response.error);
    if (error !== undefined) {
      pending.reject(new Error(typeof error.message === "string"
        ? error.message : "Codex App Server request failed."));
      return;
    }
    pending.resolve(response.result);
  }

  #write(value: Readonly<Record<string, unknown>>): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function terminateProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, PROCESS_TERMINATION_GRACE_MS);
  force.unref();
  child.once("exit", () => { clearTimeout(force); });
  child.kill("SIGTERM");
}

export function codexProfileChoices(environment: NodeJS.ProcessEnv): string[] {
  const root = environment.CODEX_HOME
    ?? join(environment.HOME ?? homedir(), ".codex");
  try {
    const profiles = object(parse(readFileSync(join(root, "config.toml"), "utf8")).profiles);
    return Object.keys(profiles ?? {}).filter((name) =>
      name.trim().length > 0 && !name.includes("\0")
    ).sort();
  } catch {
    return [];
  }
}

export function configurationHelpChoices(
  help: string,
  flag: string,
  fallback: readonly string[]
): string[] {
  const lines = help.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.includes(flag));
  if (start < 0) return [...fallback];
  let end = start + 1;
  while (end < lines.length && !/^\s{2,}(?:-[A-Za-z](?:,\s*)?|--)[\w-]/.test(lines[end] ?? "")) {
    end += 1;
  }
  const section = lines.slice(start, end).join("\n");
  const inline = /(?:\[possible values:\s*([^\]]+)\]|\(choices:\s*([^)]*)\))/i
    .exec(section);
  const declared = inline?.[1] ?? inline?.[2];
  const bulletValues = declared === undefined && /Possible values:/i.test(section)
    ? [...section.matchAll(/^\s*-\s*([\w.+-]+)\s*:/gm)].map((match) => match[1] ?? "")
    : [];
  const parsed = [...new Set((declared ?? bulletValues.join(","))
    .replace(/["']/g, "")
    .split(",")
    .map((value) => value.trim().replace(/\.$/, ""))
    .filter((value) => /^[\w.+-]+$/.test(value)))];
  return parsed.length === 0 ? [...fallback] : parsed;
}

function configurationFlagAvailable(help: string, flag: string): boolean {
  return help.replace(/\r\n/g, "\n").split("\n").some((line) =>
    line.includes(flag)
  );
}

function intersectChoices(
  choices: readonly string[],
  allowed: readonly string[] | undefined
): string[] {
  return allowed === undefined
    ? [...choices]
    : choices.filter((candidate) => allowed.includes(candidate));
}

function optionalStrings(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  return array(value, "configuration requirements").map((entry) =>
    requiredString(entry, "configuration requirement"));
}

function field(
  key: string,
  choices: readonly AgentConfigurationChoice[],
  allowCustom: boolean,
  available?: boolean,
  reason?: string
): AgentConfigurationField {
  return {
    key,
    choices,
    allowCustom,
    ...(available === undefined ? {} : { available }),
    ...(reason === undefined ? {} : { reason })
  };
}

function choice(value: string): AgentConfigurationChoice {
  return { value, label: value };
}

function semanticVersion(value: string): string | undefined {
  return /(?:^|\D)(\d+\.\d+\.\d+)(?:\D|$)/m.exec(value)?.[1];
}

function abortError(): Error {
  return Object.assign(new Error("Agent configuration discovery was aborted."), {
    name: "AbortError"
  });
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  const result = object(value);
  if (result === undefined) throw new Error(`${label} is invalid.`);
  return result;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}
