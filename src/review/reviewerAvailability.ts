import {
  nextPendingBatch,
  mailboxHasWork,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";
import type { Turn } from "../turn/turn.js";
import { runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import type { ReviewRound } from "./reviewRound.js";

export type ReviewerBusy = Readonly<{
  kind: "busy";
  reviewerRoleName: string;
  phase: "review-slot" | "active-turn" | "runtime-lifecycle";
  activeTurnId?: string;
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
  getActiveTurn(taskId: string, roleName: string): Turn | null;
  listReviewRounds(taskId: string): readonly ReviewRound[];
  getWorkMailbox(target: MailboxTarget): WorkMailbox | null;
}>;

/** One authoritative read-only projection for a Task Reviewer Role slot. */
export function projectReviewerAvailability(
  store: ReviewerAvailabilityStore,
  taskId: string,
  reviewerRoleName: string
): ReviewerAvailability {
  const active = store.getActiveTurn(taskId, reviewerRoleName);
  if (active !== null) {
    return {
      kind: "busy",
      reviewerRoleName,
      phase: "active-turn",
      activeTurnId: active.id,
      ...(active.reviewRoundId === undefined
        ? {}
        : { activeReviewRoundId: active.reviewRoundId }),
      startedAt: active.createdAt,
      retryable: true,
      retryAfterSeconds: 5
    };
  }
  const runtimeMailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName: reviewerRoleName
  }));
  if (runtimeMailbox !== null && mailboxHasWork(runtimeMailbox)) {
    return runtimeLifecycleBusy(reviewerRoleName, runtimeMailbox);
  }
  const activeRound = store.listReviewRounds(taskId).find((round) => (
    (round.status === "pending" || round.status === "running")
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
  return {
    kind: "available",
    reviewerRoleName,
    retryable: true
  };
}

function runtimeLifecycleBusy(
  reviewerRoleName: string,
  mailbox: WorkMailbox
): ReviewerBusy {
  const pending = nextPendingBatch(mailbox);
  const startedAt = mailbox.processing?.startedAt ?? pending?.firstQueuedAt;
  return {
    kind: "busy",
    reviewerRoleName,
    phase: "runtime-lifecycle",
    ...(startedAt === undefined ? {} : { startedAt }),
    retryable: true,
    retryAfterSeconds: 5
  };
}
