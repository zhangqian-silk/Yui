// Deterministic environment preamble for the default test suite.
//
// Ordinary tests must behave identically whether they are launched from a plain
// shell or from inside a managed Yui Session. A managed Session exports
// control-plane variables (YUI_SESSION_SCOPE, YUI_TASK_ID, YUI_ROLE, YUI_RUN_ID, …)
// that the Yui CLI reads to decide "am I acting as the Leader/Worker of this
// Task?". If those leak into a test child process, CLI-driven tests take a
// different, Session-scoped branch and fail for reasons unrelated to the code
// under test — a real global-environment contamination.
//
// This module is loaded via `node --import` before test files. The production
// managed-runtime registry is the only name source: tests do not carry a second
// hand-maintained list that can drift as launch descriptors evolve. YUI_HOME is
// scrubbed too; a test that needs a Home must explicitly create and supply its
// own isolated one.

import { delimiter, resolve } from "node:path";

import { YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES } from "../../dist/agent/managedRuntimeEnvironment.js";

const PROVIDER_BLOCKER_DIRECTORY = resolve(import.meta.dirname, "provider-blockers");
const PROVIDER_MANIFEST_PATH = resolve(
  import.meta.dirname,
  "../privileged/provider-e2e/manifest.json"
);

const MANAGED_SESSION_ENVIRONMENT_NAMES = Object.freeze([
  ...YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES
]);

/**
 * Deletes the managed-session control-plane markers from an environment object.
 * Returns the names actually removed, so a caller/test can observe the effect.
 * @param {NodeJS.ProcessEnv} environment
 * @returns {string[]}
 */
export function scrubManagedSessionEnvironment(environment) {
  const removed = [];
  for (const name of MANAGED_SESSION_ENVIRONMENT_NAMES) {
    if (environment[name] !== undefined) {
      delete environment[name];
      removed.push(name);
    }
  }
  return removed;
}

export { MANAGED_SESSION_ENVIRONMENT_NAMES };

// Scrub the live process environment on import. Guarded so an explicit opt-out
// is possible for the rare test that wants to observe a managed Session.
if (process.env.YUI_TEST_KEEP_SESSION_ENV !== "1") {
  scrubManagedSessionEnvironment(process.env);
}
delete process.env.YUI_TEST_MOCK_PROVIDER_ONESHOT;

// A bare Provider command is never a valid dependency of an ordinary test.
// Put deterministic refusal shims ahead of the caller's PATH so a forgotten
// Mock Agent cannot silently reach a locally installed Codex or Claude. The
// explicitly opted-in Provider tier is instead governed by its mandatory
// isolation preflight and privileged scenario driver.
const providerRunnerSelected = process.env.YUI_TEST_TIER === "provider-e2e"
  && typeof process.env.YUI_TEST_PRIVILEGED_MANIFEST === "string"
  && resolve(process.env.YUI_TEST_PRIVILEGED_MANIFEST) === PROVIDER_MANIFEST_PATH;
if (!providerRunnerSelected) {
  process.env.PATH = [PROVIDER_BLOCKER_DIRECTORY, process.env.PATH]
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .join(delimiter);
}

export { PROVIDER_BLOCKER_DIRECTORY };
