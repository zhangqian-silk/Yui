import { createHash } from "node:crypto";

import { requireIdentity } from "../domain/validation.js";
import type { ReviewConfig } from "./reviewConfig.js";

export const TASK_FINAL_REVIEW_ARGUMENT = "--yui-task-final-review";

/**
 * Immutable capability created only after the CLI has verified the exact
 * control-plane and Task-runtime descriptors. It is persisted with the first
 * Candidate so later changes to the shared review config cannot weaken the
 * Task's completion gate.
 */
export type TaskFinalReviewContract = Readonly<{
  schemaVersion: 1;
  taskId: string;
  reviewerRoleName: string;
  controlPlaneDigest: string;
  digest: string;
}>;

export type TaskFinalReviewRequest = Readonly<{
  taskId: string;
  reviewerRoleName: string;
}>;

export function createTaskFinalReviewContract(input: Readonly<{
  taskId: string;
  reviewerRoleName: string;
  controlPlaneDigest: string;
}>): TaskFinalReviewContract {
  const taskId = requireIdentity(input.taskId, "Task final-review contract Task id");
  const reviewerRoleName = requireIdentity(
    input.reviewerRoleName,
    "Task final-review contract Reviewer Role"
  );
  const controlPlaneDigest = requireDigest(
    input.controlPlaneDigest,
    "Task final-review contract control-plane digest"
  );
  return Object.freeze({
    schemaVersion: 1,
    taskId,
    reviewerRoleName,
    controlPlaneDigest,
    digest: contractDigest(taskId, reviewerRoleName, controlPlaneDigest)
  });
}

export function validateTaskFinalReviewContract(
  value: TaskFinalReviewContract
): TaskFinalReviewContract {
  if (typeof value !== "object" || value === null || value.schemaVersion !== 1) {
    throw new Error("Task final-review contract must use schemaVersion 1.");
  }
  const expected = createTaskFinalReviewContract(value);
  const digest = requireDigest(value.digest, "Task final-review contract digest");
  if (digest !== expected.digest) {
    throw new Error("Task final-review contract digest does not match its immutable fields.");
  }
  return value;
}

export function taskFinalReviewConfig(
  contract: TaskFinalReviewContract
): ReviewConfig {
  const validated = validateTaskFinalReviewContract(contract);
  return { roleName: validated.reviewerRoleName, trigger: "final" };
}

export function sameTaskFinalReviewContract(
  left: TaskFinalReviewContract | undefined,
  right: TaskFinalReviewContract | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return validateTaskFinalReviewContract(left).digest
    === validateTaskFinalReviewContract(right).digest;
}

/**
 * The contract switch is an exact CLI prefix, never an environment variable.
 * It must immediately follow `--yui-control <digest>` so the preflight can
 * bind it to the one verified Task runtime before opening mutable storage.
 */
export function extractTaskFinalReviewRequest(args: readonly string[]): Readonly<{
  request?: TaskFinalReviewRequest;
  args: readonly string[];
  error?: string;
}> {
  const index = args.indexOf(TASK_FINAL_REVIEW_ARGUMENT);
  if (index < 0) return { args: [...args] };
  if (index !== 0) {
    return {
      args: [...args],
      error: `${TASK_FINAL_REVIEW_ARGUMENT} must immediately follow the exact control prefix.`
    };
  }
  const taskId = args[1];
  const reviewerRoleName = args[2];
  if (taskId === undefined || reviewerRoleName === undefined) {
    return {
      args: args.slice(3),
      error: `${TASK_FINAL_REVIEW_ARGUMENT} requires <task-id> <reviewer-role>.`
    };
  }
  try {
    return {
      request: {
        taskId: requireIdentity(taskId, "Task final-review contract Task id"),
        reviewerRoleName: requireIdentity(
          reviewerRoleName,
          "Task final-review contract Reviewer Role"
        )
      },
      args: args.slice(3)
    };
  } catch (error) {
    return {
      args: args.slice(3),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function contractDigest(
  taskId: string,
  reviewerRoleName: string,
  controlPlaneDigest: string
): string {
  return createHash("sha256").update(JSON.stringify([
    "yui-task-final-review",
    1,
    taskId,
    reviewerRoleName,
    controlPlaneDigest
  ])).digest("hex");
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
