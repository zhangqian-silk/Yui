import { supportedAgentAdapterIds } from "../agent/adapterCatalog.js";
import { PROVIDER_RETRY_MAX_WINDOW_MS } from "../run/providerRetry.js";

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
 * Whether the Controller may automatically quarantine resources for terminal
 * Tasks. Defaults to false: automatic GC is always opt-in, and permanent
 * deletion remains a manual, delayed step.
 */
export function resolveResourcesGcAutoQuarantine(value?: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new TypeError("resourcesGcAutoQuarantine must be a boolean.");
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
 * read-only next-action decision support; `warn` additionally reports
 * duplicate deliveries and semantic-budget warnings; `enforce` hard-blocks
 * only exact duplicates, while semantic-budget exhaustion remains a warning
 * because it must not override Leader judgment. The mode is additive and
 * optional — Homes without it keep the `display` default, so no config
 * migration is required.
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

// ── Issue 01: Provider retry ──────────────────────────────────────────────

export const PROVIDER_RETRY_MODES = ["off", "shadow", "enforce"] as const;
export type ProviderRetryMode = (typeof PROVIDER_RETRY_MODES)[number];
export const DEFAULT_PROVIDER_RETRY_MODE: ProviderRetryMode = "enforce";

export function resolveProviderRetryMode(value?: unknown): ProviderRetryMode {
  if (value === undefined || value === null) return DEFAULT_PROVIDER_RETRY_MODE;
  if (typeof value !== "string") {
    throw new TypeError("providerRetryMode must be off, shadow, or enforce.");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return DEFAULT_PROVIDER_RETRY_MODE;
  if (!(PROVIDER_RETRY_MODES as readonly string[]).includes(normalized)) {
    throw new TypeError("providerRetryMode must be off, shadow, or enforce.");
  }
  return normalized as ProviderRetryMode;
}

/**
 * Resolves the adapter list. `["all"]` or undefined means every supported
 * adapter; an empty array disables in-place retry.
 */
export function resolveProviderRetryAdapters(value?: unknown): string[] {
  if (value === undefined || value === null) {
    return [...supportedAgentAdapterIds()];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("providerRetryAdapters must be an array of adapter ids.");
  }
  const supported = new Set<string>(supportedAgentAdapterIds());
  const adapters: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new TypeError("providerRetryAdapters entries must be strings.");
    }
    const token = raw.trim().toLowerCase();
    if (token === "all") {
      for (const adapter of supportedAgentAdapterIds()) {
        if (!adapters.includes(adapter)) adapters.push(adapter);
      }
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(token)) {
      throw new TypeError(`Invalid Provider retry adapter: ${token}.`);
    }
    if (!supported.has(token)) {
      throw new TypeError(`Unknown Provider retry adapter: ${token}.`);
    }
    if (!adapters.includes(token)) adapters.push(token);
  }
  return adapters;
}

export function resolveProviderRetryMaxWindowMs(value?: unknown): number {
  if (value === undefined || value === null) return PROVIDER_RETRY_MAX_WINDOW_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("providerRetryMaxWindowMs must be a positive integer.");
  }
  return value;
}

export function resolveYieldReceiptReplay(value?: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "boolean") {
    throw new TypeError("yieldReceiptReplay must be a boolean.");
  }
  return value;
}
