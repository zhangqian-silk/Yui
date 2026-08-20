import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GATE_STEPS,
  STANDARD_SYSTEM_PATH,
  assertCleanSourceCheckout,
  buildGateRecord,
  buildHermeticEnvironment,
  createGateDomain,
  isFullSha,
  planGateCheckout,
  recordPathPrefixes,
  shortTmpBase,
  writeHermeticGitConfig
} from "../helpers/gateHermetic.js";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(root) {
  mkdirSync(root, { recursive: true });
  git(["init", "-b", "master"], root);
  git(["config", "user.name", "Yui Gate"], root);
  git(["config", "user.email", "yui-gate@example.invalid"], root);
}

test("buildHermeticEnvironment isolates host paths and sanitizes PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-env-"));
  try {
    const env = buildHermeticEnvironment(root, {
      environment: {
        PATH: process.env.PATH,
        HOME: "/host/home",
        XDG_CONFIG_HOME: "/host/config",
        npm_config_cache: "/host/npm",
        YUI_GATE_SENTINEL: "kept"
      }
    });
    for (const path of [
      env.HOME,
      env.XDG_CONFIG_HOME,
      env.XDG_CACHE_HOME,
      env.XDG_DATA_HOME,
      env.GIT_CONFIG_GLOBAL,
      env.GIT_TEMPLATE_DIR,
      env.TMPDIR,
      env.npm_config_cache
    ]) assert.ok(path.startsWith(root), `${path} must be isolated under ${root}`);
    assert.equal(env.YUI_GATE_SENTINEL, "kept");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    const pathEntries = env.PATH.split(":");
    assert.equal(new Set(pathEntries).size, pathEntries.length);
    for (const standard of STANDARD_SYSTEM_PATH) assert.ok(pathEntries.includes(standard));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildHermeticEnvironment strips Git variables that can redirect the clone", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-git-env-"));
  try {
    const hostile = {
      PATH: process.env.PATH,
      GIT_CONFIG_SYSTEM: "/host/config",
      GIT_CONFIG_PARAMETERS: "host",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/host/hooks",
      GIT_TEMPLATE_DIR: "/host/template",
      GIT_DIR: "/host/.git",
      GIT_WORK_TREE: "/host/work",
      GIT_COMMON_DIR: "/host/common",
      GIT_INDEX_FILE: "/host/index",
      GIT_OBJECT_DIRECTORY: "/host/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/host/alternate"
    };
    const env = buildHermeticEnvironment(root, { environment: hostile });
    for (const name of Object.keys(hostile).filter((name) => name.startsWith("GIT_"))) {
      if (name === "GIT_TEMPLATE_DIR") continue;
      assert.equal(env[name], undefined, `${name} must be stripped`);
    }
    assert.equal(env.GIT_TEMPLATE_DIR, join(root, "git-template"));
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GATE_STEPS keeps process lifecycle E2E isolated inside one strict gate", () => {
  assert.deepEqual(
    GATE_STEPS.map(({ name }) => name),
    ["install", "build", "lint", "test", "test-process-lifecycle", "package-smoke"]
  );
  assert.ok(Object.isFrozen(GATE_STEPS));
  for (const step of GATE_STEPS) {
    assert.ok(Object.isFrozen(step));
    assert.equal(typeof step.command, "string");
  }
  const testStep = GATE_STEPS.find(({ name }) => name === "test");
  assert.match(testStep.command, /scrubSessionEnv\.js/u);
  assert.match(
    testStep.command,
    /grep -v -E 'diagnostic\|storage-upgrade-\.\*-regressions'/u
  );
  assert.match(
    testStep.command,
    /ls test\/core\/\*\.test\.js \| grep -v -F 'test\/core\/session-reconcile-e2e\.test\.js'/u
  );
  assert.doesNotMatch(testStep.command, /TAP|test-reporter|base/u);
  const lifecycleStep = GATE_STEPS.find(({ name }) => name === "test-process-lifecycle");
  assert.match(lifecycleStep.command, /scrubSessionEnv\.js/u);
  assert.match(
    lifecycleStep.command,
    /--test --test-concurrency=1 test\/core\/session-reconcile-e2e\.test\.js/u
  );
  assert.doesNotMatch(lifecycleStep.command, /ls test\/|test-reporter/u);
  const packageStep = GATE_STEPS.find(({ name }) => name === "package-smoke");
  assert.match(packageStep.command, /assemble-runtime-package\.mjs/u);
  assert.match(packageStep.command, /check-runtime-package-structure\.mjs package-smoke\.json/u);
  assert.doesNotMatch(packageStep.command, /\|\s*node scripts\/check-runtime-package-structure/u);
});

function fakeHermetic(root) {
  return {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: join(root, "git-template"),
    TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"),
    PATH: "/tool/bin:/usr/bin:/bin"
  };
}

test("buildGateRecord is immutable and any failed current step fails the record", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-record-"));
  try {
    const pass = buildGateRecord({
      sha: "a".repeat(40),
      ref: "HEAD",
      checks: [{ name: "test", status: "pass", durationMs: 10 }],
      hermetic: fakeHermetic(root),
      npmVersion: "10.0.0",
      now: () => new Date("2026-08-20T00:00:00.000Z")
    });
    assert.equal(pass.result, "pass");
    assert.equal(pass.timestamp, "2026-08-20T00:00:00.000Z");
    assert.equal(pass.npm, "10.0.0");
    assert.ok(Object.isFrozen(pass));
    assert.ok(Object.isFrozen(pass.checks[0]));

    const fail = buildGateRecord({
      sha: "b".repeat(40),
      ref: "HEAD",
      checks: [
        { name: "build", status: "pass", durationMs: 1 },
        { name: "test", status: "fail", durationMs: 2 }
      ],
      hermetic: fakeHermetic(root),
      npmVersion: "10.0.0"
    });
    assert.equal(fail.result, "fail");
    assert.equal("classification" in fail, false);
    assert.equal("base" in fail, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createGateDomain creates one isolated writable domain", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-domain-"));
  const gateTmp = mkdtempSync(join(shortTmpBase(), "yui-gate-domain-tmp-"));
  const npmCache = join(root, "explicit-cache");
  try {
    const env = createGateDomain(root, gateTmp, { npmCache });
    assert.equal(env.TMPDIR, gateTmp);
    assert.equal(env.npm_config_cache, npmCache);
    for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.GIT_TEMPLATE_DIR, npmCache]) {
      assert.equal(existsSync(path), true, `${path} must exist`);
    }
    assert.match(readFileSync(env.GIT_CONFIG_GLOBAL, "utf8"), /Yui Gate/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(gateTmp, { recursive: true, force: true });
  }
});

test("writeHermeticGitConfig writes only the gate identity", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-config-"));
  try {
    const path = join(root, "gitconfig");
    writeHermeticGitConfig(path);
    assert.equal(
      readFileSync(path, "utf8"),
      "[user]\n\tname = Yui Gate\n\temail = yui-gate@example.invalid\n"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shortTmpBase keeps Unix socket paths short", () => {
  for (const platform of ["linux", "darwin"]) {
    const base = shortTmpBase(platform);
    assert.ok(base.length <= 16);
    assert.ok(!base.endsWith("/"));
  }
  assert.equal(shortTmpBase("win32"), tmpdir());
});

test("planGateCheckout uses a detached private clone", () => {
  const plan = planGateCheckout({ root: "/gate", sha: "a".repeat(40), source: "/source" });
  assert.equal(plan.checkout, "/gate/checkout");
  assert.deepEqual(plan.cloneArgs, [
    "clone",
    "--quiet",
    "--no-hardlinks",
    "--no-checkout",
    "/source",
    "/gate/checkout"
  ]);
  assert.deepEqual(plan.detachArgs, ["checkout", "--detach", "--quiet", "a".repeat(40)]);
  assert.ok(Object.isFrozen(plan.cloneArgs));
});

test("the detached clone excludes dirty and untracked source content", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-clone-"));
  try {
    const source = join(root, "source");
    initRepo(source);
    writeFileSync(join(source, "tracked.txt"), "committed\n");
    git(["add", "tracked.txt"], source);
    git(["commit", "-m", "base"], source);
    const sha = git(["rev-parse", "HEAD"], source);
    writeFileSync(join(source, "tracked.txt"), "dirty\n");
    writeFileSync(join(source, "untracked.txt"), "untracked\n");

    const plan = planGateCheckout({ root: join(root, "gate"), sha, source });
    git(plan.cloneArgs, source);
    git(plan.detachArgs, plan.checkout);
    assert.equal(readFileSync(join(plan.checkout, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(existsSync(join(plan.checkout, "untracked.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupRunnerRepo(root) {
  const source = join(root, "source");
  initRepo(source);
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(join(source, "test", "helpers"), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../../scripts/gate-hermetic.mjs", import.meta.url)),
    join(source, "scripts", "gate-hermetic.mjs")
  );
  copyFileSync(
    fileURLToPath(new URL("../helpers/gateHermetic.js", import.meta.url)),
    join(source, "test", "helpers", "gateHermetic.js")
  );
  writeFileSync(join(source, "package.json"), '{"type":"module","private":true}\n');
  git(["add", "-A"], source);
  git(["commit", "-m", "runner"], source);
  return source;
}

test("the runner rejects historical baseline arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-no-base-"));
  try {
    const source = setupRunnerRepo(root);
    const result = spawnSync(
      process.execPath,
      [join(source, "scripts", "gate-hermetic.mjs"), "--base", "HEAD"],
      { cwd: source, encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument: --base/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dirty source cannot produce per-SHA gate evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-dirty-runner-"));
  try {
    const source = setupRunnerRepo(root);
    writeFileSync(join(source, "dirty.txt"), "dirty\n");
    const recordPath = join(root, "record.json");
    const result = spawnSync(
      process.execPath,
      [join(source, "scripts", "gate-hermetic.mjs"), "--record", recordPath],
      { cwd: source, encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dirty/u);
    assert.equal(existsSync(recordPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runner rejects --ref when it is not source HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-ref-"));
  try {
    const source = setupRunnerRepo(root);
    const oldSha = git(["rev-parse", "HEAD"], source);
    writeFileSync(join(source, "next.txt"), "next\n");
    git(["add", "next.txt"], source);
    git(["commit", "-m", "next"], source);
    const result = spawnSync(
      process.execPath,
      [join(source, "scripts", "gate-hermetic.mjs"), "--ref", oldSha],
      { cwd: source, encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /check out the SHA first/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isFullSha accepts only a full lowercase SHA", () => {
  assert.equal(isFullSha("0123456789abcdef0123456789abcdef01234567"), true);
  assert.equal(isFullSha("0123456789abcdef0123456789abcdef0123456"), false);
  assert.equal(isFullSha("0123456789abcdef0123456789abcdef0123456g"), false);
  assert.equal(isFullSha(undefined), false);
});

test("recordPathPrefixes and source cleanliness exempt only the gate output", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-clean-"));
  try {
    initRepo(root);
    writeFileSync(join(root, "tracked.txt"), "committed\n");
    git(["add", "tracked.txt"], root);
    git(["commit", "-m", "base"], root);
    assert.deepEqual(recordPathPrefixes(root, join(root, "out", "record.json")), [
      "out",
      "out/record.json"
    ]);
    assert.deepEqual(recordPathPrefixes(root, "-"), []);
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "record.json"), "{}\n");
    assertCleanSourceCheckout(root, { except: ["out", "out/record.json"] });
    writeFileSync(join(root, "scratch.txt"), "scratch\n");
    assert.throws(() => assertCleanSourceCheckout(root), /dirty/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
