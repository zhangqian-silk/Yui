import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const RUNNER = fileURLToPath(new URL("../../dist/job/jobRunner.js", import.meta.url));
const HEAD = "0123456789abcdef0123456789abcdef01234567";

/**
 * Isolated artifact + workspace pair per test. Every child process spawned
 * here is tracked so t.after can SIGKILL any survivor and remove the temp dir.
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-durable-runner-"));
  const artifactDir = join(root, "artifacts");
  const workspace = join(root, "workspace");
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  const children = [];
  t.after(() => {
    for (const child of children) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, artifactDir, workspace, children };
}

function writeSpec(artifactDir, workspace, steps, overrides = {}) {
  const specPath = join(artifactDir, "spec.json");
  const spec = {
    jobId: "job-1",
    taskId: "task-1",
    workspace,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    steps,
    defaultStepTimeoutMs: 30_000,
    artifactDir,
    head: HEAD,
    ...overrides
  };
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return specPath;
}

/** Spawn the real compiled runner over a spec. */
function spawnRunner(children, specPath) {
  const child = spawn(process.execPath, [RUNNER, specPath], { stdio: "ignore" });
  children.push(child);
  return child;
}

/** Resolve with { code, signal } when the runner process exits. */
function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForFile(path, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await delay(25);
  }
  return false;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("runner happy path executes every step and writes a succeeded exit.json", async (t) => {
  const { artifactDir, workspace, children } = fixture(t);
  const specPath = writeSpec(artifactDir, workspace, [
    { name: "one", command: "echo hello-one" },
    { name: "two", command: "echo hello-two" }
  ]);

  const child = spawnRunner(children, specPath);
  const { code } = await waitForExit(child);
  assert.equal(code, 0);

  const exit = readJson(join(artifactDir, "exit.json"));
  assert.equal(exit.outcome, "succeeded");
  assert.equal(exit.steps.length, 2);
  assert.ok(existsSync(join(artifactDir, "checkpoint.json")));
  const log = readFileSync(join(artifactDir, "logs", "001-one.log"), "utf8");
  assert.match(log, /hello-one/);
});

test("runner stops at the first failing step and records the failure", async (t) => {
  const { artifactDir, workspace, children } = fixture(t);
  const markerA = join(workspace, "marker-a");
  const markerB = join(workspace, "marker-b");
  const specPath = writeSpec(artifactDir, workspace, [
    { name: "make-a", command: `touch ${JSON.stringify(markerA)}` },
    { name: "boom", command: "exit 7" },
    { name: "make-b", command: `touch ${JSON.stringify(markerB)}` }
  ]);

  const child = spawnRunner(children, specPath);
  await waitForExit(child);

  const exit = readJson(join(artifactDir, "exit.json"));
  assert.equal(exit.outcome, "failed");
  assert.equal(exit.failedStep, "boom");
  assert.equal(exit.exitCode, 7);
  assert.equal(exit.steps.length, 2);
  assert.ok(existsSync(markerA), "step before the failure should have run");
  assert.ok(!existsSync(markerB), "step after the failure must not run");
});

test("runner enforces a per-step timeout", async (t) => {
  const { artifactDir, workspace, children } = fixture(t);
  const specPath = writeSpec(artifactDir, workspace, [
    { name: "slow", command: "sleep 30", timeoutMs: 300 }
  ]);

  const startedAt = Date.now();
  const child = spawnRunner(children, specPath);
  await waitForExit(child);
  const elapsed = Date.now() - startedAt;

  const exit = readJson(join(artifactDir, "exit.json"));
  assert.equal(exit.outcome, "timed-out");
  assert.equal(exit.steps.length, 1);
  assert.equal(exit.steps[0].timedOut, true);
  assert.ok(elapsed < 10_000, `timeout should abort well before the sleep (elapsed=${elapsed}ms)`);
});

test("runner observes the cancel fence between steps", async (t) => {
  const { artifactDir, workspace, children } = fixture(t);
  const forbidden = join(workspace, "should-not-exist");
  const specPath = writeSpec(artifactDir, workspace, [
    { name: "first", command: "sleep 2" },
    { name: "second", command: `touch ${JSON.stringify(forbidden)}` }
  ]);

  const child = spawnRunner(children, specPath);
  // Drop the cancel fence once step 1 (sleep 2) is already running, so step 1
  // completes and the runner observes the fence at the between-step boundary.
  await delay(500);
  writeFileSync(join(artifactDir, "cancel"), "");
  await waitForExit(child);

  const exit = readJson(join(artifactDir, "exit.json"));
  assert.equal(exit.outcome, "cancelled");
  assert.equal(exit.steps.length, 1);
  assert.ok(!existsSync(forbidden), "the step after the fence must not run");
});

test("runner exits cleanly as cancelled on SIGTERM", async (t) => {
  const { artifactDir, workspace, children } = fixture(t);
  const specPath = writeSpec(artifactDir, workspace, [
    { name: "long", command: "sleep 30" }
  ]);

  const child = spawnRunner(children, specPath);
  await delay(500);
  child.kill("SIGTERM");
  const { code } = await waitForExit(child);
  assert.equal(code, 0);

  assert.ok(await waitForFile(join(artifactDir, "exit.json")));
  const exit = readJson(join(artifactDir, "exit.json"));
  assert.equal(exit.outcome, "cancelled");
});

test("SIGKILL mid-step leaves a partial checkpoint and no exit.json", async (t) => {
  const { artifactDir, workspace, children } = fixture(t);
  // A fast first step completes (writing checkpoint.json), then a long second
  // step is hard-killed mid-run. This is exactly the partial-evidence state the
  // supervisor ladder consumes: a checkpoint covering some but not all steps,
  // with no terminal exit.json.
  const specPath = writeSpec(artifactDir, workspace, [
    { name: "quick", command: "echo warm" },
    { name: "long", command: "sleep 30" }
  ]);

  const child = spawnRunner(children, specPath);
  // Wait until the first step has completed and its checkpoint is on disk.
  assert.ok(
    await waitForFile(join(artifactDir, "checkpoint.json")),
    "checkpoint.json should exist after the first step completes"
  );
  child.kill("SIGKILL");
  const { signal } = await waitForExit(child);
  assert.equal(signal, "SIGKILL");

  // A hard kill cannot flush a terminal artifact.
  assert.ok(!existsSync(join(artifactDir, "exit.json")), "SIGKILL must not produce exit.json");
  // The checkpoint records only the completed first step; the killed step never
  // reached the checkpoint write that follows step completion.
  const checkpoint = readJson(join(artifactDir, "checkpoint.json"));
  assert.equal(checkpoint.completedSteps.length, 1);
  assert.equal(checkpoint.completedSteps[0].name, "quick");
});

test("f2: repeated SIGTERM during drain does not bypass the graceful exit.json write", async (t) => {
  const { artifactDir, workspace, children } = fixture(t);
  const specPath = writeSpec(artifactDir, workspace, [
    { name: "long", command: "sleep 30" }
  ]);

  const child = spawnRunner(children, specPath);
  await delay(500);

  // First SIGTERM sets the cancelled flag and kills the step.
  child.kill("SIGTERM");
  // A second SIGTERM (supervisor re-send, stale-heartbeat escalation, or a
  // second operator cancel) must NOT bypass the graceful exit.json write.
  // The idempotent handler ignores it.
  child.kill("SIGTERM");

  const { code, signal } = await waitForExit(child);
  assert.equal(code, 0, "runner must exit cleanly after repeated SIGTERM");
  assert.equal(signal, null, "runner must not be killed by signal");

  assert.ok(await waitForFile(join(artifactDir, "exit.json")));
  const exit = readJson(join(artifactDir, "exit.json"));
  assert.equal(exit.outcome, "cancelled");
});
