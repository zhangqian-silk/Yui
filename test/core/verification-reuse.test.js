import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { addProjectKnowledge, createProject } from "../../dist/repository/project.js";
import { normalizeVerificationPlan } from "../../dist/verification/verificationPlan.js";
import { resolveVerificationGate, runL1Gate, beginGateVerification, lookupReusableGateArtifact,
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
  const script = `const fs = require("fs"); const p = ${JSON.stringify(join(root, "count"))};
    fs.writeFileSync(p, String((fs.existsSync(p) ? Number(fs.readFileSync(p)) : 0) + 1));
    console.log("actual-check"); process.exit(process.env.CHECK_FAIL === "1" ? 1 : 0);`;
  const check = { name: "check", argv: [process.execPath, "-e", script] };
  const raw = { schemaVersion: 1, kind: "verification-plan", id: "checks", version: "1",
    bootstrap: [], l1: { categories: [
      { id: "code", paths: ["file"], checks: [check] },
      { id: "other", paths: ["other"], checks: [{ ...check, name: "other-check" }] }
    ] },
    l2: { steps: [check] } };
  const project = addProjectKnowledge(createProject("project-1", "Fixture", workspace,
    { stable: "main", development: "main" }, at), "knowledge-1", "Checks", JSON.stringify(raw), at);
  store.saveProject(project);
  const gate = resolveVerificationGate(project);
  return { root, store, workspace, at, gate, raw, count: () => Number(readFileSync(join(root, "count"), "utf8")) };
}

test("explicit rerun reports its failure and invalidates old success; ordinary repetition reuses exact evidence", async t => {
  const f = fixture(t);
  const input = { store: f.store, projectId: "project-1", gate: f.gate, commit: "a".repeat(40),
    changedPaths: ["file"], workspace: f.workspace, environment: { PATH: process.env.PATH },
    logsDirectory: join(f.root, "logs"), now: f.at };
  assert.equal((await runL1Gate(input)).artifact.outcome, "succeeded");
  assert.equal(f.count(), 1);
  const failed = await runL1Gate({ ...input, rerun: true,
    environment: { ...input.environment, CHECK_FAIL: "1" }, now: new Date(f.at.getTime() + 1000) });
  assert.equal(failed.reused, false);
  assert.equal(failed.artifact.outcome, "failed", "This execution must never borrow the old green result.");
  assert.ok(failed.checks.some(check => check.outcome === "failed"));
  const identity = { projectId: failed.artifact.projectId, level: failed.artifact.level, commit: failed.artifact.commit,
    planDigest: failed.artifact.planDigest, toolchainDigest: failed.artifact.toolchainDigest };
  assert.equal(await lookupReusableGateArtifact(f.store, identity), null);
  assert.equal(f.store.getGateArtifact("project-1", failed.artifact.key).outcome, "failed");
  assert.equal((await runL1Gate({ ...input, now: new Date(f.at.getTime() + 2000) })).reused, false);
  const reused = await runL1Gate({ ...input, now: new Date(f.at.getTime() + 3000) });
  assert.equal(reused.reused, true);
  assert.equal(f.count(), 3);
  assert.equal(Object.hasOwn(reused.artifact, "potentialReuseCount"), false);
  const other = await runL1Gate({ ...input, changedPaths: ["other"], now: new Date(f.at.getTime() + 4000) });
  assert.equal(other.reused, false, "Different selected checks cannot reuse one another's L1 evidence.");
  assert.equal(f.count(), 4);
  beginGateVerification(f.store, identity, f.gate.plan, new Date(f.at.getTime() + 5000));
  assert.equal(await lookupReusableGateArtifact(f.store, identity), null, "A fresh execution first withdraws old success.");
  assert.throws(() => touchGateArtifact(f.store,
    recordGateArtifactReuse(reused.artifact, new Date(f.at.getTime() + 5500))), /changed/);
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
  const input = { store: f.store, projectId: "project-1", gate: f.gate, commit: "a".repeat(40),
    changedPaths: ["file"], workspace: f.workspace, environment: { PATH: process.env.PATH },
    logsDirectory: join(f.root, "logs"), now: f.at };
  const first = await runL1Gate(input);
  const sourceLogPath = join(input.logsDirectory, first.artifact.steps[0].logPath);
  const query = { projectId: "project-1", commit: input.commit,
    planDigest: f.gate.planDigest, toolchainDigest: f.gate.toolchainDigest, targetRef: "main" };
  const { targetRef: _target, ...identity } = query;
  const outcome = { name: "gate-1", command: "fixture", exitCode: 0, signal: null,
    timedOut: false, durationMs: 1, sourceLogPath, logName: "gate-1.log" };
  await recordGateArtifactFromStepOutcomes(f.store, { ...identity, level: "L2",
    boundary: { targetRef: "main", baseHead: "b".repeat(40) } }, f.gate.plan, [outcome], true, f.at);
  assert.ok(await findL2ArtifactForCommit(f.store, query));
  const failed = await recordGateArtifactFromStepOutcomes(f.store, { ...identity, level: "L2",
    boundary: { targetRef: "main", baseHead: "c".repeat(40) } }, f.gate.plan,
    [{ ...outcome, exitCode: 1 }], false, new Date(f.at.getTime() + 1000));
  assert.equal(await findL2ArtifactForCommit(f.store, query), null);
  assert.ok(checkResultsFromGateArtifact({ ...first.artifact, status: "incomplete", outcome: "unknown" })
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
