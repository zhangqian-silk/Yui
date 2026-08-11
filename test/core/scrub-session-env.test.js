import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import test from "node:test";

import { YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES } from "../../dist/agent/launchEnvironment.js";
import {
  MANAGED_SESSION_ENVIRONMENT_NAMES,
  scrubManagedSessionEnvironment
} from "../helpers/scrubSessionEnv.js";

const REQUIRED_MANAGED_NAMES = [
  "YUI_CLI_NAME",
  "YUI_HOME",
  "YUI_SESSION_SCOPE",
  "YUI_TASK_ID",
  "YUI_ROLE",
  "YUI_AGENT_ID",
  "YUI_ADAPTER_ID",
  "YUI_WORKSPACE",
  "YUI_RUN_ID",
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
  "YUI_LEADER_ACTION_RUN_ID",
  "YUI_LEADER_ACTION_RECEIPT_ID"
];
const PROVIDER_BLOCKER_DIRECTORY = resolve(
  import.meta.dirname,
  "../helpers/provider-blockers"
);

test("test scrubbing derives from the production managed-runtime environment registry", () => {
  assert.deepEqual(
    MANAGED_SESSION_ENVIRONMENT_NAMES,
    [...YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES]
  );
  for (const name of REQUIRED_MANAGED_NAMES) {
    assert.ok(MANAGED_SESSION_ENVIRONMENT_NAMES.includes(name), `${name} must be canonical`);
  }
});

test("scrub removes shared Home and every Yui-owned managed runtime value", () => {
  const environment = Object.fromEntries(
    MANAGED_SESSION_ENVIRONMENT_NAMES.map((name) => [name, `inherited-${name}`])
  );
  environment.UNRELATED = "keep-me";

  const removed = scrubManagedSessionEnvironment(environment);

  for (const name of MANAGED_SESSION_ENVIRONMENT_NAMES) {
    assert.equal(environment[name], undefined, `${name} should be removed`);
    assert.ok(removed.includes(name), `${name} should be reported as removed`);
  }
  assert.equal(environment.UNRELATED, "keep-me");
});

test("scrub is a no-op on an already-clean environment", () => {
  const environment = { PATH: "/usr/bin" };
  const removed = scrubManagedSessionEnvironment(environment);
  assert.deepEqual(removed, []);
  assert.deepEqual(environment, { PATH: "/usr/bin" });
});

test("the loaded preamble has scrubbed the live ordinary-test process", () => {
  for (const name of MANAGED_SESSION_ENVIRONMENT_NAMES) {
    assert.equal(process.env[name], undefined, `${name} must not be present during tests`);
  }
});

test("ordinary tests resolve bare Provider commands only through the repository blocker", () => {
  assert.equal(process.env.PATH?.split(delimiter)[0], PROVIDER_BLOCKER_DIRECTORY);
  for (const command of ["codex", "claude"]) {
    const blocked = spawnSync(command, ["--version"], {
      encoding: "utf8",
      env: process.env
    });
    assert.equal(blocked.status, 86, blocked.stderr || blocked.error?.message);
    assert.match(blocked.stderr, /Blocked real .* ordinary Yui test/u);
  }
});

test("an inherited Provider tier label alone cannot bypass the blocker", () => {
  const helper = resolve(import.meta.dirname, "../helpers/scrubSessionEnv.js");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      helper,
      "--input-type=module",
      "--eval",
      "import { delimiter } from 'node:path'; process.stdout.write(process.env.PATH.split(delimiter)[0])"
    ],
    {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        YUI_TEST_TIER: "provider-e2e"
      }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, PROVIDER_BLOCKER_DIRECTORY);
});

test("the explicit opt-out is available only when a dedicated child asks for it", () => {
  const helper = resolve(import.meta.dirname, "../helpers/scrubSessionEnv.js");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      helper,
      "--input-type=module",
      "--eval",
      "process.stdout.write(JSON.stringify({home:process.env.YUI_HOME,run:process.env.YUI_RUN_ID}))"
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        YUI_TEST_KEEP_SESSION_ENV: "1",
        YUI_HOME: "/dedicated/managed-identity-fixture",
        YUI_RUN_ID: "agent-run-dedicated"
      }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    home: "/dedicated/managed-identity-fixture",
    run: "agent-run-dedicated"
  });
});
