/**
 * Regression coverage for the Task-final review-round-6 concurrency findings:
 *
 *  - P1 (stale reclaim): a stale Project-fence reclaim is serialized through a
 *    compare-and-delete critical section, so N processes racing one dead-owner
 *    lock yield AT MOST ONE holder; release removes only the exact acquired
 *    instance and never a successor lock.
 *  - P1 (Lane fence): a new Execution Group's Lane worktrees are prepared and
 *    adopted under ONE held per-Project maintenance fence, so a `project
 *    migrate` cannot switch the catalog in the prepare/adopt gap; the adoption
 *    transaction revalidates the Task binding set and exact Project paths
 *    (durable CAS) and fails closed on a stale preparation snapshot.
 *  - P2 (archive pending set): the pre-lock scan discovers only the sorted
 *    Project lock set; the pending archive set is rebuilt under the fence by
 *    re-listing refs and re-classifying their owners, so a Task that
 *    transitions terminal -> active between scan and lock is refused.
 *  - P2 (migrate stale metadata): every migrate Git effect is driven from one
 *    under-fence Project snapshot; a branch/remote change between the pre-lock
 *    read and the lock fails closed.
 *
 * Every concurrency assertion is deterministic: file-system locks, a barrier
 * that releases real child processes together, and git-port/store Proxies that
 * inject the race at the exact seam.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import {
  acquireProjectMaintenanceLock,
  projectMaintenanceLockPath,
  ProjectMaintenanceLockedError
} from "../../dist/repository/projectMaintenanceLock.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, completeTask, reopenTask } from "../../dist/task/task.js";
import { createWorkItem, retireWorkItem } from "../../dist/workItem/workItem.js";
import { createIsolatedRuntime } from "../helpers/isolatedRuntime.js";
import { installMockProviderCommands } from "../helpers/mockProviderCommands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");
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

// ---------------------------------------------------------------------------
// Shared fixture: one external Project on a real repository, bound to a Task.
// ---------------------------------------------------------------------------

async function laneFixture(t) {
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
    defaultAgent: "codex"
  });
  await runProjectCommand(
    ["add", "Yui", repositoryPath, "--stable", "main", "--development", "main"],
    store,
    { now: () => new Date(NOW) }
  );
  const project = store.getProject("project-1");

  const created = runTaskCommand(
    ["create", "Lane Task", "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  const task = activateTask(created.data.task, NOW);
  store.saveTask(task);

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  return { root, home, workspace, repositoryPath, store, project, task, preparer, agent };
}

/** Add a Task Role bound to the fixture's configured Agent. */
function addTaskRole(store, task, name) {
  runTaskCommand(
    ["role", "add", task.id, name, "--agent", "codex"],
    store,
    { now: () => new Date(NOW) }
  );
}

// ===========================================================================
// P1 (stale reclaim): multi-process race + exact-instance release
// ===========================================================================

const RACE_RUNNER = join(HERE, "..", "helpers", "project-lock-race-runner.mjs");

function seedStaleLock(home, projectId) {
  const lock = projectMaintenanceLockPath(home, projectId);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  // A dead owner (pid that does not exist) with a start time that can never
  // match a live process.
  writeFileSync(join(lock, "owner"), "999999999:0\n", { mode: 0o600 });
  // Age the lock past the stale threshold so the reclaim path is exercised
  // without a real sleep.
  const old = new Date(Date.now() - 5_000);
  utimesSync(lock, old, old);
  return lock;
}

function raceLockWorkers({ home, projectId, workers }) {
  const waitDir = join(home, "runtime");
  mkdirSync(waitDir, { recursive: true });
  const startBarrier = join(waitDir, "start.barrier");
  const children = [];
  for (let index = 0; index < workers; index += 1) {
    const resultPath = join(waitDir, `result.${index}.json`);
    const child = spawn(
      process.execPath,
      [RACE_RUNNER, home, projectId, startBarrier, resultPath, waitDir],
      { cwd: PROJECT_ROOT, stdio: "ignore" }
    );
    children.push({ index, resultPath, child });
  }
  // Wait until every worker has reached the barrier, then release them at once.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const waiting = readdirSync(waitDir).filter((file) => file.startsWith("waiting.")).length;
    if (waiting >= workers) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  }
  writeFileSync(startBarrier, "go");
  const results = new Array(children.length).fill(null);
  const collectDeadline = Date.now() + 12_000;
  while (Date.now() < collectDeadline) {
    let done = 0;
    for (const child of children) {
      if (results[child.index] !== null) { done += 1; continue; }
      if (existsSync(child.resultPath)) {
        try {
          results[child.index] = JSON.parse(readFileSync(child.resultPath, "utf8"));
          done += 1;
        } catch { /* mid-write; retry */ }
      }
    }
    if (done === children.length) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  }
  return results;
}

test("P1 stale reclaim: racing processes admit at most one Project-fence holder", (t) => {
  assert.ok(existsSync(RACE_RUNNER), `race runner must exist at ${RACE_RUNNER}`);
  const ROUNDS = 10;
  const WORKERS = 4;
  let roundsWithWinner = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const home = mkdtempSync(join(tmpdir(), "yui-rr6-lock-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    seedStaleLock(home, "project-1");
    const results = raceLockWorkers({ home, projectId: "project-1", workers: WORKERS });
    const acquired = results.filter((result) => result && result.acquired);
    assert.ok(
      acquired.length <= 1,
      `round ${round}: at most one worker may acquire, got ${acquired.length}: ${JSON.stringify(results)}`
    );
    if (acquired.length === 1) {
      roundsWithWinner += 1;
      // The winner holds the lock without releasing; the on-disk owner must be
      // that exact process (a successor lock is never clobbered).
      const owner = readFileSync(join(projectMaintenanceLockPath(home, "project-1"), "owner"), "utf8")
        .trim();
      const ownerPid = Number.parseInt(owner.slice(0, owner.indexOf(":")), 10);
      assert.equal(ownerPid, acquired[0].pid, `round ${round}: on-disk owner must be the sole winner`);
    }
  }
  // The race really ran: at least one round produced a genuine acquirer.
  assert.ok(roundsWithWinner > 0, "expected at least one round to produce an acquirer");
});

test("P1 stale reclaim: release removes only the exact acquired instance", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr6-release-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = projectMaintenanceLockPath(home, "project-1");

  // Acquire, then simulate a successor that reclaimed and replaced the lock
  // (e.g. after a crash recovery). The stale release handle must NOT remove it.
  const release = acquireProjectMaintenanceLock(home, "project-1");
  assert.ok(existsSync(lock), "lock exists after acquire");
  writeFileSync(join(lock, "owner"), "999999999:0\n", { mode: 0o600 });
  release();
  assert.ok(existsSync(lock), "a successor lock is never removed by a stale release handle");

  // A normal release removes the lock this handle owns.
  const lock2 = projectMaintenanceLockPath(home, "project-2");
  const release2 = acquireProjectMaintenanceLock(home, "project-2");
  assert.ok(existsSync(lock2), "lock exists after acquire");
  release2();
  assert.ok(!existsSync(lock2), "release removes the owned lock");
  // Idempotent: a second release is a no-op.
  release2();
  assert.ok(!existsSync(lock2), "double release is a no-op");
});

// ===========================================================================
// P1 (Lane fence): one fence across new-Lane preparation and adoption
// ===========================================================================

async function setupNewLaneDispatch(t) {
  const fx = await laneFixture(t);
  const { store, task, project, preparer } = fx;
  addTaskRole(store, task, "worker");
  addTaskRole(store, task, "worker-2");

  const item = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Paneled work",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  // Isolate the Work Item so dispatch's scope proof passes.
  await preparer.prepareWorkItemWorkspace(task.id, item.id);
  // migrate requires a remote URL; it fails at fence acquisition before any
  // Git effect, so a placeholder is sufficient. Set it only after the work
  // item workspace is prepared, since preparation resolves the local baseline.
  store.saveProject({ ...project, remoteUrl: "git@example.invalid:yui.git" });

  const groupId = `execution-group-${store.peekNextAgentRunId(task.id)}`;
  const laneIds = [`${groupId}-lane-1`, `${groupId}-lane-2`];
  return { ...fx, item, groupId, laneIds };
}

test("P1 Lane fence: a new Group's Lanes are prepared under one held fence", async (t) => {
  const fx = await setupNewLaneDispatch(t);
  const { store, task, project, preparer, item, groupId, laneIds } = fx;

  // The dispatch preflight acquires ONE fence and holds it across preparation
  // and the adoption transaction.
  const held = preparer.acquireTaskProjectMaintenanceLocks(task.id);
  try {
    const workspaces = new Map();
    for (const laneId of laneIds) {
      workspaces.set(laneId, await preparer.prepareExecutionLaneWorkspace(
        task.id, groupId, laneId,
        { purpose: "execution", workItemId: item.id },
        { current: held.current }
      ));
    }
    // A new Group's Lanes are not yet durable: the prepared worktrees are
    // unadopted until the dispatch transaction saves them.
    for (const laneId of laneIds) {
      assert.equal(
        store.getManagedWorkspace({
          type: "execution-lane",
          taskId: task.id,
          executionGroupId: groupId,
          executionLaneId: laneId,
          purpose: "execution",
          workItemId: item.id
        }),
        null,
        `Lane ${laneId} is unadopted before dispatch`
      );
    }
    // While the fence is held, a `project migrate` cannot switch the catalog
    // in the prepare/adopt gap: it fails at fence acquisition, before any Git
    // effect.
    await assert.rejects(
      runProjectCommand(["migrate", project.id], store, { now: () => new Date(NOW) }),
      ProjectMaintenanceLockedError
    );
  } finally {
    held.release();
  }
  // After release the fence is free.
  const release = acquireProjectMaintenanceLock(fx.home, project.id);
  release();
});

test("P1 Lane fence: adoption CAS rejects a stale Project-path snapshot", async (t) => {
  const fx = await setupNewLaneDispatch(t);
  const { home, store, task, project, preparer, item, groupId, laneIds } = fx;

  const held = preparer.acquireTaskProjectMaintenanceLocks(task.id);
  let workspaces;
  try {
    workspaces = new Map();
    for (const laneId of laneIds) {
      workspaces.set(laneId, await preparer.prepareExecutionLaneWorkspace(
        task.id, groupId, laneId,
        { purpose: "execution", workItemId: item.id },
        { current: held.current }
      ));
    }
  } finally {
    held.release();
  }

  // Simulate a migrate in the prepare/adopt gap: the under-fence Project path
  // snapshot handed to dispatch is stale. The adoption CAS must fail closed.
  const stalePaths = new Map([[project.id, join(home, "projects", "project-1-now-managed")]]);
  assert.throws(
    () => runTaskCommand(
      [
        "work", "dispatch", `${task.id}/${item.id}`,
        "--strategy", "fixed:2",
        "--lane-role", "worker",
        "--lane-role", "worker-2"
      ],
      store,
      {
        now: () => new Date(NOW),
        executionLaneWorkspaces: workspaces,
        laneDispatchProjectPaths: stalePaths,
        runtime: { notifyStateChanged() {}, notifyMailboxChanged() {} }
      }
    ),
    /Project path changed during Lane dispatch/
  );
  // The transaction rolled back: no runs, no adopted workspaces, no Group.
  assert.equal(
    store.listAgentRuns(task.id).filter(({ status }) => status === "active").length,
    0,
    "no runs survived the CAS rejection"
  );
  for (const laneId of laneIds) {
    assert.equal(
      store.getManagedWorkspace({
        type: "execution-lane",
        taskId: task.id,
        executionGroupId: groupId,
        executionLaneId: laneId,
        purpose: "execution",
        workItemId: item.id
      }),
      null,
      `Lane ${laneId} was not adopted after CAS rejection`
    );
  }
});

test("P1 Lane fence: adoption CAS rejects a changed Task binding set", async (t) => {
  const fx = await setupNewLaneDispatch(t);
  const { store, task, project, preparer, item, groupId, laneIds } = fx;

  const held = preparer.acquireTaskProjectMaintenanceLocks(task.id);
  let workspaces;
  try {
    workspaces = new Map();
    for (const laneId of laneIds) {
      workspaces.set(laneId, await preparer.prepareExecutionLaneWorkspace(
        task.id, groupId, laneId,
        { purpose: "execution", workItemId: item.id },
        { current: held.current }
      ));
    }
  } finally {
    held.release();
  }

  // A binding-set snapshot that no longer matches the Task's current bindings.
  const staleBindings = new Map([
    [project.id, project.path],
    ["project-999", "/nonexistent"]
  ]);
  assert.throws(
    () => runTaskCommand(
      [
        "work", "dispatch", `${task.id}/${item.id}`,
        "--strategy", "fixed:2",
        "--lane-role", "worker",
        "--lane-role", "worker-2"
      ],
      store,
      {
        now: () => new Date(NOW),
        executionLaneWorkspaces: workspaces,
        laneDispatchProjectPaths: staleBindings,
        runtime: { notifyStateChanged() {}, notifyMailboxChanged() {} }
      }
    ),
    /Task Project bindings changed during Lane dispatch/
  );
});

// ===========================================================================
// P2 (archive pending set): rebuild pending under the fence
// ===========================================================================

async function archiveFixture(t) {
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
    defaultAgent: "codex"
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

/** Create a pre-identity Task with a worktree on its legacy `yui/task-N/main` ref. */
async function legacyTaskWithRef(fixture) {
  const { store, project, workspace } = fixture;
  const created = runTaskCommand(
    ["create", "Legacy Task", "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  const git = new NodeGitWorkspace();
  const physical = await git.ensureWorktree({
    repositoryPath: project.path,
    container: join(workspace, "worktree", project.name),
    taskSegment: task.id,
    roleName: "main",
    baseRef: task.projectBindings[0].baseRef
  });
  return { task, legacyRef: physical.branch };
}

test("P2 archive: a Task that transitions terminal -> active is refused, not archived", async (t) => {
  const fixture = await archiveFixture(t);
  const { store, project, preparer } = fixture;
  const { task, legacyRef } = await legacyTaskWithRef(fixture);

  // The Task is terminal when the pre-lock scan observes its ref.
  const completed = completeTask(activateTask(task, NOW), NOW, { by: "leader", summary: "done" });
  store.saveTask(completed);
  assert.equal(store.getTask(task.id).status, "completed");

  // A git-port Proxy that reopens the Task on the SECOND listRefs call: the
  // under-fence re-scan. The pre-lock scan (first call) still sees a terminal
  // owner; the old code would have carried that classification into the pending
  // set and archived the ref. The new code re-classifies under the fence and
  // must refuse.
  const realGit = new NodeGitWorkspace();
  let listCalls = 0;
  const proxyGit = new Proxy(realGit, {
    get(target, property) {
      if (property === "listRefs") {
        return async (path, namespace) => {
          listCalls += 1;
          if (listCalls === 2) {
            store.saveTask(reopenTask(store.getTask(task.id), NOW));
          }
          return target.listRefs(path, namespace);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const proxyPreparer = new FileTaskWorkspacePreparer(
    fixture.home, store, proxyGit, () => new Date(NOW)
  );

  const result = await proxyPreparer.archiveLegacyTaskRefs();
  assert.equal(listCalls, 2, "archive scanned refs once before the lock and once under it");
  assert.deepEqual(result.archived, [], "the now-active Task's ref was not archived");
  assert.ok(
    result.refused.some((entry) => entry.endsWith(legacyRef)),
    `the ref was refused: ${JSON.stringify(result.refused)}`
  );
  // The source ref still exists; no archive ref was created.
  const refs = git(project.path, ["for-each-ref", "--format=%(refname)", "refs/heads/yui/"]);
  assert.ok(refs.includes(legacyRef), "the source ref was not deleted");
  const archiveRefs = git(project.path, ["for-each-ref", "--format=%(refname)", "refs/yui/archive/"]);
  assert.equal(archiveRefs, "", "no archive ref was created");
});

test("P2 archive: a concurrent migrate fails while the archive fence is held", async (t) => {
  const fixture = await archiveFixture(t);
  const { store, project } = fixture;
  // A legacy ref for an unknown owner (archivable) so the archive proceeds to
  // its Git effects under the fence.
  git(project.path, ["branch", "yui/task-999/main"]);
  store.saveProject({ ...project, remoteUrl: "git@example.invalid:yui.git" });

  // Intercept the archive's ref-update seam: while the fence is held, a
  // migrate must fail at fence acquisition.
  const realGit = new NodeGitWorkspace();
  const proxyGit = new Proxy(realGit, {
    get(target, property) {
      if (property === "updateRef") {
        return async (input) => {
          await assert.rejects(
            runProjectCommand(["migrate", project.id], store, { now: () => new Date(NOW) }),
            ProjectMaintenanceLockedError
          );
          return target.updateRef(input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const proxyPreparer = new FileTaskWorkspacePreparer(
    fixture.home, store, proxyGit, () => new Date(NOW)
  );

  const result = await proxyPreparer.archiveLegacyTaskRefs();
  assert.ok(
    result.archived.some((entry) => entry.endsWith("yui/task-999/main")),
    `the unknown-owner ref was archived: ${JSON.stringify(result.archived)}`
  );
});

// ===========================================================================
// P2 (migrate stale metadata): one under-fence Project snapshot
// ===========================================================================

test("P2 migrate: a branch change between the pre-lock read and the lock fails closed", async (t) => {
  const fixture = await archiveFixture(t);
  const { store, project } = fixture;
  store.saveProject({ ...project, remoteUrl: "git@example.invalid:yui.git" });

  // A store Proxy that returns a changed stableBranch on the SECOND listProjects
  // call: the under-fence re-read. The pre-lock read (first call) sees the
  // original branch; the old code would have driven the clone from that stale
  // metadata. The new code compares the under-fence snapshot and fails closed.
  let listCalls = 0;
  const proxiedStore = new Proxy(store, {
    get(target, property) {
      if (property === "listProjects") {
        return () => {
          listCalls += 1;
          const projects = target.listProjects();
          if (listCalls === 2) {
            return projects.map((candidate) => candidate.id === project.id
              ? { ...candidate, stableBranch: "develop" }
              : candidate);
          }
          return projects;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await assert.rejects(
    runProjectCommand(["migrate", project.id], proxiedStore, { now: () => new Date(NOW) }),
    /Project changed while migrating/
  );
  assert.equal(listCalls, 2, "migrate read the Project before the lock and re-read it under the fence");
  // The catalog was not switched: the Project is still external on its original path.
  const after = store.getProject(project.id);
  assert.equal(after.ownership, "external");
  assert.equal(after.stableBranch, "main");
});

test("diagnostic: reopen after under-lock classification does not archive the live ref", async (t) => {
  const fixture = await archiveFixture(t);
  const { store, project } = fixture;
  const { task, legacyRef } = await legacyTaskWithRef(fixture);
  store.saveTask(completeTask(activateTask(task, NOW), NOW, { by: "leader", summary: "done" }));

  const realGit = new NodeGitWorkspace();
  let reopened = false;
  const proxyGit = new Proxy(realGit, {
    get(target, property) {
      if (property === "inspectRecordedWorktree") {
        return async (input) => {
          reopened = true;
          store.saveTask(reopenTask(store.getTask(task.id), NOW));
          return target.inspectRecordedWorktree(input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const proxyPreparer = new FileTaskWorkspacePreparer(
    fixture.home, store, proxyGit, () => new Date(NOW)
  );

  const result = await proxyPreparer.archiveLegacyTaskRefs();
  assert.equal(reopened, true);
  assert.equal(store.getTask(task.id).status, "active");
  assert.ok(!result.archived.some((entry) => entry.endsWith(legacyRef)));
  assert.ok(git(project.path, ["for-each-ref", "--format=%(refname)", "refs/heads/yui/"])
    .includes(legacyRef));
});

// ===========================================================================
// ReviewRound 9 diagnostic regressions
// ===========================================================================

test("RR9: a crashed acquisition before owner publication does not wedge the Project forever", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr9-ownerless-lock-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = projectMaintenanceLockPath(home, "project-1");

  // acquireProjectMaintenanceLock publishes the directory before its owner
  // file. A hard kill in that exact window leaves this supported crash residue.
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  const old = new Date(Date.now() - 5_000);
  utimesSync(lock, old, old);

  // A stale acquisition must either be safely reclaimed or fail with a bounded
  // orphan diagnosis. The current generic contention error never converges.
  const release = acquireProjectMaintenanceLock(home, "project-1");
  release();
});

test("RR9: reopening after archive classification cannot delete the now-active Task ref", async (t) => {
  const fixture = await archiveFixture(t);
  const { store, project } = fixture;
  const created = runTaskCommand(
    ["create", "Archive classification race", "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  const legacyRef = `refs/heads/yui/${task.id}/main`;
  git(project.path, ["branch", `yui/${task.id}/main`]);
  store.saveTask(completeTask(activateTask(task, NOW), NOW, {
    by: "leader",
    summary: "terminal before archive"
  }));

  // Return the terminal snapshot to archive, then perform the supported reopen
  // immediately after that classification read. The Project fence does not
  // serialize Task status transitions, so archive must revalidate before the
  // ref mutation or the transition must honor the same fence.
  let reopened = false;
  const proxiedStore = new Proxy(store, {
    get(target, property) {
      if (property === "getTask") {
        return (taskId) => {
          const snapshot = target.getTask(taskId);
          if (!reopened && taskId === task.id && snapshot?.status === "completed") {
            reopened = true;
            target.saveTask(reopenTask(snapshot, NOW));
          }
          return snapshot;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const preparer = new FileTaskWorkspacePreparer(
    fixture.home, proxiedStore, undefined, () => new Date(NOW)
  );

  const result = await preparer.archiveLegacyTaskRefs();
  assert.equal(reopened, true, "the supported reopen occurred after classification");
  assert.equal(store.getTask(task.id).status, "active");
  assert.deepEqual(result.archived, [], "an active Task ref is never archived");
  assert.ok(
    git(project.path, ["for-each-ref", "--format=%(refname)", legacyRef]).includes(legacyRef),
    "the active source ref remains"
  );
});

test("RR9: direct WorkItem cleanup honors an already-held Project maintenance fence", async (t) => {
  const fixture = await laneFixture(t);
  const { home, store, task, project, preparer } = fixture;
  const item = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Cleanup fence probe",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const workspace = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  store.saveWorkItem(task.id, retireWorkItem(
    store.getWorkItem(task.id, item.id),
    { by: "leader", summary: "done" },
    NOW
  ));
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() {}
  });

  const release = acquireProjectMaintenanceLock(home, project.id);
  try {
    await assert.rejects(
      coordinator.cleanupWorkItem(task.id, item.id, "abandoned"),
      ProjectMaintenanceLockedError
    );
    assert.ok(existsSync(workspace.entries[0].path), "the fenced worktree remains untouched");
  } finally {
    release();
  }
});

test("RR9: failed new-Lane preparation compensates before releasing its Project fence", async (t) => {
  const fixture = await setupNewLaneDispatch(t);
  const {
    root, repositoryPath, store, task, project, preparer, item, groupId, laneIds
  } = fixture;
  const remote = join(root, "remote.git");
  execFileSync("git", ["clone", "--quiet", "--bare", repositoryPath, remote]);
  store.saveProject({ ...store.getProject(project.id), remoteUrl: remote });

  const held = preparer.acquireTaskProjectMaintenanceLocks(task.id);
  const workspace = await preparer.prepareExecutionLaneWorkspace(
    task.id,
    groupId,
    laneIds[0],
    { purpose: "execution", workItemId: item.id },
    { current: held.current }
  );

  // This is the exact ordering in prepareExecutionLaneWorkspacesForCommand's
  // catch path when a later Lane fails: release first, then compensate the
  // already-created map. A migrate can therefore switch the catalog before
  // compensation and make the external-backed worktree unidentifiable from
  // the new canonical repository.
  held.release();
  await runProjectCommand(["migrate", project.id], store, { now: () => new Date(NOW) });
  await assert.doesNotReject(
    preparer.discardUnadoptedExecutionLaneWorkspaces(
      new Map([[laneIds[0], workspace]])
    )
  );
  assert.equal(
    existsSync(workspace.entries.find(({ access }) => access === "write").path),
    false,
    "the unadopted external-backed Lane was removed"
  );
});

test("RR10: a recycled PID does not keep an orphaned reclaim lock alive", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr10-reclaim-pid-reuse-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = projectMaintenanceLockPath(home, "project-1");
  const reclaimLock = `${lock}.reclaim`;
  const old = new Date(Date.now() - 5_000);

  // Both records represent crashed processes. The reclaim lock deliberately
  // carries this live process's PID with a different start identity, exactly
  // the durable state produced when the original PID has been recycled.
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(join(lock, "owner"), "99999998:1\n", { mode: 0o600 });
  utimesSync(lock, old, old);
  mkdirSync(reclaimLock, { mode: 0o700 });
  writeFileSync(join(reclaimLock, "owner"), `${process.pid}:stale-start-identity\n`, {
    mode: 0o600
  });
  utimesSync(reclaimLock, old, old);

  const release = acquireProjectMaintenanceLock(home, "project-1");
  release();
});

test("RR10: the supported reopen command honors an already-held Project maintenance fence", async (t) => {
  const fixture = await archiveFixture(t);
  const { home, store, project } = fixture;
  const created = runTaskCommand(
    ["create", "Reopen fence", "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  store.saveTask(completeTask(activateTask(task, NOW), NOW, {
    by: "leader",
    summary: "terminal before reopen"
  }));

  const release = acquireProjectMaintenanceLock(home, project.id);
  try {
    assert.throws(
      () => runTaskCommand(["reopen", task.id], store, {
        now: () => new Date(NOW),
        yuiHome: home
      }),
      ProjectMaintenanceLockedError
    );
    assert.equal(
      store.getTask(task.id).status,
      "completed",
      "a fenced reopen cannot change Task status"
    );
  } finally {
    release();
  }
});

test("RR10: direct Integration cleanup honors an already-held Project maintenance fence", async (t) => {
  const fixture = await archiveFixture(t);
  const { home, store, project } = fixture;
  const created = runTaskCommand(
    ["create", "Integration cleanup fence", "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  let touched = false;
  const realGit = new NodeGitWorkspace();
  const proxyGit = new Proxy(realGit, {
    get(target, property) {
      if (property === "removeIntegrationWorktree") {
        return async () => {
          touched = true;
          return "missing";
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const service = new GitIntegrationService(
    home,
    store,
    proxyGit,
    () => new Date(NOW)
  );
  const integration = {
    id: "integration-rr10",
    taskId: created.data.task.id,
    projectId: project.id,
    status: "committed"
  };

  const release = acquireProjectMaintenanceLock(home, project.id);
  try {
    await assert.rejects(
      service.cleanup(integration),
      ProjectMaintenanceLockedError
    );
    assert.equal(touched, false, "a fenced Integration worktree is untouched");
  } finally {
    release();
  }
});
