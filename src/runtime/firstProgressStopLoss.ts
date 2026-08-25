import { createHash } from "node:crypto";

import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { WorkItem } from "../workItem/workItem.js";

/**
 * Pure first-progress stop-loss. A third fresh native generation is blocked
 * when the first two generations produced no durable Leader action. The
 * projection is rebuilt from existing records; it is not retry state.
 */
export type FirstProgressStopLoss = Readonly<{
  exhausted: boolean;
  generationsBeforeFirstProgress: number;
  firstGenerationAt?: string;
  firstProgressAt?: string;
  generationRefs: readonly string[];
  progressRefs: readonly string[];
  fingerprint: string;
  reason: string;
}>;

export type ProviderRetryPolicy = Readonly<{
  delaysMs: readonly number[];
  maxWindowMs: number;
}>;

/** One automatic same-Session continuation is allowed before first progress. */
export function boundProviderRetryBeforeFirstProgress(
  policy: ProviderRetryPolicy,
  projection: Pick<FirstProgressStopLoss, "firstProgressAt">
): ProviderRetryPolicy {
  return projection.firstProgressAt === undefined
    ? Object.freeze({ delaysMs: policy.delaysMs.slice(0, 1), maxWindowMs: policy.maxWindowMs })
    : policy;
}

export function projectFirstProgressStopLoss(input: Readonly<{
  sessions: TaskRoleSessionSet | null;
  events: readonly TaskEvent[];
  workItems: readonly WorkItem[];
  reviewRounds: readonly ReviewRound[];
  integrations: readonly IntegrationAttempt[];
}>): FirstProgressStopLoss {
  const sessions = input.sessions === null
    ? []
    : [...(input.sessions.history ?? []), ...Object.values(input.sessions.sessions)]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const unique = [...new Map(sessions.map((session) => [
    `${session.nativeSessionId}\0${session.launchId ?? ""}`,
    session
  ])).values()];
  const firstGenerationAt = unique[0]?.createdAt;
  const progress = firstGenerationAt === undefined
    ? []
    : [
        ...input.events
          .filter((event) => typeof event.payload.leaderRunId === "string")
          .map((event) => ({ at: event.createdAt, ref: `event:${event.id}` })),
        ...input.workItems.map((item) => ({ at: item.createdAt, ref: `work-item:${item.id}` })),
        ...input.reviewRounds.map((round) => ({ at: round.createdAt, ref: `review-round:${round.id}` })),
        ...input.integrations.map((attempt) => ({ at: attempt.createdAt, ref: `integration-attempt:${attempt.id}` }))
      ]
        .filter(({ at }) => at >= firstGenerationAt)
        .sort((left, right) => left.at.localeCompare(right.at) || left.ref.localeCompare(right.ref));
  const firstProgressAt = progress[0]?.at;
  const generationsBeforeFirstProgress = unique.filter((session) => (
    firstProgressAt === undefined || session.createdAt <= firstProgressAt
  )).length;
  const generationRefs = unique.map((session) => (
    `${session.nativeSessionId}@${session.launchId ?? session.createdAt}`
  ));
  const progressRefs = progress.map(({ ref }) => ref);
  const exhausted = firstProgressAt === undefined && generationsBeforeFirstProgress >= 2;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ generationRefs, progressRefs }))
    .digest("hex");
  return Object.freeze({
    exhausted,
    generationsBeforeFirstProgress,
    ...(firstGenerationAt === undefined ? {} : { firstGenerationAt }),
    ...(firstProgressAt === undefined ? {} : { firstProgressAt }),
    generationRefs,
    progressRefs,
    fingerprint,
    reason: exhausted
      ? `${generationsBeforeFirstProgress} fresh Leader generations produced no first durable progress; stop before creating another generation and hand off to the Operator.`
      : firstProgressAt !== undefined
        ? `First durable progress was recorded at ${firstProgressAt}.`
        : `Fewer than two Leader generations exist before first durable progress.`
  });
}
