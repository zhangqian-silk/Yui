import { isDeepStrictEqual } from "node:util";

import type { GlobalRole, TaskRole } from "../role/role.js";
import type { Turn } from "../turn/turn.js";
import type { Task } from "../task/task.js";
import type { ReviewConfig } from "./reviewConfig.js";
import { isAcceptedTaskReviewBaseline, type ReviewAcceptanceEvidenceStore } from "./reviewAcceptance.js";
import type { ReviewRound, TaskReviewCandidate } from "./reviewRound.js";
import {
  projectReviewerAvailability,
  type ReviewerAvailabilityStore
} from "./reviewerAvailability.js";

export type ReviewDecisionProjection = Readonly<{
  currentCandidate: TaskReviewCandidate | null;
  activeReviews: readonly Readonly<{
    reviewRoundId: string;
    reviewerRoleName: string;
    mode: "full" | "delta-recheck";
    status: "pending" | "running";
    activeTurnId?: string;
    startedAt: string;
    frozenCandidate: TaskReviewCandidate | null;
    candidateRelation: "exact" | "requires-preflight" | "unavailable";
    workspaceRoot?: string;
  }>[];
  reviewers: readonly Readonly<{
    reviewerRoleName: string;
    status: "available" | "busy" | "unavailable";
    phase?: "review-slot" | "active-turn" | "mailbox" | "runtime-lifecycle";
    activeTurnId?: string;
    activeReviewRoundId?: string;
    startedAt?: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  }>[];
  latestAcceptedBaseline: Readonly<{
    reviewRoundId: string;
    reviewerRoleName: string;
    candidate: TaskReviewCandidate;
    relationToCurrent: "exact" | "requires-preflight" | "unavailable";
  }> | null;
  delta: Readonly<{
    technicalAvailability: "unavailable" | "requires-preflight";
    reason: string;
  }>;
}>;

export type ReviewDecisionStore = ReviewAcceptanceEvidenceStore & ReviewerAvailabilityStore & Readonly<{
  getGlobalRole(roleName: string): GlobalRole | null;
}>;

/** Read-only facts for Leader judgment; this projection never blocks an action. */
export function projectReviewDecision(input: Readonly<{
  store: ReviewDecisionStore;
  task: Task;
  roles: readonly TaskRole[];
  turns: readonly Turn[];
  rounds: readonly ReviewRound[];
  reviewConfig: ReviewConfig | null;
  /** CLI-verified physical Task heads; null means no durable candidate is currently available. */
  currentCandidate: TaskReviewCandidate | null;
}>): ReviewDecisionProjection {
  const { store, task, roles, turns, rounds, reviewConfig, currentCandidate } = input;
  const taskRounds = rounds.filter((round) => (round.scope ?? "work-item") === "task");
  const accepted = [...taskRounds]
    .filter((round) => isAcceptedTaskReviewBaseline(store, round))
    .sort(compareRoundIdentity)
    .at(-1);
  const latestAcceptedBaseline = accepted?.taskCandidate === undefined
    ? null
    : {
        reviewRoundId: accepted.id,
        reviewerRoleName: accepted.reviewerRoleName,
        candidate: accepted.taskCandidate,
        relationToCurrent: candidateRelation(accepted.taskCandidate, currentCandidate)
      };
  const activeReviews = taskRounds
    .filter((round): round is ReviewRound & { status: "pending" | "running" } => (
      round.status === "pending" || round.status === "running"
    ))
    .map((round) => {
      const activeTurn = turns.find((turn) => (
        turn.status === "active" && turn.reviewRoundId === round.id
      ));
      const workspaceRoot = round.workspace?.root ?? activeTurn?.workspace?.root;
      return {
        reviewRoundId: round.id,
        reviewerRoleName: round.reviewerRoleName,
        mode: round.deltaRecheck === undefined ? "full" as const : "delta-recheck" as const,
        status: round.status,
        ...(activeTurn === undefined ? {} : { activeTurnId: activeTurn.id }),
        startedAt: activeTurn?.createdAt ?? round.createdAt,
        frozenCandidate: round.taskCandidate ?? null,
        candidateRelation: candidateRelation(round.taskCandidate ?? null, currentCandidate),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      };
    });
  const reviewerNames = [...new Set([
    ...(reviewConfig === null ? [] : [reviewConfig.roleName]),
    ...taskRounds.flatMap((round) => [
      round.reviewerRoleName,
      ...(round.executionGroup?.lanes.map(({ roleName }) => roleName) ?? [])
    ])
  ])].sort();
  const reviewers = reviewerNames.map((reviewerRoleName) => {
    const role = roles.find(({ name }) => name === reviewerRoleName);
    if (role === undefined && store.getGlobalRole(reviewerRoleName) === null) {
      return {
        reviewerRoleName,
        status: "unavailable" as const,
        retryable: false
      };
    }
    const availability = projectReviewerAvailability(store, task.id, reviewerRoleName);
    if (availability.kind === "available") {
      return {
        reviewerRoleName,
        status: "available" as const,
        retryable: true
      };
    }
    return {
      reviewerRoleName,
      status: "busy" as const,
      phase: availability.phase,
      ...(availability.activeTurnId === undefined
        ? {}
        : { activeTurnId: availability.activeTurnId }),
      ...(availability.activeReviewRoundId === undefined
        ? {}
        : { activeReviewRoundId: availability.activeReviewRoundId }),
      ...(availability.startedAt === undefined
        ? {}
        : { startedAt: availability.startedAt }),
      retryable: true,
      retryAfterSeconds: availability.retryAfterSeconds
    };
  });
  const delta = latestAcceptedBaseline === null
    ? {
        technicalAvailability: "unavailable" as const,
        reason: "No accepted Task-final Review baseline is available."
      }
    : latestAcceptedBaseline.relationToCurrent === "exact"
      ? {
          technicalAvailability: "unavailable" as const,
          reason: "The accepted baseline already covers the current durable candidate; there is no delta to recheck."
        }
      : currentCandidate === null
        ? {
            technicalAvailability: "unavailable" as const,
            reason: "The current durable Task candidate is unavailable."
          }
        : {
            technicalAvailability: "requires-preflight" as const,
            reason: "An accepted baseline exists; Git ancestry, scope and exact diff must be verified."
          };
  return {
    currentCandidate,
    activeReviews,
    reviewers,
    latestAcceptedBaseline,
    delta
  };
}

function candidateRelation(
  candidate: TaskReviewCandidate | null,
  current: TaskReviewCandidate | null
): "exact" | "requires-preflight" | "unavailable" {
  if (candidate === null || current === null) return "unavailable";
  return isDeepStrictEqual(candidate, current) ? "exact" : "requires-preflight";
}

function compareRoundIdentity(left: ReviewRound, right: ReviewRound): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id, undefined, { numeric: true });
}
