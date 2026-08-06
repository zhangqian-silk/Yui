import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-08-02T08:00:00.000Z");

function git(path, args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

function projectFixture(t, stable = "main") {
  const root = mkdtempSync(join(tmpdir(), "yui-project-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const workspace = join(root, "workspace");
  const checkout = join(workspace, "Yui");
  const home = join(root, "home");

  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, ["config", "user.name", "Yui Test"]);
  git(seed, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(seed, ".gitignore"), "ignored.log\n");
  writeFileSync(join(seed, "tracked.txt"), "commit A\n");
  git(seed, ["add", ".gitignore", "tracked.txt"]);
  git(seed, ["commit", "-qm", "commit A"]);
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

  return {
    root,
    remote,
    seed,
    workspace,
    checkout,
    home,
    store,
    stable,
    commitA
  };
}

async function registerProject(fixture) {
  await runProjectCommand([
    "add", "Yui", fixture.checkout,
    "--remote", fixture.remote,
    "--stable", fixture.stable,
    "--development", fixture.stable
  ], fixture.store, { now: () => new Date(NOW) });
  return fixture.store.getProject("project-1");
}

function advanceRemote(fixture, contents = "commit B\n") {
  writeFileSync(join(fixture.seed, "tracked.txt"), contents);
  git(fixture.seed, ["commit", "-qam", contents.trim()]);
  git(fixture.seed, ["push", "-q", "fixture", "main"]);
  return git(fixture.seed, ["rev-parse", "HEAD"]);
}

async function createAndPrepareTask(fixture, title) {
  const created = runTaskCommand([
    "create", title, "--project", "Yui"
  ], fixture.store, { now: () => new Date(NOW) });
  const task = created.data.task;
  const preparer = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    undefined,
    () => new Date(NOW)
  );
  const preparation = await preparer.prepareTaskWorkspace(task.id);
  assert.equal(preparation.status, "ready");
  const workspace = fixture.store.getRoleWorkspace(task.id, "leader");
  assert.ok(workspace);
  return { task, preparer, entry: workspace.entries[0] };
}

async function assertRefreshRejected(fixture, expected) {
  const headBefore = git(fixture.checkout, ["rev-parse", "HEAD"]);
  const projectBefore = structuredClone(fixture.store.getProject("project-1"));
  await assert.rejects(
    runProjectCommand(["refresh", "Yui"], fixture.store),
    expected
  );
  assert.equal(git(fixture.checkout, ["rev-parse", "HEAD"]), headBefore);
  assert.deepEqual(fixture.store.getProject("project-1"), projectBefore);
}

for (const stableRef of ["main", "refs/heads/main"]) {
  test(`Project refresh advances ${stableRef} while preserving old Task pins`, async (t) => {
    const fixture = projectFixture(t, stableRef);
    const project = await registerProject(fixture);
    assert.equal(project.stableBranch, stableRef);
    assert.equal(project.developmentBranch, stableRef);
    const storedBeforeRefresh = structuredClone(project);
    const oldTask = await createAndPrepareTask(fixture, "Old Task");
    assert.equal(oldTask.entry.baseCommit, fixture.commitA);

    writeFileSync(join(fixture.checkout, "ignored.log"), "keep me\n");
    const unrelatedOrigin = join(fixture.root, "unrelated-origin.git");
    git(fixture.checkout, ["remote", "set-url", "origin", unrelatedOrigin]);
    const commitB = advanceRemote(fixture);

    const refreshed = await runProjectCommand(["refresh", "Yui"], fixture.store);
    assert.match(refreshed.output, /Refreshed project project-1/);
    assert.deepEqual(Object.keys(refreshed.data).sort(), [
      "changed", "fromCommit", "project", "toCommit"
    ]);
    assert.deepEqual(refreshed.data, {
      project: storedBeforeRefresh,
      fromCommit: fixture.commitA,
      toCommit: commitB,
      changed: true
    });
    assert.equal(git(fixture.checkout, ["rev-parse", "HEAD"]), commitB);
    assert.equal(git(fixture.checkout, ["symbolic-ref", "--short", "HEAD"]), "main");
    assert.equal(git(fixture.checkout, ["remote", "get-url", "origin"]), unrelatedOrigin);
    assert.equal(readFileSync(join(fixture.checkout, "ignored.log"), "utf8"), "keep me\n");
    assert.deepEqual(fixture.store.getProject(project.id), storedBeforeRefresh);

    await oldTask.preparer.prepareTaskWorkspace(oldTask.task.id);
    assert.equal(
      fixture.store.getRoleWorkspace(oldTask.task.id, "leader").entries[0].baseCommit,
      fixture.commitA
    );
    const newTask = await createAndPrepareTask(fixture, "New Task");
    assert.equal(newTask.entry.baseCommit, commitB);

    const current = await runProjectCommand(["refresh", project.id], fixture.store);
    assert.match(current.output, /already current/i);
    assert.deepEqual(current.data, {
      project: storedBeforeRefresh,
      fromCommit: commitB,
      toCommit: commitB,
      changed: false
    });
  });
}

test("Project refresh rejects malformed full branch refs before network access", async (t) => {
  for (const stableRef of ["refs/heads/", "refs/heads/-invalid"]) {
    await t.test(stableRef, async (t) => {
      const fixture = projectFixture(t);
      const project = await registerProject(fixture);
      fixture.store.saveProject({
        ...project,
        remoteUrl: join(fixture.root, "must-not-be-fetched.git"),
        stableBranch: stableRef,
        developmentBranch: stableRef
      });
      const originBefore = git(fixture.checkout, ["remote", "get-url", "origin"]);

      await assertRefreshRejected(fixture, /Git stable branch is invalid\./);
      assert.equal(git(fixture.checkout, ["symbolic-ref", "--short", "HEAD"]), "main");
      assert.equal(git(fixture.checkout, ["rev-parse", "HEAD"]), fixture.commitA);
      assert.equal(git(fixture.checkout, ["rev-parse", "refs/heads/main"]), fixture.commitA);
      assert.equal(git(fixture.checkout, ["remote", "get-url", "origin"]), originBefore);
      assert.equal(git(fixture.checkout, ["status", "--porcelain=v1"]), "");
    });
  }
});

test("Project refresh supports HEAD and returns its stable JSON shape through the CLI", async (t) => {
  const fixture = projectFixture(t, "HEAD");
  const project = await registerProject(fixture);
  const unrelatedOrigin = join(fixture.root, "unrelated-origin.git");
  git(fixture.checkout, ["remote", "set-url", "origin", unrelatedOrigin]);
  const commitB = advanceRemote(fixture);

  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", "project", "refresh", project.id],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: fixture.home }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, {
    project,
    fromCommit: fixture.commitA,
    toCommit: commitB,
    changed: true
  });
  assert.equal(git(fixture.checkout, ["rev-parse", "HEAD"]), commitB);
  assert.equal(git(fixture.checkout, ["remote", "get-url", "origin"]), unrelatedOrigin);
  assert.equal(existsSync(join(fixture.home, "projects")), false);
});

test("Project refresh rejects HEAD when checkout is on another symbolic branch", async (t) => {
  const fixture = projectFixture(t, "HEAD");
  await registerProject(fixture);
  git(fixture.checkout, ["checkout", "-qb", "topic"]);
  const before = {
    branch: git(fixture.checkout, ["symbolic-ref", "--short", "HEAD"]),
    head: git(fixture.checkout, ["rev-parse", "HEAD"]),
    status: git(fixture.checkout, ["status", "--porcelain=v1", "--untracked-files=all"]),
    contents: readFileSync(join(fixture.checkout, "tracked.txt"), "utf8"),
    project: structuredClone(fixture.store.getProject("project-1")),
    origin: git(fixture.checkout, ["remote", "get-url", "origin"])
  };
  const commitB = advanceRemote(fixture);

  let rejection;
  try {
    await runProjectCommand(["refresh", "Yui"], fixture.store);
  } catch (error) {
    rejection = error;
  }
  const branchAfter = git(fixture.checkout, ["symbolic-ref", "--short", "HEAD"]);
  const headAfter = git(fixture.checkout, ["rev-parse", "HEAD"]);
  assert.ok(
    rejection instanceof Error,
    `Project refresh unexpectedly succeeded; branch=${branchAfter}; HEAD=${headAfter}; remote main=${commitB}.`
  );
  assert.match(rejection.message, /stable branch: expected main, found topic/i);
  assert.equal(branchAfter, before.branch);
  assert.equal(headAfter, before.head);
  assert.equal(git(fixture.checkout, ["rev-parse", "refs/heads/topic"]), before.head);
  assert.equal(
    git(fixture.checkout, ["status", "--porcelain=v1", "--untracked-files=all"]),
    before.status
  );
  assert.equal(readFileSync(join(fixture.checkout, "tracked.txt"), "utf8"), before.contents);
  assert.deepEqual(fixture.store.getProject("project-1"), before.project);
  assert.equal(git(fixture.checkout, ["remote", "get-url", "origin"]), before.origin);
});

test("Project refresh rejects HEAD from a detached checkout", async (t) => {
  const fixture = projectFixture(t, "HEAD");
  await registerProject(fixture);
  git(fixture.checkout, ["checkout", "--detach", "-q", fixture.commitA]);
  advanceRemote(fixture);

  await assertRefreshRejected(fixture, /detached HEAD/i);
  assert.equal(git(fixture.checkout, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
  assert.equal(git(fixture.checkout, ["rev-parse", "refs/heads/main"]), fixture.commitA);
  assert.equal(git(fixture.checkout, ["status", "--porcelain=v1"]), "");
});

test("Project refresh rejects missing, non-symbolic, and invalid remote HEAD", async (t) => {
  const cases = [
    ["missing", "ref: refs/heads/missing\n"],
    ["non-symbolic", undefined],
    ["invalid", "ref: refs/heads/-invalid\n"]
  ];
  for (const [name, remoteHead] of cases) {
    await t.test(name, async (t) => {
      const fixture = projectFixture(t, "HEAD");
      await registerProject(fixture);
      advanceRemote(fixture);
      writeFileSync(
        join(fixture.remote, "HEAD"),
        remoteHead ?? `${fixture.commitA}\n`
      );

      await assertRefreshRejected(fixture, /Project remote HEAD/i);
      assert.equal(git(fixture.checkout, ["rev-parse", "refs/heads/main"]), fixture.commitA);
      assert.equal(git(fixture.checkout, ["status", "--porcelain=v1"]), "");
    });
  }
});

test("Project refresh rejects invalid Project configuration before network access", async (t) => {
  await t.test("Project without a remote URL", async (t) => {
    const fixture = projectFixture(t);
    await registerProject(fixture);
    await runProjectCommand(["update", "Yui", "--clear-remote"], fixture.store);

    await assertRefreshRejected(fixture, /requires a remote URL/i);
  });

  await t.test("different stable and development branches", async (t) => {
    const fixture = projectFixture(t);
    const project = await registerProject(fixture);
    fixture.store.saveProject({
      ...project,
      remoteUrl: join(fixture.root, "must-not-be-fetched.git"),
      developmentBranch: "develop"
    });

    await assertRefreshRejected(fixture, /matching stable and development branches/i);
  });

  await t.test("checkout on the wrong symbolic branch", async (t) => {
    const fixture = projectFixture(t);
    const project = await registerProject(fixture);
    git(fixture.checkout, ["checkout", "-qb", "other"]);
    fixture.store.saveProject({
      ...project,
      remoteUrl: join(fixture.root, "must-not-be-fetched.git")
    });

    await assertRefreshRejected(
      fixture,
      /stable branch: expected main, found other/i
    );
  });
});

test("Project refresh rejects tracked and untracked dirt before fetch", async (t) => {
  for (const kind of ["tracked", "untracked"]) {
    await t.test(kind, async (t) => {
      const fixture = projectFixture(t);
      await registerProject(fixture);
      await runProjectCommand([
        "update", "Yui", "--remote", join(fixture.root, "must-not-be-fetched.git")
      ], fixture.store);
      if (kind === "tracked") {
        writeFileSync(join(fixture.checkout, "tracked.txt"), "dirty\n");
      } else {
        writeFileSync(join(fixture.checkout, "untracked.txt"), "dirty\n");
      }

      await assertRefreshRejected(fixture, /must be clean before it can be refreshed/i);
      assert.notEqual(
        git(fixture.checkout, ["status", "--porcelain=v1", "--untracked-files=all"]),
        ""
      );
    });
  }
});

test("Project refresh fails closed for divergence, a missing ref, and fetch failure", async (t) => {
  await t.test("diverged checkout", async (t) => {
    const fixture = projectFixture(t);
    await registerProject(fixture);
    advanceRemote(fixture);
    writeFileSync(join(fixture.checkout, "tracked.txt"), "local commit C\n");
    git(fixture.checkout, ["commit", "-qam", "local commit C"]);

    await assertRefreshRejected(fixture, /cannot be fast-forwarded/i);
    assert.equal(git(fixture.checkout, ["status", "--porcelain=v1"]), "");
  });

  await t.test("missing remote branch", async (t) => {
    const fixture = projectFixture(t);
    await registerProject(fixture);
    git(fixture.checkout, ["checkout", "-qb", "missing"]);
    await runProjectCommand([
      "update", "Yui", "--stable", "missing", "--development", "missing"
    ], fixture.store);

    await assertRefreshRejected(
      fixture,
      /couldn't find remote ref refs\/heads\/missing/i
    );
    assert.equal(git(fixture.checkout, ["status", "--porcelain=v1"]), "");
  });

  await t.test("unreachable remote", async (t) => {
    const fixture = projectFixture(t);
    await registerProject(fixture);
    await runProjectCommand([
      "update", "Yui", "--remote", join(fixture.root, "missing-remote.git")
    ], fixture.store);

    await assertRefreshRejected(fixture, /Git command failed/i);
    assert.equal(git(fixture.checkout, ["status", "--porcelain=v1"]), "");
  });
});
