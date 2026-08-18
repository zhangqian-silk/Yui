import assert from "node:assert/strict";
import test from "node:test";

import {
  MOCK_TRANSPORT_DISCLAIMER,
  TEST_TIERS,
  TEST_TIER_IDS,
  resolveTier,
  tierIsPrivileged,
  tierMayCallModel,
  tierOptInEnv
} from "../helpers/testTiers.js";

test("declares exactly the six explicit tiers", () => {
  assert.deepEqual(TEST_TIER_IDS, [
    "unit",
    "isolated-integration",
    "mock-agent-session",
    "fault-injection",
    "provider-e2e",
    "release-e2e"
  ]);
});

test("only Provider E2E may call a real model (Release E2E does not on its normal path)", () => {
  assert.equal(tierMayCallModel("unit"), false);
  assert.equal(tierMayCallModel("isolated-integration"), false);
  assert.equal(tierMayCallModel("mock-agent-session"), false);
  assert.equal(tierMayCallModel("provider-e2e"), true);
  // Release E2E exercises install/upgrade flows; on the normal path it calls no
  // model. Representing it as a model-caller would overstate what it proves.
  assert.equal(tierMayCallModel("release-e2e"), false);
});

test("Release E2E creates no Session and calls no model on the normal path", () => {
  const release = TEST_TIERS["release-e2e"];
  assert.equal(release.createsSession, false);
  assert.equal(release.callsModel, false);
  // But it still creates real disposable resources and stays privileged +
  // preflight-gated.
  assert.equal(release.createsDisposableRuntime, true);
  assert.equal(release.requiresIsolationPreflight, true);
  assert.equal(release.optInEnv, "YUI_ALLOW_RELEASE_E2E");
});

test("session-creating vs model-calling are distinct facts", () => {
  // The whole point of the vocabulary: a tier can create a Session without ever
  // calling a model (Mock Agent Session, Isolated Integration).
  assert.equal(TEST_TIERS["mock-agent-session"].createsSession, true);
  assert.equal(TEST_TIERS["mock-agent-session"].callsModel, false);
  assert.equal(TEST_TIERS["isolated-integration"].createsSession, true);
  assert.equal(TEST_TIERS["isolated-integration"].callsModel, false);
  assert.equal(TEST_TIERS["fault-injection"].createsSession, true);
  assert.equal(TEST_TIERS["fault-injection"].callsModel, false);
  assert.equal(TEST_TIERS.unit.createsSession, false);
  assert.equal(TEST_TIERS.unit.callsModel, false);
});

test("privilege (opt-in gating) is independent of calling a model", () => {
  // Both privileged tiers require opt-in and the preflight...
  for (const id of ["provider-e2e", "release-e2e"]) {
    assert.equal(tierIsPrivileged(id), true);
    assert.equal(TEST_TIERS[id].requiresIsolationPreflight, true);
    assert.equal(typeof tierOptInEnv(id), "string");
    assert.ok(tierOptInEnv(id).length > 0);
  }
  // ...but only Provider E2E calls a model. Release E2E is privileged WITHOUT
  // calling a model, which is exactly why gating must key on privilege.
  assert.equal(tierMayCallModel("provider-e2e"), true);
  assert.equal(tierMayCallModel("release-e2e"), false);

  for (const id of ["unit", "isolated-integration", "mock-agent-session", "fault-injection"]) {
    assert.equal(tierIsPrivileged(id), false);
    assert.equal(TEST_TIERS[id].requiresIsolationPreflight, false);
    assert.equal(tierOptInEnv(id), null);
  }
});

test("Mock Agent Session tier description carries the transport disclaimer", () => {
  assert.ok(TEST_TIERS["mock-agent-session"].description.includes(MOCK_TRANSPORT_DISCLAIMER));
});

test("resolveTier fails closed on an unknown id rather than guessing a default", () => {
  assert.throws(() => resolveTier("e2e"), /Unknown test tier/);
  assert.throws(() => resolveTier(""), /Unknown test tier/);
  assert.throws(() => resolveTier(undefined), /Unknown test tier/);
});
