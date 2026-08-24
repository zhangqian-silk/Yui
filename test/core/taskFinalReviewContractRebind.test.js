import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_FINAL_REVIEW_CONTRACT_REBOUND_EVENT,
  createTaskFinalReviewContractRebind,
  resolveTaskFinalReviewContract,
  taskFinalReviewContractRebindPayload
} from "../../dist/review/taskFinalReviewContractRebind.js";
import { createTaskFinalReviewContract } from "../../dist/review/taskFinalReviewContract.js";

const taskId = "task-1";
const reviewerRoleName = "reviewer";
const digest = (character) => character.repeat(64);
const contract = (character) => createTaskFinalReviewContract({
  taskId,
  reviewerRoleName,
  controlPlaneDigest: digest(character)
});
const observation = (value, createdAt, source) => ({
  contract: value,
  createdAt,
  source
});
const release = (id, character) => ({
  releaseId: id,
  version: "1.0.0",
  buildId: id,
  packageDigest: digest(character)
});
const event = (id, createdAt, fromContract, toCharacter) => ({
  schemaVersion: 2,
  id,
  taskId,
  type: TASK_FINAL_REVIEW_CONTRACT_REBOUND_EVENT,
  payload: taskFinalReviewContractRebindPayload(createTaskFinalReviewContractRebind({
    taskId,
    reviewerRoleName,
    fromContract,
    toControlPlaneDigest: digest(toCharacter),
    fromRelease: release("release-b", "b"),
    toRelease: release("release-c", "c"),
    handoverId: "handover-1",
    authorizedBy: "operator"
  })),
  createdAt
});

test("resolves a forward-only legacy prefix before the first explicit rebind", () => {
  const first = contract("a");
  const latestLegacy = contract("b");
  const result = resolveTaskFinalReviewContract(taskId, [
    observation(first, "2026-01-01T00:00:00.000Z", "candidate-1"),
    observation(latestLegacy, "2026-01-02T00:00:00.000Z", "candidate-2")
  ], [
    event("event-1", "2026-01-03T00:00:00.000Z", latestLegacy, "c")
  ]);

  assert.equal(result.initial.digest, first.digest);
  assert.equal(result.effective.controlPlaneDigest, digest("c"));
  assert.equal(result.rebinds.length, 1);
});

test("rejects a legacy contract reversion", () => {
  const first = contract("a");
  assert.throws(() => resolveTaskFinalReviewContract(taskId, [
    observation(first, "2026-01-01T00:00:00.000Z", "candidate-1"),
    observation(contract("b"), "2026-01-02T00:00:00.000Z", "candidate-2"),
    observation(first, "2026-01-03T00:00:00.000Z", "candidate-3")
  ], []), /reverts a legacy Task final-review contract/u);
});

test("rejects implicit contract drift after explicit rebind begins", () => {
  const first = contract("a");
  const rebound = contract("b");
  assert.throws(() => resolveTaskFinalReviewContract(taskId, [
    observation(first, "2026-01-01T00:00:00.000Z", "candidate-1"),
    observation(rebound, "2026-01-03T00:00:00.000Z", "candidate-2"),
    observation(contract("c"), "2026-01-04T00:00:00.000Z", "candidate-3")
  ], [
    event("event-1", "2026-01-02T00:00:00.000Z", first, "b")
  ]), /does not match the effective Task final-review contract/u);
});
