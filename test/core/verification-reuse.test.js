import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { addProjectKnowledge, createProject } from "../../dist/repository/project.js";
import { normalizeVerificationPlan, planL2JobSteps } from "../../dist/verification/verificationPlan.js";
import { resolveVerificationGate, runGateStepsInProcess, beginGateVerification, lookupReusableGateArtifact,
  recordGateArtifactFromStepOutcomes, checkResultsFromGateArtifact } from "../../dist/verification/verificationGateService.js";
import { findL2ArtifactForCommit, touchGateArtifact } from "../../dist/verification/gateArtifactStore.js";
import { recordGateArtifactReuse } from "../../dist/verification/gateArtifact.js";
import { createTask } from "../../dist/task/task.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runTaskNextActionCommand } from "../../dist/commands/taskNextActionCommand.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-verification-reuse-"));
  const store = new SqliteTaskStore(join(root, "home"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const at = new Date("2026-09-15T00:00:00Z");
  const script = 'console.log("actual-check");';
  const check = { name: "check", argv: [process.execPath, "-e", script] };
  const raw = { schemaVersion: 1, kind: "verification-plan", id: "checks", version: "1",
    bootstrap: [], l1: { categories: [] },
    l2: { steps: [check] } };
  const project = addProjectKnowledge(createProject("project-1", "Fixture", workspace,
    { stable: "main", development: "main" }, at), "knowledge-1", "Checks", JSON.stringify(raw), at);
  store.saveProject(project);
  const gate = resolveVerificationGate(project);
  return { root, store, workspace, at, gate, raw };
}

test("incomplete proof, stale reuse and missing logs cannot resurrect a successful artifact", async t => {
  const f = fixture(t);
  const identity = { projectId: "project-1", level: "L2", commit: "a".repeat(40),
    planDigest: f.gate.planDigest, toolchainDigest: f.gate.toolchainDigest,
    boundary: { targetRef: "main", baseHead: "b".repeat(40) } };
  const outcomes = await runGateStepsInProcess(f.workspace, planL2JobSteps(f.gate.plan, f.workspace),
    { PATH: process.env.PATH }, join(f.root, "logs"), identity.commit);
  const artifact = await recordGateArtifactFromStepOutcomes(f.store, identity, f.gate.plan, outcomes, true, f.at);
  assert.equal((await lookupReusableGateArtifact(f.store, identity)).key, artifact.key);
  const reused = recordGateArtifactReuse(artifact, new Date(f.at.getTime() + 1000));
  touchGateArtifact(f.store, reused);
  beginGateVerification(f.store, identity, f.gate.plan, new Date(f.at.getTime() + 2000));
  assert.equal(await lookupReusableGateArtifact(f.store, identity), null, "A fresh execution first withdraws old success.");
  assert.throws(() => touchGateArtifact(f.store,
    recordGateArtifactReuse(reused, new Date(f.at.getTime() + 3000))), /changed/);
  assert.equal(await lookupReusableGateArtifact(f.store, identity), null, "A stale reuse cannot resurrect old success.");
  await assert.rejects(recordGateArtifactFromStepOutcomes(f.store, identity, f.gate.plan, [{
    name: "check", command: "fixture", exitCode: 0, signal: null, timedOut: false, durationMs: 1,
    sourceLogPath: join(f.root, "missing-log"), logName: "missing.log"
  }], true, new Date(f.at.getTime() + 6000)), /ENOENT/);
  assert.equal(await lookupReusableGateArtifact(f.store, identity), null, "Missing logs cannot restore the previous success.");
  assert.throws(() => normalizeVerificationPlan({ ...f.raw, mode: "reuse" }), /mode/i);
  const { schemaVersion: _schema, ...unversioned } = f.raw;
  assert.throws(() => normalizeVerificationPlan(unversioned), /schemaVersion/i);
});

test("release lookup cannot skip a newer failed proof or conceal an incomplete overall outcome", async t => {
  const f = fixture(t);
  const commit = "a".repeat(40);
  const outcomes = await runGateStepsInProcess(f.workspace, planL2JobSteps(f.gate.plan, f.workspace),
    { PATH: process.env.PATH }, join(f.root, "logs"), commit);
  const sourceLogPath = outcomes[0].sourceLogPath;
  const query = { projectId: "project-1", commit,
    planDigest: f.gate.planDigest, toolchainDigest: f.gate.toolchainDigest, targetRef: "main" };
  const { targetRef: _target, ...identity } = query;
  const outcome = { name: "gate-1", command: "fixture", exitCode: 0, signal: null,
    timedOut: false, durationMs: 1, sourceLogPath, logName: "gate-1.log" };
  const first = await recordGateArtifactFromStepOutcomes(f.store, { ...identity, level: "L2",
    boundary: { targetRef: "main", baseHead: "b".repeat(40) } }, f.gate.plan, [outcome], true, f.at);
  assert.ok(await findL2ArtifactForCommit(f.store, query));
  const failed = await recordGateArtifactFromStepOutcomes(f.store, { ...identity, level: "L2",
    boundary: { targetRef: "main", baseHead: "c".repeat(40) } }, f.gate.plan,
    [{ ...outcome, exitCode: 1 }], false, new Date(f.at.getTime() + 1000));
  assert.equal(await findL2ArtifactForCommit(f.store, query), null);
  assert.ok(checkResultsFromGateArtifact({ ...first, status: "incomplete", outcome: "unknown" })
    .some(check => check.outcome === "failed"));
  assert.equal(failed.outcome, "failed");
});

test("overlapping WorkItems remain an advisory read, not a business-operation gate", t => {
  const f = fixture(t);
  f.store.saveTask(createTask("task-1", "Independent work", f.at));
  for (let i = 0; i < 2; i++) {
    runTaskCommand(["work", "create", "task-1", "Same title", "--accept", "same criterion"],
      f.store, { environment: {}, now: () => f.at });
  }
  const revision = f.store.getRevision();
  const result = runTaskNextActionCommand(["task-1", "--json"], f.store);
  const advisory = result.data.orchestration.advisories.find(entry => entry.code === "work-item-scope-overlap");
  assert.ok(advisory, "Matching scope text should be visible as a read-only advisory.");
  assert.equal(advisory.refs.length, 2);
  assert.equal(f.store.getRevision(), revision);
  assert.throws(() => runTaskCommand(["work", "create", "task-1", "Invalid dependency", "--after", "work-item-999"],
    f.store, { environment: {}, now: () => f.at }), /dependency/i);
});
