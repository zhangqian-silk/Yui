/**
 * Deterministic lifecycle coverage matrix for the Task workspace lifecycle
 * (slices 1-4). Every test uses real git on disk and a real FileTaskStore;
 * no test depends on an external checkout, a clock, or timing.
 *
 * Coverage matrix:
 *
 *   scenario                                            covered by
 *   --------------------------------------------------  ----------------------------
 *   active checked-out ref, recorded worktree           task-archive-ordering.test.js
 *   active checked-out ref, cross-repo recorded wt      this file (A4) + rebuild tests
 *   active checked-out ref, same-repo foreign wt        this file (A5)
 *   dirty worktree                                      task-archive-ordering / rebuild
 *   missing recorded worktree (path gone, ref kept)     this file (A1)
 *   Controller concurrent prepare during a rebuild      this file (A3)
 *   CAS retry (workspaceIdentity conflict)              this file (B1/B2)
 *   interruption: post-commit cleanup, then resume      this file (A2)
 *   interruption: archive partial                       task-archive-ordering.test.js
 *   interruption: pre-commit rebuild failure            task-workspace-rebuild.test.js
 *   deleted external checkout tolerance                 this file (C1)
 *   rebuild resume reclaims orphan token wt/branch      this file (C2)
 *
 * Part B tests cover the slice 3 (work-item-5) interface: prepareTaskWorkspace
 * raises StorageConflictError when its transaction observes a workspaceIdentity
 * different from the one it minted, discards its unadopted entries, and a
 * retry converges on the winner.
 *
 * Part C tests cover the slice 4 (work-item-6) interface: cleanup tolerates a
 * deleted external checkout, and a rebuild resume reclaims orphan token
 * worktrees/branches with no catalog record.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runTaskWorkspaceCommand } from "../../dist/commands/taskWorkspaceCommands.js";
import { isProjectMaintenanceFenced } from "../../dist/repository/projectMaintenanceLock.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, archiveTask, completeTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createIsolatedRuntime } from "../helpers/isolatedRuntime.js";
import { installMockProviderCommands } from "../helpers/mockProviderCommands.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");

function git(path, args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

function initRepository(path) {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, ["config", "user.name", "Yui Test"]);
  git(path, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(path, "tracked.txt"), "initial\n");
  git(path, ["add", "tracked.txt"]);
  git(path, ["commit", "-qm", "initial"]);
}

/** A second repository with distinct content, so its commits never hash-equal the Project's. */
function foreignRepository(path) {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, ["config", "user.name", "Yui Test"]);
  git(path, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(path, "foreign.txt"), "foreign\n");
  git(path, ["add", "foreign.txt"]);
  git(path, ["commit", "-qm", "foreign"]);
}

async function matrixFixture(t) {
  const { root, home } = createIsolatedRuntime(t);
  installMockProviderCommands(home);
  const workspace = join(root, "workspace");
  const repositoryPath = join(workspace, "Yui");
  initRepository(repositoryPath);

  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.saveConfiguredAgent(agent);
  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: workspace,
    defaultAgent: agent.id
  });
  await runProjectCommand(
    ["add", "Yui", repositoryPath, "--stable", "main", "--development", "main"],
    store,
    { now: () => new Date(NOW) }
  );
  const project = store.getProject("project-1");
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  return { root, home, workspace, repositoryPath, store, project, preparer };
}

/**
 * A separate Home for a CAS competitor. The per-Project maintenance fence
 * lives under the Home's `locks/` area, so a competitor with its own Home
 * does not contend with the racing preparer's fence. This simulates a
 * cross-process fence failure and exercises the single-writer CAS as
 * defense-in-depth: the CAS must still catch a competitor the fence would
 * normally exclude.
 */
function competitorHome(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-competitor-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/**
 * Build the pre-identity layout for a Task: a managed worktree at the bare
 * `task-N` segment (branch `yui/task-N/main`) and a v2 managed-workspace
 * record, with no workspace identity on the Task.
 */
async function legacyTask(fixture, title = "Legacy Task") {
  const { store, project, workspace } = fixture;
  const created = runTaskCommand(
    ["create", title, "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  const gitPort = new NodeGitWorkspace();
  const physical = await gitPort.ensureWorktree({
    repositoryPath: project.path,
    container: join(workspace, "worktree", project.name),
    taskSegment: task.id,
    roleName: "main",
    baseRef: task.projectBindings[0].baseRef
  });
  const root = join(workspace, "tasks", task.id, "main");
  const entry = {
    projectId: project.id,
    directory: project.name,
    access: "write",
    path: physical.path,
    branch: physical.branch,
    baseRef: task.projectBindings[0].baseRef,
    baseCommit: physical.baseCommit
  };
  const managed = createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root,
    entries: [entry]
  }, NOW);
  store.saveManagedWorkspace(managed);
  return { task, managed, entry, legacyRef: physical.branch };
}

function retireTask(fixture, task) {
  const completed = completeTask(activateTask(task, NOW), NOW, { by: "leader", summary: "done" });
  fixture.store.saveTask(archiveTask(completed, NOW));
}

function archiveRefName(fixture, legacyRef) {
  return `refs/yui/archive/${fixture.store.getHomeIdentity().homeId}/heads/${legacyRef}`;
}

function projectBranches(fixture) {
  return git(fixture.project.path, ["for-each-ref", "--format=%(refname)"]).split("\n");
}

function archiveCommand(fixture, args = []) {
  return runTaskWorkspaceCommand(
    ["history", "archive", ...args],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
}

function rebuildCommand(fixture, preparer = fixture.preparer, args = []) {
  return runTaskWorkspaceCommand(
    ["rebuild", ...args],
    fixture.store,
    preparer,
    { now: () => new Date(NOW) }
  );
}

const noTmux = {
  async prepareRoleSession() { throw new Error("unused"); },
  async waitUntilReady() { throw new Error("unused"); },
  async sendOnce() { throw new Error("unused"); },
  async inspectRole() { throw new Error("unused"); },
  async stopTask() { return false; }
};

function controllerPass(fixture, { fence = true, onDefer } = {}) {
  return runControllerSchedulerPass(
    new FileSchedulerStoreAdapter(fixture.store),
    noTmux,
    NOW,
    fixture.preparer,
    { kind: "full" },
    false,
    [],
    undefined,
    undefined,
    new Set(),
    fence ? (projectId) => isProjectMaintenanceFenced(fixture.home, projectId) : undefined,
    onDefer
  );
}

// ---------------------------------------------------------------------------
// Part A: coverage that passes on the pinned base (slices 1 and 2).
// ---------------------------------------------------------------------------

test("A1 archive completes when the recorded worktree is gone but the ref remains", async (t) => {
  const fixture = await matrixFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  const legacyCommit = git(fixture.project.path, ["rev-parse", legacyRef]);
  const legacyWorktree = join(fixture.workspace, "worktree", "Yui", task.id, "main");

  // The recorded worktree directory was deleted out from under the catalog
  // (a crashed manual cleanup); the branch and the prunable registration stay.
  rmSync(legacyWorktree, { recursive: true, force: true });
  assert.equal(existsSync(legacyWorktree), false);
  assert.equal(git(fixture.project.path, ["rev-parse", legacyRef]).length, 40);

  retireTask(fixture, task);
  const result = await archiveCommand(fixture, [task.id]);
  assert.deepEqual(result.data.archived, [`project-1:refs/heads/${legacyRef}`]);

  // The missing worktree is a no-op; the commit still lands in the archive and
  // the active ref is deleted.
  assert.equal(git(fixture.project.path, ["rev-parse", archiveRefName(fixture, legacyRef)]), legacyCommit);
  assert.throws(() => git(fixture.project.path, ["rev-parse", legacyRef]));
});

test("A2 rebuild resumes after a post-commit cleanup interruption", async (t) => {
  const fixture = await matrixFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  const legacyCommit = git(fixture.project.path, ["rev-parse", legacyRef]);
  const legacyWorktree = join(fixture.workspace, "worktree", "Yui", task.id, "main");

  // Fail the first removeRecordedWorktree call: the record switch already
  // committed, so this simulates a crash during post-commit cleanup.
  const real = new NodeGitWorkspace();
  let cleanupFailed = false;
  const interrupted = new Proxy(real, {
    get(target, property) {
      if (property === "removeRecordedWorktree") {
        return async (input) => {
          if (!cleanupFailed) {
            cleanupFailed = true;
            throw new Error("simulated post-commit cleanup interruption");
          }
          return target.removeRecordedWorktree(input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const interruptedPreparer = new FileTaskWorkspacePreparer(
    fixture.home, fixture.store, interrupted, () => new Date(NOW)
  );

  await assert.rejects(
    rebuildCommand(fixture, interruptedPreparer, [task.id]),
    /simulated post-commit cleanup interruption/
  );

  // Mid-state: the identity and the new workspace are committed; the legacy
  // layout is untouched and no archive ref exists yet.
  const interruptedTask = fixture.store.getTask(task.id);
  assert.ok(interruptedTask.workspaceIdentity, "the identity survived the interruption");
  const segment = `${task.id}-${interruptedTask.workspaceIdentity.token}`;
  const newWorktree = join(fixture.workspace, "worktree", "Yui", segment, "main");
  assert.equal(existsSync(newWorktree), true, "the new worktree survived the interruption");
  assert.equal(existsSync(legacyWorktree), true, "the legacy worktree was not removed");
  assert.equal(git(fixture.project.path, ["rev-parse", legacyRef]).length, 40, "the legacy ref survives");
  assert.throws(
    () => git(fixture.project.path, ["rev-parse", archiveRefName(fixture, legacyRef)]),
    undefined,
    "no archive ref was created before the interruption"
  );

  // The retry takes the resume path and converges.
  const resumed = await rebuildCommand(fixture, fixture.preparer, [task.id]);
  assert.equal(resumed.data.resumed, true, "the retry resumed the pending cleanup");
  assert.equal(existsSync(legacyWorktree), false, "the legacy worktree was removed on resume");
  assert.throws(() => git(fixture.project.path, ["rev-parse", legacyRef]), "the legacy ref was archived");
  assert.equal(
    git(fixture.project.path, ["rev-parse", archiveRefName(fixture, legacyRef)]),
    legacyCommit
  );
  assert.equal(existsSync(newWorktree), true, "the new worktree still serves the Task");
  assert.equal(
    fixture.store.getTask(task.id).workspaceIdentity.token,
    interruptedTask.workspaceIdentity.token,
    "the resume kept the committed identity"
  );
});

test("A3 the Controller defers a Task while its rebuild holds the maintenance fence", async (t) => {
  const fixture = await matrixFixture(t);
  const { task } = await legacyTask(fixture);
  fixture.store.saveTask(activateTask(task, NOW));

  // Run a Controller pass from inside the rebuild's worktree creation, while
  // the rebuild holds every bound Project's maintenance fence. The pass must
  // defer the Task, not prepare it.
  const real = new NodeGitWorkspace();
  let nested = false;
  const deferred = [];
  const racing = new Proxy(real, {
    get(target, property) {
      if (property === "ensureWorktree") {
        return async (input) => {
          const physical = await target.ensureWorktree(input);
          if (!nested && /^task-\d+-[a-f0-9]{8}$/.test(input.taskSegment)) {
            nested = true;
            await controllerPass(fixture, { onDefer: (detail) => deferred.push(detail) });
          }
          return physical;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const racingPreparer = new FileTaskWorkspacePreparer(
    fixture.home, fixture.store, racing, () => new Date(NOW)
  );

  const rebuilt = await rebuildCommand(fixture, racingPreparer, [task.id]);
  assert.equal(rebuilt.data.resumed, false);
  assert.deepEqual(deferred, [{ taskId: task.id, projectIds: [fixture.project.id] }]);
  const identity = fixture.store.getTask(task.id).workspaceIdentity;
  assert.ok(identity, "the rebuild bound its identity");

  // Once the fence is released, a normal pass prepares the already-identified
  // Task without minting a second identity.
  await controllerPass(fixture, { fence: true });
  assert.equal(
    fixture.store.getTask(task.id).workspaceIdentity.token,
    identity.token,
    "the post-rebuild pass reused the committed identity"
  );
});

test("A4 archive fails closed on a cross-repo worktree at the recorded path", async (t) => {
  const fixture = await matrixFixture(t);
  const { store, project, workspace } = fixture;
  const created = runTaskCommand(
    ["create", "Foreign recorded worktree", "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // The Project repository carries the legacy ref at its own commit.
  const projectCommit = git(project.path, ["rev-parse", "main"]);
  git(project.path, ["branch", `yui/${task.id}/main`, projectCommit]);

  // A foreign repository's worktree sits at the recorded path, checked out on
  // a same-named branch at a different commit (a Project migration left the
  // old checkout behind).
  const foreignPath = join(workspace, "ForeignRepo");
  foreignRepository(foreignPath);
  const foreignCommit = git(foreignPath, ["rev-parse", "main"]);
  assert.notEqual(foreignCommit, projectCommit, "the fixtures use distinct commits");
  git(foreignPath, ["branch", `yui/${task.id}/main`, foreignCommit]);
  const recordedPath = join(workspace, "worktree", project.name, task.id, "main");
  git(foreignPath, ["worktree", "add", recordedPath, `yui/${task.id}/main`]);

  const root = join(workspace, "tasks", task.id, "main");
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root,
    entries: [{
      projectId: project.id,
      directory: project.name,
      access: "write",
      path: recordedPath,
      branch: `yui/${task.id}/main`,
      baseRef: "main",
      baseCommit: foreignCommit
    }]
  }, NOW));

  retireTask(fixture, task);
  await assert.rejects(
    archiveCommand(fixture, [task.id]),
    /not retained by the current Project/i
  );

  // Nothing was removed or deleted: the foreign worktree and its HEAD survive,
  // and the Project's ref is retained.
  assert.equal(existsSync(recordedPath), true, "the foreign worktree is not removed");
  assert.equal(
    git(recordedPath, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).length,
    40,
    "the foreign worktree keeps a valid HEAD"
  );
  assert.equal(git(project.path, ["rev-parse", `yui/${task.id}/main`]), projectCommit);
  assert.throws(
    () => git(project.path, ["rev-parse", archiveRefName(fixture, `yui/${task.id}/main`)]),
    undefined,
    "no archive ref was created"
  );
});

// A same-repo foreign worktree on the legacy ref (one this Home does not
// manage) must fail the archive closed: the pre-archive enumeration lists
// every worktree on the exact ref, excludes the recorded worktree this Home
// removes in the same flow, and refuses to touch the ref while a foreign
// worktree still has it checked out. The ref stays, the foreign worktree
// keeps a valid HEAD, and no archive ref is created.
test("A5 archive fails closed when a same-repo foreign worktree occupies the ref", async (t) => {
  const fixture = await matrixFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  const legacyCommit = git(fixture.project.path, ["rev-parse", legacyRef]);

  // Another Home's worktree on the same ref, at a path this Home does not
  // manage. This Home's recorded worktree is gone first; prune its dead
  // registration so git permits a second checkout of the same branch.
  const recordedPath = join(fixture.workspace, "worktree", "Yui", task.id, "main");
  rmSync(recordedPath, { recursive: true, force: true });
  git(fixture.project.path, ["worktree", "prune"]);
  const foreignPath = join(fixture.workspace, "foreign-home", task.id, "main");
  git(fixture.project.path, ["worktree", "add", foreignPath, legacyRef]);
  assert.equal(
    git(foreignPath, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]),
    legacyCommit
  );

  retireTask(fixture, task);
  await assert.rejects(archiveCommand(fixture, [task.id]));

  // The ref is retained and the foreign worktree is not stranded.
  assert.equal(git(fixture.project.path, ["rev-parse", legacyRef]), legacyCommit);
  assert.equal(
    git(foreignPath, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]),
    legacyCommit,
    "the foreign worktree keeps a valid HEAD"
  );
  assert.throws(() => git(fixture.project.path, ["rev-parse", archiveRefName(fixture, legacyRef)]));
});

// ---------------------------------------------------------------------------
// Part B: CAS retry. Slice 3 (work-item-5): prepareTaskWorkspace raises
// StorageConflictError when its transaction observes a workspaceIdentity
// different from the one it minted, discards its unadopted entries, and a
// retry converges on the winner.
// ---------------------------------------------------------------------------

test("B1 a concurrent prepare loses the workspaceIdentity CAS and discards its residue", async (t) => {
  const fixture = await matrixFixture(t);
  const created = runTaskCommand(
    ["create", "CAS Task", "--project", fixture.project.id],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  fixture.store.saveTask(activateTask(task, NOW));

  // The competitor prepare uses a separate Home (and thus a separate
  // maintenance fence) to simulate a cross-process fence failure for the CAS.
  const competitor = new FileTaskWorkspacePreparer(
    competitorHome(t), fixture.store, undefined, () => new Date(NOW)
  );
  const real = new NodeGitWorkspace();
  let nested = false;
  const racing = new Proxy(real, {
    get(target, property) {
      if (property === "ensureWorktree") {
        return async (input) => {
          const physical = await target.ensureWorktree(input);
          if (!nested && /^task-\d+-[a-f0-9]{8}$/.test(input.taskSegment)) {
            nested = true;
            // A concurrent prepare completes first and binds its own identity.
            await competitor.prepareTaskWorkspace(task.id);
          }
          return physical;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const racingPreparer = new FileTaskWorkspacePreparer(
    fixture.home, fixture.store, racing, () => new Date(NOW)
  );

  // The loser rides the StorageConflictError retry channel: it discards its
  // own just-created worktree and branch, then converges on the winner
  // instead of surfacing the conflict.
  const converged = await racingPreparer.prepareTaskWorkspace(task.id);
  assert.equal(converged.status, "ready");

  // The loser's worktree was discarded; only the winner's workspace is cataloged.
  const winner = fixture.store.getTask(task.id).workspaceIdentity;
  assert.ok(winner, "the winner's identity is bound");
  const winnerPath = join(fixture.workspace, "worktree", "Yui", `${task.id}-${winner.token}`, "main");
  assert.equal(existsSync(winnerPath), true, "the winner's worktree is retained");
  const workspaces = fixture.store.listManagedWorkspaces(task.id);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].entries[0].path, winnerPath);
  const yuiBranches = projectBranches(fixture)
    .filter((ref) => ref.startsWith("refs/heads/yui/"))
    .sort();
  assert.deepEqual(
    yuiBranches,
    [`refs/heads/yui/${task.id}-${winner.token}/main`],
    "the loser's branch was discarded"
  );

  // A retry converges on the winner instead of minting a third identity.
  const retry = await fixture.preparer.prepareTaskWorkspace(task.id);
  assert.equal(retry.status, "ready");
  assert.equal(fixture.store.getTask(task.id).workspaceIdentity.token, winner.token);
});

test("B2 a prepare racing a rebuild loses the workspaceIdentity CAS", async (t) => {
  const fixture = await matrixFixture(t);
  const created = runTaskCommand(
    ["create", "CAS versus rebuild", "--project", fixture.project.id],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // The competitor rebuild uses a separate Home (and thus a separate
  // maintenance fence) to simulate a cross-process fence failure for the CAS.
  const competitor = new FileTaskWorkspacePreparer(
    competitorHome(t), fixture.store, undefined, () => new Date(NOW)
  );
  const real = new NodeGitWorkspace();
  let nested = false;
  const racing = new Proxy(real, {
    get(target, property) {
      if (property === "ensureWorktree") {
        return async (input) => {
          const physical = await target.ensureWorktree(input);
          if (!nested && /^task-\d+-[a-f0-9]{8}$/.test(input.taskSegment)) {
            nested = true;
            // A concurrent rebuild binds its own identity first.
            await competitor.rebuildTaskWorkspace(task.id);
          }
          return physical;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const racingPreparer = new FileTaskWorkspacePreparer(
    fixture.home, fixture.store, racing, () => new Date(NOW)
  );

  // The loser rides the StorageConflictError retry channel: it discards its
  // own just-created worktree and branch, then converges on the rebuild's
  // identity instead of surfacing the conflict.
  const converged = await racingPreparer.prepareTaskWorkspace(task.id);
  assert.equal(converged.status, "ready");

  // The rebuild's identity wins; the prepare's residue is discarded.
  const winner = fixture.store.getTask(task.id).workspaceIdentity;
  assert.ok(winner, "the rebuild's identity is bound");
  const winnerPath = join(fixture.workspace, "worktree", "Yui", `${task.id}-${winner.token}`, "main");
  assert.equal(existsSync(winnerPath), true);
  const workspaces = fixture.store.listManagedWorkspaces(task.id);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].entries[0].path, winnerPath);
  const yuiBranches = projectBranches(fixture)
    .filter((ref) => ref.startsWith("refs/heads/yui/"))
    .sort();
  assert.deepEqual(
    yuiBranches,
    [`refs/heads/yui/${task.id}-${winner.token}/main`],
    "the losing prepare's branch was discarded"
  );

  // A retry converges on the rebuild's identity.
  const retry = await fixture.preparer.prepareTaskWorkspace(task.id);
  assert.equal(retry.status, "ready");
  assert.equal(fixture.store.getTask(task.id).workspaceIdentity.token, winner.token);
});

// ---------------------------------------------------------------------------
// Part C: external-checkout tolerance and orphan reclamation. Slice 4
// (work-item-6): cleanup tolerates a deleted external checkout (a missing
// common dir no longer hard-fails), and a rebuild resume reclaims orphan
// token worktrees/branches with no catalog record.
// ---------------------------------------------------------------------------

test("C1 legacy cleanup completes when the external checkout was deleted", async (t) => {
  const fixture = await matrixFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  retireTask(fixture, task);

  // The Project's external checkout is deleted out from under the catalog.
  rmSync(fixture.project.path, { recursive: true, force: true });

  // Slice 4: the cleanup tolerates the missing checkout instead of hard-failing.
  const result = await archiveCommand(fixture, [task.id]);
  assert.deepEqual(result.data.archived, [], "the ref in the deleted repo is not archived");
  // The Task record is untouched and the command did not throw.
  assert.equal(fixture.store.getTask(task.id).status, "archived");
  assert.equal(
    fixture.store.listManagedWorkspaces(task.id).length,
    1,
    "the workspace record is preserved for a later reconcile"
  );
});

test("C2 a rebuild resume reclaims an orphan token worktree and branch", async (t) => {
  const fixture = await matrixFixture(t);
  const created = runTaskCommand(
    ["create", "Orphan Task", "--project", fixture.project.id],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  await fixture.preparer.prepareTaskWorkspace(task.id);
  const ownToken = fixture.store.getTask(task.id).workspaceIdentity.token;

  // An orphan token worktree for the same Task, a different token, with no
  // catalog record (a crashed prepare left it behind).
  const gitPort = new NodeGitWorkspace();
  const orphanSegment = `${task.id}-01234567`;
  assert.notEqual(orphanSegment, `${task.id}-${ownToken}`);
  await gitPort.ensureWorktree({
    repositoryPath: fixture.project.path,
    container: join(fixture.workspace, "worktree", fixture.project.name),
    taskSegment: orphanSegment,
    roleName: "main",
    baseRef: "main"
  });
  const orphanPath = join(fixture.workspace, "worktree", "Yui", orphanSegment, "main");
  const orphanBranch = `yui/${orphanSegment}/main`;
  assert.equal(existsSync(orphanPath), true);
  assert.equal(git(fixture.project.path, ["rev-parse", orphanBranch]).length, 40);

  // Slice 4: the resume reclaims orphan token worktrees/branches for this Task.
  const result = await rebuildCommand(fixture, fixture.preparer, [task.id]);
  assert.equal(result.data.resumed, true);
  assert.equal(existsSync(orphanPath), false, "the orphan worktree was reclaimed");
  assert.throws(
    () => git(fixture.project.path, ["rev-parse", orphanBranch]),
    "the orphan branch was reclaimed"
  );

  // The owned workspace is intact.
  const ownPath = join(fixture.workspace, "worktree", "Yui", `${task.id}-${ownToken}`, "main");
  assert.equal(existsSync(ownPath), true, "the owned worktree is retained");
  assert.equal(
    git(fixture.project.path, ["rev-parse", `yui/${task.id}-${ownToken}/main`]).length,
    40,
    "the owned branch is retained"
  );
});
