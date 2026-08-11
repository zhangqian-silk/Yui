import assert from "node:assert/strict";
import test from "node:test";

import { MOCK_TRANSPORT_DISCLAIMER } from "../helpers/testTiers.js";
import {
  createEvidenceRecorder,
  renderEvidenceReport
} from "../helpers/testEvidence.js";

test("evidence snapshot records every required field", () => {
  const recorder = createEvidenceRecorder({
    tier: "isolated-integration",
    name: "controller lifecycle",
    binarySource: "/checkout/yui/output/dev/bin/yui",
    yuiHome: "/tmp/run/yui-home",
    workspace: "/tmp/run/workspace",
    namespaceOwnership: { kind: "ephemeral-test", tmuxServer: "yui-abc", token: "0123456789abcdef" }
  });
  recorder.markSessionCreated("Controller started");
  recorder.recordCleanup("success", "all resources reaped");
  recorder.recordCheck("npm test", "passed");

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.tier, "isolated-integration");
  assert.equal(snapshot.name, "controller lifecycle");
  assert.equal(snapshot.sessionCreated, true);
  assert.equal(snapshot.modelCalled, false);
  assert.equal(snapshot.providerAccepted, false);
  assert.match(snapshot.binarySource, /output\/dev\/bin\/yui$/);
  assert.match(snapshot.yuiHome, /yui-home$/);
  assert.match(snapshot.workspace, /workspace$/);
  assert.equal(snapshot.namespaceOwnership.kind, "ephemeral-test");
  assert.equal(snapshot.cleanupOutcome, "success");
  assert.deepEqual(snapshot.checks, [{ name: "npm test", outcome: "passed" }]);
  // A session-creating, non-model tier always carries the transport disclaimer.
  assert.ok(snapshot.verificationGaps.includes(MOCK_TRANSPORT_DISCLAIMER));
});

test("the rendered report exposes every field a reader needs", () => {
  const recorder = createEvidenceRecorder({
    tier: "mock-agent-session",
    name: "mock accept path"
  });
  recorder.markSessionCreated();
  recorder.setBinarySource("/tmp/run/mock-agent");
  recorder.setYuiHome("/tmp/run/yui-home");
  recorder.recordCleanup("success");
  const report = renderEvidenceReport(recorder.snapshot());

  assert.match(report, /Tier: Mock Agent Session \(mock-agent-session\)/);
  assert.match(report, /Session created: yes/);
  assert.match(report, /Model\/provider called: no \(tier never calls a model\)/);
  assert.match(report, /Provider-native acceptance proven: no/);
  assert.match(report, /Binary source: .*mock-agent/);
  assert.match(report, /YUI_HOME: .*yui-home/);
  assert.match(report, /Cleanup: success/);
  assert.match(report, new RegExp(MOCK_TRANSPORT_DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a non-model tier cannot record a model call", () => {
  const recorder = createEvidenceRecorder({ tier: "unit", name: "pure logic" });
  assert.throws(() => recorder.markModelCalled("oops"), /must never call a real model/);
});

test("a Session-free tier cannot record a Session", () => {
  const recorder = createEvidenceRecorder({ tier: "unit", name: "pure logic" });
  assert.throws(() => recorder.markSessionCreated("oops"), /must not create a Session/);
});

test("a Mock tier cannot claim provider-native acceptance", () => {
  const recorder = createEvidenceRecorder({ tier: "mock-agent-session", name: "mock accept" });
  assert.throws(
    () => recorder.markProviderAccepted("transport handshake ok"),
    /cannot prove provider-native acceptance/
  );
});

test("a Provider tier may record a model call and native acceptance", () => {
  const recorder = createEvidenceRecorder({ tier: "provider-e2e", name: "real claude" });
  recorder.markSessionCreated();
  recorder.markModelCalled("claude responded");
  recorder.markProviderAccepted("claude accepted the exact prompt");
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.modelCalled, true);
  assert.equal(snapshot.providerAccepted, true);
});

test("preflight checks fold into the evidence as named checks", () => {
  const recorder = createEvidenceRecorder({ tier: "provider-e2e", name: "real claude" });
  recorder.recordPreflight({
    ok: false,
    checks: [
      { name: "launcher-absolute-path", ok: true, detail: "abs" },
      { name: "npm-prefix-isolated", ok: false, detail: "global prefix" }
    ]
  });
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.checks, [
    { name: "preflight:launcher-absolute-path", outcome: "passed", details: "abs" },
    { name: "preflight:npm-prefix-isolated", outcome: "failed", details: "global prefix" }
  ]);
});

test("verification gaps de-duplicate and default cleanup depends on the tier", () => {
  const unit = createEvidenceRecorder({ tier: "unit", name: "u" });
  // A unit tier neither creates a Session nor needs cleanup.
  assert.equal(unit.snapshot().cleanupOutcome, "not-applicable");

  const mock = createEvidenceRecorder({ tier: "mock-agent-session", name: "m" });
  assert.equal(mock.snapshot().cleanupOutcome, "pending");
  mock.noteVerificationGap(MOCK_TRANSPORT_DISCLAIMER);
  mock.noteVerificationGap("live provider not exercised");
  const gaps = mock.snapshot().verificationGaps;
  // The disclaimer appears exactly once despite the explicit duplicate.
  assert.equal(gaps.filter((gap) => gap === MOCK_TRANSPORT_DISCLAIMER).length, 1);
  assert.ok(gaps.includes("live provider not exercised"));
});

test("an unknown tier is rejected at recorder creation", () => {
  assert.throws(() => createEvidenceRecorder({ tier: "e2e", name: "x" }), /Unknown test tier/);
});
