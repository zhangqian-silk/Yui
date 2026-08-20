import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { CORE_TEST_FILES, runCoreTests } from "../../scripts/run-core-tests.mjs";

const root = resolve(import.meta.dirname, "../..");

test("the core suite stays bounded while covering each essential product axis", () => {
  assert.ok(Object.isFrozen(CORE_TEST_FILES));
  assert.ok(CORE_TEST_FILES.length <= 15);
  assert.equal(new Set(CORE_TEST_FILES).size, CORE_TEST_FILES.length);
  assert.ok(CORE_TEST_FILES.every((path) => path.endsWith(".test.js")));
  assert.ok(CORE_TEST_FILES.every((path) => !path.includes("e2e")));
  for (const required of [
    "test/core/agent-runtime-observer.test.js",
    "test/core/builtin-agent-drivers.test.js",
    "test/core/core-command-framework.test.js",
    "test/core/core-scheduler.test.js",
    "test/core/core-test-runner.test.js",
    "test/core/storage-migration-delivery-gate.test.js",
    "test/core/task-workflow-file-store.test.js",
    "test/restored-file-storage.test.js"
  ]) assert.ok(CORE_TEST_FILES.includes(required), `missing core coverage: ${required}`);
});

test("the core runner serializes files and scrubs provider-capable test state", () => {
  let invocation;
  const result = runCoreTests({
    root: "/repo",
    environment: {
      PATH: "/bin",
      FORCE_COLOR: "1",
      YUI_TEST_KEEP_SESSION_ENV: "1",
      YUI_TEST_TIER: "provider-e2e",
      YUI_TEST_PRIVILEGED_MANIFEST: "/real/provider/manifest.json"
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0 };
    }
  });

  assert.equal(result.status, 0);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(0, 4), [
    "--import",
    "./test/helpers/scrubSessionEnv.js",
    "--test",
    "--test-concurrency=1"
  ]);
  assert.deepEqual(invocation.args.slice(4), CORE_TEST_FILES);
  assert.equal(invocation.options.cwd, "/repo");
  assert.equal(invocation.options.env.NO_COLOR, "1");
  for (const name of [
    "FORCE_COLOR",
    "YUI_TEST_KEEP_SESSION_ENV",
    "YUI_TEST_TIER",
    "YUI_TEST_PRIVILEGED_MANIFEST"
  ]) assert.equal(invocation.options.env[name], undefined);
});

test("CI runs only the bounded core suite and package smoke", () => {
  const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /timeout-minutes: 3/u);
  assert.match(workflow, /cache: npm/u);
  assert.match(workflow, /run: npm ci/u);
  assert.match(workflow, /run: npm run test:core/u);
  assert.match(workflow, /check-runtime-package-structure\.mjs package-smoke\.json/u);
  assert.doesNotMatch(workflow, /gate-hermetic|gate-record|upload-artifact/u);
  assert.doesNotMatch(workflow, /npm test|npm run lint|test-process-lifecycle/u);
  assert.doesNotMatch(workflow, /fetch-depth:\s*0/u);
});
