import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { WorkItem } from "../workItem/workItem.js";

/**
 * Pure first-progress advisory. Two fresh native generations without durable
 * Leader action are observable as an attention signal, but never replace the
 * Leader or Operator's decision about whether another generation is useful.
 */
export type FirstProgressAdvisory = Readonly<{
  attentionRecommended: boolean;
  generationsBeforeFirstProgress: number;
  firstGenerationAt?: string;
  firstProgressAt?: string;
  reason: string;
}>;

export function projectFirstProgressAdvisory(input: Readonly<{
  sessions: TaskRoleSessionSet | null;
  events: readonly TaskEvent[];
  workItems: readonly WorkItem[];
  reviewRounds: readonly ReviewRound[];
  integrations: readonly IntegrationAttempt[];
}>): FirstProgressAdvisory {
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
          .filter((event) => typeof event.payload.leaderTurnId === "string")
          .map((event) => ({ at: event.createdAt, ref: `event:${event.id}` })),
        ...input.workItems
          .filter((item) => item.status !== "retired")
          .map((item) => ({ at: item.createdAt, ref: `work-item:${item.id}` })),
        ...input.reviewRounds.map((round) => ({ at: round.createdAt, ref: `review-round:${round.id}` })),
        ...input.integrations.map((attempt) => ({ at: attempt.createdAt, ref: `integration-attempt:${attempt.id}` }))
      ]
        .filter(({ at }) => at >= firstGenerationAt)
        .sort((left, right) => left.at.localeCompare(right.at) || left.ref.localeCompare(right.ref));
  const firstProgressAt = progress[0]?.at;
  const generationsBeforeFirstProgress = unique.filter((session) => (
    firstProgressAt === undefined || session.createdAt <= firstProgressAt
  )).length;
  const attentionRecommended = firstProgressAt === undefined
    && generationsBeforeFirstProgress >= 2;
  return Object.freeze({
    attentionRecommended,
    generationsBeforeFirstProgress,
    ...(firstGenerationAt === undefined ? {} : { firstGenerationAt }),
    ...(firstProgressAt === undefined ? {} : { firstProgressAt }),
    reason: attentionRecommended
      ? `${generationsBeforeFirstProgress} fresh Leader generations produced no first durable progress; Operator attention may be useful before another generation.`
      : firstProgressAt !== undefined
        ? `First durable progress was recorded at ${firstProgressAt}.`
        : "Fewer than two Leader generations exist before first durable progress."
  });
}
