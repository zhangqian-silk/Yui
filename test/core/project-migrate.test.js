/**
 * Regression coverage for the Home-owned Project binding and the controlled
 * external -> managed migration:
 *
 *  - a remote URL-only `project clone` defaults to Home-managed ownership and
 *    lives under the persistent Project-identity path;
 *  - `project migrate` clones and verifies the remote before switching the
 *    catalog record atomically, preserving local Yui refs and their objects;
 *    the old external checkout is never touched;
 *  - `project migrate --preflight` is read-only;
 *  - a failed migration leaves no half-migrated state and is retryable;
 *  - already-managed and remote-less Projects are rejected;
 *  - two Homes binding the same remote each own their canonical repository;
 *  - credentials embedded in a remote URL never reach error messages.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { managedProjectPath } from "../../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");

function git(path, args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

function initSeed(path) {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, ["config", "user.name", "Yui Test"]);
  git(path, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(path, "tracked.txt"), "commit A\n");
  git(path, ["add", "tracked.txt"]);
  git(path, ["commit", "-qm", "commit A"]);
}

function migrateFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-project-migrate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const workspace = join(root, "workspace");
  const checkout = join(workspace, "Yui");
  const home = join(root, "home");

  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
  initSeed(seed);
  git(seed, ["remote", "add", "fixture", remote]);
  git(seed, ["push", "-q", "fixture", "main"]);
  const commitA = git(seed, ["rev-parse", "HEAD"]);

  execFileSync("git", ["clone", "-q", "--branch", "main", remote, checkout]);
  git(checkout, ["config", "user.name", "Yui Test"]);
  git(checkout, ["config", "user.email", "yui@example.invalid"]);

  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.saveConfiguredAgent(agent);
  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: workspace,
    defaultAgent: agent.id
  });

  return { root, remote, seed, workspace, checkout, home, store, commitA };
}

async function registerExternalProject(fixture) {
  await runProjectCommand([
    "add", "Yui", fixture.checkout,
    "--remote", fixture.remote,
    "--stable", "main", "--development", "main"
  ], fixture.store, { now: () => new Date(NOW) });
  return fixture.store.getProject("project-1");
}

test("a remote URL-only project clone defaults to Home-managed ownership", async (t) => {
  const fixture = migrateFixture(t);
  const result = await runProjectCommand([
    "clone", "Yui", fixture.remote,
    "--stable", "main", "--development", "main"
  ], fixture.store, { now: () => new Date(NOW) });

  const project = result.data.project;
  assert.equal(project.ownership, "managed");
  const expected = managedProjectPath(fixture.home, project.id);
  assert.equal(project.path, expected);
  assert.ok(existsSync(join(expected, ".git")), "the canonical repository exists under the Home");
  assert.equal(git(expected, ["rev-parse", "HEAD"]), fixture.commitA);
});

test("project migrate switches an external Project to a Home-managed repository", async (t) => {
  const fixture = migrateFixture(t);
  const external = await registerExternalProject(fixture);
  assert.equal(external.ownership, "external");
  assert.equal(external.path, fixture.checkout);

  const result = await runProjectCommand(
    ["migrate", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );

  assert.equal(result.data.preflight, false);
  const migrated = fixture.store.getProject("project-1");
  assert.equal(migrated.ownership, "managed");
  assert.equal(migrated.path, managedProjectPath(fixture.home, "project-1"));
  assert.equal(migrated.remoteUrl, fixture.remote);
  assert.equal(migrated.stableBranch, "main");
  assert.equal(migrated.developmentBranch, "main");
  assert.equal(git(migrated.path, ["rev-parse", "HEAD"]), fixture.commitA);

  // The old external checkout is untouched and still usable.
  assert.equal(git(fixture.checkout, ["rev-parse", "HEAD"]), fixture.commitA);
  assert.ok(existsSync(join(fixture.checkout, "tracked.txt")));
});

test("project migrate preserves local Yui heads and archives with their exact commits", async (t) => {
  const fixture = migrateFixture(t);
  await registerExternalProject(fixture);
  writeFileSync(join(fixture.checkout, "local-task.txt"), "local task commit\n");
  git(fixture.checkout, ["add", "local-task.txt"]);
  git(fixture.checkout, ["commit", "-qm", "local task commit"]);
  const taskCommit = git(fixture.checkout, ["rev-parse", "HEAD"]);
  git(fixture.checkout, ["branch", "yui/task-2/main", taskCommit]);
  git(fixture.checkout, [
    "update-ref", "refs/yui/archive/home-test/heads/yui/task-1/main", fixture.commitA
  ]);
  git(fixture.checkout, ["reset", "--hard", fixture.commitA]);

  await runProjectCommand(
    ["migrate", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );

  const managed = fixture.store.getProject("project-1");
  assert.equal(git(managed.path, ["rev-parse", "refs/heads/yui/task-2/main"]), taskCommit);
  assert.equal(
    git(managed.path, ["rev-parse", "refs/yui/archive/home-test/heads/yui/task-1/main"]),
    fixture.commitA
  );
  assert.equal(
    git(managed.path, ["show", "refs/heads/yui/task-2/main:local-task.txt"]),
    "local task commit"
  );
  assert.equal(
    git(managed.path, ["for-each-ref", "--format=%(refname)", "refs/yui/migration-import/"]),
    "",
    "temporary import refs are always removed"
  );
  assert.equal(
    git(fixture.checkout, ["rev-parse", "refs/heads/yui/task-2/main"]),
    taskCommit,
    "migration does not mutate the source refs"
  );
});

test("a local-ref import failure leaves the Project external and removes the clone", async (t) => {
  const fixture = migrateFixture(t);
  const external = await registerExternalProject(fixture);
  git(fixture.checkout, ["branch", "yui/task-2/main", fixture.commitA]);
  const managedPath = managedProjectPath(fixture.home, "project-1");
  const real = new NodeGitWorkspace();
  const failing = new Proxy(real, {
    get(target, property) {
      if (property === "copyRefs") {
        return async () => {
          throw new Error("simulated local ref import failure");
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await assert.rejects(
    runProjectCommand(["migrate", "project-1"], fixture.store, {
      now: () => new Date(NOW),
      git: failing
    }),
    /simulated local ref import failure/
  );

  assert.deepEqual(fixture.store.getProject("project-1"), external);
  assert.equal(existsSync(managedPath), false);
  assert.equal(git(fixture.checkout, ["rev-parse", "refs/heads/yui/task-2/main"]), fixture.commitA);
});

test("project migrate --preflight is read-only", async (t) => {
  const fixture = migrateFixture(t);
  const external = await registerExternalProject(fixture);
  const before = structuredClone(external);
  const homeEntries = readdirSafe(join(fixture.home, "projects"));

  const result = await runProjectCommand(
    ["migrate", "project-1", "--preflight"],
    fixture.store,
    { now: () => new Date(NOW) }
  );

  assert.equal(result.data.preflight, true);
  assert.equal(result.data.path, managedProjectPath(fixture.home, "project-1"));
  // The catalog record is unchanged.
  assert.deepEqual(fixture.store.getProject("project-1"), before);
  // No persistent managed clone or throwaway preflight clone remains.
  assert.deepEqual(
    readdirSafe(join(fixture.home, "projects")),
    homeEntries,
    "preflight must not leave a managed clone behind"
  );
  assert.equal(
    existsSync(join(fixture.home, "projects", `.preflight-project-1`)),
    false,
    "the throwaway preflight clone is removed"
  );
});

test("a failed migration leaves no half-migrated state and stays retryable", async (t) => {
  const fixture = migrateFixture(t);
  const external = await registerExternalProject(fixture);
  const before = structuredClone(external);
  const managedPath = managedProjectPath(fixture.home, "project-1");

  // A git port whose clone succeeds but whose remote verification fails:
  // the managed clone must be discarded and the catalog untouched.
  const real = new NodeGitWorkspace();
  const failing = new Proxy(real, {
    get(target, property) {
      if (property === "resolveRemoteBaseline") {
        return async () => {
          throw new Error("simulated remote verification failure");
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await assert.rejects(
    runProjectCommand(["migrate", "project-1"], fixture.store, {
      now: () => new Date(NOW),
      git: failing
    }),
    /simulated remote verification failure/
  );

  // No half-migrated state: the catalog still points at the external checkout.
  assert.deepEqual(fixture.store.getProject("project-1"), before);
  assert.equal(existsSync(managedPath), false, "the unfinished managed clone was removed");

  // Retry with the real port succeeds.
  const result = await runProjectCommand(
    ["migrate", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  assert.equal(result.data.preflight, false);
  assert.equal(fixture.store.getProject("project-1").ownership, "managed");
  assert.equal(git(result.data.path, ["rev-parse", "HEAD"]), fixture.commitA);
});

test("project migrate rejects already-managed and remote-less Projects", async (t) => {
  const fixture = migrateFixture(t);

  // Already managed.
  await runProjectCommand([
    "clone", "Yui", fixture.remote,
    "--stable", "main", "--development", "main"
  ], fixture.store, { now: () => new Date(NOW) });
  await assert.rejects(
    runProjectCommand(["migrate", "project-1"], fixture.store, { now: () => new Date(NOW) }),
    /already Home-managed/
  );

  // Remote-less external Project.
  const local = join(fixture.workspace, "Local");
  execFileSync("git", ["init", "-q", "-b", "main", local]);
  git(local, ["config", "user.name", "Yui Test"]);
  git(local, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(local, "f.txt"), "x\n");
  git(local, ["add", "."]);
  git(local, ["commit", "-qm", "init"]);
  await runProjectCommand(
    ["add", "Local", local, "--stable", "main", "--development", "main"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  await assert.rejects(
    runProjectCommand(["migrate", "project-2"], fixture.store, { now: () => new Date(NOW) }),
    /requires a remote URL/
  );
});

test("two Homes binding the same remote each own their canonical repository", async (t) => {
  const fixture = migrateFixture(t);
  const otherHome = join(fixture.root, "other-home");
  ensureStorageSchema(otherHome, NOW);
  const otherStore = new FileTaskStore(otherHome);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  otherStore.saveConfiguredAgent(agent);
  otherStore.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: fixture.workspace,
    defaultAgent: agent.id
  });

  const first = await runProjectCommand([
    "clone", "Yui", fixture.remote,
    "--stable", "main", "--development", "main"
  ], fixture.store, { now: () => new Date(NOW) });
  const second = await runProjectCommand([
    "clone", "Yui", fixture.remote,
    "--stable", "main", "--development", "main"
  ], otherStore, { now: () => new Date(NOW) });

  // Both Projects are project-1 in their own Home, but the managed paths
  // differ because each Home owns its projects directory.
  assert.equal(first.data.project.id, "project-1");
  assert.equal(second.data.project.id, "project-1");
  assert.notEqual(first.data.project.path, second.data.project.path);
  assert.ok(existsSync(join(first.data.project.path, ".git")));
  assert.ok(existsSync(join(second.data.project.path, ".git")));
  assert.equal(git(first.data.project.path, ["rev-parse", "HEAD"]), fixture.commitA);
  assert.equal(git(second.data.project.path, ["rev-parse", "HEAD"]), fixture.commitA);
});

test("credentials in a remote URL never reach error messages", async (t) => {
  const fixture = migrateFixture(t);
  // A URL with embedded credentials pointing at an unreachable host.
  const credentialUrl = "https://user:s3cr3t@nonexistent.example.invalid/repo.git";
  await assert.rejects(
    runProjectCommand([
      "clone", "Yui", credentialUrl,
      "--stable", "main", "--development", "main"
    ], fixture.store, { now: () => new Date(NOW) }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(
        message.includes("s3cr3t"),
        false,
        `error message leaked credentials: ${message}`
      );
      return true;
    }
  );
});

test("after migration the external checkout is no longer needed", async (t) => {
  const fixture = migrateFixture(t);
  await registerExternalProject(fixture);
  await runProjectCommand(
    ["migrate", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );

  // The user moves or deletes their old external checkout.
  rmSync(fixture.checkout, { recursive: true, force: true });

  // Project refresh works against the Home-managed repository.
  const refreshed = await runProjectCommand(
    ["refresh", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  assert.equal(refreshed.data.project.path, managedProjectPath(fixture.home, "project-1"));

  // Task preparation creates worktrees from the managed repository, not the
  // deleted external checkout.
  const created = runTaskCommand(
    ["create", "Managed Task", "--project", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const preparer = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    undefined,
    () => new Date(NOW)
  );
  const preparation = await preparer.prepareTaskWorkspace(created.data.task.id);
  assert.equal(preparation.status, "ready");
  const workspace = fixture.store.getTaskWorkspace(created.data.task.id);
  assert.ok(workspace);
  assert.equal(workspace.entries[0].path.includes(fixture.checkout), false);
  assert.ok(existsSync(workspace.entries[0].path));
});

function readdirSafe(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}
