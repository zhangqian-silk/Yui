import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanonicalLifecycleEvent,
  foldCanonicalLifecycleEvent,
  isPreInputReadinessSupported,
  CanonicalLifecycleError
} from "../../dist/lifecycle/canonicalLifecycleEvent.js";

// ---------------------------------------------------------------------------
// LAYER 1 — Canonical semantic evidence.
// These tests exercise ONLY the provider-neutral vocabulary and pure fold. No
// adapter, no provider name, no real TUI. They prove the semantics decision-19
// requires: exact fences, source/evidence separation, single push, no delivered
// before acceptance, and idempotent/deferred/obsolete/fail-closed dispositions.
// ---------------------------------------------------------------------------

const FENCE = Object.freeze({
  taskId: "task-4",
  roleName: "provider-contract-implementer",
  agentId: "claude/claude",
  adapterId: "claude",
  runId: "agent-run-51",
  nativeSessionId: "native-1",
  launchId: "generation-1",
  receiptId: "agent-run:task-4/agent-run-51"
});

function expectation(overrides = {}) {
  return {
    fence: FENCE,
    sessionStarted: false,
    ready: false,
    pushed: false,
    accepted: false,
    terminal: false,
    boundNativeSessionId: FENCE.nativeSessionId,
    ...overrides
  };
}

function pushedEvent(fence = FENCE) {
  return createCanonicalLifecycleEvent({
    phase: "prompt-pushed",
    source: "transport",
    evidence: "transport",
    fence
  });
}

function acceptedEvent(fence = FENCE) {
  return createCanonicalLifecycleEvent({
    phase: "provider-accepted",
    source: "provider-native",
    evidence: "provider-native-durable",
    fence
  });
}

// --- Construction: the (phase, source, evidence) matrix fails closed ---------

test("acceptance can only be built from a durable native source — receipts fail closed", () => {
  // GREEN: a durable native acceptance is well-formed.
  assert.doesNotThrow(() => acceptedEvent());

  // RED: a transport receipt (or liveness) can never construct an acceptance.
  for (const [source, evidence] of [
    ["transport", "transport"],
    ["liveness", "liveness"],
    ["provider-native", "adapter-mapped"]
  ]) {
    assert.throws(
      () => createCanonicalLifecycleEvent({
        phase: "provider-accepted", source, evidence, fence: FENCE
      }),
      CanonicalLifecycleError,
      `${source}/${evidence} must not forge acceptance`
    );
  }
});

test("a prompt-pushed event is transport-only and requires a receipt fence", () => {
  assert.doesNotThrow(() => pushedEvent());
  // RED: pushing may not claim a provider-native source.
  assert.throws(
    () => createCanonicalLifecycleEvent({
      phase: "prompt-pushed", source: "provider-native",
      evidence: "provider-native-durable", fence: FENCE
    }),
    CanonicalLifecycleError
  );
  // RED: pushing requires a transport receiptId.
  const { receiptId, ...noReceipt } = FENCE;
  assert.throws(
    () => createCanonicalLifecycleEvent({
      phase: "prompt-pushed", source: "transport", evidence: "transport", fence: noReceipt
    }),
    /receiptId/
  );
});

test("run-scoped phases require a runId fence; generation phases may omit it", () => {
  const { runId, ...noRun } = FENCE;
  for (const phase of ["prompt-pushed", "provider-accepted", "turn-progress", "turn-terminal"]) {
    assert.throws(
      () => createCanonicalLifecycleEvent({
        phase,
        source: phase === "prompt-pushed" ? "transport" : "provider-native",
        evidence: phase === "prompt-pushed" ? "transport" : "provider-native-durable",
        fence: noRun,
        ...(phase === "turn-terminal" ? { summary: "x" } : {})
      }),
      /runId/,
      `${phase} must require runId`
    );
  }
  // Generation-scoped host/session/ready are fine without a runId.
  assert.doesNotThrow(() => createCanonicalLifecycleEvent({
    phase: "host-process-created", source: "controller", evidence: "controller", fence: noRun
  }));
});

test("preInputReady is only meaningful on provider-ready", () => {
  assert.throws(
    () => createCanonicalLifecycleEvent({
      phase: "provider-session-started", source: "provider-native",
      evidence: "provider-native-durable", preInputReady: true, fence: FENCE
    }),
    /preInputReady/
  );
});

test("an invalid identity fence fails closed at construction", () => {
  assert.throws(
    () => createCanonicalLifecycleEvent({
      phase: "host-process-created", source: "controller", evidence: "controller",
      fence: { ...FENCE, taskId: "" }
    }),
    /taskId/
  );
  assert.throws(
    () => createCanonicalLifecycleEvent({
      phase: "host-process-created", source: "controller", evidence: "controller",
      fence: { ...FENCE, adapterId: "gemini" }
    }),
    /adapter/
  );
});

// --- Ordering: the happy path advances exactly once per phase ---------------

test("happy path: host -> session -> ready -> pushed -> accepted -> progress -> terminal", () => {
  // ready
  const ready = createCanonicalLifecycleEvent({
    phase: "provider-ready", source: "provider-native",
    evidence: "provider-native-durable", preInputReady: true, fence: FENCE
  });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(ready, expectation()),
    { outcome: "mark-ready", preInputReady: true }
  );

  // pushed (exactly one)
  assert.deepEqual(
    foldCanonicalLifecycleEvent(pushedEvent(), expectation()),
    { outcome: "mark-pushed" }
  );

  // normal accepted path after the local push commit
  assert.deepEqual(
    foldCanonicalLifecycleEvent(acceptedEvent(), expectation({ pushed: true })),
    { outcome: "advance-accepted" }
  );

  // progress only inside an accepted turn
  const progress = createCanonicalLifecycleEvent({
    phase: "turn-progress", source: "provider-native",
    evidence: "provider-native-durable", sequence: 1, fence: FENCE
  });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(progress, expectation({ pushed: true, accepted: true })),
    { outcome: "advance-progress" }
  );

  // terminal after acceptance
  const terminal = createCanonicalLifecycleEvent({
    phase: "turn-terminal", source: "provider-native",
    evidence: "provider-native-durable", summary: "done", fence: FENCE
  });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(terminal, expectation({ pushed: true, accepted: true })),
    { outcome: "advance-terminal" }
  );
});

// --- The core prohibition: no delivered/accepted without a prior push --------

test("acceptance without a prior push fails closed (provider evidence is not transport evidence)", () => {
  assert.deepEqual(
    foldCanonicalLifecycleEvent(acceptedEvent(), expectation({ pushed: false })),
    { outcome: "fail-closed", reason: "accept-without-push" }
  );
});

test("exactly one push: a second push for an already-pushed run is idempotent, not a second Enter", () => {
  assert.deepEqual(
    foldCanonicalLifecycleEvent(pushedEvent(), expectation({ pushed: true })),
    { outcome: "idempotent", reason: "already-pushed" }
  );
});

test("a push after acceptance is obsolete (the turn already moved on)", () => {
  assert.deepEqual(
    foldCanonicalLifecycleEvent(pushedEvent(), expectation({ pushed: true, accepted: true })),
    { outcome: "obsolete", reason: "push-after-accepted" }
  );
});

// --- Idempotence for duplicates ---------------------------------------------

test("a duplicate acceptance for an already-accepted run is idempotent", () => {
  assert.deepEqual(
    foldCanonicalLifecycleEvent(acceptedEvent(), expectation({ pushed: true, accepted: true })),
    { outcome: "idempotent", reason: "already-accepted" }
  );
});

test("a duplicate terminal for an already-terminal run is idempotent", () => {
  const terminal = createCanonicalLifecycleEvent({
    phase: "turn-terminal", source: "provider-native",
    evidence: "provider-native-durable", summary: "again", fence: FENCE
  });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(terminal, expectation({ pushed: true, accepted: true, terminal: true })),
    { outcome: "idempotent", reason: "already-terminal" }
  );
});

// --- Late / out-of-order events fail closed or defer, never promote ----------

test("a terminal for a pushed-but-unaccepted run defers (never promotes acceptance)", () => {
  const terminal = createCanonicalLifecycleEvent({
    phase: "turn-terminal", source: "provider-native",
    evidence: "provider-native-durable", summary: "completed", fence: FENCE
  });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(terminal, expectation({ pushed: true, accepted: false })),
    { outcome: "deferred", reason: "terminal-before-accept" }
  );
});

test("a terminal with neither push nor acceptance fails closed", () => {
  const terminal = createCanonicalLifecycleEvent({
    phase: "turn-terminal", source: "provider-native",
    evidence: "provider-native-durable", summary: "?", fence: FENCE
  });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(terminal, expectation()),
    { outcome: "fail-closed", reason: "terminal-without-push" }
  );
});

test("progress before acceptance fails closed (a completion never promotes acceptance)", () => {
  const progress = createCanonicalLifecycleEvent({
    phase: "turn-progress", source: "provider-native",
    evidence: "provider-native-durable", fence: FENCE
  });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(progress, expectation({ pushed: true, accepted: false })),
    { outcome: "fail-closed", reason: "progress-without-accept" }
  );
});

test("post-terminal session/ready/progress events are obsolete, not re-applied", () => {
  const done = expectation({ pushed: true, accepted: true, terminal: true });
  const started = createCanonicalLifecycleEvent({
    phase: "provider-session-started", source: "provider-native",
    evidence: "provider-native-durable", fence: FENCE
  });
  assert.equal(foldCanonicalLifecycleEvent(started, done).outcome, "obsolete");
  const progress = createCanonicalLifecycleEvent({
    phase: "turn-progress", source: "provider-native",
    evidence: "provider-native-durable", fence: FENCE
  });
  assert.equal(foldCanonicalLifecycleEvent(progress, done).outcome, "obsolete");
});

// --- Wrong-fence events are obsolete and never touch the successor -----------

test("a wrong-run acceptance is obsolete against the current expectation", () => {
  const wrongRun = acceptedEvent({ ...FENCE, runId: "agent-run-999" });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(wrongRun, expectation({ pushed: true })),
    { outcome: "obsolete", reason: "fence-mismatch:runId" }
  );
});

test("a stale-generation (launchId) acceptance is obsolete — no silent generation rebind", () => {
  const staleGeneration = acceptedEvent({ ...FENCE, launchId: "generation-OLD" });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(staleGeneration, expectation({ pushed: true })),
    { outcome: "obsolete", reason: "fence-mismatch:launchId" }
  );
});

test("a wrong-nativeSession acceptance is obsolete", () => {
  const wrongSession = acceptedEvent({ ...FENCE, nativeSessionId: "native-OTHER" });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(wrongSession, expectation({ pushed: true })),
    { outcome: "obsolete", reason: "fence-mismatch:nativeSessionId" }
  );
});

test("a wrong-agent or wrong-adapter event is obsolete", () => {
  const wrongAgent = acceptedEvent({ ...FENCE, agentId: "claude/other" });
  assert.equal(
    foldCanonicalLifecycleEvent(wrongAgent, expectation({ pushed: true })).reason,
    "fence-mismatch:agentId"
  );
  const wrongAdapter = createCanonicalLifecycleEvent({
    phase: "provider-accepted", source: "provider-native",
    evidence: "provider-native-durable", fence: { ...FENCE, adapterId: "codex" }
  });
  assert.equal(
    foldCanonicalLifecycleEvent(wrongAdapter, expectation({ pushed: true })).reason,
    "fence-mismatch:adapterId"
  );
});

test("a wrong transport receipt for a push is obsolete", () => {
  const wrongReceipt = pushedEvent({ ...FENCE, receiptId: "agent-run:task-4/agent-run-OTHER" });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(wrongReceipt, expectation()),
    { outcome: "obsolete", reason: "fence-mismatch:receiptId" }
  );
});

// --- pre-input readiness capability helper -----------------------------------

test("isPreInputReadinessSupported reflects the capability status", () => {
  assert.equal(
    isPreInputReadinessSupported({ status: "supported", nativeEvent: "x", note: "y" }),
    true
  );
  assert.equal(
    isPreInputReadinessSupported({ status: "unsupported", reason: "not-available", note: "y" }),
    false
  );
});

// --- Finding 2: exact generation fence required for provider truth -----------

function readyEvent(preInputReady, fence = FENCE) {
  return createCanonicalLifecycleEvent({
    phase: "provider-ready", source: "provider-native",
    evidence: "provider-native-durable", preInputReady, fence
  });
}

test("provider-accepted requires the complete generation fence at construction", () => {
  const { nativeSessionId, ...noNative } = FENCE;
  assert.throws(
    () => acceptedEvent(noNative),
    /nativeSessionId/,
    "acceptance without nativeSessionId must fail closed"
  );
  const { launchId, ...noLaunch } = FENCE;
  assert.throws(() => acceptedEvent(noLaunch), /launchId/);
  const { receiptId, ...noReceipt } = FENCE;
  assert.throws(() => acceptedEvent(noReceipt), /receipt/);
});

test("turn-progress and turn-terminal require the complete generation fence", () => {
  const { nativeSessionId, ...noNative } = FENCE;
  assert.throws(
    () => createCanonicalLifecycleEvent({
      phase: "turn-progress", source: "provider-native",
      evidence: "provider-native-durable", fence: noNative
    }),
    /nativeSessionId/
  );
  const { launchId, ...noLaunch } = FENCE;
  assert.throws(
    () => createCanonicalLifecycleEvent({
      phase: "turn-terminal", source: "provider-native",
      evidence: "provider-native-durable", summary: "x", fence: noLaunch
    }),
    /launchId/
  );
});

test("only provider-native-durable advances provider truth; adapter-mapped fails closed", () => {
  for (const phase of ["provider-accepted", "turn-progress", "turn-terminal"]) {
    assert.throws(
      () => createCanonicalLifecycleEvent({
        phase, source: "provider-native", evidence: "adapter-mapped",
        fence: FENCE, ...(phase === "turn-terminal" ? { summary: "x" } : {})
      }),
      CanonicalLifecycleError,
      `${phase} must reject adapter-mapped (shape-only) evidence`
    );
  }
});

test("acceptance against a run whose bound native id differs is obsolete", () => {
  // The expectation already bound native-1; an accept for native-2 is stale.
  const other = acceptedEvent({ ...FENCE, nativeSessionId: "native-2" });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(other, expectation({ pushed: true, boundNativeSessionId: "native-1" })),
    { outcome: "obsolete", reason: "fence-mismatch:nativeSessionId" }
  );
});

// --- Finding 2: session discovery binds an unknown native id -----------------

test("session-started binds a previously-unknown native id under the exact launch fence", () => {
  const started = createCanonicalLifecycleEvent({
    phase: "provider-session-started", source: "provider-native",
    evidence: "provider-native-durable", fence: FENCE
  });
  const before = expectation({ boundNativeSessionId: undefined });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(started, before),
    { outcome: "bind-native-session", nativeSessionId: FENCE.nativeSessionId }
  );
});

test("session-started for a different launch than expected does not bind", () => {
  const started = createCanonicalLifecycleEvent({
    phase: "provider-session-started", source: "provider-native",
    evidence: "provider-native-durable", fence: { ...FENCE, launchId: "generation-OTHER" }
  });
  const before = expectation({ boundNativeSessionId: undefined });
  const decision = foldCanonicalLifecycleEvent(started, before);
  // Wrong launch never binds; it either marks-session-started or is obsolete,
  // but it must not bind the native id under a mismatched generation.
  assert.notEqual(decision.outcome, "bind-native-session");
});

// --- Finding 3: explicit boolean preInputReady required ----------------------

test("provider-ready without an explicit preInputReady fails closed", () => {
  assert.throws(
    () => createCanonicalLifecycleEvent({
      phase: "provider-ready", source: "provider-native",
      evidence: "provider-native-durable", fence: FENCE
    }),
    /explicit boolean preInputReady/
  );
});

test("provider-ready carries an explicit false without coercion", () => {
  const notPreInput = readyEvent(false);
  assert.equal(notPreInput.preInputReady, false);
  assert.deepEqual(
    foldCanonicalLifecycleEvent(notPreInput, expectation()),
    { outcome: "mark-ready", preInputReady: false }
  );
});

// --- Finding 4: session/ready duplicates are idempotent ----------------------

test("a duplicate session-started for an already-started run is idempotent", () => {
  const started = createCanonicalLifecycleEvent({
    phase: "provider-session-started", source: "provider-native",
    evidence: "provider-native-durable", fence: FENCE
  });
  assert.deepEqual(
    foldCanonicalLifecycleEvent(started, expectation({ sessionStarted: true })),
    { outcome: "idempotent", reason: "already-session-started" }
  );
});

test("a duplicate provider-ready for an already-ready run is idempotent", () => {
  assert.deepEqual(
    foldCanonicalLifecycleEvent(readyEvent(true), expectation({ sessionStarted: true, ready: true })),
    { outcome: "idempotent", reason: "already-ready" }
  );
});

test("a fresh provider-ready marks ready exactly once, then replays idempotently", () => {
  const ready = readyEvent(true);
  assert.deepEqual(
    foldCanonicalLifecycleEvent(ready, expectation()),
    { outcome: "mark-ready", preInputReady: true }
  );
  // Same immutable event, now that ready is applied: idempotent replay.
  assert.deepEqual(
    foldCanonicalLifecycleEvent(ready, expectation({ ready: true })),
    { outcome: "idempotent", reason: "already-ready" }
  );
});
