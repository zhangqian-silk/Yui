import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createProject, addProjectKnowledge } from "../../dist/repository/project.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { resolveProjectVerificationPlan, verificationPlanDigest } from "../../dist/verification/verificationPlan.js";
import { readHistoricalVerificationPlan } from "../../dist/storage/migrations/verificationPlanV1.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";
import { createGateArtifact, completeGateArtifact } from "../../dist/verification/gateArtifact.js";

test("policy cutover normalizes only active configuration and refuses to relabel an admitted gate", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-policy-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date("2026-09-15T00:00:00Z");
  const plan = { schemaVersion: 1, kind: "verification-plan", id: "checks", version: "1",
    bootstrap: [], l1: { categories: [] }, l2: { steps: [{ name: "check", argv: ["true"] }] } };
  // Independent persisted v2 encoding, not derived from the current contract.
  const oldPlanDigest = "6a91e32a43e087cba908a4c0de0c71b72dc179c1f9245e746f9a280667cb7f84";
  const oldV3Digest = "192269a7f4012881bf8b69adffe75fb0ac0e5c1678812e32fd7016b44f12ef91";
  const store = new SqliteTaskStore(home);
  let project = addProjectKnowledge(createProject("project-1", "Fixture", join(home, "repo"),
    { stable: "main", development: "main" }, at), "knowledge-1", "Checks", JSON.stringify(plan), at);
  project = { ...project, knowledge: [...project.knowledge, {
    ...project.knowledge[0], id: "knowledge-2", status: "retired", body: "historical original body"
  }] };
  const attempt = createIntegrationAttempt({ id: "integration-1", taskId: "task-1", projectId: project.id,
    targetRef: "main", beforeCommit: "a".repeat(40),
    source: { kind: "work-item", workItemId: "work-item-1", startCommit: "a".repeat(40),
      resultCommit: "b".repeat(40), strategy: "ff" } }, at);
  const log = Buffer.from("original successful check");
  const artifact = completeGateArtifact(createGateArtifact({
    projectId: project.id, level: "L2", commit: "b".repeat(40),
    planDigest: oldPlanDigest, toolchainDigest: "d".repeat(64),
    boundary: { targetRef: "main", baseHead: "a".repeat(40) }
  }, { planId: plan.id, planVersion: plan.version, generator: "yui" }, at), [{
    name: "check", command: "true", outcome: "passed", exitCode: 0, signal: null,
    timedOut: false, durationMs: 1, logPath: "check.log",
    logDigest: createHash("sha256").update(log).digest("hex"), logBytes: log.length
  }], "succeeded", at);
  const oldV3Artifact = completeGateArtifact(createGateArtifact({
    projectId: project.id, level: "L2", commit: artifact.commit, planDigest: oldV3Digest,
    toolchainDigest: artifact.toolchainDigest, boundary: artifact.boundary
  }, { planId: plan.id, planVersion: plan.version, generator: "yui" }, at),
  artifact.steps, "succeeded", at);
  try {
    store.saveProject(project);
    store.saveTask(activateTask(createTask("task-1", "Keep admitted checks", at), at));
    store.saveIntegrationAttempt("task-1", attempt);
    store.saveGateArtifact(artifact, new Map([["check", log]]));
    store.saveGateArtifact(oldV3Artifact, new Map([["check", log]]));
  } finally { store.close(); }
  rebuildHistoricalFixture(home, 32);
  const { schemaVersion: _version, ...unversioned } = plan;
  const oldPlan = { ...unversioned, mode: "record" };
  assert.equal(readHistoricalVerificationPlan(oldPlan).mode, "record");
  const db = new Database(join(home, "yui.db"));
  let terminal;
  try {
    db.exec("UPDATE config SET payload=json_set(payload,'$.leaderNextActionMode','enforce','$.leaderSemanticBudgetRuns',5)");
    db.exec("UPDATE gate_artifacts SET payload=json_set(payload,'$.potentialReuseCount',7)");
    const oldProject = { ...project, knowledge: [{ ...project.knowledge[0], body: JSON.stringify(oldPlan) }, project.knowledge[1]] };
    db.prepare("UPDATE projects SET payload=?").run(JSON.stringify(oldProject));
    const { rerunChecks: _rerun, ...old } = attempt;
    db.prepare("UPDATE integration_attempts SET payload=?").run(JSON.stringify({ ...old, gatePlanDigest: "c".repeat(64) }));
    const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const projectBytes = db.prepare("SELECT payload FROM projects").get().payload;
    for (const mode of ["dry-run", "update-preflight"]) {
      const result = await runStorageUpgrade({ home, mode });
      assert.equal(result.outcome, "blocked");
      assert.match(result.message, /task-1\/integration-1/);
      assert.equal(result.sceneUnchanged, true);
    }
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /admitted gate/);
    assert.equal(db.prepare("SELECT payload FROM projects").get().payload, projectBytes);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), before);
    terminal = { ...old, status: "failed", endedAt: at.toISOString(), summary: "Explicitly settled before upgrade" };
    db.prepare("UPDATE integration_attempts SET status='failed',payload=?").run(JSON.stringify(terminal));
    migrateSqliteSchema(db, { mode: "apply" });
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version <= 32 ORDER BY version").all(), before);
  } finally { db.close(); }
  const current = new SqliteTaskStore(home);
  try {
    assert.equal(Object.hasOwn(current.getConfig(), "leaderNextActionMode"), false);
    assert.equal(Object.hasOwn(current.getConfig(), "leaderSemanticBudgetRuns"), false);
    const migrated = current.getProject(project.id);
    assert.equal(migrated.knowledge[1].body, "historical original body");
    const normalized = resolveProjectVerificationPlan(migrated);
    assert.equal(Object.hasOwn(normalized, "mode"), false);
    assert.deepEqual(normalized.l2, plan.l2);
    assert.match(verificationPlanDigest(normalized), /^[a-f0-9]{64}$/);
    assert.notEqual(verificationPlanDigest(normalized), oldPlanDigest);
    assert.notEqual(verificationPlanDigest(normalized), oldV3Digest, "Pre-clean-candidate proof must not become reusable again.");
    assert.equal(current.findGateArtifactByIdentity({
      projectId: project.id, level: artifact.level, commit: artifact.commit,
      planDigest: verificationPlanDigest(normalized), toolchainDigest: artifact.toolchainDigest,
      boundary: artifact.boundary
    }), null, "Old successful evidence must not re-enter the current reuse contract.");
    assert.deepEqual(current.getIntegrationAttempt("task-1", attempt.id), { ...terminal, rerunChecks: false });
    assert.deepEqual(current.getGateArtifact(project.id, artifact.key), artifact);
    assert.deepEqual(current.getGateArtifact(project.id, oldV3Artifact.key), oldV3Artifact);
    assert.deepEqual(current.getGateArtifactLogs(artifact.key).get("check"), log);
    assert.throws(() => current.saveIntegrationAttempt("task-1", { ...terminal, rerunChecks: true }), /immutable/);
    assert.throws(() => current.saveConfig({ ...current.getConfig(), leaderNextActionMode: "display" }), /unknown|unexpected/i);
  } finally { current.close(); }
});
