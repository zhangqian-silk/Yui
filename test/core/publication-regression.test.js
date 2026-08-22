import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createProject } from "../../dist/repository/project.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "dist", "cli.js");

// Strip managed Task runtime descriptors so the packaged CLI is exercised
// directly instead of being refused by the exact control-plane guard.
const bareEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? ""
};

// Task-27 failure path: a Task completes with "delivery integration not
// required" (changeSets=0, integrations=0) and the external PR/squash-commit
// publication is only observable afterwards. The publication reference must
// attach to the completed Task without reopening it, stay idempotent, reject
// conflicting evidence, and surface in show/context/audit projections.
test("a completed Task records post-completion PR publication lineage", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-publication-regression-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...bareEnv, YUI_HOME: home };
  const now = new Date("2026-08-22T10:00:00.000Z");

  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const project = createProject(
    "project-1",
    "app",
    join(home, "app"),
    { stable: "master", development: "master" },
    now
  );
  store.saveProject(project);
  const task = activateTask(createTask(store.nextTaskId(), "Publication regression", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  }), now);
  store.saveTask(task);
  store.saveTask(completeTask(task, now, {
    by: "leader",
    summary: "Delivery integration not required; local delivery commit recorded only here."
  }));

  const localCommit = "e83b0c25c2257cdbd3f045cc051b2e5d57db56f0";
  const remoteCommit = "27a7f2daba040451d63f674fcdf57eb11bfaa7be";
  const addArgs = [
    "task", "publication", "add", task.id,
    "--project", "app",
    "--provider", "github",
    "--repository", "zhangqian-silk/Yui",
    "--kind", "pull-request",
    "--id", "179",
    "--local-commit", localCommit,
    "--remote-commit", remoteCommit,
    "--state", "merged",
    "--reported",
    "--merged-at", "2026-08-22T12:00:00.000Z"
  ];

  // Record the external publication against the completed Task.
  const recorded = execFileSync(process.execPath, [cli, ...addArgs], {
    cwd: root, encoding: "utf8", env
  });
  assert.match(recorded, /Recorded publication publication-1/u);

  // The Task stays completed; the publication is counted separately from
  // Yui IntegrationAttempts (which remain zero).
  const shown = JSON.parse(execFileSync(process.execPath, [cli, "--json", "task", "show", task.id], {
    cwd: root, encoding: "utf8", env
  }));
  assert.equal(shown.data.task.status, "completed");
  assert.equal(shown.data.counts.integrations, 0);
  assert.equal(shown.data.counts.publications, 1);

  // Re-recording the same evidence is idempotent.
  const again = execFileSync(process.execPath, [cli, ...addArgs], {
    cwd: root, encoding: "utf8", env
  });
  assert.match(again, /already recorded: publication-1/u);

  // Conflicting evidence (different remote commit) fails closed instead of
  // silently overwriting the current record.
  assert.throws(() => execFileSync(process.execPath, [
    cli, "task", "publication", "add", task.id,
    "--project", "app",
    "--provider", "github",
    "--repository", "zhangqian-silk/Yui",
    "--kind", "pull-request",
    "--id", "179",
    "--local-commit", localCommit,
    "--remote-commit", "0000000000000000000000000000000000000000",
    "--state", "merged",
    "--reported"
  ], { cwd: root, encoding: "utf8", env }), /conflicts with current record publication-1/u);

  // An explicit supersede appends corrected evidence immutably.
  const superseded = execFileSync(process.execPath, [
    cli, "task", "publication", "add", task.id,
    "--project", "app",
    "--provider", "github",
    "--repository", "zhangqian-silk/Yui",
    "--kind", "pull-request",
    "--id", "179",
    "--local-commit", localCommit,
    "--remote-commit", "0000000000000000000000000000000000000000",
    "--state", "merged",
    "--reported",
    "--supersede", "publication-1"
  ], { cwd: root, encoding: "utf8", env });
  assert.match(superseded, /Recorded publication publication-2/u);

  // The list projection shows the local -> PR -> squash remote lineage.
  const list = execFileSync(process.execPath, [cli, "task", "publication", "list", task.id], {
    cwd: root, encoding: "utf8", env
  });
  assert.match(list, new RegExp(`${localCommit.slice(0, 12)} -> 179 -> ${remoteCommit.slice(0, 12)}`, "u"));
  assert.match(list, /publication-2/u);

  // The execution audit keeps external publications distinct from
  // IntegrationAttempts and does not disguise one as the other.
  const audit = execFileSync(process.execPath, [cli, "execution", "audit", "--task", task.id], {
    cwd: root, encoding: "utf8", env
  });
  assert.match(audit, /Integration attempts: 0 total/u);
  assert.match(audit, /Publication references: 2 total .* 2 merged .* 0 verified .* 1 superseded/u);
});
