import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GATE_STEPS,
  STANDARD_SYSTEM_PATH,
  TEST_STEP_TAP_BASENAME,
  assertCleanSourceCheckout,
  buildCombinedGateRecord,
  buildGateRecord,
  buildHermeticEnvironment,
  classifyGateResults,
  gateDisposition,
  gateExitCode,
  isFullSha,
  parseTapFailureFingerprints,
  planCandidateCheckout,
  recordPathPrefixes,
  resolveMergeBase,
  resolveToolDirectory,
  shortTmpBase,
  writeHermeticGitConfig
} from "../helpers/gateHermetic.js";

const FAKE_ENV = Object.freeze({
  PATH: "/tool/bin:/usr/bin:/bin",
  HOME: "/real/home",
  YUI_GATE_TEST_SENTINEL: "sentinel-value",
  npm_config_cache: "/real/npm-cache"
});

test("buildHermeticEnvironment isolates every host-leaking path under the root", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-env-"));
  try {
    const env = buildHermeticEnvironment(root, { environment: FAKE_ENV });
    assert.equal(env.HOME, join(root, "home"));
    assert.equal(env.XDG_CONFIG_HOME, join(root, "xdg-config"));
    assert.equal(env.XDG_CACHE_HOME, join(root, "xdg-cache"));
    assert.equal(env.XDG_DATA_HOME, join(root, "xdg-data"));
    assert.equal(env.GIT_CONFIG_GLOBAL, join(root, "gitconfig"));
    assert.equal(env.TMPDIR, join(root, "tmp"));
    assert.equal(env.npm_config_cache, join(root, "npm-cache"));
    // Every isolated path lives under the gate root.
    for (const value of [
      env.HOME,
      env.XDG_CONFIG_HOME,
      env.XDG_CACHE_HOME,
      env.XDG_DATA_HOME,
      env.GIT_CONFIG_GLOBAL,
      env.TMPDIR,
      env.npm_config_cache
    ]) {
      assert.ok(value.startsWith(root), `${value} escapes the gate root`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildHermeticEnvironment sanitizes PATH: tool dirs first, then system dirs, de-duplicated", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-path-"));
  try {
    const env = buildHermeticEnvironment(root, { environment: process.env });
    const entries = env.PATH.split(delimiter);
    // No duplicates.
    assert.equal(new Set(entries).size, entries.length, "PATH must be de-duplicated");
    // The exact contract: resolved tool dirs in tool order, then the standard
    // system dirs, with earlier entries winning (a system dir that is also a
    // tool dir stays in the tool prefix).
    const toolDirs = ["node", "npm", "git", "tmux"]
      .map((name) => resolveToolDirectory(name, process.env))
      .filter((dir) => dir !== null);
    const expected = [...new Set([...toolDirs, ...STANDARD_SYSTEM_PATH])];
    assert.deepEqual(entries, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildHermeticEnvironment inherits unrelated host vars and honors overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-inherit-"));
  try {
    const env = buildHermeticEnvironment(root, {
      environment: FAKE_ENV,
      npmCache: "/custom/npm-cache",
      tmpdir: "/custom/tmp"
    });
    // Unrelated host vars are inherited.
    assert.equal(env.YUI_GATE_TEST_SENTINEL, "sentinel-value");
    // Explicit overrides win over the derived defaults.
    assert.equal(env.npm_config_cache, "/custom/npm-cache");
    assert.equal(env.TMPDIR, "/custom/tmp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GATE_STEPS is the ordered install/build/lint/test/package-smoke gate", () => {
  assert.deepEqual(
    GATE_STEPS.map((step) => step.name),
    ["install", "build", "lint", "test", "package-smoke"]
  );
  for (const step of GATE_STEPS) {
    assert.equal(typeof step.command, "string");
    assert.ok(step.command.length > 0, `step ${step.name} must have a command`);
    assert.ok(Object.isFrozen(step), `step ${step.name} must be frozen`);
  }
  assert.ok(Object.isFrozen(GATE_STEPS));
  const smoke = GATE_STEPS.find((step) => step.name === "package-smoke");
  assert.match(smoke.command, /assemble-runtime-package\.mjs/);
  assert.match(smoke.command, /npm pack/);
  assert.match(smoke.command, /check-runtime-package-structure\.mjs/);
  // The pack manifest goes through a file: readFileSync on a pipe is racy
  // with npm as the producer (EAGAIN), so the gate never pipes npm pack into
  // the checker.
  assert.match(smoke.command, /check-runtime-package-structure\.mjs package-smoke\.json/);
  assert.doesNotMatch(smoke.command, /\|\s*node scripts\/check-runtime-package-structure/u);
  // The test step streams TAP to a named file so the runner can parse stable
  // failing-test fingerprints, while the live spec reporter still streams to
  // stdout. The TAP destination lives under the gate TMPDIR, not the checkout.
  const testStep = GATE_STEPS.find((step) => step.name === "test");
  assert.equal(testStep.tapDestination, TEST_STEP_TAP_BASENAME);
  assert.match(testStep.command, /--test-reporter=tap/);
  assert.match(testStep.command, new RegExp(`--test-reporter-destination="\\$TMPDIR/${TEST_STEP_TAP_BASENAME}"`));
  assert.match(testStep.command, /--test-reporter=spec/);
  for (const other of GATE_STEPS) {
    if (other.name !== "test") {
      assert.equal(other.tapDestination, undefined, `${other.name} has no TAP destination`);
    }
  }
});

function fakeHermetic(root) {
  return {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"),
    PATH: "/tool/bin:/usr/bin:/bin"
  };
}

test("buildGateRecord passes only when every check passed and is frozen", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-rec-"));
  try {
    const record = buildGateRecord({
      sha: "abc123",
      ref: "abc123",
      checks: [
        { name: "install", status: "pass", durationMs: 10 },
        { name: "build", status: "pass", durationMs: 20 }
      ],
      hermetic: fakeHermetic(root),
      npmVersion: "10.0.0",
      now: () => new Date("2026-08-13T00:00:00.000Z")
    });
    assert.equal(record.sha, "abc123");
    assert.equal(record.result, "pass");
    assert.equal(record.timestamp, "2026-08-13T00:00:00.000Z");
    assert.equal(record.npm, "10.0.0");
    assert.equal(record.node, process.version);
    assert.equal(record.platform, process.platform);
    assert.deepEqual(record.hermetic.pathEntries, ["/tool/bin", "/usr/bin", "/bin"]);
    assert.equal(record.hermetic.home, join(root, "home"));
    assert.ok(Object.isFrozen(record), "the record must be frozen");
    assert.ok(Object.isFrozen(record.checks[0]), "record checks must be frozen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildGateRecord fails when any check failed", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-recf-"));
  try {
    const record = buildGateRecord({
      sha: "def456",
      ref: "def456",
      checks: [
        { name: "install", status: "pass", durationMs: 10 },
        { name: "lint", status: "fail", durationMs: 30 }
      ],
      hermetic: fakeHermetic(root),
      npmVersion: "10.0.0"
    });
    assert.equal(record.result, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function recordFor(sha, statuses) {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-cls-"));
  try {
    return buildGateRecord({
      sha,
      ref: sha,
      checks: statuses.map(([name, status]) => ({ name, status, durationMs: 1 })),
      hermetic: fakeHermetic(root),
      npmVersion: "10.0.0"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("classifyGateResults separates introduced, pre-existing, and fixed checks", () => {
  // A non-test step failing on both sides has no comparable identity, so it
  // is introduced (fail-closed), never silently pre-existing.
  const candidate = recordFor("candidate", [
    ["install", "pass"],
    ["build", "fail"],
    ["lint", "fail"],
    ["test", "pass"]
  ]);
  const base = recordFor("base", [
    ["install", "pass"],
    ["build", "pass"],
    ["lint", "fail"],
    ["test", "fail"]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, ["build", "lint"]);
  assert.deepEqual(classification.preExisting, []);
  assert.deepEqual(classification.fixed, ["test"]);
  assert.ok(Object.isFrozen(classification));
});

test("classifyGateResults treats a check absent on one side as failing there", () => {
  // The candidate dropped the package-smoke step entirely: it must count as a
  // candidate failure (introduced), never as a silent pass.
  const candidate = recordFor("candidate", [["install", "pass"]]);
  const base = recordFor("base", [
    ["install", "pass"],
    ["package-smoke", "pass"]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, ["package-smoke"]);
});

test("writeHermeticGitConfig writes the gate identity", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-gitcfg-"));
  try {
    const path = join(root, "gitconfig");
    writeHermeticGitConfig(path);
    const content = readFileSync(path, "utf8");
    assert.match(content, /name = Yui Gate/);
    assert.match(content, /email = yui-gate@example\.invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shortTmpBase keeps socket paths short on Linux and macOS", () => {
  // Unix domain sockets are capped at 108 chars on Linux; the base must be
  // short enough that a Controller socket under it stays under the limit.
  for (const platform of ["linux", "darwin"]) {
    const base = shortTmpBase(platform);
    assert.ok(base.length <= 16, `${platform} tmp base ${base} is too deep`);
    assert.ok(!base.endsWith("/"), `${platform} tmp base has no trailing slash`);
  }
  // Other platforms fall back to the host tmpdir.
  assert.equal(shortTmpBase("win32"), tmpdir());
});

test("gateExitCode blocks on any unclassified failure and only introduced failures with a base", () => {
  const pass = recordFor("pass", [["install", "pass"]]);
  const fail = recordFor("fail", [["install", "fail"]]);
  assert.equal(gateExitCode(pass), 0);
  assert.equal(gateExitCode(pass, { introduced: [], preExisting: [], fixed: [] }), 0);
  assert.equal(gateExitCode(fail), 1, "an unclassified failure blocks");
  assert.equal(
    gateExitCode(fail, { introduced: ["install"], preExisting: [], fixed: [] }),
    1,
    "an introduced failure blocks"
  );
  assert.equal(
    gateExitCode(fail, { introduced: [], preExisting: ["install"], fixed: [] }),
    0,
    "a pre-existing failure does not block"
  );
});

const SAMPLE_TAP = [
  "TAP version 13",
  "# Subtest: passing test",
  "ok 1 - passing test",
  "  ---",
  "  duration_ms: 0.5",
  "  ...",
  "# Subtest: failing test B",
  "not ok 2 - failing test B",
  "  ---",
  "  duration_ms: 1.1",
  "  location: '/gate/worktree-candidate/test/core/sample.test.js:5:1'",
  "  failureType: 'testCodeFailure'",
  "  error: |-",
  "    Expected values to be strictly equal:",
  "    1 !== 2",
  "  ...",
  "# Subtest: nested suite",
  "    # Subtest: inner failing A",
  "    not ok 1 - inner failing A",
  "      ---",
  "      duration_ms: 0.4",
  "      location: '/gate/worktree-candidate/test/core/sample.test.js:9:11'",
  "      ...",
  "not ok 3 - nested suite",
  "  ---",
  "  duration_ms: 2.0",
  "  location: '/gate/worktree-candidate/test/core/sample.test.js:8:1'",
  "  failureType: 'subtestsFailed'",
  "  ...",
  "# tests 3",
  "# pass 1",
  "# fail 2"
].join("\n");

test("parseTapFailureFingerprints extracts stable file-qualified failing-test identities", () => {
  const fingerprints = parseTapFailureFingerprints(SAMPLE_TAP, {
    checkout: "/gate/worktree-candidate"
  });
  assert.deepEqual(fingerprints, [
    "test/core/sample.test.js > failing test B",
    "test/core/sample.test.js > nested suite",
    "test/core/sample.test.js > nested suite > inner failing A"
  ]);
});

test("parseTapFailureFingerprints is stable across different worktree paths", () => {
  // The base and the candidate gate in different worktrees; the same failing
  // test must produce the same fingerprint on both sides.
  const baseTap = SAMPLE_TAP.replaceAll("/gate/worktree-candidate", "/gate/worktree-base");
  const base = parseTapFailureFingerprints(baseTap, { checkout: "/gate/worktree-base" });
  const candidate = parseTapFailureFingerprints(SAMPLE_TAP, {
    checkout: "/gate/worktree-candidate"
  });
  assert.deepEqual(base, candidate);
});

test("parseTapFailureFingerprints distinguishes same-named tests in different files", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: shared name",
    "not ok 1 - shared name",
    "  ---",
    "  location: '/gate/w/test/core/a.test.js:3:1'",
    "  ...",
    "# Subtest: shared name",
    "not ok 2 - shared name",
    "  ---",
    "  location: '/gate/w/test/core/b.test.js:3:1'",
    "  ..."
  ].join("\n");
  const fingerprints = parseTapFailureFingerprints(tap, { checkout: "/gate/w" });
  assert.deepEqual(fingerprints, [
    "test/core/a.test.js > shared name",
    "test/core/b.test.js > shared name"
  ]);
});

test("parseTapFailureFingerprints handles results without YAML or location", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: load failure",
    "not ok 1 - load failure",
    "# Subtest: another",
    "not ok 2 - another"
  ].join("\n");
  assert.deepEqual(parseTapFailureFingerprints(tap), ["another", "load failure"]);
});

test("parseTapFailureFingerprints normalizes file-wrapper subtests (file-wrapped TAP layout)", () => {
  // Node 22+ wraps each file's tests under a subtest named with the file path.
  // The wrapper's own `not ok` carries only the file as identity; without a
  // crash diagnostic it contributes no fingerprint (the inner failure does).
  const tap = [
    "TAP version 13",
    "# Subtest: /gate/w/test/core/sample.test.js",
    "    # Subtest: failing test B",
    "    not ok 1 - failing test B",
    "      ---",
    "      location: '/gate/w/test/core/sample.test.js:5:1'",
    "      ...",
    "not ok 1 - /gate/w/test/core/sample.test.js",
    "  ---",
    "  duration_ms: 1.0",
    "  ..."
  ].join("\n");
  const fingerprints = parseTapFailureFingerprints(tap, { checkout: "/gate/w" });
  assert.deepEqual(fingerprints, ["test/core/sample.test.js > failing test B"]);
});

test("parseTapFailureFingerprints gives a file-wrapper crash a diagnostic fingerprint", () => {
  // A test file that crashes before registering tests only produces the
  // file-wrapper `not ok`. The crash error (printed as a TAP comment) is the
  // positive identity: base error A and candidate error B in the same file
  // must produce different fingerprints.
  const crashTap = (checkout, message) =>
    [
      "TAP version 13",
      `# ${checkout}/test/core/crash.test.js:2`,
      `# throw new Error("${message}");`,
      "# ^",
      `# Error: ${message}`,
      `#     at Object.<anonymous> (${checkout}/test/core/crash.test.js:2:7)`,
      "# Node.js v24.19.0",
      `# Subtest: ${checkout}/test/core/crash.test.js`,
      `not ok 1 - ${checkout}/test/core/crash.test.js`,
      "  ---",
      "  duration_ms: 29.5",
      `  location: '${checkout}/test/core/crash.test.js:1:1'`,
      "  failureType: 'testCodeFailure'",
      "  exitCode: 1",
      "  error: 'test failed'",
      "  code: 'ERR_TEST_FAILURE'",
      "  ...",
      "1..1",
      "# fail 1"
    ].join("\n");
  const candidate = parseTapFailureFingerprints(crashTap("/gate/worktree-candidate", "boom-error-A"), {
    checkout: "/gate/worktree-candidate"
  });
  const base = parseTapFailureFingerprints(crashTap("/gate/worktree-base", "boom-error-B"), {
    checkout: "/gate/worktree-base"
  });
  assert.deepEqual(candidate, ["test/core/crash.test.js :: Error: boom-error-A"]);
  assert.deepEqual(base, ["test/core/crash.test.js :: Error: boom-error-B"]);
  assert.notDeepEqual(candidate, base, "A and B in the same file must differ");
});

test("parseTapFailureFingerprints keeps a file-wrapper crash stable across worktrees", () => {
  // The same crash on the base and the candidate must produce the same
  // fingerprint despite the different worktree paths (in the error message).
  const crashTap = (checkout) =>
    [
      "TAP version 13",
      `# Error: Cannot find module '${checkout}/lib/missing.js'`,
      `# Subtest: ${checkout}/test/core/crash.test.js`,
      `not ok 1 - ${checkout}/test/core/crash.test.js`,
      "  ---",
      `  location: '${checkout}/test/core/crash.test.js:1:1'`,
      "  error: 'test failed'",
      "  ..."
    ].join("\n");
  const candidate = parseTapFailureFingerprints(crashTap("/gate/worktree-candidate"), {
    checkout: "/gate/worktree-candidate"
  });
  const base = parseTapFailureFingerprints(crashTap("/gate/worktree-base"), {
    checkout: "/gate/worktree-base"
  });
  assert.deepEqual(candidate, base);
  assert.deepEqual(candidate, [
    "test/core/crash.test.js :: Error: Cannot find module '<checkout>/lib/missing.js'"
  ]);
});

test("parseTapFailureFingerprints fails closed for a file wrapper without a diagnostic", () => {
  // A wrapper `not ok` with no crash comment has no provable identity: it
  // contributes no fingerprint, so the classifier treats the failure as
  // unprovable (introduced).
  const tap = [
    "TAP version 13",
    "# Subtest: /gate/w/test/core/crash.test.js",
    "not ok 1 - /gate/w/test/core/crash.test.js",
    "  ---",
    "  duration_ms: 1.0",
    "  location: '/gate/w/test/core/crash.test.js:1:1'",
    "  error: 'test failed'",
    "  ..."
  ].join("\n");
  assert.deepEqual(parseTapFailureFingerprints(tap, { checkout: "/gate/w" }), []);
});

function recordWithFailures(sha, entries) {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-clsf-"));
  try {
    return buildGateRecord({
      sha,
      ref: sha,
      checks: entries.map(([name, status, failures]) => {
        const check = { name, status, durationMs: 1 };
        if (failures !== undefined) {
          check.failures = failures;
        }
        return check;
      }),
      hermetic: fakeHermetic(root),
      npmVersion: "10.0.0"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("classifyGateResults at failure level: base failure B plus a new candidate failure A is introduced", () => {
  // The P1-2 regression: a whole-step boolean would call both sides
  // test=fail and swallow the new failure A as pre-existing.
  const candidate = recordWithFailures("candidate", [
    ["install", "pass"],
    ["test", "fail", ["test/core/x.test.js > failing A"]]
  ]);
  const base = recordWithFailures("base", [
    ["install", "pass"],
    ["test", "fail", ["test/core/x.test.js > failing B"]]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, ["test: test/core/x.test.js > failing A"]);
  assert.deepEqual(classification.preExisting, []);
  assert.deepEqual(classification.fixed, ["test: test/core/x.test.js > failing B"]);
  assert.equal(gateExitCode(candidate, classification), 1, "the new failure must exit red");
});

test("classifyGateResults at failure level: identical fingerprints on both sides are pre-existing", () => {
  const failures = ["test/core/x.test.js > failing B"];
  const candidate = recordWithFailures("candidate", [
    ["install", "pass"],
    ["test", "fail", failures]
  ]);
  const base = recordWithFailures("base", [
    ["install", "pass"],
    ["test", "fail", failures]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, []);
  assert.deepEqual(classification.preExisting, ["test: test/core/x.test.js > failing B"]);
  assert.deepEqual(classification.fixed, []);
  assert.equal(gateExitCode(candidate, classification), 0, "a proven red base stays green");
});

test("classifyGateResults at failure level: a candidate subset of the base is pre-existing", () => {
  const candidate = recordWithFailures("candidate", [
    ["test", "fail", ["test/core/x.test.js > failing B"]]
  ]);
  const base = recordWithFailures("base", [
    ["test", "fail", ["test/core/x.test.js > failing A", "test/core/x.test.js > failing B"]]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, []);
  assert.deepEqual(classification.preExisting, ["test: test/core/x.test.js > failing B"]);
  assert.deepEqual(classification.fixed, ["test: test/core/x.test.js > failing A"]);
  assert.equal(gateExitCode(candidate, classification), 0);
});

test("classifyGateResults fails closed when a failed test step has no fingerprint data", () => {
  // The test step failed but produced no TAP identity (runner crash, missing
  // file): identity is unprovable, so the failure must be introduced, never
  // swallowed as pre-existing.
  const candidate = recordWithFailures("candidate", [
    ["install", "pass"],
    ["test", "fail", []]
  ]);
  const base = recordWithFailures("base", [
    ["install", "pass"],
    ["test", "fail", ["test/core/x.test.js > failing B"]]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, ["test"]);
  assert.equal(gateExitCode(candidate, classification), 1, "unprovable identity exits red");

  // The mirror case: the base has no fingerprints either.
  const bareCandidate = recordWithFailures("candidate2", [
    ["test", "fail", []]
  ]);
  const bareBase = recordWithFailures("base2", [["test", "fail", []]]);
  const bareClassification = classifyGateResults(bareCandidate, bareBase);
  assert.deepEqual(bareClassification.introduced, ["test"]);
  assert.equal(gateExitCode(bareCandidate, bareClassification), 1);
});

test("classifyGateResults fails closed for a non-test step failing on both sides", () => {
  // install/build/lint/package-smoke carry no stable failure identity: a lint
  // error on the base and a different lint error on the candidate cannot be
  // proven the same, so both-sides failures are introduced (fail-closed),
  // never swallowed as pre-existing.
  const candidate = recordWithFailures("candidate", [
    ["install", "pass"],
    ["lint", "fail"]
  ]);
  const base = recordWithFailures("base", [
    ["install", "pass"],
    ["lint", "fail"]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, ["lint"]);
  assert.deepEqual(classification.preExisting, []);
  assert.equal(gateExitCode(candidate, classification), 1, "an unprovable both-sides failure exits red");
});

test("classifyGateResults at failure level: a file-wrapper crash A on the candidate vs B on the base is introduced", () => {
  // The P1 regression: a file that crashes before registering tests only
  // produces the file-wrapper identity. With the crash diagnostic as the
  // fingerprint, base error B and candidate error A in the same file no
  // longer collide, so the new failure is introduced and exits red.
  const candidate = recordWithFailures("candidate", [
    ["install", "pass"],
    ["test", "fail", ["test/core/crash.test.js :: Error: boom-error-A"]]
  ]);
  const base = recordWithFailures("base", [
    ["install", "pass"],
    ["test", "fail", ["test/core/crash.test.js :: Error: boom-error-B"]]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, ["test: test/core/crash.test.js :: Error: boom-error-A"]);
  assert.deepEqual(classification.preExisting, []);
  assert.deepEqual(classification.fixed, ["test: test/core/crash.test.js :: Error: boom-error-B"]);
  assert.equal(gateExitCode(candidate, classification), 1, "the new crash must exit red");
});

test("classifyGateResults at failure level: the same file-wrapper crash on both sides is pre-existing", () => {
  const failures = ["test/core/crash.test.js :: Error: boom-error-A"];
  const candidate = recordWithFailures("candidate", [
    ["install", "pass"],
    ["test", "fail", failures]
  ]);
  const base = recordWithFailures("base", [
    ["install", "pass"],
    ["test", "fail", failures]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.introduced, []);
  assert.deepEqual(classification.preExisting, ["test: test/core/crash.test.js :: Error: boom-error-A"]);
  assert.equal(gateExitCode(candidate, classification), 0, "a proven red base stays green");
});

test("gateDisposition aligns with the exit code in every case", () => {
  const pass = recordFor("pass", [["install", "pass"]]);
  const fail = recordFor("fail", [["install", "fail"]]);
  assert.equal(gateDisposition(pass), "pass");
  assert.equal(gateDisposition(fail), "unclassified-failure");
  assert.equal(
    gateDisposition(fail, { introduced: ["x"], preExisting: [], fixed: [] }),
    "introduced-failures"
  );
  assert.equal(
    gateDisposition(fail, { introduced: [], preExisting: ["x"], fixed: [] }),
    "pre-existing-only"
  );
});

test("buildCombinedGateRecord keeps top-level sha/result and embeds the full base evidence", () => {
  const candidate = recordWithFailures("candidate-sha", [
    ["install", "pass"],
    ["test", "fail", ["test/core/x.test.js > failing A"]]
  ]);
  const base = recordWithFailures("base-sha", [
    ["install", "pass"],
    ["test", "fail", ["test/core/x.test.js > failing A", "test/core/x.test.js > failing B"]]
  ]);
  const classification = classifyGateResults(candidate, base);
  const combined = buildCombinedGateRecord({
    candidate,
    base,
    baseSha: "base-sha",
    classification,
    now: () => new Date("2026-08-13T00:00:00.000Z")
  });
  // The publish-lane contract: the top-level fields stay the candidate's.
  assert.equal(combined.sha, "candidate-sha");
  assert.equal(combined.result, "fail");
  assert.equal(combined.baseSha, "base-sha");
  assert.equal(combined.candidate, candidate);
  assert.equal(combined.base, base);
  assert.equal(combined.classification, classification);
  assert.equal(combined.disposition, "pre-existing-only");
  assert.equal(combined.timestamp, "2026-08-13T00:00:00.000Z");
  assert.ok(Object.isFrozen(combined));
  // The base evidence is embedded, not referenced by path: nothing must be
  // re-run or deleted to consume the saved record.
  assert.equal(combined.base.checks[1].failures.length, 2);
});

test("planCandidateCheckout always gates a detached worktree, never the source checkout", () => {
  const plan = planCandidateCheckout({ root: "/gate/root", sha: "abc123" });
  assert.equal(plan.sha, "abc123");
  assert.equal(plan.checkout, "/gate/root/worktree-candidate");
  assert.deepEqual(plan.addArgs, [
    "worktree",
    "add",
    "--detach",
    "/gate/root/worktree-candidate",
    "abc123"
  ]);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.addArgs));
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("a dirty checkout cannot gate as HEAD: the candidate worktree excludes uncommitted content", () => {
  // P2-3: the runner always gates `git worktree add --detach <sha>`, so a
  // tracked modification or an untracked file in the source checkout can never
  // enter the gated tree or produce pass evidence labeled with the HEAD SHA.
  const root = mkdtempSync(join(tmpdir(), "yui-gate-dirty-"));
  try {
    const source = join(root, "source");
    mkdirSync(source);
    git(["init", "-b", "master"], source);
    git(["config", "user.name", "Yui Gate"], source);
    git(["config", "user.email", "yui-gate@example.invalid"], source);
    writeFileSync(join(source, "tracked.txt"), "committed content\n");
    git(["add", "tracked.txt"], source);
    git(["commit", "-m", "base"], source);
    const headSha = git(["rev-parse", "HEAD"], source);

    // Dirty the source checkout: a tracked edit plus an untracked file.
    writeFileSync(join(source, "tracked.txt"), "uncommitted fix\n");
    writeFileSync(join(source, "untracked.txt"), "untracked content\n");

    const plan = planCandidateCheckout({ root, sha: headSha });
    git(plan.addArgs, source);
    try {
      // The gated tree is exactly the committed tree at HEAD.
      assert.equal(git(["rev-parse", "HEAD"], plan.checkout), headSha);
      assert.equal(readFileSync(join(plan.checkout, "tracked.txt"), "utf8"), "committed content\n");
      assert.ok(
        !existsSync(join(plan.checkout, "untracked.txt")),
        "untracked content must not enter the gated tree"
      );
      assert.ok(
        !existsSync(join(plan.checkout, "test-gate.tap")),
        "the gated tree stays clean of gate artifacts"
      );
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", plan.checkout], { cwd: source });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupRunnerRepo(root) {
  // Commit the real runner and helper into a fresh repo so a spawned gate
  // process loads the actual code under test.
  const source = join(root, "source");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(join(source, "test", "helpers"), { recursive: true });
  git(["init", "-b", "master"], source);
  git(["config", "user.name", "Yui Gate"], source);
  git(["config", "user.email", "yui-gate@example.invalid"], source);
  copyFileSync(
    fileURLToPath(new URL("../../scripts/gate-hermetic.mjs", import.meta.url)),
    join(source, "scripts", "gate-hermetic.mjs")
  );
  copyFileSync(
    fileURLToPath(new URL("../helpers/gateHermetic.js", import.meta.url)),
    join(source, "test", "helpers", "gateHermetic.js")
  );
  git(["add", "scripts/gate-hermetic.mjs", "test/helpers/gateHermetic.js"], source);
  git(["commit", "-m", "gate runner"], source);
  return source;
}

test("a dirty source checkout cannot produce gate evidence (e2e dirty-runner)", () => {
  // P2-2: the runner and helper are loaded from the caller's checkout, so a
  // dirty checkout could run modified code and label its result with the HEAD
  // SHA. The gate must fail-closed before gating and write no pass record.
  const root = mkdtempSync(join(tmpdir(), "yui-gate-dirty-runner-"));
  try {
    const source = setupRunnerRepo(root);
    const headSha = git(["rev-parse", "HEAD"], source);

    // Dirty a tracked file (the helper, like the reviewer's GATE_STEPS edit):
    // a behavior-changing uncommitted edit that would alter the gate if it ran.
    const helperPath = join(source, "test", "helpers", "gateHermetic.js");
    const original = readFileSync(helperPath, "utf8");
    writeFileSync(
      helperPath,
      original.replace("yui-gate@example.invalid", "attacker@example.invalid")
    );

    const recordPath = join(root, "record.json");
    const result = spawnSync(
      process.execPath,
      [join(source, "scripts", "gate-hermetic.mjs"), "--record", recordPath],
      { cwd: source, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, "a dirty source checkout must fail-closed");
    assert.match(result.stderr, /dirty/u, "the failure must name the dirty checkout");
    // No pass record labeled with the HEAD SHA.
    if (existsSync(recordPath)) {
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.notEqual(record.result, "pass", "a dirty checkout must not produce pass evidence");
      assert.notEqual(record.sha, headSha, "a dirty checkout must not label evidence with HEAD");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner rejects an unresolvable --base-ref before gating (e2e)", () => {
  // P2-1: an empty merge base (shallow checkout, missing ref) must exit before
  // the candidate is gated, so an empty SHA can never reach a record.
  const root = mkdtempSync(join(tmpdir(), "yui-gate-baseref-"));
  try {
    const source = setupRunnerRepo(root);
    const recordPath = join(root, "record.json");
    const result = spawnSync(
      process.execPath,
      [
        join(source, "scripts", "gate-hermetic.mjs"),
        "--base-ref",
        "refs/does-not-exist",
        "--record",
        recordPath
      ],
      { cwd: source, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, "an unresolvable base ref must fail-closed");
    assert.match(result.stderr, /merge base/u, "the failure must name the merge-base resolution");
    assert.ok(!existsSync(recordPath), "no record may be written when the base cannot be resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMergeBase fails closed on a shallow graph and resolves on a full graph", () => {
  // P2-1: actions/checkout defaults to fetch-depth=1, so a PR's synthetic
  // merge commit has no common ancestor with the base branch: `git merge-base`
  // exits non-zero with empty output. The gate must treat that as "no provable
  // base" (null), never as an empty SHA.
  const root = mkdtempSync(join(tmpdir(), "yui-gate-shallow-"));
  try {
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(["init", "-b", "master"], origin);
    git(["config", "user.name", "Yui Gate"], origin);
    git(["config", "user.email", "yui-gate@example.invalid"], origin);
    writeFileSync(join(origin, "f.txt"), "a\n");
    git(["add", "f.txt"], origin);
    git(["commit", "-m", "A"], origin);
    const aSha = git(["rev-parse", "HEAD"], origin);
    writeFileSync(join(origin, "f.txt"), "ab\n");
    git(["add", "f.txt"], origin);
    git(["commit", "-m", "B"], origin);
    writeFileSync(join(origin, "f.txt"), "abc\n");
    git(["add", "f.txt"], origin);
    git(["commit", "-m", "C"], origin);
    git(["branch", "feat", aSha], origin);
    git(["checkout", "feat"], origin);
    writeFileSync(join(origin, "f.txt"), "ad\n");
    git(["add", "f.txt"], origin);
    git(["commit", "-m", "D"], origin);
    git(["checkout", "master"], origin);

    // Full graph: the merge base of master and feat is A.
    assert.equal(resolveMergeBase(origin, "feat"), aSha);

    // Shallow clone: depth 1 fetches only C (master) and only D (feat); their
    // common ancestor A is absent, so merge-base cannot resolve.
    const shallow = join(root, "shallow");
    execFileSync(
      "git",
      ["clone", "--depth=1", "--branch", "master", origin, shallow],
      { stdio: "ignore" }
    );
    execFileSync("git", ["fetch", "--depth=1", "origin", "feat"], {
      cwd: shallow,
      stdio: "ignore"
    });
    assert.equal(resolveMergeBase(shallow, "FETCH_HEAD"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isFullSha accepts only full 40-hex commit SHAs", () => {
  assert.equal(isFullSha("0123456789abcdef0123456789abcdef01234567"), true);
  assert.equal(isFullSha("0123456789abcdef0123456789abcdef0123456"), false, "too short");
  assert.equal(isFullSha("0123456789abcdef0123456789abcdef012345678"), false, "too long");
  assert.equal(isFullSha("0123456789abcdef0123456789abcdef0123456g"), false, "non-hex");
  assert.equal(isFullSha(""), false, "empty");
  assert.equal(isFullSha(undefined), false);
});

test("recordPathPrefixes lists the record and its ancestor directories", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-recprefix-"));
  try {
    assert.deepEqual(recordPathPrefixes(root, join(root, "out", "record.json")), [
      "out",
      "out/record.json"
    ]);
    assert.deepEqual(recordPathPrefixes(root, join(root, "gate-record.json")), ["gate-record.json"]);
    assert.deepEqual(recordPathPrefixes(root, "-"), []);
    // A record outside the checkout is not exempted (it never shows in status).
    assert.deepEqual(recordPathPrefixes(root, join(tmpdir(), "elsewhere.json")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertCleanSourceCheckout passes clean and refuses dirty, exempting the gate record", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-clean-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(["init", "-b", "master"], repo);
    git(["config", "user.name", "Yui Gate"], repo);
    git(["config", "user.email", "yui-gate@example.invalid"], repo);
    writeFileSync(join(repo, "tracked.txt"), "committed\n");
    git(["add", "tracked.txt"], repo);
    git(["commit", "-m", "base"], repo);

    // A clean checkout passes.
    assertCleanSourceCheckout(repo);

    // The gate's own record output is exempted.
    writeFileSync(join(repo, "gate-record.json"), "{}\n");
    assertCleanSourceCheckout(repo, { except: ["gate-record.json"] });

    // A tracked edit is refused.
    writeFileSync(join(repo, "tracked.txt"), "uncommitted\n");
    assert.throws(() => assertCleanSourceCheckout(repo), /dirty/u);

    // An untracked file that is not exempted is refused.
    writeFileSync(join(repo, "tracked.txt"), "committed\n");
    writeFileSync(join(repo, "scratch.txt"), "untracked\n");
    assert.throws(() => assertCleanSourceCheckout(repo), /dirty/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
