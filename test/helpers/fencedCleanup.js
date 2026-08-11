// Reusable, fail-closed cleanup pass for disposable test runtimes.
//
// This encapsulates an exact ownership gate for future test drivers that add
// their external creator receipt to inventory records. The current isolated
// runtime instead proves ownership by its creator-owned Home and never writes
// synthetic domain metadata into production state. Annotated-resource callers
// get these guarantees:
//   - a cleanup pass ALWAYS requires the exact non-empty ephemeral-test
//     ownership token and a matching ephemeral-test domain; there is no option
//     to omit the token and no option to disable the domain fence. A missing
//     token touches nothing AND is reported as a FAILED outcome (ok=false), so
//     registered teardown fails loudly instead of silently leaking owned
//     resources behind a "successful skip";
//   - only resources whose domain is `ephemeral-test` AND whose token equals the
//     expected token are ever cleaned;
//   - unknown / unmarked / foreign-token / protected / report-only resources
//     are left completely untouched — no pkill, no name/PID/age matching. These
//     intentional skips (with a valid token present) are NOT failures;
//   - a cleanup error on one resource is remembered but does not abort the pass,
//     so a single wedged resource cannot strand the rest;
//   - the pass runs from node:test `after()` teardown, which fires on pass,
//     assertion failure, timeout, and interruption alike.
//
// The actual signalling/removal is delegated to the identity-fenced
// `cleanControllerResource`, which performs its own compare-and-swap on process
// start-identity and domain fingerprint. This helper is the selection gate in
// front of it; both layers must agree before anything is touched.

import { cleanControllerResource } from "../../dist/controller/resourceCleanupLinux.js";

/** Dispositions the resource inventory marks as eligible for cleanup. */
export const CLEANABLE_DISPOSITIONS = Object.freeze(["safe", "review"]);

/** The exact domain kind a cleanable resource must declare. */
export const REQUIRED_DOMAIN_KIND = "ephemeral-test";

/**
 * True only for the two dispositions the inventory declares cleanable.
 * `protected` and `report-only` always return false.
 * @param {string | undefined} disposition
 */
export function isCleanableDisposition(disposition) {
  return CLEANABLE_DISPOSITIONS.includes(disposition);
}

/**
 * True only for a non-empty string token. The cleanup fence has no meaning
 * without an exact token, so an absent/empty token is never acceptable.
 * @param {unknown} token
 */
export function isValidOwnershipToken(token) {
  return typeof token === "string" && token.length > 0;
}

/**
 * Decides whether one resource may be cleaned, and why. Fail-closed: a resource
 * is cleaned ONLY when the caller supplies a valid non-empty ephemeral-test
 * token and the resource's domain is `ephemeral-test` with exactly that token.
 * There is no mode that skips the token or disables the domain fence.
 *
 * @param {Readonly<{ id: string, disposition?: string, domain?: { kind?: string, token?: string } }>} resource
 * @param {Readonly<{ expectedToken?: string }>} [options]
 * @returns {Readonly<{ action: "clean" | "skip", reason: string }>}
 */
export function classifyForCleanup(resource, options = {}) {
  const expectedToken = options.expectedToken;
  // The token is mandatory. Without it there is nothing to match against, so we
  // refuse to clean anything rather than fall back to a weaker rule.
  if (!isValidOwnershipToken(expectedToken)) {
    return Object.freeze({
      action: "skip",
      reason: "missing ephemeral-test ownership token; refusing to clean without an exact owner"
    });
  }
  const disposition = resource?.disposition;
  if (!isCleanableDisposition(disposition)) {
    return Object.freeze({
      action: "skip",
      reason: `disposition ${JSON.stringify(disposition ?? null)} is not cleanable`
    });
  }
  const domain = resource?.domain;
  if (domain?.kind !== REQUIRED_DOMAIN_KIND) {
    return Object.freeze({
      action: "skip",
      reason: `unmarked domain (${JSON.stringify(domain?.kind ?? null)}); refusing to touch unowned resource`
    });
  }
  if (domain?.token !== expectedToken) {
    return Object.freeze({
      action: "skip",
      reason: "foreign ephemeral-test token; resource belongs to another disposable domain"
    });
  }
  return Object.freeze({ action: "clean", reason: "owned cleanable resource" });
}

/**
 * @typedef {Readonly<{
 *   ok: boolean,
 *   cleaned: readonly string[],
 *   skipped: readonly { id: string, reason: string }[],
 *   errors: readonly { id: string, message: string }[]
 * }>} FencedCleanupResult
 */

/** Sentinel id for a pass-level (non-resource) cleanup failure. */
export const CLEANUP_PASS_ID = "<cleanup-pass>";

/**
 * Runs one fail-closed cleanup pass over the supplied resources. A valid
 * non-empty `expectedToken` is mandatory. Without it every resource is still
 * skipped (nothing is ever touched by a weaker rule), but the pass is reported
 * as a **failure** — a structured pass-level error is recorded so `ok` is false.
 * This is deliberate: a missing token means owned resources that should have
 * been reaped were left behind, so it must never look like a successful skip
 * that lets teardown pass while resources leak.
 *
 * Intentional skips of foreign / protected / report-only resources *with* a
 * valid token are NOT errors — those resources are simply not ours to clean.
 *
 * @param {Readonly<{
 *   resources: readonly any[],
 *   expectedToken?: string,
 *   clean?: (resource: any, options: { environment: NodeJS.ProcessEnv }) => Promise<void>,
 *   environment?: NodeJS.ProcessEnv
 * }>} input
 * @returns {Promise<FencedCleanupResult>}
 */
export async function runFencedCleanup(input) {
  const clean = input.clean ?? cleanControllerResource;
  const environment = input.environment ?? process.env;
  const resources = input.resources ?? [];
  const tokenValid = isValidOwnershipToken(input.expectedToken);
  const cleaned = [];
  const skipped = [];
  const errors = [];
  for (const resource of resources) {
    const decision = classifyForCleanup(resource, {
      expectedToken: input.expectedToken
    });
    if (decision.action === "skip") {
      skipped.push({ id: resource?.id, reason: decision.reason });
      continue;
    }
    try {
      await clean(resource, { environment });
      cleaned.push(resource?.id);
    } catch (error) {
      // Remember but keep converging: one wedged resource must not strand the
      // rest of the disposable domain.
      errors.push({ id: resource?.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  // A missing/invalid token is a FAILED outcome, not a successful skip. We
  // deliberately touched nothing above (classifyForCleanup skipped everything),
  // but returning ok=true here would let registered teardown pass while owned
  // resources leak. Record it as a structured pass-level error so ok=false.
  if (!tokenValid) {
    errors.push({
      id: CLEANUP_PASS_ID,
      message: `missing ephemeral-test ownership token; refused to clean ${resources.length} resource(s). `
        + "This is a failed cleanup outcome (owned resources may leak), not a successful skip."
    });
  }
  return Object.freeze({
    ok: errors.length === 0,
    cleaned: Object.freeze(cleaned),
    skipped: Object.freeze(skipped),
    errors: Object.freeze(errors)
  });
}

/**
 * Registers a fail-closed cleanup pass on a node:test TestContext. The `after`
 * hook runs whether the test passes, fails an assertion, times out, or is
 * interrupted, so this is the teardown seam new tiers should use to guarantee
 * their disposable resources are reaped.
 *
 * `factory` is invoked at teardown time (not registration time) so it can scan
 * the live inventory. It must return `{ resources, expectedToken, environment? }`
 * where `expectedToken` is the exact non-empty ephemeral-test token. A missing
 * token still touches nothing, but it is a FAILED outcome, so by default this
 * teardown throws (owned resources may have leaked). An optional `onResult`
 * receives the structured outcome so a test can assert on it or fold it into
 * evidence.
 *
 * @param {{ after: (fn: () => unknown) => void }} testContext
 * @param {() => Promise<Readonly<{
 *   resources: readonly any[],
 *   expectedToken?: string,
 *   clean?: (resource: any, options: { environment: NodeJS.ProcessEnv }) => Promise<void>,
 *   environment?: NodeJS.ProcessEnv
 * }>>} factory
 * @param {Readonly<{ onResult?: (result: FencedCleanupResult) => void, throwOnError?: boolean }>} [options]
 */
export function registerFencedCleanup(testContext, factory, options = {}) {
  testContext.after(async () => {
    const input = await factory();
    const result = await runFencedCleanup(input);
    options.onResult?.(result);
    if (options.throwOnError !== false && !result.ok) {
      throw new Error(
        `fenced cleanup left errors: ${result.errors.map((entry) => `${entry.id}: ${entry.message}`).join("; ")}`
      );
    }
  });
}
