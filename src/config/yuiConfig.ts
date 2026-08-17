export const DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 120;
export const MIN_RECONCILIATION_INTERVAL_SECONDS = 5;
export const MAX_RECONCILIATION_INTERVAL_SECONDS = 300;

export type ResourcesGcMode = "report" | "quarantine";
export const DEFAULT_RESOURCES_GC_MODE: ResourcesGcMode = "report";

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

/**
 * Issue 07 (Leader convergence) feature mode. `display` only shows the
 * read-only next-action projection; `warn` additionally reports duplicate
 * deliveries; `enforce` hard-blocks exact duplicates and exhausted semantic
 * budgets. The mode is additive and optional — Homes without it keep the
 * `display` default, so no config migration is required.
 */
export const LEADER_NEXT_ACTION_MODES = ["display", "warn", "enforce"] as const;
export type LeaderNextActionMode = typeof LEADER_NEXT_ACTION_MODES[number];
export const DEFAULT_LEADER_NEXT_ACTION_MODE: LeaderNextActionMode = "display";

export function resolveLeaderNextActionMode(value?: unknown): LeaderNextActionMode {
  if (value === undefined || value === null) return DEFAULT_LEADER_NEXT_ACTION_MODE;
  if (typeof value !== "string") {
    throw new TypeError("leaderNextActionMode must be display, warn, or enforce.");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return DEFAULT_LEADER_NEXT_ACTION_MODE;
  if (!(LEADER_NEXT_ACTION_MODES as readonly string[]).includes(normalized)) {
    throw new TypeError("leaderNextActionMode must be display, warn, or enforce.");
  }
  return normalized as LeaderNextActionMode;
}

/**
 * Resolve the effective mode. An explicit environment override
 * (`YUI_LEADER_NEXT_ACTION_MODE`) wins over the durable config value so a
 * single CLI invocation can be tightened or loosened without a config write.
 */
export function leaderNextActionMode(
  configured: unknown,
  env: NodeJS.ProcessEnv = process.env
): LeaderNextActionMode {
  const override = env.YUI_LEADER_NEXT_ACTION_MODE;
  if (override !== undefined && override.trim().length > 0) {
    return resolveLeaderNextActionMode(override);
  }
  return resolveLeaderNextActionMode(configured);
}
