import { isDeepStrictEqual } from "node:util";

import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { DurableJob } from "../job/durableJob.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { PublicationReference } from "../task/publicationReference.js";
import type { Turn } from "../turn/turn.js";
import { isCompletedReviewExecutionFromTurns } from "../review/reviewAcceptance.js";
import type { ReviewRound } from "../review/reviewRound.js";
import { projectFirstProgressAdvisory } from "../runtime/firstProgressAdvisory.js";
import type { Task } from "../task/task.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import type { WorkItem } from "../workItem/workItem.js";

export type OrchestrationAdvisoryCode =
  | "bugfix-workitem-overhead"
  | "repeated-integration-check"
  | "repeated-full-review"
  | "provider-first-progress-advisory";

export type OrchestrationAdvisory = Readonly<{
  code: OrchestrationAdvisoryCode;
  reason: string;
  refs: readonly string[];
}>;

export type TaskOrchestrationMetrics = Readonly<{
  taskId: string;
  taskType: string | null;
  timeToFirstProjectCommitMs: number | null;
  turns: Readonly<{
    total: number;
    byStatus: Readonly<Record<string, number>>;
    byRole: Readonly<Record<string, number>>;
  }>;
  workItems: number;
  reviews: Readonly<{
    full: number;
    delta: number;
    failed: number;
  }>;
  integrations: Readonly<{
    attempts: number;
    failed: number;
    repeatedIdentities: number;
    evidenceReuses: number;
  }>;
  providerGenerationsBeforeFirstProgress: number;
  publicationToCompletionMs: number | null;
  terminalWorkspaceCount: number;
  advisories: readonly OrchestrationAdvisory[];
}>;

export type TaskOrchestrationFacts = Readonly<{
  task: Task;
  turns: readonly Turn[];
  roleSessionSets: readonly TaskRoleSessionSet[];
  workItems: readonly WorkItem[];
  changeSets: readonly ChangeSet[];
  reviewRounds: readonly ReviewRound[];
  integrations: readonly IntegrationAttempt[];
  durableJobs: readonly DurableJob[];
  publications: readonly PublicationReference[];
  events: readonly TaskEvent[];
  managedWorkspaces: readonly ManagedWorkspace[];
}>;

/** One Task's orchestration cost and advisory projection, with no writes. */
export function projectTaskOrchestration(
  facts: TaskOrchestrationFacts
): TaskOrchestrationMetrics {
  const fullRounds = facts.reviewRounds.filter((round) => round.deltaRecheck === undefined);
  const deltaRounds = facts.reviewRounds.filter((round) => round.deltaRecheck !== undefined);

  const candidateTimes = [
    ...facts.changeSets.map(({ createdAt }) => createdAt),
    ...facts.workItems.flatMap((item) => item.candidates
      .filter((candidate) => candidate.gitSnapshot !== undefined
        || candidate.taskMainSnapshot?.projects.some((project) => (
          project.baseCommit !== project.headCommit
        )))
      .map(({ createdAt }) => createdAt))
  ].sort();
  const firstCommitAt = candidateTimes[0];

  const integrationIdentities = new Map<string, number>();
  for (const job of facts.durableJobs) {
    if (job.owner.kind !== "integration-attempt") continue;
    const integrationAttemptId = job.owner.integrationAttemptId;
    const attempt = facts.integrations.find(({ id }) => id === integrationAttemptId);
    if (attempt === undefined || attempt.jobId !== job.id) continue;
    const identity = `${attempt.projectId}\0${job.head}\0${JSON.stringify(attempt.checkCommands)}`;
    integrationIdentities.set(identity, (integrationIdentities.get(identity) ?? 0) + 1);
  }
  const repeatedIdentities = [...integrationIdentities.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);

  const leaderSessions = facts.roleSessionSets.find(({ owner }) => owner.roleName === "leader") ?? null;
  const firstProgress = projectFirstProgressAdvisory({
    sessions: leaderSessions,
    events: facts.events,
    workItems: facts.workItems,
    reviewRounds: facts.reviewRounds,
    integrations: facts.integrations
  });
  const advisories = projectAdvisories(
    facts,
    fullRounds,
    repeatedIdentities,
    firstProgress.attentionRecommended
  );
  const publicationAt = facts.task.completedAt === undefined
    ? undefined
    : facts.publications
      .map((reference) => reference.mergedAt ?? reference.createdAt)
      .filter((timestamp) => timestamp <= facts.task.completedAt!)
      .sort()
      .at(-1);

  return Object.freeze({
    taskId: facts.task.id,
    taskType: facts.task.type ?? null,
    timeToFirstProjectCommitMs: firstCommitAt === undefined
      ? null
      : Math.max(0, Date.parse(firstCommitAt) - Date.parse(facts.task.createdAt)),
    turns: {
      total: facts.turns.length,
      byStatus: counts(facts.turns.map(({ status }) => status)),
      byRole: counts(facts.turns.map(({ roleName }) => roleName))
    },
    workItems: facts.workItems.length,
    reviews: {
      full: fullRounds.length,
      delta: deltaRounds.length,
      failed: facts.reviewRounds.filter(({ status }) => status === "failed").length
    },
    integrations: {
      attempts: facts.integrations.length,
      failed: facts.integrations.filter(({ status }) => status === "failed").length,
      repeatedIdentities,
      evidenceReuses: facts.integrations.filter((attempt) => (
        (attempt.checks ?? []).some(({ details }) => details?.startsWith("Reused successful check evidence from "))
      )).length
    },
    providerGenerationsBeforeFirstProgress: firstProgress.generationsBeforeFirstProgress,
    publicationToCompletionMs: publicationAt === undefined || facts.task.completedAt === undefined
      ? null
      : Math.max(0, Date.parse(facts.task.completedAt) - Date.parse(publicationAt)),
    terminalWorkspaceCount: terminalWorkspaceCount(facts),
    advisories
  });
}

function projectAdvisories(
  facts: TaskOrchestrationFacts,
  fullRounds: readonly ReviewRound[],
  repeatedIdentities: number,
  firstProgressAttention: boolean
): OrchestrationAdvisory[] {
  const result: OrchestrationAdvisory[] = [];
  if (facts.task.type === "bugfix" && facts.workItems.length > 0) {
    result.push({
      code: "bugfix-workitem-overhead",
      reason: `Bugfix ${facts.task.id} created ${facts.workItems.length} WorkItem(s); bugfixes are Leader-owned, so reclassify expanding scope as a feature before delegating independent delivery units.`,
      refs: facts.workItems.map(({ id }) => `work-item:${id}`)
    });
  }
  if (repeatedIdentities > 0) {
    result.push({
      code: "repeated-integration-check",
      reason: `${repeatedIdentities} Integration DurableJob(s) reran the same candidate commit and ordered checks.`,
      refs: facts.durableJobs
        .filter(({ owner }) => owner.kind === "integration-attempt")
        .map(({ id }) => `durable-job:${id}`)
    });
  }
  const completedFull = fullRounds.filter((round) => (
    isCompletedReviewExecutionFromTurns(round, facts.turns)
  ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const recent = completedFull.slice(-3);
  const sameCandidate = recent.length === 3
    && recent.every((round) => isDeepStrictEqual(
      round.taskCandidate,
      recent[0]!.taskCandidate
    ));
  const sameReviewer = recent.length === 3
    && recent.every((round) => round.reviewerRoleName === recent[0]!.reviewerRoleName);
  if (sameCandidate && sameReviewer) {
    result.push({
      code: "repeated-full-review",
      reason: `The same Reviewer completed three full Reviews of the same frozen candidate; Core does not inspect their result text, so this is only a cost advisory.`,
      refs: recent.map(({ id }) => `review-round:${id}`)
    });
  }
  if (firstProgressAttention) {
    result.push({
      code: "provider-first-progress-advisory",
      reason: "Two fresh Leader generations produced no first durable progress; consider Operator attention before another generation.",
      refs: [facts.task.id]
    });
  }
  return result;
}

function terminalWorkspaceCount(facts: TaskOrchestrationFacts): number {
  return facts.managedWorkspaces.filter(({ owner }) => {
    if (owner.type === "task") return false;
    if (owner.type === "work-item") {
      return terminalStatus(facts.workItems.find(({ id }) => id === owner.workItemId)?.status);
    }
    if (owner.type === "review-round") {
      return terminalStatus(facts.reviewRounds.find(({ id }) => id === owner.reviewRoundId)?.status);
    }
    if (owner.type === "integration-attempt") {
      return terminalStatus(facts.integrations.find(({ id }) => id === owner.integrationAttemptId)?.status);
    }
    if (owner.workItemId !== undefined) {
      return terminalStatus(facts.workItems.find(({ id }) => id === owner.workItemId)?.status);
    }
    return owner.reviewRoundId !== undefined
      && terminalStatus(facts.reviewRounds.find(({ id }) => id === owner.reviewRoundId)?.status);
  }).length;
}

function terminalStatus(status: string | undefined): boolean {
  return status !== undefined && !["pending", "running", "awaiting_acceptance", "blocked", "validating"].includes(status);
}

function counts(values: readonly string[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.freeze(result);
}
