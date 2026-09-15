import {
  DEFAULT_RUN_CAP,
  DEFAULT_TERMINAL_KEEP,
  MAX_RUN_CAP
} from "../telemetry/telemetryConfig.js";
import {
  DEFAULT_RUNTIME_HEALTH_POLICY,
  type RuntimeHealthPolicy
} from "../runtime/runtimeHealthPolicy.js";

export const DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 120;
export const MIN_RECONCILIATION_INTERVAL_SECONDS = 5;
export const MAX_RECONCILIATION_INTERVAL_SECONDS = 300;

export type ResourcesGcMode = "report" | "quarantine";
export const DEFAULT_RESOURCES_GC_MODE: ResourcesGcMode = "report";
export const DEFAULT_RESOURCES_QUARANTINE_TTL_HOURS = 24;
export const MIN_RESOURCES_QUARANTINE_TTL_HOURS = 1;
export const MAX_RESOURCES_QUARANTINE_TTL_HOURS = 720;

/**
 * Resolves the Resource GC mode. `report` (default) only reports candidates;
 * `quarantine` allows `yui resources gc --apply` to quarantine releasable
 * resources.
 */
export function resolveResourcesGcMode(value?: unknown): ResourcesGcMode {
  if (value === undefined) return DEFAULT_RESOURCES_GC_MODE;
  if (value === "report" || value === "quarantine") return value;
  throw new TypeError("resourcesGcMode must be 'report' or 'quarantine'.");
}

/**
 * Whether the Controller may automatically quarantine resources for terminal
 * Tasks. Defaults to false: automatic GC is always opt-in, and permanent
 * deletion remains a manual, delayed step.
 */
export function resolveResourcesGcAutoQuarantine(value?: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new TypeError("resourcesGcAutoQuarantine must be a boolean.");
}

export function resolveResourcesQuarantineTtlHours(value?: unknown): number {
  return resolveBoundedPositiveInteger(
    value,
    DEFAULT_RESOURCES_QUARANTINE_TTL_HOURS,
    MIN_RESOURCES_QUARANTINE_TTL_HOURS,
    MAX_RESOURCES_QUARANTINE_TTL_HOURS,
    "resourcesQuarantineTtlHours"
  );
}

/**
 * Resolves the durable Yui setting used for low-frequency recovery
 * reconciliation. Normal durable state changes wake the Controller through
 * its event queue and do not wait for this interval.
 */
export function reconciliationIntervalMilliseconds(value?: unknown): number {
  const seconds = value ?? DEFAULT_RECONCILIATION_INTERVAL_SECONDS;
  if (
    typeof seconds !== "number"
    || !Number.isSafeInteger(seconds)
    || seconds < MIN_RECONCILIATION_INTERVAL_SECONDS
    || seconds > MAX_RECONCILIATION_INTERVAL_SECONDS
  ) {
    throw new TypeError(
      "reconciliationIntervalSeconds must be an integer from 5 to 300."
    );
  }
  return seconds * 1_000;
}

// ── Executable paths ──────────────────────────────────────────────────────

export function resolveTmuxBin(value?: unknown): string {
  if (value === undefined || value === null) return "tmux";
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("tmuxBin must be a non-empty string.");
  }
  return value.trim();
}

// ── Telemetry ─────────────────────────────────────────────────────────────

export function resolveTelemetryEnabled(value?: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new TypeError("telemetryEnabled must be a boolean.");
  return value;
}

export function resolveTelemetryTerminalKeep(value?: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TERMINAL_KEEP;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("telemetryTerminalKeep must be a positive integer.");
  }
  return value;
}

export function resolveTelemetryRunCap(value?: unknown): number {
  if (value === undefined || value === null) return DEFAULT_RUN_CAP;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("telemetryTurnCap must be a positive integer.");
  }
  if (value > MAX_RUN_CAP) {
    throw new TypeError(
      `telemetryTurnCap must not exceed ${MAX_RUN_CAP.toLocaleString("en-US")} (retention cannot be disabled).`
    );
  }
  return value;
}

// ── Runtime and workflow policy ───────────────────────────────────────────

export const DEFAULT_CONTROLLER_TASK_CONCURRENCY = 4;
export const MAX_CONTROLLER_TASK_CONCURRENCY = 32;
export const DEFAULT_AGENT_LAUNCH_INACTIVITY_TIMEOUT_SECONDS = 300;
export const DEFAULT_DELIVERY_TIMEOUT_SECONDS = 120;
export const DEFAULT_TMUX_HISTORY_LIMIT = 100_000;

export type RuntimeHealthConfig = Readonly<{
  quietAfterSeconds?: number;
  diagnosticAfterSeconds?: number;
  stallAfterSeconds?: number;
}>;

export function resolveRuntimeHealth(configured?: unknown): RuntimeHealthPolicy {
  if (configured === undefined || configured === null) return DEFAULT_RUNTIME_HEALTH_POLICY;
  if (typeof configured !== "object" || Array.isArray(configured)) {
    throw new TypeError("runtimeHealth must be an object.");
  }
  const value = configured as RuntimeHealthConfig;
  const quietAfterMs = resolveBoundedPositiveInteger(
    value.quietAfterSeconds,
    DEFAULT_RUNTIME_HEALTH_POLICY.quietAfterMs / 1_000,
    30,
    86_400,
    "runtimeHealth.quietAfterSeconds"
  ) * 1_000;
  const diagnosticAfterMs = resolveBoundedPositiveInteger(
    value.diagnosticAfterSeconds,
    DEFAULT_RUNTIME_HEALTH_POLICY.diagnosticAfterMs / 1_000,
    30,
    86_400,
    "runtimeHealth.diagnosticAfterSeconds"
  ) * 1_000;
  const stallWindowMs = resolveBoundedPositiveInteger(
    value.stallAfterSeconds,
    DEFAULT_RUNTIME_HEALTH_POLICY.stallWindowMs / 1_000,
    60,
    604_800,
    "runtimeHealth.stallAfterSeconds"
  ) * 1_000;
  if (!(quietAfterMs < diagnosticAfterMs && diagnosticAfterMs < stallWindowMs)) {
    throw new TypeError(
      "runtimeHealth thresholds must be ordered quietAfterSeconds < diagnosticAfterSeconds < stallAfterSeconds."
    );
  }
  return Object.freeze({ quietAfterMs, diagnosticAfterMs, stallWindowMs });
}

export function resolveControllerTaskConcurrency(value?: unknown): number {
  return resolveBoundedPositiveInteger(
    value,
    DEFAULT_CONTROLLER_TASK_CONCURRENCY,
    1,
    MAX_CONTROLLER_TASK_CONCURRENCY,
    "controllerTaskConcurrency"
  );
}

export function resolveAgentLaunchInactivityTimeoutSeconds(value?: unknown): number {
  return resolveBoundedPositiveInteger(
    value,
    DEFAULT_AGENT_LAUNCH_INACTIVITY_TIMEOUT_SECONDS,
    15,
    3_600,
    "agentLaunchInactivityTimeoutSeconds"
  );
}

export function resolveDeliveryTimeoutSeconds(value?: unknown): number {
  return resolveBoundedPositiveInteger(
    value,
    DEFAULT_DELIVERY_TIMEOUT_SECONDS,
    5,
    600,
    "deliveryTimeoutSeconds"
  );
}

export function resolveTmuxHistoryLimit(value?: unknown): number {
  return resolveBoundedPositiveInteger(
    value,
    DEFAULT_TMUX_HISTORY_LIMIT,
    1_000,
    1_000_000,
    "tmuxHistoryLimit"
  );
}

function resolveBoundedPositiveInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
