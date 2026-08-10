import assert from "node:assert/strict";
import test from "node:test";

import {
  mapNativeLifecycleSignal,
  providerLifecycleMapping,
  findProviderLifecycleMapping,
  preInputReadinessCapability
} from "../../dist/lifecycle/providerLifecycleMapping.js";
import {
  foldCanonicalLifecycleEvent,
  CanonicalLifecycleError
} from "../../dist/lifecycle/canonicalLifecycleEvent.js";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";

// ---------------------------------------------------------------------------
// LAYER 2 — Adapter mapping evidence.
// These prove each provider maps its OWN observed native behavior to the
// canonical vocabulary independently, that pre-input readiness is a per-adapter
// capability, and that mapping is selected by registry (adapterId) rather than a
// provider-name branch. This is mapping evidence, NOT real-TUI evidence.
// ---------------------------------------------------------------------------

const claudeFence = Object.freeze({
  taskId: "task-4",
  roleName: "provider-contract-implementer",
  agentId: "claude/claude",
  adapterId: "claude",
  runId: "agent-run-51",
  nativeSessionId: "claude-native-1",
  launchId: "claude-gen-1",
  receiptId: "agent-run:task-4/agent-run-51"
});

const codexFence = Object.freeze({
  taskId: "task-4",
  roleName: "runtime-implementer",
  agentId: "codex/codex",
  adapterId: "codex",
  runId: "agent-run-45",
  nativeSessionId: "codex-thread-1",
  launchId: "codex-gen-1",
  receiptId: "agent-run:task-4/agent-run-45"
});

// --- Claude mapping ----------------------------------------------------------

test("Claude SessionStart(startup) maps to provider-ready with pre-input readiness proven", () => {
  const event = mapNativeLifecycleSignal({
    kind: "native-session-start", sessionSource: "startup", fence: claudeFence
  });
  assert.equal(event.phase, "provider-ready");
  assert.equal(event.source, "provider-native");
  assert.equal(event.evidence, "provider-native-durable");
  assert.equal(event.preInputReady, true);
  // The proven variant is preserved end to end.
  assert.equal(event.readinessVariant, "SessionStart(source=startup)");
});

test("Claude SessionStart with a non-startup source is downgraded to session-started, never ready", () => {
  for (const sessionSource of ["resume", "clear", "compact"]) {
    const event = mapNativeLifecycleSignal({
      kind: "native-session-start", sessionSource, fence: claudeFence
    });
    assert.equal(event.phase, "provider-session-started", sessionSource);
    assert.equal(event.preInputReady, undefined, sessionSource);
    assert.equal(event.readinessVariant, undefined, sessionSource);
  }
});

test("Claude SessionStart without a source variant fails closed (cannot prove readiness)", () => {
  assert.throws(
    () => mapNativeLifecycleSignal({ kind: "native-session-start", fence: claudeFence }),
    CanonicalLifecycleError
  );
});

test("Claude UserPromptSubmit is the only acceptance fence", () => {
  const event = mapNativeLifecycleSignal({ kind: "native-prompt-submit", fence: claudeFence });
  assert.equal(event.phase, "provider-accepted");
  assert.equal(event.evidence, "provider-native-durable");
});

test("Claude maps turn progress and both terminal signals", () => {
  assert.equal(
    mapNativeLifecycleSignal({ kind: "native-turn-progress", sequence: 2, fence: claudeFence }).phase,
    "turn-progress"
  );
  assert.equal(
    mapNativeLifecycleSignal({ kind: "native-turn-complete", summary: "done", fence: claudeFence }).phase,
    "turn-terminal"
  );
  const failure = mapNativeLifecycleSignal({ kind: "native-stop-failure", summary: "API 400", fence: claudeFence });
  assert.equal(failure.phase, "turn-terminal");
  assert.equal(failure.summary, "API 400");
});

test("Claude capability declares pre-input readiness supported by SessionStart(startup)", () => {
  const capability = preInputReadinessCapability("claude");
  assert.equal(capability.status, "supported");
  assert.equal(capability.nativeEvent, "SessionStart(source=startup)");
});

// --- Codex mapping (0.145) ---------------------------------------------------

test("Codex SessionStart maps to provider-session-started only — NEVER pre-input-ready", () => {
  const event = mapNativeLifecycleSignal({ kind: "native-session-start", fence: codexFence });
  assert.equal(event.phase, "provider-session-started");
  assert.equal(event.evidence, "provider-native-durable");
  // It must not carry a readiness claim of any kind.
  assert.equal(event.preInputReady, undefined);
});

test("Codex UserPromptSubmit is the acceptance fence", () => {
  const event = mapNativeLifecycleSignal({ kind: "native-prompt-submit", fence: codexFence });
  assert.equal(event.phase, "provider-accepted");
  assert.equal(event.evidence, "provider-native-durable");
});

test("Codex notify agent-turn-complete maps to turn-terminal", () => {
  const event = mapNativeLifecycleSignal({ kind: "native-turn-complete", summary: "ok", fence: codexFence });
  assert.equal(event.phase, "turn-terminal");
});

test("Codex capability declares pre-input readiness unsupported/not-available and fails closed", () => {
  const capability = preInputReadinessCapability("codex");
  assert.equal(capability.status, "unsupported");
  assert.equal(capability.reason, "not-available");
  // Codex does not emit a StopFailure hook; mapping one must refuse, not invent.
  assert.throws(
    () => mapNativeLifecycleSignal({ kind: "native-stop-failure", summary: "x", fence: codexFence }),
    CanonicalLifecycleError
  );
  assert.equal(
    providerLifecycleMapping("codex").supportedSignals.includes("native-stop-failure"),
    false
  );
});

// --- Provider mappings differ on the SAME neutral signal ---------------------

test("the same native-session-start maps differently per provider — readiness is per-adapter", () => {
  const claudeReady = mapNativeLifecycleSignal({
    kind: "native-session-start", sessionSource: "startup", fence: claudeFence
  });
  const codexStarted = mapNativeLifecycleSignal({ kind: "native-session-start", fence: codexFence });
  assert.equal(claudeReady.phase, "provider-ready");
  assert.equal(codexStarted.phase, "provider-session-started");
  assert.notEqual(claudeReady.phase, codexStarted.phase);
});

// --- Registry selection, no provider-name branch ----------------------------

test("mapping is selected by the fence adapterId — a Codex signal is never mapped by Claude's rules", () => {
  // The fence's adapterId chooses the mapping; no caller branch on provider name.
  const event = mapNativeLifecycleSignal({ kind: "native-session-start", fence: codexFence });
  assert.equal(event.phase, "provider-session-started");
  // Unknown adapter fails closed rather than defaulting to any provider.
  assert.equal(findProviderLifecycleMapping("gemini"), null);
  assert.throws(() => providerLifecycleMapping("gemini"), CanonicalLifecycleError);
});

// --- Mapping + fold integrate: Codex has no pre-input push gate ---------------

test("mapped Codex acceptance still requires an independently committed transport receipt", () => {
  const accepted = mapNativeLifecycleSignal({ kind: "native-prompt-submit", fence: codexFence });
  const beforePush = {
    fence: codexFence, pushed: false, accepted: false, terminal: false
  };
  assert.deepEqual(
    foldCanonicalLifecycleEvent(accepted, beforePush),
    { outcome: "fail-closed", reason: "accept-without-push" }
  );
  const afterPush = { ...beforePush, pushed: true };
  assert.deepEqual(
    foldCanonicalLifecycleEvent(accepted, afterPush),
    { outcome: "advance-accepted" }
  );
});

// --- Attach generation stability --------------------------------------------

test("attach reuses the same generation: identical launchId/nativeSession folds idempotently", () => {
  const accepted = mapNativeLifecycleSignal({ kind: "native-prompt-submit", fence: claudeFence });
  const acceptedState = { fence: claudeFence, pushed: true, accepted: true, terminal: false };
  // A supported attach that reuses the SAME generation replays the same fence:
  // the fold treats the duplicate as idempotent — generation is unchanged.
  assert.deepEqual(
    foldCanonicalLifecycleEvent(accepted, acceptedState),
    { outcome: "idempotent", reason: "already-accepted" }
  );
});

test("a changed generation (new launchId) after acceptance is obsolete, not a silent rebind", () => {
  const rebind = mapNativeLifecycleSignal({
    kind: "native-prompt-submit",
    fence: { ...claudeFence, launchId: "claude-gen-2" }
  });
  const acceptedState = { fence: claudeFence, pushed: true, accepted: true, terminal: false };
  assert.deepEqual(
    foldCanonicalLifecycleEvent(rebind, acceptedState),
    { outcome: "obsolete", reason: "fence-mismatch:launchId" }
  );
});

// --- The real adapter surface exposes the capability -------------------------

test("resolveAgentAdapter exposes the pre-input readiness capability per provider", () => {
  assert.equal(resolveAgentAdapter("claude").capabilities.preInputReadiness.status, "supported");
  assert.equal(resolveAgentAdapter("codex").capabilities.preInputReadiness.status, "unsupported");
});
