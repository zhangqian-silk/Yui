import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { migrateSqliteSchema, storageMigrationPlan } from "../../dist/storage/sqliteSchema.js";
import { managedTaskRoot } from "../../dist/storage/homeLayout.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { CURRENT_STORAGE_VERSION } from "../../dist/storage/storageVersions.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";

// The collapse-worktree-layout migration is version 20: it takes a v19 Home (real
// worktrees under `<home>/workspaces/worktree/<projectName>/<taskKey>/<roleKey>`
// surfaced through symlink views under `tasks/`) to the single-layer v20 layout
// (real worktrees at `tasks/<taskId>/<owner>/<projectDirectory>`). These tests
// seed the v19 NATIVE on-disk shape directly and drive the real runner to head.
const V19 = 24;
const pendingVersions = Array.from({ length: CURRENT_STORAGE_VERSION - V19 }, (_, index) => V19 + index + 1);

const gitEnv = sanitizedTestEnv({
  GIT_AUTHOR_NAME: "Yui Test",
  GIT_AUTHOR_EMAIL: "yui-test@example.com",
  GIT_COMMITTER_NAME: "Yui Test",
  GIT_COMMITTER_EMAIL: "yui-test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null"
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

/**
 * A Home built from the real storage-v24 prefix, with current singleton fixtures.
 * The runner has the 24->25 collapse step pending. Foreign keys are
 * OFF on this raw connection (the store enables them per-connection), so
 * old-layout rows can be seeded without a full domain graph.
 */
function openV19Home(t, prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  rebuildHistoricalFixture(home, V19);
  const db = new Database(join(home, "yui.db"));
  t.after(() => db.close());
  const head = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  assert.equal(head.version, V19, "real historical schema prefix");
  return { home, db };
}

/** The v19 physical worktree root: `<home>/workspaces/worktree`. */
function worktreeRoot(home) {
  return join(home, "workspaces", "worktree");
}

/**
 * Build a real managed clone + linked worktree in the v19 PHYSICAL layout,
 * `<home>/workspaces/worktree/<projectName>/<taskKey>/<roleKey>`, exactly as the
 * v19 preparer laid them out. Returns the absolute physical paths.
 */
function seedPhysicalWorktrees(home, projectName, taskKey, mainRole, linkedRole) {
  const remote = join(home, "remotes", `${projectName}.git`);
  mkdirSync(join(home, "remotes"), { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=master", remote], { env: gitEnv });
  const container = join(worktreeRoot(home), projectName, taskKey);
  mkdirSync(container, { recursive: true });
  const mainPath = join(container, mainRole);
  execFileSync("git", ["clone", remote, mainPath], { env: gitEnv });
  writeFileSync(join(mainPath, "README.md"), "# managed\n");
  git(["add", "."], mainPath);
  git(["commit", "-m", "managed base"], mainPath);
  git(["push", "origin", "master"], mainPath);
  const linkedPath = join(container, linkedRole);
  git(["worktree", "add", "--detach", linkedPath, "HEAD"], mainPath);
  // An uncommitted edit in the linked worktree must survive the relocation.
  writeFileSync(join(linkedPath, "DIRTY.txt"), "uncommitted\n");
  return { remote, mainPath, linkedPath };
}

/** Create the v19 symlink view `tasks/<taskId>/<owner>/<directory>` -> physical. */
function seedViewSymlink(home, taskId, ownerSegments, directory, physicalPath) {
  const viewRoot = join(managedTaskRoot(home), taskId, ...ownerSegments);
  mkdirSync(viewRoot, { recursive: true });
  const linkPath = join(viewRoot, directory);
  symlinkSync(physicalPath, linkPath, "dir");
  return { viewRoot, linkPath };
}

function managedWorkspacePayload(owner, root, entries) {
  return {
    schemaVersion: 2,
    owner,
    root,
    entries,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}

function insertManagedWorkspace(db, ownerKind, ownerId, taskId, workspace) {
  db.prepare(
    `INSERT INTO managed_workspaces
       (owner_kind, owner_id, task_id, path, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(ownerKind, ownerId, taskId, workspace.root, JSON.stringify(workspace),
    workspace.createdAt, workspace.updatedAt);
}

function projectEntry(projectId, path, directory, access = "write") {
  return {
    projectId,
    directory,
    access,
    path,
    branch: "yui/task/main",
    baseRef: "master",
    baseCommit: "0".repeat(40)
  };
}

/** Insert the catalog row a task-scoped record needs. */
function seedTaskCatalog(db, taskId) {
  db.prepare(
    `INSERT OR IGNORE INTO tasks_catalog
       (task_id, status, lifecycle, is_active, created_at, updated_at)
     VALUES (?, 'active', 'active', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
  ).run(taskId);
}

/**
 * Insert the authoritative Task record carrying the Project bindings the
 * migration reads to reshape an integration worktree's directory segment from
 * the Project name to the bound directory.
 */
function seedTaskRecord(db, taskId, projectBindings) {
  seedTaskCatalog(db, taskId);
  const payload = JSON.stringify({ id: taskId, status: "active", projectBindings });
  db.prepare(
    `INSERT INTO task_records (task_id, payload, updated_at)
     VALUES (?, ?, '2026-09-01T00:00:00.000Z')`
  ).run(taskId, payload);
}

/** Run the real 19->20 collapse migration through the transaction-wrapping runner. */
function runMigration(db) {
  return migrateSqliteSchema(db, { mode: "apply" });
}

test("collapse: the pre-collapse Home retains its fixed next migration as the chain grows", () => {
  const first = storageMigrationPlan(V19)[0];
  assert.equal(first.name, "collapse-worktree-layout");
  assert.equal(first.toVersion, 25);
  assert.equal(first.fromVersion, V19);
});

test("collapse: real worktrees replace their v19 view symlinks at the single-layer path", (t) => {
  const { home, db } = openV19Home(t, "yui-collapse-relocate-");

  const taskId = "task-1";
  const taskKey = "task-1-abcd";
  const { mainPath, linkedPath } = seedPhysicalWorktrees(
    home, "app", taskKey, "main", "work-item-1-efgh"
  );
  seedTaskRecord(db, taskId, [{ projectId: "app", directory: "app" }]);

  // v19 views: the runtime addresses each worktree through a symlink whose name is
  // the bound directory. The collapse must publish the real worktree over it.
  const taskView = seedViewSymlink(home, taskId, ["main"], "app", mainPath);
  const workItemView = seedViewSymlink(
    home, taskId, ["work-items", "work-item-1"], "app", linkedPath
  );
  assert.equal(lstatSync(taskView.linkPath).isSymbolicLink(), true, "task view seeded as symlink");
  assert.equal(
    lstatSync(workItemView.linkPath).isSymbolicLink(), true, "work-item view seeded as symlink"
  );

  // Authoritative registry rows: task main + a work-item worktree. The v19 entry
  // stores the bound directory and the PHYSICAL path; the workspace root is the
  // per-owner VIEW directory.
  const taskRoot = join(managedTaskRoot(home), taskId, "main");
  const workItemRoot = join(managedTaskRoot(home), taskId, "work-items", "work-item-1");
  insertManagedWorkspace(
    db, "task", `task:${taskId}`, taskId,
    managedWorkspacePayload({ type: "task", taskId }, taskRoot, [
      projectEntry("app", mainPath, "app")
    ])
  );
  insertManagedWorkspace(
    db, "work-item", `work-item:${taskId}:work-item-1`, taskId,
    managedWorkspacePayload(
      { type: "work-item", taskId, workItemId: "work-item-1" }, workItemRoot,
      [projectEntry("app", linkedPath, "app")]
    )
  );

  const result = runMigration(db);
  assert.deepEqual(result.applied, pendingVersions);

  // (1) The real worktrees now live at the single-layer Task/owner path — exactly
  // where the v19 view symlink used to point the runtime.
  const newMain = join(taskRoot, "app");
  const newLinked = join(workItemRoot, "app");
  assert.equal(lstatSync(newMain).isDirectory(), true, "task-main is now a real directory");
  assert.equal(
    lstatSync(newMain).isSymbolicLink(), false, "the v19 view symlink was replaced by a real worktree"
  );
  assert.equal(lstatSync(newLinked).isDirectory(), true, "work-item is now a real directory");
  assert.equal(lstatSync(newLinked).isSymbolicLink(), false, "work-item view symlink replaced");

  // The original physical worktrees are PRESERVED as the rollback anchor.
  assert.equal(existsSync(mainPath), true, "original main clone preserved under worktree/");
  assert.equal(existsSync(linkedPath), true, "original linked worktree preserved under worktree/");

  // Uncommitted content survived and git worktree repair reconnected the copy.
  assert.equal(readFileSync(join(newLinked, "DIRTY.txt"), "utf8"), "uncommitted\n");
  assert.equal(
    git(["-C", newLinked, "rev-parse", "--is-inside-work-tree"]), "true",
    "relocated linked worktree is a valid git work tree"
  );
  assert.match(
    git(["-C", newLinked, "status", "--porcelain"]), /DIRTY\.txt/u,
    "uncommitted edit still tracked after repair"
  );

  // (2) Authoritative registry rewritten: entries[].path -> single-layer path, the
  // owner root unchanged, and directory stays the bound directory.
  const taskRow = db
    .prepare("SELECT path, payload FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  const taskWorkspace = JSON.parse(taskRow.payload);
  assert.equal(taskRow.path, taskRoot, "task registry root column unchanged (owner root is stable)");
  assert.equal(taskWorkspace.root, taskRoot, "task workspace root unchanged");
  assert.equal(taskWorkspace.entries[0].path, newMain, "task entry path collapsed to single layer");
  assert.equal(taskWorkspace.entries[0].directory, "app", "task entry directory preserved");
  assert.equal(
    taskWorkspace.entries[0].baseCommit, "0".repeat(40), "untouched entry metadata preserved"
  );

  const workItemRow = db
    .prepare("SELECT payload FROM managed_workspaces WHERE owner_kind = 'work-item'")
    .get();
  const workItemWorkspace = JSON.parse(workItemRow.payload);
  assert.equal(workItemWorkspace.entries[0].path, newLinked, "work-item entry path collapsed");
  assert.equal(workItemWorkspace.entries[0].directory, "app", "work-item entry directory preserved");

  // Ledger advanced to head.
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, CURRENT_STORAGE_VERSION);
});

test("collapse: an integration attempt moves under integrations/<id> with the bound directory", (t) => {
  const { home, db } = openV19Home(t, "yui-collapse-integration-");

  const taskId = "task-1";
  const taskKey = "task-1-abcd";
  const integrationId = "integration-1";

  // The Task binds project "app" to a directory that DIFFERS from the Project name
  // (a `--directory` override). v19 recorded the integration entry.directory as the
  // PROJECT NAME; the v20 runtime addresses it by the BOUND directory, so the
  // collapse must reshape the segment.
  seedTaskRecord(db, taskId, [{ projectId: "app", directory: "custom-dir" }]);

  // v19 integration physical worktree: `worktree/<projectName>/<taskKey>/integrations/<intKey>`.
  const remote = join(home, "remotes", "app.git");
  mkdirSync(join(home, "remotes"), { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=master", remote], { env: gitEnv });
  const intContainer = join(worktreeRoot(home), "app", taskKey, "integrations");
  mkdirSync(intContainer, { recursive: true });
  const intPath = join(intContainer, integrationId);
  execFileSync("git", ["clone", remote, intPath], { env: gitEnv });
  writeFileSync(join(intPath, "README.md"), "# integration\n");
  git(["add", "."], intPath);
  git(["commit", "-m", "integration base"], intPath);

  // v19 integration workspace: root === entry.path (the physical leaf), and
  // entry.directory === project name (NOT the bound directory).
  insertManagedWorkspace(
    db, "integration-attempt", `integration-attempt:${taskId}:${integrationId}`, taskId,
    managedWorkspacePayload(
      { type: "integration-attempt", taskId, integrationAttemptId: integrationId },
      intPath,
      [projectEntry("app", intPath, "app")]
    )
  );

  const result = runMigration(db);
  assert.deepEqual(result.applied, pendingVersions);

  // The integration worktree now lives at
  // `tasks/<taskId>/integrations/<integrationId>/<boundDirectory>`.
  const newIntRoot = join(managedTaskRoot(home), taskId, "integrations", integrationId);
  const newIntPath = join(newIntRoot, "custom-dir");
  assert.equal(lstatSync(newIntPath).isDirectory(), true, "integration worktree relocated");
  assert.equal(existsSync(intPath), true, "original integration worktree preserved as rollback anchor");
  assert.equal(
    git(["-C", newIntPath, "rev-parse", "--is-inside-work-tree"]), "true",
    "relocated integration worktree is valid"
  );

  // Registry rewritten: both root and entry.path move to the single-layer leaf,
  // and entry.directory is reshaped from the Project name to the bound directory.
  const row = db
    .prepare("SELECT path, payload FROM managed_workspaces WHERE owner_kind = 'integration-attempt'")
    .get();
  const workspace = JSON.parse(row.payload);
  assert.equal(row.path, newIntPath, "integration registry path column moved to the leaf");
  assert.equal(workspace.root, newIntPath, "integration workspace root moved to the leaf");
  assert.equal(workspace.entries[0].path, newIntPath, "integration entry path moved to the leaf");
  assert.equal(
    workspace.entries[0].directory, "custom-dir",
    "integration entry directory reshaped to the bound directory"
  );

  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, CURRENT_STORAGE_VERSION);
});

test("collapse: a foreign directory at the relocation target is refused, source untouched", (t) => {
  const { home, db } = openV19Home(t, "yui-collapse-conflict-");

  const taskId = "task-1";
  const taskKey = "task-1-abcd";
  const { mainPath } = seedPhysicalWorktrees(home, "app", taskKey, "main", "linked-efgh");
  seedTaskRecord(db, taskId, [{ projectId: "app", directory: "app" }]);

  const taskRoot = join(managedTaskRoot(home), taskId, "main");
  insertManagedWorkspace(
    db, "task", `task:${taskId}`, taskId,
    managedWorkspacePayload({ type: "task", taskId }, taskRoot, [
      projectEntry("app", mainPath, "app")
    ])
  );

  // Plant a FOREIGN directory exactly at the relocation target (not the expected
  // v19 view symlink). ANY non-symlink at the target is refused outright.
  const target = join(taskRoot, "app");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SOMEONE-ELSES-FILE.txt"), "not ours\n");

  assert.throws(
    () => runMigration(db),
    /relocation target .* already exists/u,
    "refuses to publish over a pre-existing non-symlink at the target"
  );

  // Source preserved; foreign target left exactly as planted; ledger unchanged.
  assert.equal(
    readFileSync(join(mainPath, "README.md"), "utf8"), "# managed\n", "source content intact"
  );
  assert.equal(
    readFileSync(join(target, "SOMEONE-ELSES-FILE.txt"), "utf8"), "not ours\n",
    "foreign target left as-is"
  );
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, V19, "ledger stays at v19 on conflict");
  const row = db
    .prepare("SELECT path FROM managed_workspaces WHERE owner_kind = 'task'")
    .get();
  assert.equal(row.path, taskRoot, "registry pointer unchanged after refusal");
});

test("collapse: a queued/running durable Job under a relocating root is refused", (t) => {
  const { home, db } = openV19Home(t, "yui-collapse-job-");

  const taskId = "task-1";
  const taskKey = "task-1-abcd";
  const { mainPath } = seedPhysicalWorktrees(home, "app", taskKey, "main", "linked-efgh");
  seedTaskRecord(db, taskId, [{ projectId: "app", directory: "app" }]);
  seedViewSymlink(home, taskId, ["main"], "app", mainPath);

  const taskRoot = join(managedTaskRoot(home), taskId, "main");
  insertManagedWorkspace(
    db, "task", `task:${taskId}`, taskId,
    managedWorkspacePayload({ type: "task", taskId }, taskRoot, [
      projectEntry("app", mainPath, "app")
    ])
  );

  // A running Job whose step cwd is under the physical worktree about to relocate.
  const runningJob = { id: "job-1", workspace: mainPath, steps: [{ cwd: mainPath }] };
  db.prepare(
    `INSERT INTO durable_jobs
       (job_id, task_id, status, payload, created_at, updated_at)
     VALUES ('job-1', ?, 'running', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`
  ).run(taskId, JSON.stringify(runningJob));

  assert.throws(
    () => runMigration(db),
    /queued or running durable Job/u,
    "refuses to relocate a tree a live Job is bound to"
  );

  // Fail-closed: nothing published over the view symlink, ledger unchanged.
  const target = join(taskRoot, "app");
  assert.equal(lstatSync(target).isSymbolicLink(), true, "view symlink untouched on refusal");
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, V19, "ledger stays at v19");
});

test("collapse: a Home already single-layer is a clean no-op", (t) => {
  const { home, db } = openV19Home(t, "yui-collapse-noop-");
  // No managed_workspaces rows under the legacy worktree/ root: nothing to relocate.
  const result = runMigration(db);
  assert.deepEqual(result.applied, pendingVersions, "schema still advances to head");
  assert.equal(existsSync(worktreeRoot(home)), false, "no worktree tree fabricated");
  const ledgerHead = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  assert.equal(ledgerHead.version, CURRENT_STORAGE_VERSION);
});
