#!/usr/bin/env node
// Fast, deterministic CI tripwire for Yui's essential local control-plane
// behavior. Keep this list explicit: npm test is the broader on-demand
// diagnostic suite, not a merge gate.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_TEST_FILES = Object.freeze([
  "test/core/agent-driver-registry.test.js",
  "test/core/agent-runtime-observer.test.js",
  "test/core/builtin-agent-drivers.test.js",
  "test/core/core-command-framework.test.js",
  "test/core/core-scheduler.test.js",
  "test/core/core-test-runner.test.js",
  "test/core/mock-agent-protocol.test.js",
  "test/core/provider-acceptance-wiring.test.js",
  "test/core/runtime-event-inbox.test.js",
  "test/core/runtime-observation-projection.test.js",
  "test/core/storage-migration-delivery-gate.test.js",
  "test/core/storage-schema-boundary.test.js",
  "test/core/task-role-runtime-status.test.js",
  "test/core/task-workflow-file-store.test.js",
  "test/restored-file-storage.test.js"
]);

export function runCoreTests(options = {}) {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const environment = { ...(options.environment ?? process.env), NO_COLOR: "1" };
  for (const name of [
    "FORCE_COLOR",
    "YUI_TEST_KEEP_SESSION_ENV",
    "YUI_TEST_TIER",
    "YUI_TEST_PRIVILEGED_MANIFEST"
  ]) delete environment[name];

  return (options.spawn ?? spawnSync)(
    process.execPath,
    [
      "--import",
      "./test/helpers/scrubSessionEnv.js",
      "--test",
      "--test-concurrency=1",
      ...CORE_TEST_FILES
    ],
    { cwd: root, env: environment, stdio: "inherit" }
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runCoreTests();
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}
