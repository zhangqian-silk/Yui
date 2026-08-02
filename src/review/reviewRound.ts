import {
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";
export type ReviewRoundStatus = "pending" | "running" | "completed" | "failed";
export type ReviewRequestSource = "policy" | "leader";

export type ReviewRound = {
  schemaVersion: 2;
  id: string;
  taskId: string;
  workItemId: string;
  candidateId: string;
  reviewerRoleName: string;
  reviewerRunId?: string;
  requestedBy: ReviewRequestSource;
  status: ReviewRoundStatus;
  summary?: string;
  createdAt: string;
  endedAt?: string;
};

export function createReviewRound(
  id: string,
  taskId: string,
  workItemId: string,
  candidateId: string,
  reviewerRoleName: string,
  requestedBy: ReviewRequestSource,
  now: Date
): ReviewRound {
  return validateReviewRound({
    schemaVersion: 2,
    id: requireIdentity(id, "ReviewRound id"),
    taskId: requireIdentity(taskId, "Task id"),
    workItemId: requireIdentity(workItemId, "Work Item id"),
    candidateId: requireIdentity(candidateId, "Candidate id"),
    reviewerRoleName: requireIdentity(reviewerRoleName, "Reviewer Role"),
    requestedBy: validateReviewRequestSource(requestedBy),
    status: "pending",
    createdAt: now.toISOString()
  });
}

export function startReviewRound(
  round: ReviewRound,
  reviewerRunId: string
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "pending") {
    throw new Error(`ReviewRound cannot start from ${round.status}: ${round.id}.`);
  }
  return validateReviewRound({
    ...round,
    reviewerRunId: requireIdentity(reviewerRunId, "Reviewer Run id"),
    status: "running"
  });
}

export function finishReviewRound(
  round: ReviewRound,
  status: "completed" | "failed",
  summary: string,
  now: Date
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "pending" && round.status !== "running") {
    throw new Error(`ReviewRound is already terminal: ${round.id}.`);
  }
  return validateReviewRound({
    ...round,
    status,
    summary: requireText(summary, "Review summary"),
    endedAt: now.toISOString()
  });
}

export function validateReviewRound(round: ReviewRound): ReviewRound {
  if (round.schemaVersion !== 2) throw new Error("ReviewRound must use schemaVersion 2.");
  validateTaskRecordReference({ taskId: round.taskId, localId: round.id }, "reviewRound");
  validateTaskRecordReference({ taskId: round.taskId, localId: round.workItemId }, "workItem");
  if (!/^candidate-[1-9]\d*$/.test(round.candidateId)) {
    throw new Error(`Candidate local id is invalid: ${round.candidateId}.`);
  }
  requireIdentity(round.reviewerRoleName, "Reviewer Role");
  validateReviewRequestSource(round.requestedBy);
  if (!["pending", "running", "completed", "failed"].includes(round.status)) {
    throw new Error(`ReviewRound status is invalid: ${String(round.status)}.`);
  }
  if (round.reviewerRunId !== undefined) {
    validateTaskRecordReference({
      taskId: round.taskId,
      localId: round.reviewerRunId
    }, "agentRun");
  }
  requireTimestamp(round.createdAt, "ReviewRound createdAt");
  const terminal = round.status === "completed" || round.status === "failed";
  if (terminal) {
    requireText(round.summary ?? "", "Review summary");
    requireTimestamp(round.endedAt ?? "", "ReviewRound endedAt");
  } else if (round.summary !== undefined || round.endedAt !== undefined) {
    throw new Error("An active ReviewRound cannot have terminal metadata.");
  }
  if (round.status === "running" && round.reviewerRunId === undefined) {
    throw new Error("A running ReviewRound requires a Reviewer Run.");
  }
  return round;
}

function validateReviewRequestSource(source: ReviewRequestSource): ReviewRequestSource {
  if (source !== "policy" && source !== "leader") {
    throw new Error(`Review request source is invalid: ${String(source)}.`);
  }
  return source;
}
