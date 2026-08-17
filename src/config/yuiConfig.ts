export const DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 120;
export const MIN_RECONCILIATION_INTERVAL_SECONDS = 5;
export const MAX_RECONCILIATION_INTERVAL_SECONDS = 300;

/**
 * Issue 03 independent switch. `report` (the default) keeps Session
 * reconciliation read-only: it records physical owner identity and reports
 * durable/physical mismatches without changing stop or archive behavior.
 * `exact-owner-cleanup` additionally proves physical exit before committing
 * `stopped` and blocks archive while owned physical resources remain live.
 */
export type SessionReconcileMode = "report" | "exact-owner-cleanup";
export const DEFAULT_SESSION_RECONCILE_MODE: SessionReconcileMode = "report";

export function sessionReconcileMode(value?: unknown): SessionReconcileMode {
  const mode = value ?? DEFAULT_SESSION_RECONCILE_MODE;
  if (mode !== "report" && mode !== "exact-owner-cleanup") {
    throw new TypeError(
      'session.reconcileMode must be "report" or "exact-owner-cleanup".'
    );
  }
  return mode;
}

/**
 * Reads the independent switch from the process environment. An invalid value
 * fails closed to `report` so a typo can never silently enable cleanup.
 */
export function sessionReconcileModeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): SessionReconcileMode {
  const value = environment.YUI_SESSION_RECONCILE_MODE;
  if (value === undefined || value === "") return DEFAULT_SESSION_RECONCILE_MODE;
  if (value !== "report" && value !== "exact-owner-cleanup") {
    return DEFAULT_SESSION_RECONCILE_MODE;
  }
  return value;
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
