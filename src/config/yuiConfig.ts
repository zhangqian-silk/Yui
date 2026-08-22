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

/**
 * Issue 04 (context token budget): thresholds for one native Session
 * generation's observed per-request input peak, measured in tokens. When the
 * peak crosses the soft threshold the Leader wake carries a checkpoint
 * advisory; when it crosses the hard threshold the scheduler retires the
 * generation and starts a fresh one instead of waiting for provider-side
 * auto-compaction. The fields are additive and optional — Homes without them
 * keep these defaults, so no config migration is required.
 */
export const DEFAULT_CONTEXT_SOFT_TOKENS = 100_000;
export const DEFAULT_CONTEXT_HARD_TOKENS = 120_000;
export const MIN_CONTEXT_BUDGET_TOKENS = 1_000;
export const MAX_CONTEXT_BUDGET_TOKENS = 1_000_000;

export type ContextBudgetConfig = Readonly<{
  softTokens?: number;
  hardTokens?: number;
}>;

export type ResolvedContextBudget = Readonly<{
  softTokens: number;
  hardTokens: number;
}>;

function resolveContextBudgetToken(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer.`);
  }
  if (value < MIN_CONTEXT_BUDGET_TOKENS || value > MAX_CONTEXT_BUDGET_TOKENS) {
    throw new TypeError(
      `${label} must be between ${MIN_CONTEXT_BUDGET_TOKENS} and ${MAX_CONTEXT_BUDGET_TOKENS}.`
    );
  }
  return value;
}

export function resolveContextBudget(configured?: unknown): ResolvedContextBudget {
  if (configured === undefined || configured === null) {
    return { softTokens: DEFAULT_CONTEXT_SOFT_TOKENS, hardTokens: DEFAULT_CONTEXT_HARD_TOKENS };
  }
  if (typeof configured !== "object" || Array.isArray(configured)) {
    throw new TypeError("contextBudget must be an object.");
  }
  const record = configured as Record<string, unknown>;
  const softTokens = record.softTokens === undefined
    ? DEFAULT_CONTEXT_SOFT_TOKENS
    : resolveContextBudgetToken(record.softTokens, "contextBudget.softTokens");
  const hardTokens = record.hardTokens === undefined
    ? DEFAULT_CONTEXT_HARD_TOKENS
    : resolveContextBudgetToken(record.hardTokens, "contextBudget.hardTokens");
  if (softTokens >= hardTokens) {
    throw new TypeError("contextBudget.softTokens must be smaller than contextBudget.hardTokens.");
  }
  return { softTokens, hardTokens };
}
