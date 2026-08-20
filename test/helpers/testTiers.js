// Explicit, executable test-tier contract for the Yui repository itself.
//
// Historical tests often used "E2E" as a catch-all, which made it impossible
// to tell whether a given test actually created a Yui/native Session, called a
// real model/provider, or touched the global environment. This module fixes
// the vocabulary: every tier is declared once here, with the two facts a reader
// most needs — does it create a Session, and does it call a real model — plus
// whether the isolation preflight is mandatory before it may run.
//
// This registry does NOT retroactively relabel existing tests. It defines the
// tiers new tests opt into and that the tier entrypoints (scripts/run-test-tier.mjs)
// dispatch. The pre-existing default suite (`npm test`) remains the deterministic
// regression path and never launches a real model.

/**
 * The one sentence every Mock Agent Session artifact must be able to reproduce:
 * a successful in-process/local transport handshake is not evidence that a real
 * Codex/Claude provider natively accepted the prompt.
 */
export const MOCK_TRANSPORT_DISCLAIMER =
  "Mock Agent Session transport success does not prove provider-native acceptance.";

/**
 * Every tier declares four independent facts a reader needs:
 *   - createsSession: does it create a Yui/native Session?
 *   - callsModel: does it call a real model/provider?
 *   - createsDisposableRuntime: does it create real disposable resources (home,
 *     npm prefix, Controller/tmux, panes) that a teardown must reap? This is
 *     broader than createsSession — Release E2E creates a disposable npm
 *     prefix/home without ever creating an Agent Session.
 *   - requiresIsolationPreflight: must the blocking isolation preflight pass
 *     before it may run? Privileged tiers (those with an optInEnv) are gated on
 *     opt-in regardless of whether they call a model.
 * @typedef {Readonly<{
 *   id: string,
 *   title: string,
 *   createsSession: boolean,
 *   callsModel: boolean,
 *   createsDisposableRuntime: boolean,
 *   requiresIsolationPreflight: boolean,
 *   optInEnv: string | null,
 *   description: string
 * }>} TestTier
 */

/** @type {Readonly<Record<string, TestTier>>} */
export const TEST_TIERS = Object.freeze({
  unit: Object.freeze({
    id: "unit",
    title: "Unit",
    createsSession: false,
    callsModel: false,
    createsDisposableRuntime: false,
    requiresIsolationPreflight: false,
    optInEnv: null,
    description:
      "Pure logic and file-store tests. No Controller, tmux, Session, model, "
      + "or global-environment side effects."
  }),
  "isolated-integration": Object.freeze({
    id: "isolated-integration",
    title: "Isolated Integration",
    createsSession: true,
    callsModel: false,
    createsDisposableRuntime: true,
    requiresIsolationPreflight: false,
    optInEnv: null,
    description:
      "Repository integration against a disposable YUI_HOME plus its own "
      + "Controller/tmux namespace. May create a real detached Controller and "
      + "tmux panes, but never launches a real model."
  }),
  "mock-agent-session": Object.freeze({
    id: "mock-agent-session",
    title: "Mock Agent Session",
    createsSession: true,
    callsModel: false,
    createsDisposableRuntime: true,
    requiresIsolationPreflight: false,
    optInEnv: null,
    description:
      "Creates an observable native Session driven by a deterministic local "
      + "Mock Agent process. Exercises real lifecycle/runtime seams without any "
      + `model or network dependency. ${MOCK_TRANSPORT_DISCLAIMER}`
  }),
  "provider-e2e": Object.freeze({
    id: "provider-e2e",
    title: "Provider E2E",
    createsSession: true,
    callsModel: true,
    createsDisposableRuntime: true,
    requiresIsolationPreflight: true,
    optInEnv: "YUI_ALLOW_PROVIDER_E2E",
    description:
      "Drives a real Codex/Claude provider through an isolated launcher and "
      + "disposable environment. Reserved for provider-specific behavior; must "
      + "pass the isolation preflight and is never part of the default suite."
  }),
  "release-e2e": Object.freeze({
    id: "release-e2e",
    title: "Release E2E",
    // A normal release run exercises install/update/upgrade flows under an
    // isolated npm prefix. On that normal path it does NOT create an Agent
    // Session and does NOT call a model — representing otherwise would overstate
    // what the tier proves. It stays privileged (explicit opt-in) and must pass
    // the isolation preflight because it still touches real npm/home/namespace
    // resources.
    createsSession: false,
    callsModel: false,
    createsDisposableRuntime: true,
    requiresIsolationPreflight: true,
    optInEnv: "YUI_ALLOW_RELEASE_E2E",
    description:
      "Exercises binary/install/update/upgrade release flows end to end under "
      + "an isolated npm prefix and disposable environment. On the normal path "
      + "it creates no Agent Session and calls no model; it stays privileged "
      + "(explicit opt-in) and must pass the isolation preflight because it "
      + "touches real npm/home/namespace resources. Never part of the default "
      + "suite."
  })
});

/** Stable ordering from cheapest/safest to most privileged. */
export const TEST_TIER_IDS = Object.freeze(Object.keys(TEST_TIERS));

/**
 * Resolves a tier by id, failing closed on an unknown id rather than guessing a
 * default. Callers that accept a tier from a script argument or a test author
 * get an explicit error listing the known tiers.
 * @param {string} id
 * @returns {TestTier}
 */
export function resolveTier(id) {
  if (typeof id !== "string" || !Object.hasOwn(TEST_TIERS, id)) {
    throw new Error(
      `Unknown test tier: ${JSON.stringify(id)}. Known tiers: ${TEST_TIER_IDS.join(", ")}.`
    );
  }
  return TEST_TIERS[id];
}

/**
 * True when a tier is permitted to reach a real model/provider. Used by the
 * evidence recorder to reject a dishonest "model was called" claim from a tier
 * that must never touch one, and by the runner to gate opt-in.
 * @param {string} id
 */
export function tierMayCallModel(id) {
  return resolveTier(id).callsModel === true;
}

/**
 * True when a tier is privileged and requires an explicit opt-in env var before
 * the runner will run it. This is independent of whether the tier calls a model:
 * Release E2E is privileged (touches real npm/home/namespace) yet, on the normal
 * path, creates no Session and calls no model. Gating on this, not on
 * `callsModel`, keeps the runner honest.
 * @param {string} id
 */
export function tierIsPrivileged(id) {
  return typeof resolveTier(id).optInEnv === "string";
}

/**
 * Returns the opt-in env var name for a privileged tier, or null for a tier that
 * needs no opt-in.
 * @param {string} id
 * @returns {string | null}
 */
export function tierOptInEnv(id) {
  return resolveTier(id).optInEnv;
}
