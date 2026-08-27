import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createProductionRegistry,
  runMigration
} from "../../dist/storage/migration/index.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const now = new Date("2026-08-27T00:00:00.000Z");
const userEnv = sanitizedTestEnv();
const gitEnv = sanitizedTestEnv({
  GIT_AUTHOR_NAME: "Yui Test",
  GIT_AUTHOR_EMAIL: "yui-test@example.com",
  GIT_COMMITTER_NAME: "Yui Test",
  GIT_COMMITTER_EMAIL: "yui-test@example.com"
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

function commitFile(repo, name, body, message) {
  writeFileSync(join(repo, name), body);
  git(["add", "."], repo);
  git(["commit", "-m", message], repo);
}

function newHome(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-project-lifecycle-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function newStore(t, home) {
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  return store;
}

/**
 * A bare remote plus a Home-managed clone that has diverged from it: one
 * local-only commit on the checkout and one remote-only commit on the seed.
 */
function setupDivergedCheckout(home, projectId) {
  const remote = join(home, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=master", remote], { env: gitEnv });
  const seed = join(home, "seed");
  execFileSync("git", ["clone", remote, seed], { env: gitEnv });
  commitFile(seed, "README.md", "# seed\n", "seed");
  git(["push", "origin", "master"], seed);
  mkdirSync(join(home, "projects"), { recursive: true });
  const checkout = join(home, "projects", projectId);
  execFileSync("git", ["clone", remote, checkout], { env: gitEnv });
  commitFile(checkout, "local.txt", "local\n", "local work");
  commitFile(seed, "remote.txt", "remote\n", "remote work");
  git(["push", "origin", "master"], seed);
  return { remote, seed, checkout };
}

function registerManagedProject(store, projectId, checkout, remote) {
  const project = createProject(
    projectId,
    "app",
    checkout,
    { stable: "master", development: "master" },
    now,
    { remoteUrl: remote, ownership: "managed" }
  );
  store.saveProject(project);
  return project;
}

test("project reset refuses divergence without --discard-local and lists the local commits", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  const localHead = git(["rev-parse", "HEAD"], checkout);

  await assert.rejects(
    runProjectCommand(["reset", "project-1"], store, { now: () => now, environment: userEnv }),
    /diverged[\s\S]*local work[\s\S]*--discard-local/u
  );
  // The refusal must not have moved the checkout.
  assert.equal(git(["rev-parse", "HEAD"], checkout), localHead);
});

test("project reset --discard-local hard-resets the checkout to the verified remote baseline", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  const result = await runProjectCommand(
    ["reset", "project-1", "--discard-local"],
    store,
    { now: () => now, environment: userEnv }
  );
  const remoteHead = git(["--git-dir", remote, "rev-parse", "master"], home);
  assert.match(result.output, /Reset project project-1/u);
  assert.equal(git(["rev-parse", "HEAD"], checkout), remoteHead);
  assert.ok(!existsSync(join(checkout, "local.txt")), "the discarded local commit's files must be gone");
  assert.ok(existsSync(join(checkout, "remote.txt")), "the remote commit's files must be present");
});

test("project reset fast-forwards a checkout that is only behind the remote", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, seed, checkout } = setupDivergedCheckout(home, "project-1");
  // Undo the local-only commit so the checkout is merely behind.
  git(["reset", "--hard", "HEAD~1"], checkout);
  registerManagedProject(store, "project-1", checkout, remote);

  const result = await runProjectCommand(
    ["reset", "project-1"],
    store,
    { now: () => now, environment: userEnv }
  );
  const remoteHead = git(["--git-dir", remote, "rev-parse", "master"], home);
  assert.match(result.output, /fast-forward/u);
  assert.equal(git(["rev-parse", "HEAD"], checkout), remoteHead);
  assert.ok(existsSync(join(checkout, "remote.txt")));
  assert.ok(!existsSync(join(seed, "local.txt")));
});

test("project reset refuses a dirty checkout", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  writeFileSync(join(checkout, "uncommitted.txt"), "dirty\n");

  await assert.rejects(
    runProjectCommand(["reset", "project-1", "--discard-local"], store, { now: () => now, environment: userEnv }),
    /clean/u
  );
});

test("project reset refuses a managed Task Session", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  await assert.rejects(
    runProjectCommand(
      ["reset", "project-1", "--discard-local"],
      store,
      { now: () => now, environment: { YUI_SESSION_SCOPE: "task" } }
    ),
    /Operator authority/u
  );
});

test("project replace re-clones the checkout and preserves Yui-local refs", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, seed, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  // A Yui-local ref that must survive the checkout replacement.
  const oldHead = git(["rev-parse", "HEAD"], checkout);
  git(["branch", "yui/task-1/worker"], checkout);
  // Advance the remote so the replace actually changes content.
  commitFile(seed, "remote2.txt", "remote2\n", "remote work 2");
  git(["push", "origin", "master"], seed);

  const result = await runProjectCommand(
    ["replace", "project-1", "--discard-local"],
    store,
    { now: () => now, environment: userEnv }
  );
  const remoteHead = git(["--git-dir", remote, "rev-parse", "master"], home);
  assert.match(result.output, /Replaced project project-1/u);
  assert.equal(git(["rev-parse", "HEAD"], checkout), remoteHead);
  assert.equal(git(["rev-parse", "yui/task-1/worker"], checkout), oldHead);
  assert.ok(existsSync(join(checkout, "remote2.txt")));
  assert.ok(
    !existsSync(join(home, "projects", ".replace-project-1")),
    "the staging clone must be gone after a successful replace"
  );
});

test("project replace requires --discard-local", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  await assert.rejects(
    runProjectCommand(["replace", "project-1"], store, { now: () => now, environment: userEnv }),
    /--discard-local/u
  );
});

test("project retire records the audit trail and blocks further mutation", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  const result = await runProjectCommand(
    ["retire", "project-1", "--reason", "superseded by app-ng"],
    store,
    { now: () => now, environment: userEnv }
  );
  assert.match(result.output, /Retired project project-1/u);
  const retired = store.listProjects().find(({ id }) => id === "project-1");
  assert.equal(retired.status, "retired");
  assert.equal(retired.retirement.reason, "superseded by app-ng");
  assert.equal(retired.retirement.retiredBy, "user");
  assert.equal(retired.retirement.retiredAt, now.toISOString());

  // Read-only inspection still works and shows the lifecycle state.
  const shown = await runProjectCommand(["show", "project-1"], store, { now: () => now, environment: userEnv });
  assert.match(shown.output, /Status: retired/u);
  assert.match(shown.output, /Retirement reason: superseded by app-ng/u);

  // Every mutation path is now closed.
  await assert.rejects(
    runProjectCommand(["retire", "project-1", "--reason", "again"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
  await assert.rejects(
    runProjectCommand(["refresh", "project-1"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
  await assert.rejects(
    runProjectCommand(["update", "project-1", "--alias", "renamed"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
  await assert.rejects(
    runProjectCommand(["reset", "project-1", "--discard-local"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
});

test("project retire refuses while an active Task binds the Project", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  const task = activateTask(createTask(store.nextTaskId(), "Active delivery", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  }), now);
  store.saveTask(task);

  await assert.rejects(
    runProjectCommand(["retire", "project-1", "--reason", "x"], store, { now: () => now, environment: userEnv }),
    /active Task/u
  );
  assert.equal(store.listProjects()[0].status, "active");
});

test("project delete requires a retired Project and an exact --confirm", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  await assert.rejects(
    runProjectCommand(["delete", "project-1", "--confirm", "project-1"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });
  await assert.rejects(
    runProjectCommand(["delete", "project-1", "--confirm", "wrong"], store, { now: () => now, environment: userEnv }),
    /--confirm project-1/u
  );
  assert.ok(store.listProjects().length === 1, "the wrong confirm must not delete the record");
});

test("project delete fails closed while any Task record references the Project", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  // A historical (completed) Task binding: the evidence must stay resolvable.
  const task = createTask(store.nextTaskId(), "Shipped feature", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  });
  store.saveTask(task);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });

  await assert.rejects(
    runProjectCommand(["delete", "project-1", "--confirm", "project-1"], store, { now: () => now, environment: userEnv }),
    /Task records reference/u
  );
  assert.ok(store.listProjects().length === 1);
});

test("project delete removes the catalog record and, with --checkout, the managed checkout", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });

  const result = await runProjectCommand(
    ["delete", "project-1", "--checkout", "--confirm", "project-1"],
    store,
    { now: () => now, environment: userEnv }
  );
  assert.match(result.output, /Deleted project project-1/u);
  assert.equal(store.listProjects().length, 0);
  assert.ok(!existsSync(checkout), "the managed checkout must be removed with --checkout");
});

test("task create refuses to bind a retired Project", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });

  assert.throws(
    () => runTaskCommand(["create", "New delivery", "--project", "project-1"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
});

test("the production migration upgrades Project v4 records to v5 with active status", () => {
  const latest = latestStorageVersionState();
  const source = {
    layout: latest.layout,
    aggregate: latest.aggregate,
    record: { ...latest.record, project: { version: 4, path: latest.record.project.path } }
  };
  const v4Project = {
    schemaVersion: 4,
    id: "project-1",
    name: "app",
    aliases: [],
    path: "/tmp/app",
    ownership: "external",
    stableBranch: "master",
    developmentBranch: "master",
    knowledge: [],
    knowledgeProposals: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  let snapshot = {
    schemaManifest: { recordVersions: { project: 4 } },
    state: { projects: { "project-1": v4Project } }
  };
  let staged = null;
  const target = {
    inspectVersions: () => source,
    detectLiveRuntime: () => ({ active: false }),
    readSource: () => snapshot,
    writeFreshOutput: (next) => { staged = next; },
    rebuildDerivedState: () => ({ rebuiltEffects: [] }),
    validateCurrentState: () => ({ checks: [] }),
    discardFreshOutput: () => { staged = null; },
    atomicSwitchWithBackup: () => { snapshot = staged; staged = null; return { status: "switched" }; }
  };

  const report = runMigration({
    registry: createProductionRegistry(),
    target,
    latest,
    mode: "execute"
  });
  assert.equal(report.outcome, "migrated");
  const migrated = snapshot.state.projects["project-1"];
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.status, "active");
  assert.equal(migrated.retirement, undefined);
  assert.equal(snapshot.schemaManifest.recordVersions.project, 5);
});
