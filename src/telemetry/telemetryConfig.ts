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
  TELEMETRY_TURN_CAP
} from "../storage/sqliteSchema.js";

/**
 * These names predate Agent Drivers and now control only the optional
 * diagnostic sidecar. Canonical `runtime.observation` state is always durable
 * and compacted independently; no mode changes lifecycle authority.
 */
export type TelemetryMode = "off" | "on";

export const DEFAULT_TELEMETRY_MODE: TelemetryMode = "off";

/** Terminal Turn/generation progress rows retained after prune. */
export const DEFAULT_TERMINAL_KEEP = TELEMETRY_KEEP_PER_GENERATION;

/** Hard cap of progress rows per Turn while it is still active. */
export const DEFAULT_TURN_CAP = TELEMETRY_TURN_CAP;

/**
 * Absolute ceiling for the configurable Turn cap. Retention can be tuned but
 * never disabled: every Home keeps a computable upper bound on telemetry
 * rows (Tasks × Turns × cap).
 */
export const MAX_TURN_CAP = 10_000_000;

/**
 * Resolve the terminal-Turn retention window from the durable config value
 * (default 200). Must be a positive integer.
 */
export function resolveTerminalKeep(value?: unknown): number {
  return resolvePositiveInteger(value, DEFAULT_TERMINAL_KEEP, "telemetryTerminalKeep");
}

/**
 * Resolve the active-Turn hard cap from the durable config value (default
 * 50,000). Must be a positive integer not exceeding {@link MAX_TURN_CAP};
 * the cap cannot be disabled.
 */
export function resolveTurnCap(value?: unknown): number {
  const cap = resolvePositiveInteger(value, DEFAULT_TURN_CAP, "telemetryTurnCap");
  if (cap > MAX_TURN_CAP) {
    throw new TypeError(
      `telemetryTurnCap must not exceed ${MAX_TURN_CAP.toLocaleString("en-US")} (retention cannot be disabled).`
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
