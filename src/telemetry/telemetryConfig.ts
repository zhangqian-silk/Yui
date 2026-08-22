/**
 * Issue 09 — telemetry retention & compaction configuration.
 *
 * Telemetry lives in the Home's authoritative `yui.db` (database-only
 * direction). Its activation is an explicit per-Home diagnostic switch and
 * never changes canonical runtime-state persistence. Retention defaults are
 * the schema's own constants (§4.4); the environment only overrides them.
 */

import {
  TELEMETRY_KEEP_PER_GENERATION,
  TELEMETRY_RUN_CAP
} from "../storage/sqliteSchema.js";

/**
 * These names predate Agent Drivers and now control only the optional
 * diagnostic sidecar. Canonical `runtime.observation` state is always durable
 * and compacted independently; no mode changes lifecycle authority.
 */
export type TelemetryMode = "legacy" | "dual" | "bounded";

export const DEFAULT_TELEMETRY_MODE: TelemetryMode = "legacy";

/** Terminal Run/generation progress rows retained after prune. */
export const DEFAULT_TERMINAL_KEEP = TELEMETRY_KEEP_PER_GENERATION;

/** Hard cap of progress rows per Run while it is still active. */
export const DEFAULT_RUN_CAP = TELEMETRY_RUN_CAP;

/**
 * Absolute ceiling for the configurable Run cap. Retention can be tuned but
 * never disabled: every Home keeps a computable upper bound on telemetry
 * rows (Tasks × Runs × cap).
 */
export const MAX_RUN_CAP = 10_000_000;

const TELEMETRY_MODES: readonly TelemetryMode[] = ["legacy", "dual", "bounded"];

/**
 * Resolve the telemetry mode from the durable config value (default `legacy`).
 * Only the three exact values (case-insensitive) are accepted; anything else
 * fails closed at startup instead of silently changing diagnostic retention.
 */
export function resolveTelemetryMode(value?: unknown): TelemetryMode {
  if (typeof value !== "string") return DEFAULT_TELEMETRY_MODE;
  const raw = value.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_TELEMETRY_MODE;
  if (!TELEMETRY_MODES.includes(raw as TelemetryMode)) {
    throw new TypeError(
      `telemetryMode must be one of ${TELEMETRY_MODES.join(", ")}; got ${JSON.stringify(raw)}.`
    );
  }
  return raw as TelemetryMode;
}

/**
 * Resolve the terminal-Run retention window from the durable config value
 * (default 200). Must be a positive integer.
 */
export function resolveTerminalKeep(value?: unknown): number {
  return resolvePositiveInteger(value, DEFAULT_TERMINAL_KEEP, "telemetryTerminalKeep");
}

/**
 * Resolve the active-Run hard cap from the durable config value (default
 * 50,000). Must be a positive integer not exceeding {@link MAX_RUN_CAP};
 * the cap cannot be disabled.
 */
export function resolveRunCap(value?: unknown): number {
  const cap = resolvePositiveInteger(value, DEFAULT_RUN_CAP, "telemetryRunCap");
  if (cap > MAX_RUN_CAP) {
    throw new TypeError(
      `telemetryRunCap must not exceed ${MAX_RUN_CAP.toLocaleString("en-US")} (retention cannot be disabled).`
    );
  }
  return cap;
}

function resolvePositiveInteger(raw: unknown, fallback: number, label: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new TypeError(`${label} must be a positive integer; got ${JSON.stringify(raw)}.`);
  }
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer; got ${JSON.stringify(raw)}.`);
  }
  return value;
}
