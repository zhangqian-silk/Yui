/**
 * Regression coverage for the controlled Task workspace rebuild, the legacy
 * ref history commands, and the terminal-Task replacement path:
 *
 *  - rebuild mints a fresh workspace identity, re-creates the managed
 *    worktrees under the token-bearing segment, archives legacy refs into
 *    the Home-scoped archive namespace, and removes the old worktrees;
 *  - every failure point leaves the old layout usable and is retryable;
 *  - evidence (Run/WorkItem/ChangeSet/IntegrationAttempt), a dirty
 *    worktree, and a terminal Task block the rebuild;
 *  - `task history list|archive` inspects and archives legacy refs,
 *    refusing refs owned by an open Task;
 *  - `task replace` creates a fresh draft Task with the same bindings and
 *    records the relationship as a milestone, never touching the original;
 *  - two Homes preparing the same Task number in a shared repository never
 *    collide; an existing foreign token branch is never adopted;
 *  - archiving a Task never deletes the Home-managed Project repository.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentRun } from "../../dist/run/agentRun.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runTaskWorkspaceCommand } from "../../dist/commands/taskWorkspaceCommands.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { isLegacyTaskRef } from "../../dist/repository/taskWorkspaceIdentity.js";
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

async function rebuildFixture(t, { remote = false } = {}) {
  const { root, home } = createIsolatedRuntime(t);
  installMockProviderCommands(home);
  const workspace = join(root, "workspace");
  const repositoryPath = join(workspace, "Yui");
  initRepository(repositoryPath);

  let remoteUrl;
  if (remote) {
    const bare = join(root, "remote.git");
    const seed = join(root, "seed");
    execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", bare]);
    execFileSync("git", ["clone", "-q", repositoryPath, seed]);
    // A clone never inherits the source repository's local identity, so the
    // seed must carry its own before any commit (a scrubbed Integration
    // environment provides no global user.name/user.email fallback).
    git(seed, ["config", "user.name", "Yui Test"]);
    git(seed, ["config", "user.email", "yui@example.invalid"]);
    git(seed, ["remote", "add", "fixture", bare]);
    git(seed, ["push", "-q", "fixture", "main"]);
    remoteUrl = bare;
  }

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
    [
      "add", "Yui", repositoryPath,
      ...(remote ? ["--remote", remoteUrl] : []),
      "--stable", "main", "--development", "main"
    ],
    store,
    { now: () => new Date(NOW) }
  );
  const project = store.getProject("project-1");
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  return { root, home, workspace, repositoryPath, remoteUrl, store, project, preparer };
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
  const git = new NodeGitWorkspace();
  const physical = await git.ensureWorktree({
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

function projectBranches(fixture) {
  return git(fixture.project.path, ["for-each-ref", "--format=%(refname)"]).split("\n");
}

test("rebuild mints an identity, re-creates the workspace, and archives legacy refs", async (t) => {
  const fixture = await rebuildFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  const legacyCommit = git(fixture.project.path, ["rev-parse", legacyRef]);
  const legacyWorktree = join(fixture.workspace, "worktree", "Yui", task.id, "main");
  assert.equal(existsSync(legacyWorktree), true);

  const result = await runTaskWorkspaceCommand(
    ["rebuild", task.id],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
  assert.match(result.output, /Rebuilt Task workspace task-1/);
  assert.equal(result.data.resumed, false);
  assert.deepEqual(result.data.archived, [`project-1:refs/heads/${legacyRef}`]);

  const rebuilt = fixture.store.getTask(task.id);
  assert.ok(rebuilt.workspaceIdentity, "the Task now carries its persistent identity");
  assert.equal(rebuilt.workspaceIdentity.taskId, task.id);
  const segment = `${task.id}-${rebuilt.workspaceIdentity.token}`;
  assert.match(segment, /^task-1-[a-f0-9]{8}$/);

  // The new workspace lives under the token-bearing segment.
  const managed = fixture.store.getTaskWorkspace(task.id);
  assert.equal(managed.entries[0].branch, `yui/${segment}/main`);
  assert.equal(managed.entries[0].path, join(fixture.workspace, "worktree", "Yui", segment, "main"));
  assert.equal(existsSync(managed.entries[0].path), true);

  // Legacy branch is gone; its commit survives in the Home-scoped archive.
  const branches = projectBranches(fixture);
  assert.equal(branches.includes(`refs/heads/yui/${segment}/main`), true);
  assert.equal(branches.includes(`refs/heads/${legacyRef}`), false);
  const homeId = fixture.store.getHomeIdentity().homeId;
  const archiveRef = `refs/yui/archive/${homeId}/heads/${legacyRef}`;
  assert.equal(branches.includes(archiveRef), true);
  assert.equal(git(fixture.project.path, ["rev-parse", archiveRef]), legacyCommit);
  assert.equal(existsSync(legacyWorktree), false);

  // The rebuild is resumable: a second run only completes pending cleanup.
  const again = await runTaskWorkspaceCommand(
    ["rebuild", task.id],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
  assert.equal(again.data.resumed, true);
  assert.deepEqual(again.data.archived, []);
  assert.equal(fixture.store.getTask(task.id).workspaceIdentity.token, rebuilt.workspaceIdentity.token);
});

test("rebuild pins remote-default Projects to the advertised remote SHA", async (t) => {
  const fixture = await rebuildFixture(t, { remote: true });
  const { task } = await legacyTask(fixture);
  assert.equal(fixture.store.getTask(task.id).projectBindings[0].baseRef, "main");

  // The remote moves after the legacy layout was created.
  const seed = join(fixture.root, "seed");
  writeFileSync(join(seed, "tracked.txt"), "remote latest\n");
  git(seed, ["commit", "-qam", "remote latest"]);
  git(seed, ["push", "-q", "fixture", "main"]);
  const advertised = git(seed, ["rev-parse", "HEAD"]);

  await runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
    now: () => new Date(NOW)
  });
  const rebuilt = fixture.store.getTask(task.id);
  assert.equal(rebuilt.projectBindings[0].baseRef, advertised);
  const managed = fixture.store.getTaskWorkspace(task.id);
  assert.equal(managed.entries[0].baseCommit, advertised);
  assert.equal(git(managed.entries[0].path, ["rev-parse", "HEAD"]), advertised);
});

test("rebuild --latest refreshes a previously pinned Project to the latest remote SHA", async (t) => {
  const fixture = await rebuildFixture(t, { remote: true });
  const { task } = await legacyTask(fixture);
  const original = fixture.store.getTask(task.id);
  const initialCommit = git(fixture.repositoryPath, ["rev-parse", "main"]);
  fixture.store.saveTask({
    ...original,
    projectBindings: original.projectBindings.map((binding) => ({
      ...binding,
      baseRef: initialCommit
    }))
  });

  const seed = join(fixture.root, "seed");
  writeFileSync(join(seed, "tracked.txt"), "remote latest after first pin\n");
  git(seed, ["commit", "-qam", "remote latest after first pin"]);
  git(seed, ["push", "-q", "fixture", "main"]);
  const advertised = git(seed, ["rev-parse", "HEAD"]);

  await runTaskWorkspaceCommand(["rebuild", task.id, "--latest"], fixture.store, fixture.preparer, {
    now: () => new Date(NOW)
  });

  const rebuilt = fixture.store.getTask(task.id);
  assert.equal(rebuilt.projectBindings[0].baseRef, advertised);
  const managed = fixture.store.getTaskWorkspace(task.id);
  assert.equal(managed.entries[0].baseCommit, advertised);
  assert.equal(git(managed.entries[0].path, ["rev-parse", "HEAD"]), advertised);
});

test("rebuild moves a legacy Task from a migrated external Project into the Home repository", async (t) => {
  const fixture = await rebuildFixture(t, { remote: true });
  const { task, legacyRef, entry } = await legacyTask(fixture);
  const legacyCommit = git(fixture.repositoryPath, ["rev-parse", legacyRef]);
  assert.equal(existsSync(entry.path), true);

  await runProjectCommand(
    ["migrate", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const managedProject = fixture.store.getProject("project-1");
  assert.equal(managedProject.ownership, "managed");
  assert.equal(
    git(managedProject.path, ["rev-parse", legacyRef]),
    legacyCommit,
    "migration preserves the legacy Task ref and its objects in the Home repository"
  );

  await runTaskWorkspaceCommand(
    ["rebuild", task.id],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );

  const rebuilt = fixture.store.getTask(task.id);
  const segment = `${task.id}-${rebuilt.workspaceIdentity.token}`;
  const workspace = fixture.store.getTaskWorkspace(task.id);
  assert.equal(workspace.entries[0].branch, `yui/${segment}/main`);
  assert.equal(existsSync(workspace.entries[0].path), true);
  assert.equal(
    git(workspace.entries[0].path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    join(managedProject.path, ".git"),
    "the rebuilt checkout is owned by the Project repository in YUI_HOME"
  );
  assert.equal(existsSync(entry.path), false, "the exact legacy worktree is removed from its old owner");

  const homeId = fixture.store.getHomeIdentity().homeId;
  const archiveRef = `refs/yui/archive/${homeId}/heads/${legacyRef}`;
  assert.equal(git(managedProject.path, ["rev-parse", archiveRef]), legacyCommit);
  assert.throws(() => git(managedProject.path, ["rev-parse", legacyRef]));
  assert.throws(
    () => git(fixture.repositoryPath, ["rev-parse", legacyRef]),
    undefined,
    "the obsolete branch is removed from its former repository after its exact commit is archived"
  );
  assert.equal(existsSync(fixture.repositoryPath), true, "the user's external checkout remains intact");
});

test("rebuild blocks on evidence, a dirty worktree, and a terminal Task", async (t) => {
  const evidenceKinds = [
    ["work item", async (fx, task) => {
      runTaskCommand(["work", "create", task.id, "evidence"], fx.store, { now: () => new Date(NOW) });
    }],
    ["agent run", async (fx, task) => {
      const leader = fx.store.getRole(task.id, "leader");
      fx.store.saveAgentRun(createAgentRun(
        fx.store.nextAgentRunId(task.id),
        task.id,
        leader.name,
        "new",
        "evidence",
        NOW,
        { effective: resolveEffectiveLaunch({ role: leader, purpose: "execution" }) }
      ));
    }],
    ["change set", async (fx, task) => {
      runTaskCommand(["work", "create", task.id, "evidence"], fx.store, { now: () => new Date(NOW) });
      fx.store.saveChangeSet(task.id, createWorkItemChangeSet({
        id: "change-set-1",
        taskId: task.id,
        projectId: "project-1",
        workItemId: "work-item-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        branch: "yui/task-1/work-item-1",
        changedPaths: ["src/change.ts"]
      }, NOW));
    }],
    ["integration attempt", async (fx, task) => {
      runTaskCommand(["work", "create", task.id, "evidence"], fx.store, { now: () => new Date(NOW) });
      fx.store.saveChangeSet(task.id, createWorkItemChangeSet({
        id: "change-set-1",
        taskId: task.id,
        projectId: "project-1",
        workItemId: "work-item-1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        branch: "yui/task-1/work-item-1",
        changedPaths: ["src/change.ts"]
      }, NOW));
      fx.store.saveIntegrationAttempt(task.id, createIntegrationAttempt({
        id: "integration-1",
        taskId: task.id,
        projectId: "project-1",
        targetRef: "yui/task-1/main",
        expectedHead: "a".repeat(40),
        changeSetIds: ["change-set-1"],
        checkCommands: []
      }, NOW));
    }]
  ];
  for (const [label, seed] of evidenceKinds) {
    await t.test(label, async (t) => {
      const fixture = await rebuildFixture(t);
      const { task } = await legacyTask(fixture);
      await seed(fixture, task);
      await assert.rejects(
        runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
          now: () => new Date(NOW)
        }),
        /evidence and cannot be rebuilt/i
      );
      assert.equal(fixture.store.getTask(task.id).workspaceIdentity, undefined);
    });
  }

  await t.test("dirty legacy worktree", async (t) => {
    const fixture = await rebuildFixture(t);
    const { task, entry } = await legacyTask(fixture);
    writeFileSync(join(entry.path, "uncommitted.txt"), "dirty\n");
    await assert.rejects(
      runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
        now: () => new Date(NOW)
      }),
      /dirty and blocks the rebuild/i
    );
    assert.equal(fixture.store.getTask(task.id).workspaceIdentity, undefined);
  });

  await t.test("dirty legacy worktree after Project migration", async (t) => {
    const fixture = await rebuildFixture(t, { remote: true });
    const { task, entry, legacyRef } = await legacyTask(fixture);
    await runProjectCommand(
      ["migrate", "project-1"],
      fixture.store,
      { now: () => new Date(NOW) }
    );
    writeFileSync(join(entry.path, "uncommitted.txt"), "dirty after migration\n");

    await assert.rejects(
      runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
        now: () => new Date(NOW)
      }),
      /dirty and blocks the rebuild/i
    );

    assert.equal(fixture.store.getTask(task.id).workspaceIdentity, undefined);
    assert.equal(existsSync(entry.path), true);
    assert.equal(
      git(fixture.store.getProject("project-1").path, ["rev-parse", legacyRef]).length,
      40
    );
  });

  await t.test("mismatched retained ref after Project migration", async (t) => {
    const fixture = await rebuildFixture(t, { remote: true });
    const { task, entry, legacyRef } = await legacyTask(fixture);
    const legacyCommit = git(fixture.repositoryPath, ["rev-parse", legacyRef]);
    await runProjectCommand(
      ["migrate", "project-1"],
      fixture.store,
      { now: () => new Date(NOW) }
    );
    const managed = fixture.store.getProject("project-1");
    // The legacy branch initially equals main in this fixture. Create a
    // distinct commit only in the Home repository, then move the retained ref
    // to prove cleanup cannot mistake branch name equality for commit proof.
    git(managed.path, ["config", "user.name", "Yui Test"]);
    git(managed.path, ["config", "user.email", "yui@example.invalid"]);
    writeFileSync(join(managed.path, "retained-mismatch.txt"), "mismatch\n");
    git(managed.path, ["add", "retained-mismatch.txt"]);
    git(managed.path, ["commit", "-qm", "retained mismatch"]);
    const mismatchedCommit = git(managed.path, ["rev-parse", "HEAD"]);
    git(managed.path, ["update-ref", `refs/heads/${legacyRef}`, mismatchedCommit]);

    await assert.rejects(
      runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
        now: () => new Date(NOW)
      }),
      /not retained by the current Project/i
    );

    assert.equal(fixture.store.getTask(task.id).workspaceIdentity, undefined);
    assert.equal(existsSync(entry.path), true);
    assert.equal(git(fixture.repositoryPath, ["rev-parse", legacyRef]), legacyCommit);
  });

  await t.test("terminal Task", async (t) => {
    const fixture = await rebuildFixture(t);
    const { task } = await legacyTask(fixture);
    const completed = completeTask(activateTask(task, NOW), NOW, { by: "leader", summary: "done" });
    fixture.store.saveTask(completed);
    await assert.rejects(
      runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
        now: () => new Date(NOW)
      }),
      /Only a draft or active Task can be rebuilt in place/i
    );
  });
});

test("a preflight failure changes nothing and the rebuild stays retryable", async (t) => {
  const fixture = await rebuildFixture(t, { remote: true });
  const { task, legacyRef } = await legacyTask(fixture);
  const before = {
    task: structuredClone(fixture.store.getTask(task.id)),
    workspace: structuredClone(fixture.store.getTaskWorkspace(task.id)),
    branches: projectBranches(fixture)
  };

  const real = new NodeGitWorkspace();
  const failing = new Proxy(real, {
    get(target, property) {
      if (property === "resolveRemoteBaseline") {
        return async () => {
          throw new Error("simulated remote resolution failure");
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const preparer = new FileTaskWorkspacePreparer(fixture.home, fixture.store, failing, () => new Date(NOW));
  await assert.rejects(
    runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, preparer, {
      now: () => new Date(NOW)
    }),
    /simulated remote resolution failure/
  );

  // Nothing moved: no identity, no new refs, the old layout is intact.
  assert.deepEqual(fixture.store.getTask(task.id), before.task);
  assert.deepEqual(fixture.store.getTaskWorkspace(task.id), before.workspace);
  assert.deepEqual(projectBranches(fixture), before.branches);
  assert.equal(existsSync(join(fixture.workspace, "worktree", "Yui", task.id, "main")), true);

  // The retry with a working port succeeds.
  await runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
    now: () => new Date(NOW)
  });
  assert.ok(fixture.store.getTask(task.id).workspaceIdentity);
  assert.equal(
    projectBranches(fixture).includes(`refs/heads/${legacyRef}`),
    false,
    "the retry still archives the legacy ref"
  );
});

test("a mid-rebuild failure discards only the new worktrees and stays retryable", async (t) => {
  // Two Projects so the second Project's worktree creation can fail after
  // the first new worktree was created.
  const fixture = await rebuildFixture(t);
  const secondPath = join(fixture.workspace, "Other");
  initRepository(secondPath);
  await runProjectCommand(
    ["add", "Other", secondPath, "--stable", "main", "--development", "main"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const other = fixture.store.getProject("project-2");
  const created = runTaskCommand(
    ["create", "Two Projects", "--project", "project-1", "--project", "project-2"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // Legacy layout for both Projects.
  const gitPort = new NodeGitWorkspace();
  const entries = [];
  for (const project of [fixture.project, other]) {
    const physical = await gitPort.ensureWorktree({
      repositoryPath: project.path,
      container: join(fixture.workspace, "worktree", project.name),
      taskSegment: task.id,
      roleName: "main",
      baseRef: "main"
    });
    entries.push({
      projectId: project.id,
      directory: project.name,
      access: "write",
      path: physical.path,
      branch: physical.branch,
      baseRef: task.projectBindings.find((binding) => binding.projectId === project.id).baseRef,
      baseCommit: physical.baseCommit
    });
  }
  const root = join(fixture.workspace, "tasks", task.id, "main");
  fixture.store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root,
    entries
  }, NOW));

  const real = new NodeGitWorkspace();
  let newSegmentWorktrees = 0;
  const failing = new Proxy(real, {
    get(target, property) {
      if (property === "ensureWorktree") {
        return async (input) => {
          if (/^task-\d+-[a-f0-9]{8}$/.test(input.taskSegment)) {
            newSegmentWorktrees += 1;
            if (newSegmentWorktrees === 2) {
              throw new Error("simulated second-project worktree failure");
            }
          }
          return target.ensureWorktree(input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const preparer = new FileTaskWorkspacePreparer(fixture.home, fixture.store, failing, () => new Date(NOW));
  await assert.rejects(
    runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, preparer, {
      now: () => new Date(NOW)
    }),
    /simulated second-project worktree failure/
  );

  // The first Project's new worktree was discarded; no identity persisted.
  assert.equal(fixture.store.getTask(task.id).workspaceIdentity, undefined);
  const firstProjectBranches = git(fixture.project.path, ["for-each-ref", "--format=%(refname)"]).split("\n");
  assert.equal(
    firstProjectBranches.some((ref) => /^refs\/heads\/yui\/task-1-[a-f0-9]{8}\/main$/.test(ref)),
    false,
    "the unadopted first-project worktree branch was removed"
  );
  assert.equal(
    existsSync(join(fixture.workspace, "worktree", "Yui", task.id, "main")),
    true,
    "the legacy worktree still serves the Task"
  );

  // Retry with the real port completes the rebuild.
  await runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
    now: () => new Date(NOW)
  });
  assert.ok(fixture.store.getTask(task.id).workspaceIdentity);
});

test("the external checkout disappearing mid-rebuild leaves the old layout usable and stays retryable", async (t) => {
  const fixture = await rebuildFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  const legacyWorktree = join(fixture.workspace, "worktree", "Yui", task.id, "main");
  const before = {
    task: structuredClone(fixture.store.getTask(task.id)),
    workspace: structuredClone(fixture.store.getTaskWorkspace(task.id))
  };

  // Snapshot the external checkout so the retry can restore it exactly,
  // including the legacy branch and the worktree registration.
  const snapshot = join(fixture.root, "checkout-snapshot");
  cpSync(fixture.repositoryPath, snapshot, { recursive: true, preserveTimestamps: true });

  // The rebuild creates the new worktree from the external checkout. Remove
  // the checkout at that seam (the new token-bearing segment): the rebuild
  // must fail closed with a bounded diagnosis and leave the old layout intact.
  const real = new NodeGitWorkspace();
  const disappearing = new Proxy(real, {
    get(target, property) {
      if (property === "ensureWorktree") {
        return async (input) => {
          if (/^task-\d+-[a-f0-9]{8}$/.test(input.taskSegment)) {
            rmSync(input.repositoryPath, { recursive: true, force: true });
          }
          return target.ensureWorktree(input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const preparer = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    disappearing,
    () => new Date(NOW)
  );

  await assert.rejects(
    runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, preparer, {
      now: () => new Date(NOW)
    }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(message.length > 0, "a disappearing checkout must surface a bounded diagnosis");
      assert.match(message, /no such file|does not exist|ENOENT|not a git repository|Git command failed/i);
      return true;
    }
  );

  // The old layout is intact: no identity, the legacy worktree directory is
  // still present, and the managed workspace record is unchanged.
  assert.deepEqual(fixture.store.getTask(task.id), before.task);
  assert.deepEqual(fixture.store.getTaskWorkspace(task.id), before.workspace);
  assert.equal(existsSync(legacyWorktree), true, "the legacy worktree still serves the Task");

  // Restore the external checkout exactly and retry: the rebuild completes.
  cpSync(snapshot, fixture.repositoryPath, { recursive: true, preserveTimestamps: true });
  await runTaskWorkspaceCommand(["rebuild", task.id], fixture.store, fixture.preparer, {
    now: () => new Date(NOW)
  });
  assert.ok(fixture.store.getTask(task.id).workspaceIdentity, "the retry minted the workspace identity");
  assert.equal(
    projectBranches(fixture).includes(`refs/heads/${legacyRef}`),
    false,
    "the retry still archives the legacy ref"
  );
});

test("task history lists legacy refs and archives only refs without a live owner", async (t) => {
  const fixture = await rebuildFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);

  const list = await runTaskWorkspaceCommand(
    ["history", "list"],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
  assert.equal(list.data.refs.length, 1);
  assert.equal(list.data.refs[0].ref, `refs/heads/${legacyRef}`);
  assert.equal(list.data.refs[0].taskId, task.id);

  // The Task is still a draft: its own ref is refused.
  const refused = await runTaskWorkspaceCommand(
    ["history", "archive", task.id],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
  assert.deepEqual(refused.data.archived, []);
  assert.deepEqual(refused.data.refused, [`project-1:refs/heads/${legacyRef}`]);
  assert.equal(projectBranches(fixture).includes(`refs/heads/${legacyRef}`), true);

  // A terminal Task no longer protects its refs.
  const completed = completeTask(activateTask(task, NOW), NOW, { by: "leader", summary: "done" });
  const archived = archiveTask(completed, NOW);
  fixture.store.saveTask(archived);
  const result = await runTaskWorkspaceCommand(
    ["history", "archive"],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
  assert.deepEqual(result.data.archived, [`project-1:refs/heads/${legacyRef}`]);
  const homeId = fixture.store.getHomeIdentity().homeId;
  assert.equal(
    projectBranches(fixture).includes(`refs/yui/archive/${homeId}/heads/${legacyRef}`),
    true
  );
  assert.equal(projectBranches(fixture).includes(`refs/heads/${legacyRef}`), false);

  // Archiving is idempotent.
  const again = await runTaskWorkspaceCommand(
    ["history", "archive"],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
  assert.match(again.output, /No legacy Task refs to archive/);
});

test("task replace creates a draft successor with the same bindings and a milestone", async (t) => {
  const fixture = await rebuildFixture(t);
  const { task } = await legacyTask(fixture);
  const oldBindings = structuredClone(task.projectBindings);
  const oldTitle = task.title;
  const completed = completeTask(activateTask(task, NOW), NOW, { by: "leader", summary: "done" });
  fixture.store.saveTask(completed);

  const result = await runTaskWorkspaceCommand(
    ["replace", task.id, "--title", "Successor work"],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
  assert.match(result.output, /Recorded replacement of task-1 on task-2/);
  const replacement = fixture.store.getTask("task-2");
  assert.equal(replacement.status, "draft");
  assert.equal(replacement.title, "Successor work");
  assert.deepEqual(replacement.projectBindings, oldBindings);
  assert.equal(replacement.workspaceIdentity, undefined);

  // The relationship is recorded as a milestone on the successor.
  const milestones = fixture.store.listMilestones("task-2");
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].title, "Replaces task-1");
  assert.match(milestones[0].summary, /original Task, its refs, and its evidence are preserved/);

  // The original Task is untouched apart from its completion.
  const original = fixture.store.getTask(task.id);
  assert.equal(original.status, "completed");
  assert.equal(original.title, oldTitle);
  assert.deepEqual(original.projectBindings, oldBindings);
  assert.equal(original.workspaceIdentity, undefined);
  assert.equal(original.completedBy, "leader");
  assert.equal(original.completionSummary, "done");

  // An open Task is replaced through rebuild instead.
  const open = runTaskCommand(
    ["create", "Open Task", "--project", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  ).data.task;
  await assert.rejects(
    runTaskWorkspaceCommand(["replace", open.id], fixture.store, fixture.preparer, {
      now: () => new Date(NOW)
    }),
    /can be rebuilt instead/i
  );
});

test("two Homes preparing the same Task number in a shared repository never collide", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-two-homes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repo", "Yui");
  initRepository(repositoryPath);

  const homes = [];
  for (const name of ["home-a", "home-b"]) {
    const home = join(root, name);
    const workspace = join(root, `workspace-${name}`);
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
    const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
    homes.push({ home, store, preparer });
  }

  const segments = [];
  for (const each of homes) {
    const created = runTaskCommand(
      ["create", "Same number", "--project", "project-1"],
      each.store,
      { now: () => new Date(NOW) }
    );
    await each.preparer.prepareTaskWorkspace(created.data.task.id);
    const prepared = each.store.getTask("task-1");
    segments.push(`${prepared.id}-${prepared.workspaceIdentity.token}`);
  }
  assert.notEqual(segments[0], segments[1], "each Home derives its own token");

  // Both main branches coexist in the shared Project repository.
  const refs = git(repositoryPath, ["for-each-ref", "--format=%(refname)"]).split("\n");
  for (const segment of segments) {
    assert.equal(
      refs.includes(`refs/heads/yui/${segment}/main`),
      true,
      `expected branch for ${segment}`
    );
  }
});

test("preparation never adopts a foreign token branch and regenerates on conflict", async (t) => {
  const fixture = await rebuildFixture(t);
  const created = runTaskCommand(
    ["create", "Conflict Task", "--project", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // A foreign Home left a token branch behind; the mint loop must not adopt
  // it and must regenerate until it finds a free branch.
  const real = new NodeGitWorkspace();
  const probedBranches = [];
  let conflicts = 0;
  const adversarial = new Proxy(real, {
    get(target, property) {
      if (property === "refExists") {
        return async (repositoryPath, ref) => {
          // The mint loop probes the bare branch name (no refs/heads/ prefix).
          if (ref.startsWith("yui/task-1-")) {
            probedBranches.push(ref);
            if (conflicts < 2) {
              conflicts += 1;
              return true;
            }
          }
          return target.refExists(repositoryPath, ref);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const preparer = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    adversarial,
    () => new Date(NOW)
  );
  await preparer.prepareTaskWorkspace(task.id);

  const prepared = fixture.store.getTask(task.id);
  const segment = `${task.id}-${prepared.workspaceIdentity.token}`;
  assert.ok(probedBranches.length >= 3, "the mint loop probed at least three candidates");
  assert.equal(
    new Set(probedBranches).size,
    probedBranches.length,
    "every conflict regenerated a fresh candidate"
  );
  // The persisted branch is the one that was actually created, never a
  // pre-existing foreign branch.
  const managed = fixture.store.getTaskWorkspace(task.id);
  assert.equal(managed.entries[0].branch, `yui/${segment}/main`);
  assert.equal(
    git(fixture.project.path, ["rev-parse", `refs/heads/yui/${segment}/main`]),
    managed.entries[0].baseCommit
  );
});

test("archiving a Task removes its worktrees but keeps the Project repository", async (t) => {
  const fixture = await rebuildFixture(t);
  const created = runTaskCommand(
    ["create", "Archive Task", "--project", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  await fixture.preparer.prepareTaskWorkspace(task.id);
  const prepared = fixture.store.getTask(task.id);
  const segment = `${task.id}-${prepared.workspaceIdentity.token}`;
  const worktreePath = join(fixture.workspace, "worktree", "Yui", segment, "main");
  assert.equal(existsSync(worktreePath), true);

  // Archive cleanup runs once the Task is completed. Complete the prepared
  // task from the store so the workspace identity survives into the terminal
  // record (the stale `task` variable predates preparation).
  fixture.store.saveTask(completeTask(activateTask(prepared, NOW), NOW, { by: "leader", summary: "done" }));
  const cleanup = await fixture.preparer.cleanupTaskForArchive(task.id);
  assert.equal(cleanup.status, "removed");
  assert.equal(existsSync(worktreePath), false);
  // The Project repository itself is owned by the Home, not the Task.
  assert.equal(existsSync(fixture.project.path), true);
  assert.equal(git(fixture.project.path, ["rev-parse", "HEAD"]).length, 40);
});

test("the task workspace commands are wired through the CLI", async (t) => {
  const fixture = await rebuildFixture(t);
  const { legacyRef } = await legacyTask(fixture);
  const result = execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", "task", "history", "list"],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: fixture.home, NO_COLOR: "1" }
    }
  );
  const response = JSON.parse(result);
  assert.equal(response.ok, true);
  assert.equal(response.data.refs.length, 1);
  assert.equal(response.data.refs[0].ref, `refs/heads/${legacyRef}`);
  assert.equal(isLegacyTaskRef(response.data.refs[0].ref), true);
});
