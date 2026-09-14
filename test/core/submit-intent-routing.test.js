import assert from "node:assert/strict";
import test from "node:test";

import {
  decideSubmissionRouting,
  describeSubmissionFeedback,
  draftActivationState,
  normalizeSubmissionIntent
} from "../../dist/task/taskSubmission.js";

const EMPTY_PLAN = { kind: "empty" };

/** decideSubmissionRouting with the common defaults filled in. */
function route(overrides) {
  return decideSubmissionRouting({
    intent: "discuss",
    status: "draft",
    enteredPlanning: false,
    activation: "none",
    executionEnabled: true,
    developEnvironmentPlan: EMPTY_PLAN,
    ...overrides
  });
}

test("normalizeSubmissionIntent defaults an omitted intent to discuss", () => {
  assert.equal(normalizeSubmissionIntent(undefined), "discuss");
});

// ---------------------------------------------------------------------------
// §2.1 table: record always saves-only. It is an unconditional early return that
// ignores status, activation and planning, so a representative sample of the
// corners proves the invariant without permanently freezing the whole matrix.
// ---------------------------------------------------------------------------
for (const state of [
  { status: "draft", activation: "none", enteredPlanning: false },
  { status: "draft", activation: "pending", enteredPlanning: true },
  { status: "active", activation: "adopted", enteredPlanning: true }
]) {
  test(`record saves only (${JSON.stringify(state)})`, () => {
    assert.deepEqual(route({ intent: "record", ...state }), { kind: "record" });
  });
}

// ---------------------------------------------------------------------------
// §2.1 Draft, not in planning, no activation.
// ---------------------------------------------------------------------------
test("discuss on an unplanned Draft enters planning", () => {
  assert.deepEqual(route({ intent: "discuss" }), { kind: "enter-planning" });
});

test("develop on an unplanned Draft with an enabled gate activates", () => {
  assert.deepEqual(
    route({ intent: "develop" }),
    { kind: "activate", environmentPlan: EMPTY_PLAN }
  );
});

test("develop on an unplanned Draft with a stopped gate is blocked, message still saved", () => {
  assert.deepEqual(
    route({ intent: "develop", executionEnabled: false }),
    { kind: "activation-blocked-execution-stopped" }
  );
});

// ---------------------------------------------------------------------------
// §2.1 Draft, in planning, no activation.
// ---------------------------------------------------------------------------
test("discuss on a planning Draft continues planning", () => {
  assert.deepEqual(
    route({ intent: "discuss", enteredPlanning: true }),
    { kind: "continue-planning" }
  );
});

test("develop on a planning Draft needs manual activation, never a new wake", () => {
  assert.deepEqual(
    route({ intent: "develop", enteredPlanning: true }),
    { kind: "planned-needs-manual-activation" }
  );
});

test("develop on a planning Draft needs manual activation even with a stopped gate", () => {
  // Already-planned takes precedence over the gate: the answer is 'activate
  // manually', not 'start execution', because no fresh activation is attempted.
  assert.deepEqual(
    route({ intent: "develop", enteredPlanning: true, executionEnabled: false }),
    { kind: "planned-needs-manual-activation" }
  );
});

// ---------------------------------------------------------------------------
// §2.1 Draft, activation pending.
// ---------------------------------------------------------------------------
test("develop with a pending activation references it, never a second request", () => {
  assert.deepEqual(
    route({ intent: "develop", activation: "pending" }),
    { kind: "await-activation", state: "pending" }
  );
});

test("discuss with a pending activation waits as post-activation input, no new planning", () => {
  assert.deepEqual(
    route({ intent: "discuss", activation: "pending" }),
    { kind: "await-activation", state: "pending" }
  );
});

test("a pending activation dominates even when planning was entered", () => {
  assert.deepEqual(
    route({ intent: "develop", activation: "pending", enteredPlanning: true }),
    { kind: "await-activation", state: "pending" }
  );
});

// ---------------------------------------------------------------------------
// §2.1 Draft, activation failed.
// ---------------------------------------------------------------------------
test("develop with a failed activation never auto-retries or downgrades", () => {
  assert.deepEqual(
    route({ intent: "develop", activation: "failed" }),
    { kind: "await-activation", state: "failed" }
  );
});

test("discuss with a failed activation reports the failure, no new planning", () => {
  assert.deepEqual(
    route({ intent: "discuss", activation: "failed" }),
    { kind: "await-activation", state: "failed" }
  );
});

// ---------------------------------------------------------------------------
// §2.1 active Task: never re-activate, never downgrade to Draft.
// ---------------------------------------------------------------------------
test("discuss on an active Task is normal delivery context", () => {
  assert.deepEqual(route({ intent: "discuss", status: "active" }), { kind: "active-context" });
});

test("develop on an active Task does not re-activate", () => {
  assert.deepEqual(route({ intent: "develop", status: "active" }), { kind: "active-context" });
});

test("an adopted activation on a Draft routes as unplanned unless planning says otherwise", () => {
  // draftActivationState maps 'adopted' distinctly, but routing treats a settled
  // (non-pending, non-failed) activation like none: discuss still enters planning.
  assert.deepEqual(route({ intent: "discuss", activation: "adopted" }), { kind: "enter-planning" });
});

// ---------------------------------------------------------------------------
// draftActivationState mapping.
// ---------------------------------------------------------------------------
test("draftActivationState maps dispositions, collapsing cancelled to none", () => {
  assert.equal(draftActivationState(undefined), "none");
  assert.equal(draftActivationState({ disposition: "pending" }), "pending");
  assert.equal(draftActivationState({ disposition: "failed" }), "failed");
  assert.equal(draftActivationState({ disposition: "adopted" }), "adopted");
  assert.equal(draftActivationState({ disposition: "cancelled" }), "none");
});

// ---------------------------------------------------------------------------
// §2.5 feedback: every facet is expressed separately, never merged.
// ---------------------------------------------------------------------------
function feedback(overrides) {
  const { routing, ...rest } = overrides;
  return describeSubmissionFeedback({
    taskId: "task-1",
    messageId: "message-1",
    status: "draft",
    enteredPlanning: false,
    activationState: "none",
    routing,
    ...rest
  });
}

test("record feedback: saved, unplanned, nothing queued or activated", () => {
  const result = feedback({ routing: { kind: "record" } });
  assert.deepEqual(result.saved, { taskId: "task-1", messageId: "message-1" });
  assert.equal(result.phase, "draft-unplanned");
  assert.equal(result.planning, "none");
  assert.equal(result.activation, "none");
  assert.equal(result.delivery, "none");
  assert.equal(result.nextStep, undefined);
});

test("enter-planning feedback: planning entered, delivery queued, phase draft-planning", () => {
  const result = feedback({ routing: { kind: "enter-planning" } });
  assert.equal(result.phase, "draft-planning");
  assert.equal(result.planning, "entered");
  assert.equal(result.delivery, "queued");
  assert.equal(result.activation, "none");
});

test("continue-planning feedback: planning continued, delivery queued", () => {
  const result = feedback({ routing: { kind: "continue-planning" }, enteredPlanning: true });
  assert.equal(result.phase, "draft-planning");
  assert.equal(result.planning, "continued");
  assert.equal(result.delivery, "queued");
});

test("activate feedback: activation requested, delivery not queued for the Leader", () => {
  const result = feedback({ routing: { kind: "activate", environmentPlan: EMPTY_PLAN } });
  assert.equal(result.activation, "requested");
  assert.equal(result.planning, "none");
  // develop queues activation processing, not a Leader wake — delivery stays none.
  assert.equal(result.delivery, "none");
});

test("planned-needs-manual-activation feedback carries the activate-manually next step", () => {
  const result = feedback({ routing: { kind: "planned-needs-manual-activation" }, enteredPlanning: true });
  assert.equal(result.phase, "draft-planning");
  assert.equal(result.activation, "manual-required");
  assert.deepEqual(result.nextStep, { kind: "activate-manually", taskId: "task-1" });
});

test("execution-stopped feedback carries the start-execution next step", () => {
  const result = feedback({ routing: { kind: "activation-blocked-execution-stopped" } });
  assert.equal(result.activation, "execution-stopped");
  assert.deepEqual(result.nextStep, { kind: "start-execution", taskId: "task-1" });
});

test("await pending feedback carries the exact activation ref", () => {
  const result = feedback({
    routing: { kind: "await-activation", state: "pending" },
    activationState: "pending",
    activationRef: "task-1/activation:req-1"
  });
  assert.equal(result.activation, "pending");
  assert.deepEqual(result.nextStep, { kind: "await-pending-activation", activationRef: "task-1/activation:req-1" });
});

test("await failed feedback carries the failure and the resolve next step", () => {
  const result = feedback({
    routing: { kind: "await-activation", state: "failed" },
    activationState: "failed",
    activationRef: "task-1/activation:req-1",
    activationFailure: "preparer crashed"
  });
  assert.equal(result.activation, "failed");
  assert.deepEqual(result.nextStep, {
    kind: "resolve-failed-activation",
    activationRef: "task-1/activation:req-1",
    failure: "preparer crashed"
  });
});

test("active-context feedback never downgrades the phase to Draft", () => {
  const result = feedback({ routing: { kind: "active-context" }, status: "active" });
  assert.equal(result.phase, "active");
  assert.equal(result.delivery, "queued");
  assert.equal(result.planning, "none");
});

test("record on a Draft with a pending activation truthfully reports that activation", () => {
  // record acts on nothing, but the feedback must still surface the existing
  // obligation rather than claim 'none'.
  const result = feedback({ routing: { kind: "record" }, activationState: "pending" });
  assert.equal(result.activation, "pending");
  assert.equal(result.delivery, "none");
});
