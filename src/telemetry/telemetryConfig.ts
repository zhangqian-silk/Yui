/**
 * Issue 09 — telemetry retention & compaction configuration.
 *
 * Telemetry lives in the Home's authoritative `yui.db` (database-only
 * direction). Its activation is an explicit per-Home switch so the feature
 * can be rolled out (legacy → dual → bounded) and rolled back independently
 * of every other Issue. Retention defaults are the schema's own constants
 * (§4.4); the environment only overrides them.
 */

import {
  TELEMETRY_KEEP_PER_GENERATION,
  TELEMETRY_RUN_CAP
} from "../storage/sqliteSchema.js";

/**
 * - `legacy`  — progress is written only to semantic Task events (master
 *   behavior). The sidecar is not opened.
 * - `dual`    — progress keeps going to semantic events AND is upserted into
 *   the sidecar. Used to validate count/sequence consistency before pruning.
 * - `bounded` — progress goes only to the sidecar; semantic Task events stop
 *   carrying `runtime.provider-turn-progress` rows.
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
 * Resolve `YUI_TELEMETRY_MODE` (default `legacy`). Only the three exact
 * values (case-insensitive) are accepted; anything else fails closed at
 * startup instead of silently changing progress routing.
 */
export function resolveTelemetryMode(env: NodeJS.ProcessEnv = process.env): TelemetryMode {
  const raw = env.YUI_TELEMETRY_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_TELEMETRY_MODE;
  if (!TELEMETRY_MODES.includes(raw as TelemetryMode)) {
    throw new TypeError(
      `YUI_TELEMETRY_MODE must be one of ${TELEMETRY_MODES.join(", ")}; got ${JSON.stringify(raw)}.`
    );
  }
  return raw as TelemetryMode;
}

/**
 * Resolve the terminal-Run retention window (`YUI_TELEMETRY_TERMINAL_KEEP`,
 * default 200). Must be a positive integer.
 */
export function resolveTerminalKeep(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePositiveInteger(env.YUI_TELEMETRY_TERMINAL_KEEP, DEFAULT_TERMINAL_KEEP, "YUI_TELEMETRY_TERMINAL_KEEP");
}

/**
 * Resolve the active-Run hard cap (`YUI_TELEMETRY_RUN_CAP`, default 50,000).
 * Must be a positive integer not exceeding {@link MAX_RUN_CAP}; the cap
 * cannot be disabled.
 */
export function resolveRunCap(env: NodeJS.ProcessEnv = process.env): number {
  const cap = resolvePositiveInteger(env.YUI_TELEMETRY_RUN_CAP, DEFAULT_RUN_CAP, "YUI_TELEMETRY_RUN_CAP");
  if (cap > MAX_RUN_CAP) {
    throw new TypeError(
      `YUI_TELEMETRY_RUN_CAP must not exceed ${MAX_RUN_CAP.toLocaleString("en-US")} (retention cannot be disabled).`
    );
  }
  return cap;
}

function resolvePositiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer; got ${JSON.stringify(raw)}.`);
  }
  return value;
}
