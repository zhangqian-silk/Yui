import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { CURRENT_STORAGE_VERSION } from "../../dist/storage/storageVersions.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createProject, addProjectKnowledge } from "../../dist/repository/project.js";
import { createTask, activateTask, bindTaskWorkspaceIdentity } from "../../dist/task/task.js";
import { generateTaskWorkspaceIdentity } from "../../dist/repository/taskWorkspaceIdentity.js";
import { createManagedWorkspace, managedWorkspaceKey } from "../../dist/worktree/managedWorkspace.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import { createDurableJob, startDurableJob, completeDurableJob, durableJobIdempotencyKey } from "../../dist/job/durableJob.js";
import { runTaskIntegrationCommand } from "../../dist/commands/taskIntegrationCommands.js";
import { resolveVerificationGate } from "../../dist/verification/verificationGateService.js";
import { createDurableJobControl } from "../../dist/controller/jobControl.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { runTaskUpstreamCommand } from "../../dist/commands/taskUpstreamCommands.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { integrationTmuxSocketRoot } from "../../dist/storage/homeLayout.js";
import { completeGateArtifact } from "../../dist/verification/gateArtifact.js";

const now = new Date("2026-09-12T00:00:00Z");
const git = (path, ...args) => execFileSync("git", ["-C", path, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
}).trim();

test("explicit Job requests replay their original operation and never fall back to content identity", t => {
  const fixture = integrationFixture(t);
  const { store } = fixture;
  const task = store.getTask("task-1");
  const workspace = store.getTaskWorkspace(task.id);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, workspace.root, now);
  store.saveRole(task.id, role);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet({ scope: "task", taskId: task.id, roleName: role.name }, binding.agentId, now),
    { agentId: binding.agentId, adapterId: binding.adapterId, nativeSessionId: "job-request-fixture",
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }, now));
  const params = {
    taskId: task.id, requestId: "check-1", owner: { kind: "task" }, projectId: "project-1",
    head: git(workspace.root, "rev-parse", "HEAD"), workspace: workspace.root,
    env: {}, steps: [{ name: "check", command: "true" }],
    caller: { scope: "task", taskId: task.id, role: role.name, nativeSessionId: "job-request-fixture" }
  };
  const control = createDurableJobControl(store);
  const first = control.startJob(params, now);
  assert.equal(first.created, true);
  const replay = control.startJob(params, now);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.job, first.job);
  assert.throws(() => control.startJob({ ...params, requestId: undefined }, now), /requestId/);
  assert.throws(() => control.startJob({ ...params, steps: [{ name: "changed", command: "false" }] }, now), /conflicts/);
  assert.equal(store.listDurableJobs(task.id).length, 1);
  assert.equal(control.getJob(task.id, first.job.id).operation.requestId, "check-1");
});

export function integrationFixture(t, strategy = "merge") {
  const root = mkdtempSync(join(tmpdir(), "yui-integration-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@local");
  writeFileSync(join(repo, "file"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", "source");
  writeFileSync(join(repo, "file"), "source\n");
  git(repo, "commit", "-am", "source");
  const source = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");
  writeFileSync(join(repo, "file"), "target\n");
  git(repo, "commit", "-am", "target");
  const before = git(repo, "rev-parse", "HEAD");
  const store = new SqliteTaskStore(home);
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: join(root, "worktrees") });
  store.saveProject({ ...createProject("project-1", "app", join(root, "stable"),
    { stable: "main", development: "main" }, now), remoteUrl: repo });
  const task = activateTask(bindTaskWorkspaceIdentity(createTask("task-1", "Integrate", now, {
    cwd: repo, projectBindings: [{
      projectId: "project-1", directory: "app", baseRef: "main",
      baseCommit: base, currentCommit: before
    }]
  }), generateTaskWorkspaceIdentity({
    home: store.getHomeIdentity(), taskId: "task-1", now, entropy: Buffer.alloc(16, 9)
  }), now), now);
  store.saveTask(task);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id }, root: repo,
    entries: [{
      projectId: "project-1", directory: "app", access: "write", path: repo,
      branch: "main", baseRef: "main", baseCommit: before
    }]
  }, now));
  store.saveIntegrationAttempt(task.id, createIntegrationAttempt({
    id: "integration-1", taskId: task.id, projectId: "project-1", targetRef: "main",
    beforeCommit: before, checkCommands: ["true"],
    source: strategy === "rebase"
      ? { kind: "upstream", branch: "source", remoteCommit: source, taskBaseCommit: base, strategy }
      : { kind: "work-item", workItemId: "work-item-1", startCommit: base, resultCommit: source, strategy }
  }, now));
  let starts = 0;
  const jobs = {
    async startCheckJob(input) {
      const admitted = store.getIntegrationAttempt(input.taskId, input.integrationId);
      assert.equal(admitted.status, "running");
      assert.equal(admitted.candidateCommit, input.head);
      assert.equal(admitted.checkInputDigest, durableJobIdempotencyKey({
        ...input, owner: { kind: "integration-attempt", integrationAttemptId: input.integrationId }
      }));
      const old = store.listDurableJobs(task.id)[0];
      if (old) return old;
      starts++;
      const job = createDurableJob({
        id: "job-1", taskId: input.taskId,
        owner: { kind: "integration-attempt", integrationAttemptId: input.integrationId },
        projectId: input.projectId, head: input.head, workspace: input.workspace,
        env: input.env, steps: input.steps, artifactsLocator: "artifacts/job-1",
        operation: { requestId: `integration:${input.integrationId}`, actorId: "fixture:leader",
          authorityRef: "fixture:leader", inputDigest: admitted.checkInputDigest }
      }, now);
      store.saveDurableJob(task.id, job);
      return job;
    },
    async getJob(taskId, id) { return store.getDurableJob(taskId, id); },
    async cancelJob() {}
  };
  const service = () => new GitIntegrationService(home, store, undefined, () => now,
    { PATH: process.env.PATH }, undefined, jobs);
  t.after(() => {
    // Fake Jobs never launch processes. Remove only each fixture's exact
    // marked runtime, including checks intentionally left unfinished.
    try {
      const isolation = service().runtimeIsolation;
      for (const attempt of store.listIntegrationAttempts(task.id)) {
        const workspace = store.getIntegrationWorkspace(task.id, attempt.id);
        if (workspace !== null) isolation.cleanup(isolation.preflight({
          workspace, allowExactActive: true
        }), "completion");
      }
    } finally { store.close(); }
    try { rmdirSync(integrationTmuxSocketRoot(home)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, home, repo, store, service, jobs, base, source, before,
    starts: () => starts,
    finishJob() {
      const queued = store.getDurableJob(task.id, "job-1");
      const job = startDurableJob(queued, { pid: 99999999, startIdentity: "fixture-only" }, now);
      store.saveDurableJob(task.id, job);
      store.saveDurableJob(task.id, completeDurableJob(job, {
          outcome: "succeeded", exitCode: 0, signal: null,
          steps: job.steps.map(step => ({
            name: step.name, head: job.head, exitCode: 0, signal: null,
            timedOut: false, durationMs: 1, logPath: `${step.name}.log`
          }))
      }, now));
    },
    git: (...args) => git(repo, ...args),
    resolve(path) {
      writeFileSync(join(path, "file"), "resolved\n");
      git(path, "add", "file");
    }
  };
}

test("a check that mutates its candidate cannot publish reusable successful evidence", async t => {
  const f = integrationFixture(t, "ff");
  git(f.repo, "checkout", "-b", "clean-candidate");
  git(f.repo, "commit", "--allow-empty", "-m", "candidate");
  const candidate = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "checkout", "main");
  const plan = { schemaVersion: 1, kind: "verification-plan", id: "checks", version: "1",
    bootstrap: [], l1: { categories: [] }, l2: { steps: [{
      name: "mutating-check", argv: [process.execPath, "-e", "require('fs').writeFileSync('file','mutated\\n')"]
    }] } };
  const project = addProjectKnowledge(f.store.getProject("project-1"), "knowledge-1", "Checks", JSON.stringify(plan), now);
  f.store.saveProject(project);
  const seed = { ...f.store.getIntegrationAttempt("task-1", "integration-1"), checkCommands: [],
    source: { kind: "work-item", workItemId: "work-item-1", startCommit: f.before, resultCommit: candidate, strategy: "ff" } };
  f.store.saveIntegrationAttempt("task-1", seed);
  const service = new GitIntegrationService(f.home, f.store, undefined, () => now, { PATH: process.env.PATH });
  const first = await service.integrate("task-1", seed.id);
  assert.equal(first.status, "blocked");
  const gate = resolveVerificationGate(project);
  const artifacts = () => f.store.findL2GateArtifactsForCommit({
    projectId: project.id, commit: candidate, planDigest: gate.planDigest,
    toolchainDigest: gate.toolchainDigest, targetRef: "main"
  });
  assert.ok(artifacts().every(artifact => artifact.outcome !== "succeeded"),
    "The candidate integrity check must precede reusable success publication.");
  await service.abort("task-1", seed.id, "Abandon mutated checks", () => {});
  f.store.saveIntegrationAttempt("task-1", { ...seed, id: "integration-2" });
  const second = await service.integrate("task-1", "integration-2");
  assert.equal(second.status, "blocked", "A fresh attempt must run the check, not reuse the rejected candidate's green.");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.before);
  assert.ok(artifacts().every(artifact => artifact.outcome !== "succeeded"));

  // A continuation with admission persisted but no Job binding must withdraw
  // any prior success before the (idempotent) Job start, too.
  writeFileSync(join(second.workspace.path, "file"), "target\n");
  const log = Buffer.from("an earlier complete check");
  f.store.saveGateArtifact(completeGateArtifact(artifacts()[0], [{
    name: "gate-1", command: "earlier check", outcome: "passed", exitCode: 0,
    signal: null, timedOut: false, durationMs: 1, logPath: "earlier.log",
    logDigest: createHash("sha256").update(log).digest("hex"), logBytes: log.length
  }], "succeeded", now), new Map([["gate-1", log]]));
  let started = false;
  const resumed = await new GitIntegrationService(f.home, f.store, undefined, () => now,
    { PATH: process.env.PATH }, undefined, {
      ...f.jobs,
      async startCheckJob(input) {
        assert.ok(artifacts().every(artifact => artifact.status === "incomplete"));
        started = true;
        return f.jobs.startCheckJob(input);
      }
    }).integrate("task-1", "integration-2");
  assert.equal(resumed.status, "checks-running");
  assert.equal(started, true);
});

test("upstream uses its supplied Job port and returns exact continuation references", async t => {
  const f = integrationFixture(t, "rebase");
  // Workspace adoption has independent lifecycle coverage. This fixture already
  // provides its exact managed Git records; exercise the upstream command/Job
  // composition without changing that separately tested layout.
  t.mock.method(FileTaskWorkspacePreparer.prototype, "prepareTaskWorkspace", async () => {});
  const result = await runTaskUpstreamCommand(["integrate", "task-1", "--latest", "--check", "true"],
    f.store, f.home, { now: () => now, environment: { PATH: process.env.PATH }, jobPort: f.jobs });
  assert.equal(result.data.integrations.length, 1);
  const integration = result.data.integrations[0];
  assert.equal(integration.status, "checks-running");
  assert.equal(f.starts(), 1);
  assert.ok(result.output.includes(`Job ${integration.job.id}`));
  assert.ok(result.output.includes(`yui task integration continue task-1/${integration.attempt.id}`));
});

test("Integration reuses exact checks, reruns explicitly, and cannot bypass equivalent unfinished verification", async t => {
  const f = integrationFixture(t);
  const count = join(f.root, "gate-count");
  const fail = join(f.root, "gate-fail");
  const script = `const fs=require("fs"); const p=${JSON.stringify(count)};
    fs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p)):0)+1));
    console.log("actual gate"); process.exit(fs.existsSync(${JSON.stringify(fail)})?1:0);`;
  const plan = { schemaVersion: 1, kind: "verification-plan", id: "checks", version: "1",
    bootstrap: [], l1: { categories: [] }, l2: { steps: [{ name: "check", argv: [process.execPath, "-e", script] }] } };
  const project = addProjectKnowledge(f.store.getProject("project-1"), "knowledge-1", "Checks", JSON.stringify(plan), now);
  f.store.saveProject(project);
  const service = new GitIntegrationService(f.home, f.store, undefined, () => now, { PATH: process.env.PATH });
  const request = (number, rerunChecks = false, checkCommands = []) => {
    const attempt = createIntegrationAttempt({ id: `integration-${number}`, taskId: "task-1", projectId: "project-1",
      targetRef: "main", beforeCommit: f.before, rerunChecks, checkCommands,
      source: { kind: "work-item", workItemId: "work-item-1", startCommit: f.base, resultCommit: f.before, strategy: "ff" } }, now);
    f.store.saveIntegrationAttempt("task-1", attempt);
    return attempt;
  };
  const first = request(2);
  assert.equal((await service.integrate("task-1", first.id)).status, "committed");
  const reused = await service.integrate("task-1", request(3).id);
  assert.equal(reused.status, "committed");
  assert.ok(reused.attempt.checks.some(check => check.details?.startsWith("Reused exact-SHA")));
  assert.equal(Number(readFileSync(count)), 1);
  writeFileSync(fail, "explicitly exercise a failure");
  const failed = await service.integrate("task-1", request(4, true).id);
  assert.equal(failed.status, "failed");
  assert.ok(failed.attempt.checks.some(check => check.outcome === "failed"));
  assert.equal(Number(readFileSync(count)), 2);
  assert.equal(f.git("rev-parse", "HEAD"), f.before);
  rmSync(fail);
  const additional = await service.integrate("task-1", request(8, false, ["false"]).id);
  assert.equal(additional.status, "failed", "An explicitly requested diagnostic cannot be ignored by a configured plan.");
  assert.ok(additional.attempt.checks.some(check => check.name === "check-1" && check.outcome === "failed"));
  assert.equal(Number(readFileSync(count)), 3);
  const gate = resolveVerificationGate(project);
  const blocked = { ...request(5), candidateCommit: f.before, status: "validating",
    gatePlanDigest: gate.planDigest, gateToolchainDigest: gate.toolchainDigest };
  f.store.saveIntegrationAttempt("task-1", blocked);
  const refused = await service.integrate("task-1", request(6, true).id);
  assert.equal(refused.status, "blocked");
  assert.match(refused.attempt.summary, /unsettled/);
  assert.equal(Number(readFileSync(count)), 3);
  assert.deepEqual(f.store.getIntegrationAttempt("task-1", blocked.id), blocked);
  await assert.rejects(runTaskIntegrationCommand(["continue", "task-1/integration-5", "--rerun-checks"],
    f.store, f.home), error => error.code === "USAGE_ERROR");
  const revision = f.store.getRevision();
  await assert.rejects(runTaskIntegrationCommand(["start", "task-missing", "--work-item", "work-item-1",
    "--strategy", "ff", "--rerun-checks"], f.store, f.home), /Task not found/);
  assert.equal(f.store.getRevision(), revision);
});

test("ordinary conflict continues without resolve and consumes one exact check Job", async t => {
  const f = integrationFixture(t);
  const conflict = await f.service().integrate("task-1", "integration-1");
  assert.equal(conflict.status, "conflicted");
  assert.equal(f.store.getTask("task-1").executionGate.state, "enabled");
  assert.equal(f.starts(), 0);
  assert.equal((await f.service().integrate("task-1", "integration-1")).status, "conflicted");
  assert.equal(f.starts(), 0);
  f.resolve(conflict.workspace.path);
  const checking = await f.service().integrate("task-1", "integration-1");
  assert.equal(checking.status, "checks-running", checking.attempt.summary);
  assert.equal(checking.attempt.status, "running");
  assert.equal(checking.attempt.candidateCommit, checking.job.head);
  f.finishJob();
  const done = await f.service().integrate("task-1", "integration-1");
  assert.equal(done.status, "committed");
  assert.equal(f.git("rev-parse", "HEAD"), done.attempt.afterCommit);
  assert.equal(f.starts(), 1);
});

test("an old Git conflict without its Integration receipt is diagnosed without adopting or replaying it", async t => {
  const f = integrationFixture(t);
  const conflict = await f.service().integrate("task-1", "integration-1");
  assert.equal(conflict.status, "conflicted");
  const { sourceProgress: _oldProgress, ...old } = conflict.attempt;
  f.store.saveIntegrationAttempt("task-1", old);
  const file = readFileSync(join(conflict.workspace.path, "file"), "utf8");
  const operation = git(conflict.workspace.path, "rev-parse", "MERGE_HEAD");
  const result = await f.service().integrate("task-1", old.id);
  assert.equal(result.attempt.sourceProgress, undefined, "A matching MERGE_HEAD does not create an attempt-owned receipt.");
  assert.match(result.attempt.summary, /receipt|progress/i);
  assert.equal(readFileSync(join(conflict.workspace.path, "file"), "utf8"), file);
  assert.equal(git(conflict.workspace.path, "rev-parse", "MERGE_HEAD"), operation);
  assert.equal(f.git("rev-parse", "HEAD"), f.before);
  assert.equal(f.starts(), 0);
});

test("interrupted rebase receipt and successful unbound Job resume without replay", async t => {
  const f = integrationFixture(t, "rebase");
  const conflict = await f.service().integrate("task-1", "integration-1");
  assert.equal(conflict.status, "conflicted", conflict.attempt.summary);
  f.resolve(conflict.workspace.path);
  const save = f.store.saveIntegrationAttempt.bind(f.store);
  let interruptGit = true;
  let interruptBind = true;
  f.store.saveIntegrationAttempt = (taskId, attempt) => {
    if (interruptGit && attempt.sourceProgress?.completedSteps === 1) {
      interruptGit = false;
      throw new Error("fixture: Git finished before cursor save");
    }
    if (interruptBind && attempt.jobId !== undefined) {
      interruptBind = false;
      f.finishJob();
      throw new Error("fixture: successful Job before binding");
    }
    save(taskId, attempt);
  };
  const interrupted = await f.service().integrate("task-1", "integration-1");
  assert.match(interrupted.attempt.summary ?? JSON.stringify(interrupted), /Git finished before cursor save/);
  const appliedHead = git(conflict.workspace.path, "rev-parse", "HEAD");
  assert.notEqual(appliedHead, f.before);
  assert.equal(f.starts(), 0);
  const unbound = await f.service().integrate("task-1", "integration-1");
  assert.match(unbound.attempt.summary, /successful Job before binding/);
  assert.equal(unbound.attempt.jobId, undefined);
  assert.equal(unbound.attempt.candidateCommit, appliedHead);
  const done = await f.service().integrate("task-1", "integration-1");
  assert.equal(done.status, "committed", done.attempt.summary);
  assert.equal(done.attempt.candidateCommit, appliedHead);
  assert.equal(f.starts(), 1);
});

test("validating settlement distinguishes new check conditions from an already-applied CAS", async t => {
  for (const applied of [false, true]) await t.test(applied ? "applied" : "unadvanced", async t => {
    const f = integrationFixture(t);
    const ids = ["task-1", "integration-1"];
    const conflict = await f.service().integrate(...ids);
    f.resolve(conflict.workspace.path);
    const checked = await f.service().integrate(...ids);
    assert.equal(checked.status, "checks-running");
    f.finishJob();
    const original = readFileSync(join(f.repo, "file"));
    const saveAttempt = f.store.saveIntegrationAttempt.bind(f.store);
    const saveTask = f.store.saveTask.bind(f.store);
    if (applied) {
      f.store.saveTask = () => { throw new Error("completion write interrupted"); };
    } else {
      f.store.saveIntegrationAttempt = (taskId, attempt) => {
        saveAttempt(taskId, attempt);
        if (attempt.status === "validating") writeFileSync(join(f.repo, "file"), "concurrent target edit");
      };
    }
    const pending = await f.service().integrate(...ids);
    assert.equal(pending.attempt.status, "validating");
    f.store.saveIntegrationAttempt = saveAttempt;
    f.store.saveTask = saveTask;
    if (!applied) writeFileSync(join(f.repo, "file"), original);
    const changed = new GitIntegrationService(f.home, f.store, undefined, () => now,
      { PATH: process.env.PATH, LANG: "new-check-environment" }, undefined, f.jobs);
    if (!applied) {
      await assert.rejects(changed.integrate(...ids), /check conditions changed/);
      assert.equal(f.git("rev-parse", "HEAD"), f.before);
    }
    const settled = await runTaskIntegrationCommand(["abort", ids.join("/"), "--reason", "changed checks"],
      f.store, f.home, { environment: {}, jobPort: f.jobs });
    assert.equal(settled.data.integration.status, applied ? "committed" : "failed");
    assert.equal(f.git("rev-parse", "HEAD"), applied ? checked.attempt.candidateCommit : f.before);
    assert.equal(f.store.getDurableJob("task-1", "job-1").status, "succeeded");
    assert.equal(f.starts(), 1);
    assert.equal(f.store.getIntegrationWorkspace(...ids).root, conflict.workspace.path);
  });
});

test("storage 20 classifies old Git conflicts without fabricating recovery evidence", () => {
  const db = new Database(":memory:");
  try {
    migrateSqliteSchema(db, { mode: "apply", throughVersion: 19 });
    const base = createIntegrationAttempt({
      id: "integration-1", taskId: "task-1", projectId: "project-1",
      targetRef: "main", beforeCommit: "a".repeat(40),
      source: { kind: "upstream", strategy: "rebase", remoteCommit: "b".repeat(40), taskBaseCommit: "c".repeat(40), branch: "main" }
    }, now);
    const old = {
      ...base, status: "blocked", conflict: { affectedPaths: ["file"], summary: "Upstream rebase conflicts in main." },
      resolution: { action: "manual-resolution", rationale: "resolved", decidedBy: "leader", decidedAt: now.toISOString() }
    };
    const insert = db.prepare("INSERT INTO integration_attempts VALUES (?, ?, ?, ?, ?)");
    const payloads = [
      old,
      { ...old, id: "integration-2", conflict: { affectedPaths: [], summary: "Target moved" } },
      { ...old, id: "integration-3",
        source: { kind: "work-item", workItemId: "work-item-1", startCommit: "a".repeat(40), resultCommit: "b".repeat(40), strategy: "manual" },
        conflict: { affectedPaths: [], summary: "Manual WorkItem integration" } }
    ];
    for (const value of payloads) insert.run("task-1", value.id, "blocked", JSON.stringify(value), now.toISOString());
    // Snapshot of the v19 record contract observed using the actual baseline
    // service in the temporary compatibility regression: no new receipt or
    // digest is seeded. This unit keeps the migration itself seconds-scale.
    const ff = { ...createIntegrationAttempt({
      ...base, id: "integration-4", checkCommands: ["true"],
      source: { kind: "work-item", workItemId: "work-item-1", strategy: "ff",
        startCommit: base.beforeCommit, resultCommit: "b".repeat(40) }
    }, now), jobId: "job-1" };
    const project = createProject("project-1", "app", "/fixture/stable", { stable: "main", development: "main" }, now);
    const task = activateTask(createTask("task-1", "Legacy FF", now, {
      projectBindings: [{ projectId: project.id, directory: "app", baseRef: "main",
        baseCommit: ff.beforeCommit, currentCommit: ff.beforeCommit }]
    }), now);
    db.prepare("INSERT INTO tasks_catalog (task_id,status,lifecycle,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(task.id, "active", "delivery", 1, task.createdAt, task.updatedAt);
    db.prepare("INSERT INTO task_records (task_id,payload,updated_at) VALUES (?,?,?)").run(task.id, JSON.stringify(task), task.updatedAt);
    db.prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)").run(project.id, project.name, project.path, JSON.stringify(project), project.createdAt, project.updatedAt);
    const main = createManagedWorkspace({
      owner: { type: "task", taskId: task.id }, root: "/fixture/main",
      entries: [{ projectId: project.id, directory: "app", access: "write", path: "/fixture/main",
        branch: "main", baseRef: "main", baseCommit: ff.beforeCommit }]
    }, now);
    const workspace = createManagedWorkspace({
      owner: { type: "integration-attempt", taskId: task.id, integrationAttemptId: ff.id },
      root: "/fixture/integration",
      entries: [{ ...main.entries[0], path: "/fixture/integration", branch: "integration" }]
    }, now);
    for (const w of [main, workspace]) db.prepare("INSERT INTO managed_workspaces VALUES (?,?,?,?,?,?,?,?)")
      .run(w.owner.type, managedWorkspaceKey(w.owner), task.id, w.root, JSON.stringify(w), "active", w.createdAt, w.updatedAt);
    const jobInput = {
      id: "job-1", taskId: task.id, owner: { kind: "integration-attempt", integrationAttemptId: ff.id },
      projectId: project.id, head: ff.source.resultCommit, workspace: workspace.root,
      env: {}, steps: [{ name: "check-1", command: "true", timeoutMs: 1800000 }], artifactsLocator: "artifacts/job-1"
    };
    const job = createDurableJob({ ...jobInput, operation: {
      requestId: "fixture-request", actorId: "fixture:leader", authorityRef: "fixture:leader",
      inputDigest: durableJobIdempotencyKey(jobInput)
    } }, now);
    db.prepare("INSERT INTO durable_jobs (job_id,task_id,idempotency_key,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(job.id, task.id, job.idempotencyKey, job.status, JSON.stringify(job), job.createdAt, job.updatedAt);
    insert.run(task.id, ff.id, ff.status, JSON.stringify(ff), ff.updatedAt);
    const result = migrateSqliteSchema(db, { mode: "apply", throughVersion: 20 });
    assert.deepEqual(result.applied, [20]);
    const rows = db.prepare("SELECT status, payload FROM integration_attempts ORDER BY integration_id").all();
    assert.deepEqual(rows.map(row => row.status), ["conflicted", "blocked", "blocked", "running"]);
    assert.deepEqual(rows.slice(0, 3).map(row => JSON.parse(row.payload)), [
      { ...old, status: "conflicted" }, payloads[1], payloads[2]
    ]);
    const upgraded = JSON.parse(rows[3].payload);
    assert.equal(upgraded.sourceProgress.head, ff.source.resultCommit);
    assert.equal(upgraded.candidateCommit, job.head);
    assert.equal(upgraded.checkInputDigest, durableJobIdempotencyKey(job));
    assert.equal(upgraded.sourceProgress.activeAction, undefined);
    assert.equal(upgraded.checks, undefined); // no fabricated successful checks
    assert.deepEqual(migrateSqliteSchema(db, { mode: "apply", throughVersion: 20 }).applied, []);
  } finally { db.close(); }
});
