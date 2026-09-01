/**
 * Shared test environment helper.
 *
 * Quick Win (EXE-11): test subprocesses must not inherit the managed Session,
 * Turn, launch, or control-plane descriptors of the Yui Session that launched
 * the test runner.  A test that needs to verify descriptor handling must
 * inject its own fixture explicitly.
 */

// Keep this list in sync with YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES in
// src/agent/managedRuntimeEnvironment.ts.  Tests run against the compiled
// output, so we duplicate the names here to avoid a build dependency.
const MANAGED_RUNTIME_ENV_NAMES = Object.freeze([
  "YUI_CLI_NAME",
  "YUI_HOME",
  "YUI_SESSION_SCOPE",
  "YUI_TASK_ID",
  "YUI_ROLE",
  "YUI_AGENT_ID",
  "YUI_ADAPTER_ID",
  "YUI_DRIVER_ID",
  "YUI_WORKSPACE",
  "YUI_TURN_ID",
  "YUI_LAUNCH_ID",
  "YUI_NATIVE_SESSION_ROOT",
  "YUI_NATIVE_SESSION_ID",
  "YUI_CONTROL_PLANE_DESCRIPTOR",
  "YUI_TASK_RUNTIME_DESCRIPTOR",
  "YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR",
  "YUI_TASK_RUNTIME_SERVICE_NAMESPACE",
  "YUI_SESSION_TITLE",
  "YUI_AGENT_COMMAND",
  "YUI_AGENT_BASE_ARGS",
  "YUI_WRITABLE_PROJECT_IDS",
  "YUI_CONTEXT_PROJECT_IDS",
  "YUI_WORKSPACE_PROJECTS",
  "YUI_LEADER_ACTION_TURN_ID",
  "YUI_LEADER_ACTION_RECEIPT_ID",
  "YUI_JOB_CALLER_KEY"
]);

/**
 * Build a sanitized environment for a test subprocess.  Only PATH and HOME
 * are inherited by default; every Yui managed-runtime descriptor is stripped.
 * Tests that need a specific YUI_HOME or descriptor must inject it explicitly.
 */
export function sanitizedTestEnv(overrides = {}) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? ""
  };
  for (const name of MANAGED_RUNTIME_ENV_NAMES) {
    if (name === "YUI_HOME" && overrides.YUI_HOME !== undefined) continue;
    delete env[name];
  }
  return { ...env, ...overrides };
}

/**
 * The list of managed-runtime env names that are stripped by default.
 * Tests that assert descriptor isolation can use this to verify every name
 * is absent from a spawned process environment.
 */
export { MANAGED_RUNTIME_ENV_NAMES };
