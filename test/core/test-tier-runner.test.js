import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const UNIT_FILES_USED_BY_THE_OLD_RUNNER = [
  "test/core/test-tier-contract.test.js",
  "test/core/isolation-preflight.test.js",
  "test/core/test-evidence-report.test.js",
  "test/core/fenced-cleanup.test.js",
  "test/core/scrub-session-env.test.js",
  "test/core/ensure-build.test.js",
  "test/core/mock-agent-protocol.test.js"
];

function copy(root, relativePath) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(repoRoot, relativePath), destination);
}

function createRunnerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-tier-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const path of [
    "scripts/run-test-tier.mjs",
    "test/helpers/ensureBuild.js",
    "test/helpers/scrubSessionEnv.js",
    "test/helpers/testTiers.js",
    "test/helpers/provider-blockers/codex",
    "test/helpers/provider-blockers/claude"
  ]) copy(root, path);

  // Newer runners resolve manifests through this seam. The old runner ignores
  // it, so the fixture also creates its seven historical unit paths below.
  writeFileSync(join(root, "test/helpers/testTierManifest.js"), `
import { join } from "node:path";
export function resolveTierTestPlan(tierId, repoRoot) {
  if (tierId !== "unit") return { files: [], labels: [], environment: {} };
  return {
    files: [join(repoRoot, "test/core/test-tier-contract.test.js")],
    labels: ["test/core/test-tier-contract.test.js"],
    environment: {}
  };
}
`);

  for (const relativePath of UNIT_FILES_USED_BY_THE_OLD_RUNNER) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// intentionally empty fixture module\n");
  }

  const probeName = "tier runner executes freshly built source with a real name pattern";
  const probeRan = join(root, "probe-ran.txt");
  writeFileSync(join(root, "test/core/test-tier-contract.test.js"), `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { value } from "../../dist/value.js";
test(${JSON.stringify(probeName)}, () => {
  assert.equal(value, "fresh");
  assert.equal(process.env.YUI_HOME, undefined);
  assert.equal(process.env.YUI_RUN_ID, undefined);
  writeFileSync(process.env.PROBE_RAN_FILE, value);
});
`);

  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist/agent"), { recursive: true });
  writeFileSync(join(root, "src/value.js"), "export const value = 'fresh';\n");
  writeFileSync(join(root, "dist/value.js"), "export const value = 'stale';\n");
  writeFileSync(join(root, "dist/cli.js"), "// stale marker that must not bypass build\n");
  writeFileSync(
    join(root, "dist/agent/managedRuntimeEnvironment.js"),
    "export const YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES = ['YUI_HOME', 'YUI_RUN_ID'];\n"
  );
  writeFileSync(join(root, "scripts/build-fixture.mjs"), `
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync(new URL("../dist/agent/", import.meta.url), { recursive: true });
copyFileSync(new URL("../src/value.js", import.meta.url), new URL("../dist/value.js", import.meta.url));
writeFileSync(new URL("../dist/cli.js", import.meta.url), "// freshly built\\n");
writeFileSync(
  new URL("../dist/agent/managedRuntimeEnvironment.js", import.meta.url),
  "export const YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES = ['YUI_HOME', 'YUI_RUN_ID'];\\n"
);
`);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "yui-tier-runner-fixture",
    private: true,
    type: "module",
    scripts: { build: "node scripts/build-fixture.mjs" }
  }, null, 2));

  return { root, probeName, probeRan };
}

test("real tier command rebuilds stale dist and consumes `--` before node:test options", (t) => {
  const fixture = createRunnerFixture(t);
  const environment = {
    PATH: process.env.PATH,
    PROBE_RAN_FILE: fixture.probeRan,
    // A managed launch and even an inherited opt-out must not reach the
    // ordinary tier test child.
    YUI_HOME: "/shared/managed/home",
    YUI_RUN_ID: "agent-run-shared",
    YUI_TEST_KEEP_SESSION_ENV: "1"
  };
  const scrubbedEnvironment = { ...environment };
  delete scrubbedEnvironment.YUI_TEST_KEEP_SESSION_ENV;

  const stale = spawnSync(
    process.execPath,
    [
      "--import",
      join(fixture.root, "test/helpers/scrubSessionEnv.js"),
      "--test",
      "--test-name-pattern",
      fixture.probeName,
      join(fixture.root, "test/core/test-tier-contract.test.js")
    ],
    { cwd: fixture.root, encoding: "utf8", env: scrubbedEnvironment }
  );
  assert.notEqual(stale.status, 0, "the fixture must prove the checked-in dist is stale first");
  assert.equal(existsSync(fixture.probeRan), false, "the stale probe must not claim it ran green");

  const green = spawnSync(
    process.execPath,
    [
      join(fixture.root, "scripts/run-test-tier.mjs"),
      "unit",
      "--",
      "--test-name-pattern",
      fixture.probeName
    ],
    { cwd: fixture.root, encoding: "utf8", env: environment }
  );

  assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`);
  assert.equal(readFileSync(fixture.probeRan, "utf8"), "fresh");
  assert.match(green.stdout, new RegExp(fixture.probeName));
  assert.doesNotMatch(green.stdout + green.stderr, /Could not find .*--test-name-pattern/);
});
