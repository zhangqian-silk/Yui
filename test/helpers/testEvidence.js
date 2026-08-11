// Structured, honest test evidence for the Yui test tiers.
//
// The recurring problem this solves: a test log that says "E2E passed" without
// telling the reader whether a Session was created, whether a real model was
// actually called, which binary and YUI_HOME were used, who owned the runtime
// namespace, whether cleanup succeeded, and what remained unverified. This
// recorder captures exactly those facts and refuses to record a claim that
// contradicts the declared tier — so a Mock Agent artifact can never quietly
// assert provider-native acceptance.

import { resolve } from "node:path";

import {
  MOCK_TRANSPORT_DISCLAIMER,
  resolveTier,
  tierMayCallModel
} from "./testTiers.js";

/**
 * @typedef {"pending" | "success" | "error" | "skipped" | "not-applicable"} CleanupOutcome
 * @typedef {Readonly<{ kind: string, home?: string, tmuxServer?: string, token?: string }>} NamespaceOwnership
 */

/**
 * Creates a mutable evidence recorder bound to one tier. The tier's declared
 * facts (createsSession, callsModel) are the ceiling: an attempt to record a
 * stronger claim than the tier allows throws immediately, so dishonest evidence
 * fails the test rather than being written to a report.
 *
 * @param {Readonly<{
 *   tier: string,
 *   name: string,
 *   binarySource?: string | null,
 *   yuiHome?: string | null,
 *   workspace?: string | null,
 *   namespaceOwnership?: NamespaceOwnership | null
 * }>} input
 */
export function createEvidenceRecorder(input) {
  const tier = resolveTier(input.tier);
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new Error("Evidence recorder requires a non-empty test name.");
  }

  const state = {
    tier: tier.id,
    tierTitle: tier.title,
    name: input.name,
    // Declared tier facts, echoed so a reader never has to cross-reference.
    tierCreatesSession: tier.createsSession,
    tierCallsModel: tier.callsModel,
    // Observed facts, all conservative by default.
    sessionCreated: false,
    modelCalled: false,
    providerAccepted: false,
    binarySource: normalizeOptionalPath(input.binarySource),
    yuiHome: normalizeOptionalPath(input.yuiHome),
    workspace: normalizeOptionalPath(input.workspace),
    namespaceOwnership: input.namespaceOwnership ?? null,
    // Cleanup applies to any tier that creates real disposable resources, not
    // only Session-creating tiers: Release E2E creates a disposable npm
    // prefix/home without an Agent Session and still must be reaped.
    cleanupOutcome: /** @type {CleanupOutcome} */ (tier.createsDisposableRuntime ? "pending" : "not-applicable"),
    cleanupDetail: null,
    /** @type {Array<Readonly<{ name: string, outcome: string, details?: string }>>} */
    checks: [],
    /** @type {string[]} */
    verificationGaps: []
  };

  // Mock/unit tiers must always carry the transport disclaimer as a standing
  // verification gap: transport success is not provider acceptance.
  if (!tier.callsModel && tier.createsSession) {
    state.verificationGaps.push(MOCK_TRANSPORT_DISCLAIMER);
  }

  const recorder = {
    /** Records that a Yui/native Session was created (only where the tier allows it). */
    markSessionCreated(detail) {
      if (!tier.createsSession) {
        throw new Error(
          `Tier ${tier.id} must not create a Session, but the test recorded one`
          + `${detail ? `: ${detail}` : "."}`
        );
      }
      state.sessionCreated = true;
      return recorder;
    },
    /**
     * Records that a real model/provider was actually called. This is rejected
     * outright for tiers that must never call a model, which is the mechanism
     * that keeps the default suite honest.
     */
    markModelCalled(detail) {
      if (!tierMayCallModel(tier.id)) {
        throw new Error(
          `Tier ${tier.id} must never call a real model, but the test recorded a model call`
          + `${detail ? `: ${detail}` : "."}`
        );
      }
      state.modelCalled = true;
      return recorder;
    },
    /**
     * Records that a real provider natively accepted the prompt. Only a
     * model-calling tier may claim this; a Mock tier claiming it is a bug.
     */
    markProviderAccepted(detail) {
      if (!tierMayCallModel(tier.id)) {
        throw new Error(
          `Tier ${tier.id} cannot prove provider-native acceptance (${MOCK_TRANSPORT_DISCLAIMER})`
          + `${detail ? ` [${detail}]` : ""}`
        );
      }
      state.providerAccepted = true;
      return recorder;
    },
    setBinarySource(path) {
      state.binarySource = normalizeOptionalPath(path);
      return recorder;
    },
    setYuiHome(path) {
      state.yuiHome = normalizeOptionalPath(path);
      return recorder;
    },
    setWorkspace(path) {
      state.workspace = normalizeOptionalPath(path);
      return recorder;
    },
    /** @param {NamespaceOwnership} ownership */
    setNamespaceOwnership(ownership) {
      state.namespaceOwnership = ownership ?? null;
      return recorder;
    },
    /** @param {CleanupOutcome} outcome */
    recordCleanup(outcome, detail) {
      const allowed = ["pending", "success", "error", "skipped", "not-applicable"];
      if (!allowed.includes(outcome)) {
        throw new Error(`Unknown cleanup outcome: ${JSON.stringify(outcome)}.`);
      }
      state.cleanupOutcome = outcome;
      state.cleanupDetail = detail ?? null;
      return recorder;
    },
    recordCheck(name, outcome, details) {
      state.checks.push(Object.freeze({ name, outcome, ...(details ? { details } : {}) }));
      return recorder;
    },
    /** Notes a material fact this test did NOT verify. Duplicates are ignored. */
    noteVerificationGap(gap) {
      if (typeof gap === "string" && gap.length > 0 && !state.verificationGaps.includes(gap)) {
        state.verificationGaps.push(gap);
      }
      return recorder;
    },
    /** Merges the resolved isolation-preflight checks into the evidence. */
    recordPreflight(result) {
      for (const check of result?.checks ?? []) {
        state.checks.push(Object.freeze({
          name: `preflight:${check.name}`,
          outcome: check.ok ? "passed" : "failed",
          details: check.detail
        }));
      }
      return recorder;
    },
    /** Returns an immutable snapshot of the recorded evidence. */
    snapshot() {
      return Object.freeze({
        ...state,
        checks: Object.freeze([...state.checks]),
        verificationGaps: Object.freeze([...state.verificationGaps])
      });
    },
    /** Renders a stable, human-readable evidence report. */
    render() {
      return renderEvidenceReport(recorder.snapshot());
    }
  };

  return recorder;
}

/**
 * Renders a deterministic multi-line report from an evidence snapshot. The
 * field order is fixed so reports diff cleanly and a reader always finds the
 * same facts in the same place.
 * @param {ReturnType<ReturnType<typeof createEvidenceRecorder>["snapshot"]>} snapshot
 */
export function renderEvidenceReport(snapshot) {
  const lines = [];
  lines.push(`Test evidence: ${snapshot.name}`);
  lines.push(`  Tier: ${snapshot.tierTitle} (${snapshot.tier})`);
  lines.push(`  Session created: ${yesNo(snapshot.sessionCreated)}`
    + ` (tier ${snapshot.tierCreatesSession ? "creates" : "creates no"} Session)`);
  lines.push(`  Model/provider called: ${yesNo(snapshot.modelCalled)}`
    + ` (tier ${snapshot.tierCallsModel ? "may call" : "never calls"} a model)`);
  lines.push(`  Provider-native acceptance proven: ${yesNo(snapshot.providerAccepted)}`);
  lines.push(`  Binary source: ${snapshot.binarySource ?? "<none>"}`);
  lines.push(`  YUI_HOME: ${snapshot.yuiHome ?? "<none>"}`);
  lines.push(`  Workspace: ${snapshot.workspace ?? "<none>"}`);
  lines.push(`  Namespace ownership: ${renderNamespace(snapshot.namespaceOwnership)}`);
  lines.push(`  Cleanup: ${snapshot.cleanupOutcome}`
    + (snapshot.cleanupDetail ? ` — ${snapshot.cleanupDetail}` : ""));
  if (snapshot.checks.length > 0) {
    lines.push("  Checks:");
    for (const check of snapshot.checks) {
      lines.push(`    - ${check.name}: ${check.outcome}`
        + (check.details ? ` (${check.details})` : ""));
    }
  }
  lines.push("  Verification gaps:");
  if (snapshot.verificationGaps.length === 0) {
    lines.push("    - none declared");
  } else {
    for (const gap of snapshot.verificationGaps) lines.push(`    - ${gap}`);
  }
  return lines.join("\n");
}

function renderNamespace(ownership) {
  if (ownership === null || typeof ownership !== "object") return "<none>";
  const parts = [ownership.kind ?? "unknown"];
  if (ownership.tmuxServer) parts.push(`tmux=${ownership.tmuxServer}`);
  if (ownership.home) parts.push(`home=${ownership.home}`);
  if (ownership.token) parts.push(`token=${ownership.token.slice(0, 8)}…`);
  return parts.join(" ");
}

function yesNo(value) {
  return value === true ? "yes" : "no";
}

function normalizeOptionalPath(value) {
  return typeof value === "string" && value.length > 0 ? resolve(value) : null;
}
