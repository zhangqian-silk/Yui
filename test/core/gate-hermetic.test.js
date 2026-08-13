import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  GATE_STEPS,
  STANDARD_SYSTEM_PATH,
  buildGateRecord,
  buildHermeticEnvironment,
  classifyGateResults,
  resolveToolDirectory,
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
