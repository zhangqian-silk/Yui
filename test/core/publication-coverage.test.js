import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createProject } from "../../dist/repository/project.js";
import { createTask, activateTask, completeTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { upsertTaskPublication } from "../../dist/commands/taskPublicationCommands.js";
import { runTaskPublicationVerifyCommand } from "../../dist/commands/taskPublicationVerifyCommand.js";
import { projectTaskRemoteDeliveryFromStore, createTaskRemoteDeliveryProof, assertTaskRemoteDeliveryProof } from "../../dist/task/remoteDeliveryService.js";
import { runTaskPublicationAdoptCommand } from "../../dist/commands/taskPublicationAdoptCommand.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { buildWebTaskDetail } from "../../dist/web/webSnapshot.js";
import { readTaskContext } from "../../dist/context/taskContext.js";
import { createPublicationReference } from "../../dist/task/publicationReference.js";
import { createIntegrationAttempt, updateIntegrationAttempt, supersedeIntegration } from "../../dist/integration/integrationAttempt.js";

const now = new Date("2026-09-13T00:00:00Z");
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
}).trim();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-publication-coverage-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@local");
  writeFileSync(join(repo, "feature"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", "task");
  writeFileSync(join(repo, "feature"), "accepted feature\n");
  git(repo, "commit", "-am", "accepted");
  const accepted = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");
  writeFileSync(join(repo, "upstream"), "upstream\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "upstream");
  git(repo, "checkout", "task");
  git(repo, "merge", "--no-edit", "main");
  const candidate = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");
  git(repo, "merge", "--squash", "task");
  git(repo, "commit", "-m", "squash delivery");
  const remote = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "task");
  const store = new SqliteTaskStore(join(root, "home"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.saveProject(createProject("project-1", "app", repo,
    { stable: "main", development: "main" }, now));
  const task = completeTask(activateTask(createTask("task-1", "Deliver accepted feature", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main",
      baseCommit: base, currentCommit: accepted }]
  }), now), now, { by: "user", summary: "Feature accepted" });
  store.saveTask(task);
  const completion = createTaskEvent(store.nextEventId(task.id), task.id, "task.completed", {
    projectHeads: `project-1@${accepted}`, projectBases: `project-1@${base}`
  }, now);
  store.saveEvent(task.id, completion);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: repo,
    entries: [{ projectId: "project-1", directory: "app", access: "write",
      path: repo, branch: "task", baseRef: "main", baseCommit: base }]
  }, now));
  const identity = { projectId: "project-1", provider: "github",
    repository: "fixture/app", externalKind: "pull-request", externalId: "1" };
  const upsert = input => store.transaction(tx => upsertTaskPublication(
    tx, task, { ...identity, ...input }, "user", now
  ).reference);
  const publication = upsert({ localCommit: candidate, state: "merged", remoteCommit: remote });
  const verify = (id, patch = {}) => runTaskPublicationVerifyCommand([task.id, id], store, {
    environment: {}, now: () => now,
    verifiers: { github: { async inspect() {
      return { ...identity, state: "merged", headCommit: candidate,
        remoteCommit: remote, evidence: "isolated provider fixture", ...patch };
    } } }
  });
  const delivery = () => projectTaskRemoteDeliveryFromStore(store, store.getTask(task.id));
  return { store, task, completion, publication, repo, base, accepted, candidate,
    remote, upsert, verify, delivery };
}

test("a merged post-completion candidate is a remote fact, not automatic Task coverage", async t => {
  const f = fixture(t);
  assert.notEqual(f.accepted, f.candidate);
  assert.equal(git(f.repo, "rev-parse", `${f.candidate}^{tree}`),
    git(f.repo, "rev-parse", `${f.remote}^{tree}`));
  const verified = await f.verify(f.publication.id);
  assert.equal(verified.data.publication.verification, "verified");
  const delivery = f.delivery();
  assert.equal(delivery.status, "uncovered");
  assert.equal(delivery.projects[0].state, "merged");
  assert.equal(delivery.integratedCoverageSatisfied, false);
  assert.deepEqual(f.store.listEvents(f.task.id).find(e => e.id === f.completion.id), f.completion);

  const beforeRead = f.store.getStateRevision();
  const candidate = await runTaskPublicationAdoptCommand(
    ["diff", `${f.task.id}/${verified.data.publication.id}`], f.store, { environment: {} });
  assert.match(candidate.data.diff, /upstream/);
  assert.equal(f.store.getStateRevision(), beforeRead, "diff is a local read, not acceptance");
  const adopt = ["adopt", `${f.task.id}/${verified.data.publication.id}`,
    "--reviewed-diff", candidate.data.diffDigest,
    "--acceptance", "Reviewed full delta: only upstream file added; accepted feature is retained."];
  const adopted = await runTaskPublicationAdoptCommand(adopt, f.store, { environment: {} });
  assert.deepEqual((await runTaskPublicationAdoptCommand(adopt, f.store, { environment: {} })).data, adopted.data);
  assert.equal(f.delivery().status, "merged");
  assert.equal(f.delivery().projects[0].expectedLocalCommit, f.accepted);
  assert.equal(f.delivery().projects[0].deliveryLocalCommit, f.candidate);
  assert.equal(f.delivery().integratedCoverageSatisfied, true);

  const metadata = f.upsert({ title: "Updated PR title" });
  assert.equal(f.delivery().projects[0].adoption.id, adopted.data.id, "same-head metadata retains adoption");
  const snapshotRevision = f.store.getStateRevision();
  assert.deepEqual(buildWebTaskDetail(f.store, f.task.id).remoteDelivery, f.delivery());
  assert.deepEqual(readTaskContext(f.store, f.task.id).records.find(r => r.ref.store === "remote-delivery").value,
    f.delivery());
  assert.equal(f.store.getStateRevision(), snapshotRevision);
  const proof = createTaskRemoteDeliveryProof(f.store, f.task);
  const changed = await f.verify(metadata.id, { headCommit: f.base });
  assert.equal(changed.data.publication.verification, "reported");
  assert.equal(f.delivery().projects[0].coverage, "head-mismatch");
  assert.equal(f.delivery().status, "uncovered");
  assert.throws(() => assertTaskRemoteDeliveryProof(f.store, f.task, proof), /evidence changed/);
  await f.verify(changed.data.publication.id);
  assert.equal(f.delivery().integratedCoverageSatisfied, true);

  f.upsert({ localCommit: f.base });
  const restored = f.upsert({ localCommit: f.candidate, state: "merged", remoteCommit: f.remote });
  await f.verify(restored.id);
  assert.equal(f.delivery().projects[0].adoption, null, "changed local lineage cannot revive an old decision");
  const restoredId = f.delivery().projects[0].publication.id;
  // A committed Integration is supporting execution evidence, not acceptance.
  // Its source is the upstream-side increment in the real fixture merge.
  const integration = updateIntegrationAttempt(createIntegrationAttempt({
    id: "integration-1", taskId: f.task.id, projectId: "project-1", targetRef: "task",
    beforeCommit: f.accepted,
    source: { kind: "work-item", workItemId: "work-item-1", startCommit: f.base,
      resultCommit: git(f.repo, "rev-parse", `${f.candidate}^2`), strategy: "merge" }
  }, now), { status: "committed", candidateCommit: f.candidate, afterCommit: f.candidate,
    summary: "Isolated merge of upstream increment", checks: [] }, now);
  f.store.saveIntegrationAttempt(f.task.id, integration);
  assert.equal(f.delivery().integratedCoverageSatisfied, false, "Integration alone does not accept the delta");
  const integratedDiff = await runTaskPublicationAdoptCommand(
    ["diff", `${f.task.id}/${restoredId}`, "--integration", integration.id], f.store);
  const integratedAdopt = ["adopt", `${f.task.id}/${restoredId}`, "--integration", integration.id,
    "--reviewed-diff", integratedDiff.data.diffDigest, "--acceptance", "Same reviewed upstream-only delta."];
  await runTaskPublicationAdoptCommand(integratedAdopt, f.store);
  const integrationProof = createTaskRemoteDeliveryProof(f.store, f.task);
  f.store.saveIntegrationAttempt(f.task.id, supersedeIntegration(integration, "Evidence no longer selected", now));
  assert.equal(f.delivery().integratedCoverageSatisfied, false);
  assert.throws(() => assertTaskRemoteDeliveryProof(f.store, f.task, integrationProof), /evidence changed/);
  // Explicit independent re-adoption may use the still-fixed Git evidence;
  // superseding execution evidence must not silently select another decision.
  await runTaskPublicationAdoptCommand(["adopt", `${f.task.id}/${restoredId}`,
    "--reviewed-diff", integratedDiff.data.diffDigest, "--acceptance", "Independently reviewed exact trees and full upstream-only delta."],
  f.store);
  assert.equal(f.delivery().integratedCoverageSatisfied, true);

  // Cleanup is a distinct, already covered boundary. Remove only the fixture's
  // ownership record to exercise the ordinary archive decision (never force).
  f.store.removeManagedWorkspace({ type: "task", taskId: f.task.id });
  const archived = runTaskCommand(["archive", f.task.id, "--integrated"], f.store, {
    environment: {}, now: () => now,
    archiveRemoteDeliveryProof: createTaskRemoteDeliveryProof(f.store, f.task)
  });
  assert.equal(archived.data.archived, true);
  assert.equal(f.delivery().integratedCoverageSatisfied, true, "frozen evidence survives workspace removal");
  assert.deepEqual(f.store.listEvents(f.task.id).find(e => e.id === f.completion.id), f.completion);
});

test("ancestry, changed candidates and wrong reviewed diffs cannot silently adopt acceptance", async t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "feature"), "base\n");
  writeFileSync(join(f.repo, "unaccepted"), "new unaccepted behavior\n");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-m", "revoke feature and add unaccepted behavior");
  const revoked = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "merge-base", "--is-ancestor", f.accepted, revoked);
  const publication = f.upsert({ localCommit: revoked, state: "merged", remoteCommit: f.remote });
  await f.verify(publication.id, { headCommit: revoked });
  assert.equal(f.delivery().projects[0].coverage, "stale", "ancestry does not prove semantic retention");
  assert.equal(f.delivery().integratedCoverageSatisfied, false);
  const current = f.delivery().projects[0].publication.id;
  const delta = await runTaskPublicationAdoptCommand(["diff", `${f.task.id}/${current}`], f.store);
  assert.match(delta.data.diff, /-accepted feature/);
  assert.match(delta.data.diff, /unaccepted behavior/);
  await assert.rejects(runTaskPublicationAdoptCommand(["adopt", `${f.task.id}/${current}`,
    "--reviewed-diff", "0".repeat(64), "--acceptance", "not the reviewed diff"], f.store), /does not match/);
  await assert.rejects(runTaskPublicationAdoptCommand(["adopt", `${f.task.id}/${current}`,
    "--reviewed-diff", delta.data.diffDigest], f.store), /explicit acceptance/);
  await assert.rejects(runTaskPublicationAdoptCommand(["diff", `${f.task.id}/${f.publication.id}`],
    f.store), /not the current/);
  assert.equal(f.store.listEvents(f.task.id).filter(e => e.type === "publication.candidate-adopted").length, 0);
});

test("exact historical coverage remains valid while multi-Project delivery stays partial", async t => {
  const f = fixture(t);
  // A valid old Publication has no observed-head field or adoption event.
  f.upsert({ localCommit: f.accepted, state: "merged", verification: "verified", remoteCommit: f.remote });
  assert.equal(f.delivery().integratedCoverageSatisfied, true);
  f.store.saveProject(createProject("project-2", "other", f.repo,
    { stable: "main", development: "main" }, now));
  const task = { ...f.task, projectBindings: [...f.task.projectBindings,
    { projectId: "project-2", directory: "other", baseRef: "main", baseCommit: f.base, currentCommit: f.candidate }] };
  f.store.saveTask(task);
  assert.equal(f.delivery().status, "unavailable", "missing historical head cannot be inferred");
  assert.equal(f.delivery().integratedCoverageSatisfied, false);
  // Independent historical completion fixture with exact heads for both Projects.
  const multi = { ...task, id: "task-2" };
  f.store.saveTask(multi);
  f.store.saveEvent(multi.id, createTaskEvent(f.store.nextEventId(multi.id), multi.id, "task.completed", {
    projectHeads: `project-1@${f.accepted},project-2@${f.candidate}`,
    projectBases: `project-1@${f.base},project-2@${f.base}`
  }, now));
  f.store.savePublicationReference(multi.id, createPublicationReference("publication-1", multi.id, {
    projectId: "project-1", provider: "github", repository: "fixture/app", externalKind: "pull-request",
    externalId: "2", localCommit: f.accepted, state: "merged", verification: "verified", remoteCommit: f.remote
  }, now));
  const delivery = projectTaskRemoteDeliveryFromStore(f.store, multi);
  assert.equal(delivery.status, "partial");
  assert.equal(delivery.mergedProjectCount, 1);
  assert.equal(delivery.projects[1].coverage, "missing");
  assert.equal(delivery.integratedCoverageSatisfied, false);
});

test("storage 25 to 26 preserves historical completion and Publication bytes without inferred adoption", () => {
  const db = new Database(":memory:");
  try {
    migrateSqliteSchema(db, { mode: "apply", throughVersion: 25 });
    const publication = createPublicationReference("publication-1", "task-1", {
      projectId: "project-1", provider: "github", repository: "fixture/app", externalKind: "pull-request",
      externalId: "1", localCommit: "a".repeat(40), state: "merged",
      verification: "verified", remoteCommit: "b".repeat(40)
    }, now);
    const original = JSON.stringify(publication);
    db.prepare(`INSERT INTO publication_references
      (task_id, publication_id, project_id, provider, repository, external_kind, external_id,
       external_key, state, verification, local_commit, remote_commit, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "task-1", "publication-1", "project-1", "github", "fixture/app", "pull-request", "1",
      "github/fixture/app/1", "merged", "verified", publication.localCommit, publication.remoteCommit, original,
      now.toISOString());
    const completion = JSON.stringify(createTaskEvent("event-1", "task-1", "task.completed",
      { projectHeads: `project-1@${publication.localCommit}` }, now));
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)").run(
      "task-1", "event-1", "task.completed", now.toISOString(), completion);
    assert.equal(migrateSqliteSchema(db, { mode: "apply", throughVersion: 26 }).applied.length, 1);
    assert.equal(db.prepare("SELECT payload FROM publication_references").get().payload, original);
    assert.deepEqual(db.prepare("SELECT payload FROM events").all(), [{ payload: completion }]);
  } finally { db.close(); }
});
