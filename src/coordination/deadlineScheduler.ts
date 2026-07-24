export type ScheduledDeadline<TKey extends string = string> = Readonly<{
  key: TKey;
  at: number;
}>;

export type NearestDeadlineBatch<TKey extends string = string> = Readonly<{
  at: number;
  keys: readonly TKey[];
}>;

/**
 * Pure nearest-deadline selection shared by business deadlines and runtime
 * recovery deadlines. Invalid timestamps are ignored and equal deadlines are
 * coalesced into one wake batch.
 */
export function nearestDeadlineBatch<TKey extends string>(
  deadlines: readonly ScheduledDeadline<TKey>[]
): NearestDeadlineBatch<TKey> | null {
  const valid = deadlines.filter((deadline) => Number.isFinite(deadline.at));
  if (valid.length === 0) return null;
  const at = Math.min(...valid.map((deadline) => deadline.at));
  return {
    at,
    keys: [...new Set(
      valid.filter((deadline) => deadline.at === at).map((deadline) => deadline.key)
    )]
  };
}
