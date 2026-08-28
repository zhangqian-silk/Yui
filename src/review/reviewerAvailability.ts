import {
  nextPendingBatch,
  mailboxHasWork,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import type { AgentRun } from "../run/agentRun.js";
import { runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import type { ReviewRound } from "./reviewRound.js";

export type ReviewerBusy = Readonly<{
  kind: "busy";
  reviewerRoleName: string;
  phase: "review-slot" | "active-run" | "mailbox" | "runtime-lifecycle";
  activeRunId?: string;
  activeReviewRoundId?: string;
  startedAt?: string;
  retryable: true;
  retryAfterSeconds: number;
}>;

export type ReviewerAvailable = Readonly<{
  kind: "available";
  reviewerRoleName: string;
  retryable: true;
}>;

export type ReviewerAvailability = ReviewerBusy | ReviewerAvailable;

export type ReviewerAvailabilityStore = Readonly<{
  getActiveAgentRun(taskId: string, roleName: string): AgentRun | null;
  listAgentRuns(taskId: string): readonly AgentRun[];
  listReviewRounds(taskId: string): readonly ReviewRound[];
  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
}>;

/** One authoritative read-only projection for a Task Reviewer Role slot. */
export function projectReviewerAvailability(
  store: ReviewerAvailabilityStore,
  taskId: string,
  reviewerRoleName: string
): ReviewerAvailability {
  const active = store.getActiveAgentRun(taskId, reviewerRoleName)
    ?? store.listAgentRuns(taskId).find((run) => (
      run.roleName === reviewerRoleName && run.status === "active"
    ));
  if (active !== null && active !== undefined) {
    return {
      kind: "busy",
      reviewerRoleName,
      phase: "active-run",
      activeRunId: active.id,
      ...(active.reviewRoundId === undefined
        ? {}
        : { activeReviewRoundId: active.reviewRoundId }),
      startedAt: active.createdAt,
      retryable: true,
      retryAfterSeconds: 5
    };
  }
  const activeRound = store.listReviewRounds(taskId).find((round) => (
    (round.scope ?? "work-item") === "task"
    && (round.status === "pending" || round.status === "running")
    && (round.reviewerRoleName === reviewerRoleName
      || round.executionGroup?.lanes.some(({ roleName }) => roleName === reviewerRoleName) === true)
  ));
  if (activeRound !== undefined) {
    return {
      kind: "busy",
      reviewerRoleName,
      phase: "review-slot",
      activeReviewRoundId: activeRound.id,
      startedAt: activeRound.createdAt,
      retryable: true,
      retryAfterSeconds: 5
    };
  }
  const reviewerMailbox = store.getWorkMailbox({
    kind: "role",
    taskId,
    roleName: reviewerRoleName
  });
  if (reviewerMailbox !== null && mailboxHasWork(reviewerMailbox)) {
    return mailboxBusy(reviewerRoleName, "mailbox", reviewerMailbox);
  }
  const runtimeMailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName: reviewerRoleName
  }));
  if (runtimeMailbox !== null && mailboxHasWork(runtimeMailbox)) {
    return mailboxBusy(reviewerRoleName, "runtime-lifecycle", runtimeMailbox);
  }
  return {
    kind: "available",
    reviewerRoleName,
    retryable: true
  };
}

function mailboxBusy(
  reviewerRoleName: string,
  phase: "mailbox" | "runtime-lifecycle",
  mailbox: WorkMailbox
): ReviewerBusy {
  const pending = nextPendingBatch(mailbox);
  const startedAt = mailbox.processing?.startedAt ?? pending?.firstQueuedAt;
  return {
    kind: "busy",
    reviewerRoleName,
    phase,
    ...(startedAt === undefined ? {} : { startedAt }),
    retryable: true,
    retryAfterSeconds: 5
  };
}
