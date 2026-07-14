import { validateAgentBaseArguments } from "./argumentPolicy.js";
import { isAbsolute } from "node:path";

export const MAX_PROBE_INTERPRETER_WITNESSES = 8;
export const MAX_PROBE_WITNESS_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_PROBE_WITNESS_TOTAL_BYTES = 256 * 1024 * 1024;

export type EnvironmentBinding = {
  target: string;
  source: "process";
  sourceName: string;
  required: boolean;
};

export type ProbeFileWitness = {
  path: string;
  sha256: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  birthtimeNs: string;
  dev: string;
  ino: string;
  mode: string;
};

export type ProbeInterpreterWitness = {
  invocation: string;
  file: ProbeFileWitness;
};

/**
 * A configuration-time trust record for the exact executable used by a
 * first-class Agent capability probe. It is deliberately separate from the
 * launch command: normal launches retain the user's configured command, while
 * probes execute only this verified absolute path.
 */
export type ProbeExecutablePin = {
  executable: ProbeFileWitness;
  executableKind: "native" | "script";
  interpreters: ProbeInterpreterWitness[];
};

export type ConfiguredAgent = {
  schemaVersion: 2;
  id: string;
  adapterId: string;
  command: string;
  baseArgs: string[];
  environment: EnvironmentBinding[];
  probePin?: ProbeExecutablePin;
  probePinRefreshRequired?: true;
  createdAt: string;
  updatedAt: string;
};

export type AgentDefinition = ConfiguredAgent & {
  source: "custom";
};

export function createConfiguredAgent(
  id: string,
  adapterId: string,
  command: string,
  baseArgs: string[],
  environment: EnvironmentBinding[],
  now: Date,
  probePin?: ProbeExecutablePin,
  probePinRefreshRequired?: true
): ConfiguredAgent {
  const trimmedId = id.trim();
  const trimmedAdapterId = adapterId.trim();
  const trimmedCommand = command.trim();
  const timestamp = now.toISOString();

  if (trimmedId.length === 0) {
    throw new Error("Agent id is required.");
  }
  if (["__proto__", "prototype", "constructor"].includes(trimmedId) || /[\/\\\0]/.test(trimmedId)) {
    throw new Error("Agent id is invalid.");
  }
  if (trimmedAdapterId.length === 0) {
    throw new Error("Agent adapter id is required.");
  }
  if (trimmedCommand.length === 0) {
    throw new Error("Agent command is required.");
  }
  if (probePinRefreshRequired !== undefined && probePinRefreshRequired !== true) {
    throw new Error("Agent capability probe pin refresh state is invalid.");
  }
  if (probePin !== undefined && probePinRefreshRequired === true) {
    throw new Error("Agent capability probe pin refresh state is invalid.");
  }
  validateAgentBaseArguments(trimmedAdapterId, baseArgs);

  return {
    schemaVersion: 2,
    id: trimmedId,
    adapterId: trimmedAdapterId,
    command: trimmedCommand,
    baseArgs: [...baseArgs],
    environment: environment.map(validateEnvironmentBinding),
    ...(probePin === undefined ? {} : { probePin: cloneProbeExecutablePin(probePin) }),
    ...(probePinRefreshRequired === undefined ? {} : { probePinRefreshRequired }),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function configuredAgentToDefinition(agent: ConfiguredAgent): AgentDefinition {
  return {
    ...agent,
    baseArgs: [...agent.baseArgs],
    environment: agent.environment.map((binding) => ({ ...binding })),
    ...(agent.probePin === undefined ? {} : { probePin: cloneProbeExecutablePin(agent.probePin) }),
    source: "custom"
  };
}

export function resolveAgentEnvironment(
  agent: AgentDefinition,
  processEnvironment: NodeJS.ProcessEnv
): Record<string, string> {
  return Object.fromEntries(agent.environment.flatMap((binding) => {
    const value = processEnvironment[binding.sourceName];
    if (value === undefined) {
      if (binding.required) {
        throw new Error("A required process environment variable is missing.");
      }
      return [];
    }
    return [[binding.target, value]];
  }));
}

function validateEnvironmentBinding(binding: EnvironmentBinding): EnvironmentBinding {
  const target = binding.target.trim();
  const sourceName = binding.sourceName.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceName)) {
    throw new Error("Agent environment bindings require valid process environment names.");
  }
  if (binding.source !== "process") {
    throw new Error("Agent environment values must be sourced from the process environment.");
  }
  return { target, source: "process", sourceName, required: binding.required };
}

export function isProbeExecutablePin(value: unknown): value is ProbeExecutablePin {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(value, ["executable", "executableKind", "interpreters"]) ||
    !isProbeFileWitness(value.executable) ||
    (value.executableKind !== "native" && value.executableKind !== "script") ||
    !Array.isArray(value.interpreters) ||
    value.interpreters.length > MAX_PROBE_INTERPRETER_WITNESSES ||
    !value.interpreters.every(isProbeInterpreterWitness)
  ) {
    return false;
  }
  const witnesses = [value.executable, ...value.interpreters.map((interpreter) => interpreter.file)];
  if (
    witnesses.some((witness) => BigInt(witness.size) > BigInt(MAX_PROBE_WITNESS_FILE_BYTES)) ||
    witnesses.reduce((total, witness) => total + BigInt(witness.size), 0n) >
      BigInt(MAX_PROBE_WITNESS_TOTAL_BYTES)
  ) {
    return false;
  }
  if (value.executableKind === "native") return value.interpreters.length === 0;
  return value.interpreters.length > 0;
}

export function cloneProbeExecutablePin(pin: ProbeExecutablePin): ProbeExecutablePin {
  if (!isProbeExecutablePin(pin)) {
    throw new Error("Agent capability probe pin is invalid.");
  }
  return {
    executable: { ...pin.executable },
    executableKind: pin.executableKind,
    interpreters: pin.interpreters.map((interpreter) => ({
      invocation: interpreter.invocation,
      file: { ...interpreter.file }
    }))
  };
}

function isProbeInterpreterWitness(value: unknown): value is ProbeInterpreterWitness {
  return isRecord(value) &&
    hasExactOwnKeys(value, ["invocation", "file"]) &&
    typeof value.invocation === "string" &&
    value.invocation.length > 0 &&
    value.invocation.length <= 4_096 &&
    !/[\0\r\n]/.test(value.invocation) &&
    (isAbsolute(value.invocation) || /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value.invocation)) &&
    isProbeFileWitness(value.file);
}

function isProbeFileWitness(value: unknown): value is ProbeFileWitness {
  return isRecord(value) &&
    hasExactOwnKeys(value, [
      "path", "sha256", "size", "mtimeNs", "ctimeNs", "birthtimeNs", "dev", "ino", "mode"
    ]) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    value.path.length <= 4_096 &&
    isAbsolute(value.path) &&
    !/[\0\r\n]/.test(value.path) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    isCanonicalUnsignedDecimal(value.size) &&
    isCanonicalUnsignedDecimal(value.mtimeNs) &&
    isCanonicalUnsignedDecimal(value.ctimeNs) &&
    isCanonicalUnsignedDecimal(value.birthtimeNs) &&
    isCanonicalUnsignedDecimal(value.dev) &&
    isCanonicalUnsignedDecimal(value.ino) &&
    isCanonicalUnsignedDecimal(value.mode);
}

export function isObsoleteProbeExecutablePin(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.every((key) => key === "executable" || key === "runtime") &&
    keys.includes("executable") &&
    isObsoleteProbeFileWitness(value.executable) &&
    (value.runtime === undefined || isObsoleteProbeFileWitness(value.runtime))
  ) {
    return true;
  }
  return keys.every((key) =>
    key === "executable" || key === "executableKind" || key === "interpreters") &&
    keys.length === 3 &&
    isObsoleteProbeFileWitness(value.executable) &&
    (value.executableKind === "native" || value.executableKind === "script") &&
    Array.isArray(value.interpreters) &&
    value.interpreters.length <= MAX_PROBE_INTERPRETER_WITNESSES &&
    value.interpreters.every((interpreter) =>
      isRecord(interpreter) &&
      Object.keys(interpreter).length === 2 &&
      typeof interpreter.invocation === "string" &&
      isObsoleteProbeFileWitness(interpreter.file));
}

function isObsoleteProbeFileWitness(value: unknown): boolean {
  if (!isRecord(value) || value.ctimeNs !== undefined) return false;
  const keys = Object.keys(value);
  const expected = ["path", "sha256", "size", "mtimeNs", "birthtimeNs", "dev", "ino", "mode"];
  return keys.length === expected.length &&
    expected.every((key) => keys.includes(key)) &&
    isProbeFileWitness({ ...value, ctimeNs: "0" });
}

function isCanonicalUnsignedDecimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && /^(0|[1-9][0-9]*)$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
