/**
 * Single source of truth for runtime health thresholds shared by the CLI
 * status projection, the Web snapshot, and the scheduler stall pass.
 *
 * The layers are deliberately time-based and conservative: short silence is
 * normal for high-reasoning-effort turns, large reviews, and tool waits.
 * Time-based layers authorize display hints and coalesced read-only diagnosis
 * only. They never reset a Turn or replace a Provider Session.
 */

/** Runtime silence after which a live turn is surfaced as "quiet" (hint only). */
export const RUNTIME_QUIET_AFTER_MS = 5 * 60_000;

/** No durable semantic progress after which the checkpoint is displayed as overdue. */
export const RUNTIME_DIAGNOSTIC_AFTER_MS = 15 * 60_000;

/** No durable semantic progress before one coalesced read-only runtime probe is due. */
export const SEMANTIC_STALL_WINDOW_MS = 30 * 60_000;

export type RuntimeHealthPolicy = Readonly<{
  quietAfterMs: number;
  diagnosticAfterMs: number;
  stallWindowMs: number;
}>;

export const DEFAULT_RUNTIME_HEALTH_POLICY: RuntimeHealthPolicy = Object.freeze({
  quietAfterMs: RUNTIME_QUIET_AFTER_MS,
  diagnosticAfterMs: RUNTIME_DIAGNOSTIC_AFTER_MS,
  stallWindowMs: SEMANTIC_STALL_WINDOW_MS
});
