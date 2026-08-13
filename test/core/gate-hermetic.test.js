import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  GATE_STEPS,
  STANDARD_SYSTEM_PATH,
  TEST_STEP_TAP_BASENAME,
  buildCombinedGateRecord,
  buildGateRecord,
  buildHermeticEnvironment,
  classifyGateResults,
  gateDisposition,
  gateExitCode,
  parseTapFailureFingerprints,
  planCandidateCheckout,
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
  assert.deepEqual(classification.introduced, ["build"]);
  assert.deepEqual(classification.preExisting, ["lint"]);
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
  assert.deepEqual(fingerprints, [
    "test/core/sample.test.js",
    "test/core/sample.test.js > failing test B"
  ]);
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

test("classifyGateResults keeps whole-step identity for the non-test steps", () => {
  const candidate = recordWithFailures("candidate", [
    ["install", "pass"],
    ["lint", "fail"]
  ]);
  const base = recordWithFailures("base", [
    ["install", "pass"],
    ["lint", "fail"]
  ]);
  const classification = classifyGateResults(candidate, base);
  assert.deepEqual(classification.preExisting, ["lint"]);
  assert.equal(gateExitCode(candidate, classification), 0);
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
