/**
 * Canonical taxonomy for Leader wake reasons.
 *
 * The leader-role WorkMailbox pending batch is the durable aggregation bucket;
 * it stores reason tags as strings. This module is the single taxonomy that
 * producers use to build those tags and that the wake envelope uses to render
 * them together with their record references. The mailbox stays a generic
 * queue — the wake layer owns the meaning of its tags.
 *
 * Tag wire format: `<kind>` or `<kind>:<ref>`. The ref is an exact record
 * identifier (InputRequest id, Turn id, ...) or, for `force-wake`, the
 * operator-supplied text. Unknown kinds parse losslessly so a newer producer
 * can never wedge an older reader.
 */

export const WAKE_REASON_KINDS = Object.freeze([
  "role-result",
  "input-timeout",
  "role-turn-stalled",
  "agent-error",
  "agent-session-recovery",
  "review-failed",
  "task-reopened",
  "leader-turn-failed",
  "role-turn-failed",
  "job-finished",
  "published-tree-authorized",
  "force-wake"
] as const);

export type WakeReasonKind = (typeof WAKE_REASON_KINDS)[number];

export type WakeReason = Readonly<{
  kind: string;
  /** Exact record reference carried by the tag, when the kind has one. */
  ref?: string;
  /** Urgent reasons bypass any debounce and must be dispatched promptly. */
  immediate: boolean;
}>;

const IMMEDIATE_KINDS: ReadonlySet<string> = new Set([
  "task-reopened",
  "leader-turn-failed",
  "role-turn-failed"
]);

export function wakeReason(kind: WakeReasonKind, ref?: string): string {
  if (ref === undefined) return kind;
  const normalized = ref.trim();
  if (normalized.length === 0) throw new Error(`Wake reason ref is required: ${kind}.`);
  if (normalized.includes(":")) {
    throw new Error(`Wake reason ref must not contain ':': ${normalized}.`);
  }
  return `${kind}:${normalized}`;
}

export function parseWakeReason(tag: string): WakeReason {
  const normalized = tag.trim();
  if (normalized.length === 0) throw new Error("Wake reason tag is required.");
  const separator = normalized.indexOf(":");
  const kind = separator < 0 ? normalized : normalized.slice(0, separator);
  const ref = separator < 0 ? undefined : normalized.slice(separator + 1);
  return {
    kind,
    ...(ref === undefined || ref.length === 0 ? {} : { ref }),
    immediate: IMMEDIATE_KINDS.has(kind)
  };
}

/** One-line rendering for the wake envelope: `kind (ref)` or `kind`. */
export function renderWakeReason(tag: string): string {
  const reason = parseWakeReason(tag);
  return reason.ref === undefined ? reason.kind : `${reason.kind} (${reason.ref})`;
}

/** True when any aggregated reason demands prompt dispatch. */
export function hasImmediateWakeReason(tags: readonly string[]): boolean {
  return tags.some((tag) => parseWakeReason(tag).immediate);
}
