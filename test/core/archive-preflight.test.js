import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { inspectTaskArchive, renderTaskArchivePreflight } from "../../dist/task/archivePreflight.js";
import { createTask, activateTask, completeTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { taskArchiveDiagnostics } from "../../dist/task/archiveDiagnostics.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { upsertTaskPublication } from "../../dist/commands/taskPublicationCommands.js";
import { runTaskPublicationAdoptCommand } from "../../dist/commands/taskPublicationAdoptCommand.js";
import { generateTaskWorkspaceIdentity, taskWorkspaceRefSegmentFromIdentity } from "../../dist/repository/taskWorkspaceIdentity.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-archive-preflight-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "workspaces/tasks/task-1/main/app");
  mkdirSync(root, { recursive: true });
  const env = { ...sanitizedTestEnv(), GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (path, ...args) => execFileSync("git", ["-C", path, ...args], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  git(root, "init", "-b", "yui/task-1/main");
  writeFileSync(join(root, "tracked.txt"), "tracked baseline");
  git(root, "add", "tracked.txt");
  git(root, "commit", "--allow-empty", "-m", "baseline");
  return { home, root, git };
}

test("frozen result inspection distinguishes record, commit and HEAD differences without changing evidence", async t => {
  const { home, root, git } = fixture(t);
  const nodeGit = new NodeGitWorkspace();
  const container = join(home, "workspaces/tasks/task-1/work-items/work-item-1");
  const prepared = await nodeGit.ensureWorktree({
    repositoryPath: root, container, directory: "app", taskSegment: "task-1",
    roleName: "work-item-1", baseRef: "HEAD"
  });
  const workspace = { schemaVersion: 2, owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-1" },
    root: container, entries: [{ projectId: "project-1", directory: "app", access: "write",
      ...prepared, baseRef: "HEAD" }], createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z" };
  let candidate = { id: "candidate-1", workspace: structuredClone(workspace),
    gitSnapshot: { projects: [{ projectId: "project-1", commit: prepared.baseCommit }] } };
  const item = { id: "work-item-1", taskId: "task-1", status: "accepted", acceptedCandidateId: "candidate-1" };
  const store = {
    getWorkItem: () => ({ ...item, candidates: [candidate] }),
    getWorkItemWorkspace: () => workspace,
    getTaskWorkspace: () => ({ entries: [{ projectId: "project-1", path: root }] }),
    listIntegrationAttempts: () => [{ id: "integration-1", status: "committed", projectId: "project-1",
      source: { kind: "work-item", workItemId: item.id, startCommit: prepared.baseCommit, resultCommit: prepared.baseCommit } }]
  };
  const manager = new WorkItemChangeSetManager(store);
  assert.ok((await manager.inspectIntegrated(item.taskId, item.id)).proof);
  candidate = { ...candidate, workspace: undefined };
  assert.ok((await manager.inspectIntegrated(item.taskId, item.id)).checks.some(c => c.reason === "candidate-workspace-missing"));
  candidate = { ...candidate, workspace: structuredClone(workspace), gitSnapshot: undefined };
  assert.ok((await manager.inspectIntegrated(item.taskId, item.id)).checks.some(c => c.reason === "frozen-commit-missing"));
  candidate = { ...candidate, gitSnapshot: { projects: [{ projectId: "project-1", commit: prepared.baseCommit }] } };
  candidate.workspace.entries[0].path = join(home, "workspaces/worktree/app/task-1/work-item-1");
  const original = structuredClone(candidate);
  const relocated = await manager.inspectIntegrated(item.taskId, item.id);
  assert.ok(relocated.checks.some(c => c.reason === "workspace-path-mismatch" && c.expected !== c.observed));
  await assert.rejects(manager.assertIntegrated(item.taskId, item.id), /workspace-path-mismatch/);
  assert.deepEqual(candidate, original, "a diagnosis must not rewrite the frozen Candidate");
  candidate = { ...candidate, workspace: structuredClone(workspace) };
  const indexPath = git(prepared.path, "rev-parse", "--path-format=absolute", "--git-path", "index");
  utimesSync(join(prepared.path, "tracked.txt"), new Date("2020-01-01"), new Date("2020-01-01"));
  const index = existsSync(indexPath) ? readFileSync(indexPath) : undefined;
  await manager.inspectIntegrated(item.taskId, item.id);
  assert.deepEqual(existsSync(indexPath) ? readFileSync(indexPath) : undefined, index);
  git(prepared.path, "commit", "--allow-empty", "-m", "moved after preflight");
  const moved = await manager.inspectIntegrated(item.taskId, item.id);
  assert.ok(moved.checks.some(c => c.reason === "head-mismatch" && c.expected === prepared.baseCommit));
  await assert.rejects(manager.assertIntegrated(item.taskId, item.id), /head-mismatch/);
  writeFileSync(join(prepared.path, "keep.txt"), "preserve dirty data");
  const dirty = await manager.inspectIntegrated(item.taskId, item.id);
  assert.ok(dirty.checks.some(c => c.reason === "dirty-worktree"));
  assert.ok(dirty.checks.some(c => c.reason === "head-mismatch"), "one inspection exposes independent differences");
});

test("archive preflight observes SQLite and Git without writes, and force still commits before retaining changed resources", async t => {
  const { home, root, git } = fixture(t);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-13T00:00:00Z");
  const workspaceIdentity = generateTaskWorkspaceIdentity({
    home: { homeId: "home-fixture" }, taskId: "task-1", now, entropy: Buffer.alloc(16, 1)
  });
  const branch = `yui/${taskWorkspaceRefSegmentFromIdentity(workspaceIdentity)}/main`;
  git(root, "branch", "-m", branch);
  const base = git(root, "rev-parse", "HEAD");
  store.saveProject(createProject("project-1", "app", join(home, "reference"),
    { stable: "main", development: "main" }, now));
  const task = completeTask(activateTask(createTask("task-1", "Archive inspection", now, {
    cwd: join(home, "workspaces/tasks/task-1/main"),
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main", baseCommit: base, currentCommit: base }]
  }), now), now, { by: "user", summary: "Unchanged baseline" });
  store.saveTask({ ...task, workspaceIdentity });
  store.saveEvent(task.id, createTaskEvent(store.nextEventId(task.id), task.id, "task.completed",
    { projectHeads: `project-1@${base}`, projectBases: `project-1@${base}` }, now));
  store.saveManagedWorkspace(createManagedWorkspace({ owner: { type: "task", taskId: task.id },
    root: task.cwd, entries: [{ projectId: "project-1", directory: "app", access: "write", path: root,
      branch, baseRef: "main", baseCommit: base }] }, now));
  const preparer = new FileTaskWorkspacePreparer(home, store);
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() { assert.fail("inspection must not stop a runtime"); },
    async assertTaskPhysicalResourcesReleased() {}
  });
  const before = { task: store.getTask(task.id), events: store.listEvents(task.id),
    workspaces: store.listManagedWorkspaces(task.id), publications: store.listPublicationReferences(task.id) };
  const indexPath = join(root, ".git/index");
  const index = readFileSync(indexPath);
  const request = { taskId: task.id, disposition: "integrated", force: false };
  const report = await inspectTaskArchive(coordinator, request);
  assert.equal(report.archive.eligible, true);
  assert.deepEqual(report.cleanup.execution, []);
  assert.equal(report.cleanup.resources[0].status, "checked");
  assert.equal(report.authorizesCleanup, false);
  assert.deepEqual({ task: store.getTask(task.id), events: store.listEvents(task.id),
    workspaces: store.listManagedWorkspaces(task.id), publications: store.listPublicationReferences(task.id) }, before);
  assert.deepEqual(readFileSync(indexPath), index);
  assert.match(renderTaskArchivePreflight(report), /not authorization/);
  git(root, "commit", "--allow-empty", "-m", "new HEAD after inspection");
  const moved = await inspectTaskArchive(coordinator, request);
  assert.ok(moved.cleanup.resources[0].checks.some(c => c.reason === "head-mismatch"));
  await assert.rejects(preparer.cleanupTaskForArchive(task.id, "integrated"), /head-mismatch/);
  assert.equal(existsSync(root), true);
  writeFileSync(join(root, "preserve.txt"), "not disposable");
  runTaskCommand(["archive", task.id, "--integrated", "--force"], store, { environment: {}, now: () => now });
  await coordinator.cleanupArchivedTask(task.id, "integrated");
  const diagnostics = taskArchiveDiagnostics(store, store.getTask(task.id));
  assert.equal(diagnostics.archived, true);
  assert.equal(diagnostics.cleanupFinished, true);
  assert.ok(diagnostics.retainedResources.some(r => r.resource === "task:task-1"));
  assert.equal(readFileSync(join(root, "preserve.txt"), "utf8"), "not disposable");
  assert.ok(store.listEvents(task.id).findIndex(e => e.type === "task.archived")
    < store.listEvents(task.id).findIndex(e => e.type === "task.archive-cleanup"));
  const unknown = await inspectTaskArchive(new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() { assert.fail("read only"); }
  }), { ...request, force: true });
  assert.ok(unknown.cleanup.execution.some(c => c.status === "unknown"));
});

test("archive cleanup honors an explicitly adopted publication candidate but retains an uncovered later HEAD", async t => {
  const { home, root, git } = fixture(t);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-13T00:00:00Z");
  const workspaceIdentity = generateTaskWorkspaceIdentity({
    home: { homeId: "home-fixture" }, taskId: "task-1", now, entropy: Buffer.alloc(16, 2)
  });
  const branch = `yui/${taskWorkspaceRefSegmentFromIdentity(workspaceIdentity)}/main`;
  git(root, "branch", "-m", branch);
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "tracked.txt"), "accepted feature");
  git(root, "commit", "-am", "accepted feature");
  const accepted = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "upstream.txt"), "integrated upstream");
  git(root, "add", "upstream.txt");
  git(root, "commit", "-m", "publication candidate");
  const candidate = git(root, "rev-parse", "HEAD");
  store.saveProject(createProject("project-1", "app", join(home, "reference"),
    { stable: "main", development: "main" }, now));
  const task = { ...completeTask(activateTask(createTask("task-1", "Adopted delivery", now, {
    cwd: join(home, "workspaces/tasks/task-1/main"),
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main",
      baseCommit: base, currentCommit: accepted }]
  }), now), now, { by: "user", summary: "Feature accepted" }), workspaceIdentity };
  store.saveTask(task);
  store.saveEvent(task.id, createTaskEvent(store.nextEventId(task.id), task.id, "task.completed",
    { projectHeads: `project-1@${accepted}`, projectBases: `project-1@${base}` }, now));
  const workspace = createManagedWorkspace({ owner: { type: "task", taskId: task.id },
    root: task.cwd, entries: [{ projectId: "project-1", directory: "app", access: "write", path: root,
      branch, baseRef: "main", baseCommit: base }] }, now);
  store.saveManagedWorkspace(workspace);
  const publication = store.transaction(tx => upsertTaskPublication(tx, task, {
    projectId: "project-1", provider: "github", repository: "fixture/app", externalKind: "pull-request",
    externalId: "1", localCommit: candidate, headCommit: candidate, remoteCommit: candidate,
    state: "merged", verification: "verified"
  }, "user", now).reference);
  const reference = `${task.id}/${publication.id}`;
  const diff = await runTaskPublicationAdoptCommand(["diff", reference], store);
  await runTaskPublicationAdoptCommand(["adopt", reference, "--reviewed-diff", diff.data.diffDigest,
    "--acceptance", "Accepted feature retained; only the reviewed upstream file is added."], store);
  const preparer = new FileTaskWorkspacePreparer(home, store);
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() { assert.fail("inspection must not stop runtime"); },
    async assertTaskPhysicalResourcesReleased() {}
  });
  const report = await inspectTaskArchive(coordinator, {
    taskId: task.id, disposition: "integrated", force: false
  });
  assert.deepEqual(report.archive.delivery, []);
  assert.deepEqual(report.cleanup.resources[0].checks, []);
  git(root, "commit", "--allow-empty", "-m", "uncovered later HEAD");
  await assert.rejects(preparer.cleanupTaskForArchive(task.id, "integrated"), /head-mismatch/);
  assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "accepted feature");
});

test("Git cleanup inspect is read-only and removal rechecks branch ownership and new dirt", async t => {
  const { home, root, git } = fixture(t);
  const workspace = new NodeGitWorkspace();
  const input = { repositoryPath: root, container: join(home, "work"), directory: "app",
    taskSegment: "task-1", roleName: "work-item-1", baseRef: "HEAD", deleteBranch: true };
  const prepared = await workspace.ensureWorktree(input);
  assert.equal(await workspace.inspectWorktree(input), "clean");
  git(prepared.path, "switch", "-c", "foreign-owner");
  await assert.rejects(workspace.removeWorktree(input), /identity|branch/);
  assert.equal(existsSync(prepared.path), true);
  git(prepared.path, "switch", prepared.branch);
  assert.equal(await workspace.inspectWorktree(input), "clean");
  writeFileSync(join(prepared.path, "keep.txt"), "new dirt after preflight");
  assert.equal(await workspace.removeWorktree(input), "dirty");
  assert.equal(readFileSync(join(prepared.path, "keep.txt"), "utf8"), "new dirt after preflight");
  const marker = join(home, "filter-must-not-execute");
  git(root, "config", "filter.probe.clean", `touch '${marker}'; cat`);
  writeFileSync(join(prepared.path, ".gitattributes"), "*.txt filter=probe\n");
  writeFileSync(join(prepared.path, "tracked.txt"), "altered baseline");
  let filterError;
  try { await workspace.inspectWorktree(input); } catch (error) { filterError = error; }
  assert.equal(existsSync(marker), false, "read-only inspection must not execute a repository clean filter");
  assert.match(filterError?.message ?? "", /filter|program/);
  git(root, "config", "--unset", "filter.probe.clean");
  git(root, "config", "core.fsmonitor", `touch '${marker}'`);
  assert.equal(await workspace.inspectWorktree(input), "dirty");
  assert.equal(existsSync(marker), false, "index/attribute discovery must not execute a filesystem monitor either");
});
