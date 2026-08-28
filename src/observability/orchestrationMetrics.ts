import { isDeepStrictEqual } from "node:util";

import type { Decision } from "../decision/decision.js";
import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { DurableJob } from "../job/durableJob.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import type { PublicationReference } from "../task/publicationReference.js";
import type { AgentRun } from "../run/agentRun.js";
import type { ReviewFinding } from "../review/reviewFinding.js";
import { classifyReviewRoundOutcome } from "../review/reviewOutcomeClassifier.js";
import type { ReviewRound } from "../review/reviewRound.js";
import { projectFirstProgressAdvisory } from "../runtime/firstProgressAdvisory.js";
import type { Task } from "../task/task.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import type { WorkItem } from "../workItem/workItem.js";

export type OrchestrationAdvisoryCode =
  | "bugfix-workitem-overhead"
  | "review-repair-fanout"
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
  runs: Readonly<{
    total: number;
    byStatus: Readonly<Record<string, number>>;
    byRole: Readonly<Record<string, number>>;
  }>;
  workItems: number;
  reviews: Readonly<{
    full: number;
    delta: number;
    nonSemantic: number;
    ambiguous: number;
    p1P2Findings: number;
    p1P2FindingsPerSemanticReview: number;
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
  runs: readonly AgentRun[];
  roleSessionSets: readonly TaskRoleSessionSet[];
  workItems: readonly WorkItem[];
  changeSets: readonly ChangeSet[];
  reviewRounds: readonly ReviewRound[];
  reviewFindings: readonly ReviewFinding[];
  integrations: readonly IntegrationAttempt[];
  durableJobs: readonly DurableJob[];
  publications: readonly PublicationReference[];
  decisions: readonly Decision[];
  events: readonly TaskEvent[];
  managedWorkspaces: readonly ManagedWorkspace[];
}>;

/** One Task's orchestration cost and advisory projection, with no writes. */
export function projectTaskOrchestration(
  facts: TaskOrchestrationFacts
): TaskOrchestrationMetrics {
  const evidence = {
    listAgentRuns: () => facts.runs,
    listReviewFindings: () => facts.reviewFindings,
    listEvents: () => facts.events
  };
  const fullRounds = facts.reviewRounds.filter((round) => round.deltaRecheck === undefined);
  const deltaRounds = facts.reviewRounds.filter((round) => round.deltaRecheck !== undefined);
  const classifications = new Map(facts.reviewRounds.map((round) => (
    [round.id, classifyReviewRoundOutcome(round, evidence)] as const
  )));
  const semanticRounds = facts.reviewRounds.filter((round) => (
    classifications.get(round.id)?.kind === "semantic"
  ));
  const p1P2Findings = facts.reviewFindings.filter((finding) => (
    (finding.severity === "p1" || finding.severity === "p2")
    && semanticRounds.some((round) => round.id === finding.firstReviewRoundId)
  )).length;

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
    classifications,
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
    runs: {
      total: facts.runs.length,
      byStatus: counts(facts.runs.map(({ status }) => status)),
      byRole: counts(facts.runs.map(({ roleName }) => roleName))
    },
    workItems: facts.workItems.length,
    reviews: {
      full: fullRounds.length,
      delta: deltaRounds.length,
      nonSemantic: [...classifications.values()].filter((value) => value?.kind === "non-semantic").length,
      ambiguous: [...classifications.values()].filter((value) => value?.kind === "ambiguous").length,
      p1P2Findings,
      p1P2FindingsPerSemanticReview: semanticRounds.length === 0
        ? 0
        : p1P2Findings / semanticRounds.length
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
  classifications: ReadonlyMap<string, ReturnType<typeof classifyReviewRoundOutcome>>,
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
  const repairItems = facts.workItems.filter((item) => (
    item.acceptance.some((line) => line.startsWith("review-finding:"))
  ));
  const byRound = new Map<string, WorkItem[]>();
  for (const item of repairItems) {
    const roundIds = new Set(item.acceptance.flatMap((line) => {
      const findingId = line.startsWith("review-finding:") ? line.slice("review-finding:".length) : "";
      const finding = facts.reviewFindings.find(({ id }) => id === findingId);
      return finding === undefined ? [] : [finding.firstReviewRoundId];
    }));
    for (const roundId of roundIds) byRound.set(roundId, [...(byRound.get(roundId) ?? []), item]);
  }
  for (const [roundId, items] of byRound) {
    if (items.length < 2 || hasRepairFanoutDecision(facts.decisions, roundId, items)) continue;
    result.push({
      code: "review-repair-fanout",
      reason: `Findings from Review ${roundId} were split across ${items.length} WorkItems without a durable Decision explaining independent ownership.`,
      refs: [`review-round:${roundId}`, ...items.map(({ id }) => `work-item:${id}`)]
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
  const semanticFull = fullRounds.filter((round) => classifications.get(round.id)?.kind === "semantic")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const recent = semanticFull.slice(-3);
  const recentIds = new Set(recent.map(({ id }) => id));
  const newFinding = facts.reviewFindings.some(({ firstReviewRoundId }) => recentIds.has(firstReviewRoundId));
  const sameCandidate = recent.length === 3
    && recent.every((round) => isDeepStrictEqual(
      round.taskCandidate,
      recent[0]!.taskCandidate
    ));
  const sameReviewer = recent.length === 3
    && recent.every((round) => round.reviewerRoleName === recent[0]!.reviewerRoleName);
  if (sameCandidate && sameReviewer && !newFinding) {
    result.push({
      code: "repeated-full-review",
      reason: `The same Reviewer completed three full semantic Reviews of the same frozen candidate without a new finding; this is a cost advisory, not a Review limit.`,
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

function hasRepairFanoutDecision(
  decisions: readonly Decision[],
  roundId: string,
  items: readonly WorkItem[]
): boolean {
  return decisions.some((decision) => {
    const text = `${decision.title}\n${decision.rationale}`;
    return text.includes(roundId) && items.every(({ id }) => text.includes(id));
  });
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
