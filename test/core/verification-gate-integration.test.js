import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  enqueueIntegrationQueueEntry
} from "../../dist/integration/integrationQueueService.js";
import { createChangeSetManifest } from "../../dist/integration/changeSetManifest.js";
import {
  createIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import {
  addProjectKnowledge,
  createProject,
  retireProjectKnowledge
} from "../../dist/repository/project.js";
import {
  createReleaseWorkflowPorts
} from "../../dist/release/releaseWorkflowPorts.js";
import { createInMemoryReleaseIdempotencyStore } from "../../dist/release/releaseIdempotencyStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import {
  gateArtifactKey,
  gateArtifactRef,
  isReusableGateArtifact
} from "../../dist/verification/gateArtifact.js";
import {
  findGateArtifact,
  loadGateArtifact
} from "../../dist/verification/gateArtifactStore.js";
import {
  assertNoAdHocFullSuiteChecks,
  gateIdentityForCandidate,
  resolveVerificationGate,
  verifyGateArtifactForReview
} from "../../dist/verification/verificationGateService.js";
import {
  VERIFICATION_PLAN_KIND,
  verificationPlanKnowledgeBody
} from "../../dist/verification/verificationPlan.js";

const now = new Date("2026-08-17T00:00:00.000Z");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function planBody(overrides = {}) {
  return {
    kind: VERIFICATION_PLAN_KIND,
    id: "yui-core",
    version: "1.0.0",
    mode: "reuse",
    toolchain: { node: ">=20", platform: "linux" },
    bootstrap: [{ name: "deps", argv: ["npm", "ci"] }],
    l1: { categories: [] },
    l2: {
      steps: [
        { name: "lint", argv: ["npm", "run", "lint"] },
        { name: "build", argv: ["npm", "run", "build"] }
      ]
    },
    ...overrides
  };
}

/**
 * Fake IntegrationJobPort that records the start input and lets the test
 * decide when the job reaches which terminal state. Plan-aware: it returns
 * step results matching the planned bootstrap/gate step names and writes real
 * log files so the artifact import can hash them.
 */
function fakeJobPort(home) {
  const calls = { starts: 0, gets: 0 };
  let lastInput = null;
  let job = null;

  function writeLog(stepName, content) {
    const logDir = join(home, job.artifactsLocator, "logs");
    mkdirSync(logDir, { recursive: true });
    const logName = `001-${stepName}.log`;
    writeFileSync(join(logDir, logName), content);
    return logName;
  }

  function stepResult(name, exitCode, content) {
    const logPath = writeLog(name, content);
    return {
      name,
      exitCode,
      signal: null,
      timedOut: false,
      durationMs: 100,
      logPath,
      head: lastInput.head
    };
  }

  function terminalize(outcome, result) {
    if (job === null) throw new Error("job was never started");
    job = { ...job, status: outcome, result };
  }

  return {
    calls,
    async startCheckJob(input) {
      calls.starts += 1;
      lastInput = input;
      job = {
        id: `job-${calls.starts}`,
        taskId: input.taskId,
        head: input.head,
        status: "running",
        artifactsLocator: `artifacts/jobs/${input.taskId}/job-${calls.starts}`,
        result: undefined,
        steps: input.steps
      };
      return job;
    },
    async getJob() {
      calls.gets += 1;
      return job;
    },
    async cancelJob() {},
    get input() { return lastInput; },
    get job() { return job; },
    succeed() {
      const steps = lastInput.steps.map((step) =>
        stepResult(step.name, 0, `${step.name} ok\n`)
      );
      terminalize("succeeded", {
        outcome: "succeeded",
        exitCode: 0,
        signal: null,
        steps
      });
    },
    failBootstrap() {
      const steps = [stepResult("bootstrap-1", 1, "npm ERR! network\n")];
      terminalize("failed", {
        outcome: "failed",
        exitCode: 1,
        signal: null,
        failedStep: "bootstrap-1",
        steps
      });
    },
    failGate() {
      const steps = [
        stepResult("bootstrap-1", 0, "added 0 packages\n"),
        stepResult("gate-1", 1, "lint error\n")
      ];
      terminalize("failed", {
        outcome: "failed",
        exitCode: 1,
        signal: null,
        failedStep: "gate-1",
        steps
      });
    }
  };
}

async function createFixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "yui-gate-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const repositoryPath = join(root, "repository");
  git(["init", "-b", "master", repositoryPath]);
  git(["-C", repositoryPath, "config", "user.name", "Test"]);
  git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repositoryPath, "base.txt"), "base\n");
  git(["-C", repositoryPath, "add", "base.txt"]);
  git(["-C", repositoryPath, "commit", "-m", "base"]);
  const baseCommit = git(["-C", repositoryPath, "rev-parse", "HEAD"]).trim();

  // Candidate branch with one change on top of base.
  const branch = "candidate";
  git(["-C", repositoryPath, "branch", branch, baseCommit]);
  const wt = join(root, "wt-candidate");
  git(["-C", repositoryPath, "worktree", "add", wt, branch]);
  writeFileSync(join(wt, "change.txt"), "change\n");
  git(["-C", wt, "add", "-A"]);
  git(["-C", wt, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "change"]);
  const headCommit = git(["-C", repositoryPath, "rev-parse", branch]).trim();
  git(["-C", repositoryPath, "worktree", "remove", wt]);

  const home = join(root, "home");
  mkdirSync(home);
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: workspaceRoot });

  const plan = options.plan ?? planBody();
  let project = createProject(
    store.nextProjectId(),
    "fixture",
    repositoryPath,
    { stable: "master", development: "master" },
    now
  );
  project = addProjectKnowledge(
    project,
    "verification-plan-1",
    "Verification plan",
    verificationPlanKnowledgeBody(plan),
    now
  );
  store.saveProject(project);

  const task = activateTask(createTask(store.nextTaskId(), "Gate task", now, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "master" }]
  }), now);
  store.saveTask(task);

  const workItem = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Change",
    acceptance: [],
    dependsOn: [],
    assignee: "leader",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, workItem);

  const changeSet = createWorkItemChangeSet({
    id: "change-set-1",
    taskId: task.id,
    workItemId: workItem.id,
    projectId: project.id,
    baseCommit,
    headCommit,
    branch,
    changedPaths: ["change.txt"]
  }, now);
  store.saveChangeSet(task.id, changeSet);

  const jobPort = options.noJobPort ? undefined : fakeJobPort(home);
  const service = new GitIntegrationService(
    home,
    store,
    undefined,
    () => now,
    process.env,
    undefined,
    jobPort
  );

  return {
    root,
    repositoryPath,
    home,
    store,
    project,
    task,
    changeSet,
    baseCommit,
    headCommit,
    plan,
    jobPort,
    service,
    resetMaster() {
      // Reset both the ref and the working tree so the preflight sees a clean
      // target at the base commit.
      git(["-C", repositoryPath, "reset", "--hard", baseCommit]);
    },
    async newAttempt(id, overrides = {}) {
      const attempt = createIntegrationAttempt({
        id,
        taskId: task.id,
        projectId: project.id,
        targetRef: "master",
        expectedHead: baseCommit,
        changeSetIds: [changeSet.id],
        ...overrides
      }, now);
      store.saveIntegrationAttempt(task.id, attempt);
      return attempt;
    },
    async integrate(attempt) {
      return service.integrate(task.id, attempt.id);
    },
    gateIdentity(commit = headCommit) {
      const gate = resolveVerificationGate(project, process.env);
      return gateIdentityForCandidate({
        projectId: project.id,
        gate,
        level: "L2",
        commit,
        targetRef: "master",
        baseHead: baseCommit
      });
    }
  };
}

// --- E2E: bootstrap → L2 artifact → committed --------------------------------

test("E2E: bootstrap and L2 run once, record a reusable artifact, and commit", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");

  const started = await f.integrate(attempt);
  assert.equal(started.status, "checks-running");
  assert.equal(f.jobPort.calls.starts, 1);
  assert.deepEqual(
    f.jobPort.input.steps.map((step) => step.name),
    ["bootstrap-1", "gate-1", "gate-2"]
  );
  assert.deepEqual([...f.jobPort.input.steps[0].argv], ["npm", "ci"]);
  assert.equal(f.jobPort.input.steps[0].command, "npm ci");

  f.jobPort.succeed();
  const finished = await f.integrate(attempt);
  assert.equal(finished.status, "committed");

  const identity = f.gateIdentity();
  const artifact = findGateArtifact(f.home, identity);
  assert.notEqual(artifact, null);
  assert.equal(isReusableGateArtifact(artifact), true);
  assert.equal(artifact.commit, f.headCommit);
  assert.equal(artifact.planId, "yui-core");
  assert.equal(artifact.steps.length, 3);

  assert.equal(
    git(["-C", f.repositoryPath, "rev-parse", "master"]).trim(),
    f.headCommit
  );
});

// --- Same-tuple reuse (5 requests → 1 execution) ------------------------------

test("reuse mode: 5 requests for the same tuple execute the L2 gate once", async (t) => {
  const f = await createFixture(t);

  // Request 1: full gate execution.
  const attempt1 = await f.newAttempt("integration-1");
  const started1 = await f.integrate(attempt1);
  assert.equal(started1.status, "checks-running");
  f.jobPort.succeed();
  const finished1 = await f.integrate(attempt1);
  assert.equal(finished1.status, "committed");
  assert.equal(f.jobPort.calls.starts, 1);

  // Requests 2-5: reset master so each is a fresh Integration request for the
  // same candidate tuple. The gate must reuse the artifact without a new job.
  for (let i = 2; i <= 5; i += 1) {
    f.resetMaster();
    const attempt = await f.newAttempt(`integration-${i}`);
    const result = await f.integrate(attempt);
    assert.equal(result.status, "committed", `request ${i} should commit via reuse`);
    assert.equal(
      f.jobPort.calls.starts,
      1,
      `request ${i} must not start a new gate job`
    );
  }

  const identity = f.gateIdentity();
  const artifact = loadGateArtifact(f.home, f.project.id, gateArtifactKey(identity));
  assert.equal(artifact.reuseCount, 4);
});

// --- Record mode: shadow potential reuse --------------------------------------

test("record mode always runs the gate and counts potential reuses", async (t) => {
  const f = await createFixture(t, { plan: planBody({ mode: "record" }) });

  const attempt1 = await f.newAttempt("integration-1");
  await f.integrate(attempt1);
  f.jobPort.succeed();
  await f.integrate(attempt1);
  assert.equal(f.jobPort.calls.starts, 1);

  // A second request for the same tuple runs the gate again (no skip) but
  // records a shadow potential-reuse observation.
  f.resetMaster();
  const attempt2 = await f.newAttempt("integration-2");
  await f.integrate(attempt2);
  assert.equal(f.jobPort.calls.starts, 2, "record mode must not skip the gate");
  f.jobPort.succeed();
  await f.integrate(attempt2);

  const identity = f.gateIdentity();
  const artifact = loadGateArtifact(f.home, f.project.id, gateArtifactKey(identity));
  assert.equal(artifact.potentialReuseCount, 1);
  assert.equal(artifact.reuseCount, 0);
});

// --- Invalidation ---------------------------------------------------------------

test("a head change invalidates the artifact (different key)", async (t) => {
  const f = await createFixture(t);
  const identity1 = f.gateIdentity(f.headCommit);
  const identity2 = f.gateIdentity("1".repeat(40));
  assert.notEqual(gateArtifactKey(identity1), gateArtifactKey(identity2));
});

test("a plan version change invalidates the artifact", async (t) => {
  const f = await createFixture(t);
  const gateV1 = resolveVerificationGate(f.project, process.env);

  const retired = retireProjectKnowledge(f.project, "verification-plan-1", now);
  const withV2 = addProjectKnowledge(
    retired,
    "verification-plan-2",
    "Verification plan v2",
    verificationPlanKnowledgeBody(planBody({ version: "2.0.0" })),
    now
  );
  f.store.saveProject(withV2);
  const gateV2 = resolveVerificationGate(withV2, process.env);

  assert.notEqual(gateV1.planDigest, gateV2.planDigest);

  const identityV1 = f.gateIdentity();
  const identityV2 = gateIdentityForCandidate({
    projectId: f.project.id,
    gate: gateV2,
    level: "L2",
    commit: f.headCommit,
    targetRef: "master",
    baseHead: f.baseCommit
  });
  assert.notEqual(gateArtifactKey(identityV1), gateArtifactKey(identityV2));
});

// --- Preflight: dirty/stale target fails before the gate -----------------------

test("a stale target ref fails preflight before the gate starts", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");

  // Move master away from the expected head before integrating.
  writeFileSync(join(f.repositoryPath, "interloper.txt"), "interloper\n");
  git(["-C", f.repositoryPath, "add", "interloper.txt"]);
  git(["-C", f.repositoryPath, "commit", "-m", "interloper"]);

  const result = await f.integrate(attempt);
  assert.equal(result.status, "failed");
  assert.equal(f.jobPort.calls.starts, 0, "the gate must not start on a stale target");
});

test("a dirty target worktree fails preflight before the gate starts", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");

  // The main repository has master checked out; an untracked file makes it
  // dirty, so the preflight must reject the gate before it starts.
  writeFileSync(join(f.repositoryPath, "uncommitted.txt"), "dirty\n");

  const result = await f.integrate(attempt);
  assert.equal(result.status, "failed");
  assert.equal(f.jobPort.calls.starts, 0, "the gate must not start on a dirty target");
});

// --- Bootstrap failure classification -------------------------------------------

test("a bootstrap failure is classified as [bootstrap] and not a Candidate failure", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");

  await f.integrate(attempt);
  f.jobPort.failBootstrap();
  const result = await f.integrate(attempt);
  assert.equal(result.status, "failed");

  const saved = f.store.getIntegrationAttempt(f.task.id, attempt.id);
  const bootstrapCheck = saved.checks.find((check) => check.name === "bootstrap-1");
  assert.equal(bootstrapCheck.outcome, "failed");
  assert.match(bootstrapCheck.details, /^\[bootstrap\]/);
  // Gate steps were planned but never ran (bootstrap failed first): they are
  // recorded as skipped, not passed or failed.
  const gateChecks = saved.checks.filter((check) => check.name.startsWith("gate-"));
  assert.ok(gateChecks.length > 0, "gate steps should be recorded as skipped");
  assert.ok(
    gateChecks.every((check) => check.outcome === "skipped"),
    "gate steps must not have run when bootstrap failed"
  );
});

test("a gate failure is classified without the [bootstrap] prefix", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");

  await f.integrate(attempt);
  f.jobPort.failGate();
  const result = await f.integrate(attempt);
  assert.equal(result.status, "failed");

  const saved = f.store.getIntegrationAttempt(f.task.id, attempt.id);
  const gateCheck = saved.checks.find((check) => check.name === "gate-1");
  assert.equal(gateCheck.outcome, "failed");
  assert.doesNotMatch(gateCheck.details ?? "", /^\[bootstrap\]/);
});

// --- Crash/restart: incomplete artifact is not reusable --------------------------

test("an incomplete artifact from a crashed gate is not reusable", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");

  await f.integrate(attempt);
  // Simulate a crash: the job is still running (no terminal result).
  const crashed = await f.integrate(attempt);
  assert.equal(crashed.status, "checks-running");

  const identity = f.gateIdentity();
  assert.equal(findGateArtifact(f.home, identity), null);
});

// --- Enforce mode ------------------------------------------------------------------

test("enforce mode rejects an ad-hoc full-suite check that duplicates an L2 step", async (t) => {
  const f = await createFixture(t, { plan: planBody({ mode: "enforce" }) });
  const attempt = await f.newAttempt("integration-1", {
    checkCommands: ["npm run lint"]
  });

  const result = await f.integrate(attempt);
  assert.equal(result.status, "failed");
  assert.equal(f.jobPort.calls.starts, 0, "enforce mode must reject before starting the gate");
  const saved = f.store.getIntegrationAttempt(f.task.id, attempt.id);
  assert.match(saved.checks[0]?.details ?? "", /Ad-hoc full-suite check is rejected/);
});

test("enforce mode allows a targeted diagnostic check that is not an L2 step", async (t) => {
  const f = await createFixture(t, { plan: planBody({ mode: "enforce" }) });
  const attempt = await f.newAttempt("integration-1", {
    checkCommands: ["npx vitest run src/foo.test.ts"]
  });

  const started = await f.integrate(attempt);
  assert.equal(started.status, "checks-running");
  assert.equal(f.jobPort.calls.starts, 1);
});

// --- Review verification ------------------------------------------------------------

test("Reviewer verifies the artifact and its logs, then runs a targeted gap check", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");
  await f.integrate(attempt);
  f.jobPort.succeed();
  await f.integrate(attempt);

  const identity = f.gateIdentity();
  const artifact = findGateArtifact(f.home, identity);

  const verification = await verifyGateArtifactForReview(
    f.home,
    f.project.id,
    artifact.key,
    { commit: f.headCommit }
  );
  assert.equal(verification.ok, true);

  // A targeted gap check (not an L2 step) is the Reviewer's escape hatch.
  assert.doesNotThrow(() =>
    assertNoAdHocFullSuiteChecks(f.plan, ["npx vitest run src/gap.test.ts"])
  );
  assert.throws(
    () => assertNoAdHocFullSuiteChecks(f.plan, ["npm run lint"]),
    /Ad-hoc full-suite check is rejected/
  );
});

// --- Queue evidence fence -----------------------------------------------------------

test("a gate-artifact evidence ref covers the exact check commands at the exact commit", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");
  await f.integrate(attempt);
  f.jobPort.succeed();
  await f.integrate(attempt);

  const identity = f.gateIdentity();
  const artifact = findGateArtifact(f.home, identity);
  const ref = gateArtifactRef(artifact.key);

  // The queue reads evidenceRefs from the ChangeSet manifest. ChangeSets are
  // immutable, so record a second ChangeSet for the same candidate that
  // carries the gate-artifact ref, then reset master so the queue entry is a
  // fresh request for the same candidate.
  const withEvidence = createWorkItemChangeSet({
    id: "change-set-2",
    taskId: f.task.id,
    workItemId: f.changeSet.workItemId,
    projectId: f.project.id,
    baseCommit: f.baseCommit,
    headCommit: f.headCommit,
    branch: f.changeSet.branch,
    changedPaths: [...f.changeSet.changedPaths],
    manifest: createChangeSetManifest({
      tags: [],
      deletedPaths: [],
      evidenceRefs: [ref]
    })
  }, now);
  f.store.saveChangeSet(f.task.id, withEvidence);

  f.resetMaster();
  const result = await enqueueIntegrationQueueEntry({
    store: f.store,
    taskId: f.task.id,
    projectId: f.project.id,
    changeSetId: "change-set-2",
    targetRef: "master",
    checkCommands: ["npm run lint", "npm run build"],
    home: f.home,
    now: () => now
  });
  assert.equal(result.entry.status, "validated");
});

// --- Release ci-confirm L2 consume ---------------------------------------------------

test("release ci-confirm consumes the L2 artifact as local (not CI) evidence", async (t) => {
  const f = await createFixture(t);
  const attempt = await f.newAttempt("integration-1");
  await f.integrate(attempt);
  f.jobPort.succeed();
  await f.integrate(attempt);

  const ports = createReleaseWorkflowPorts({
    home: f.home,
    updatePorts: {
      stage: () => { throw new Error("not used in this test"); },
      cleanup: () => {},
      activate: () => { throw new Error("not used in this test"); }
    },
    projectStore: f.store,
    idempotencyStore: createInMemoryReleaseIdempotencyStore()
  });

  const effect = await ports.executeStep({
    step: { id: "ci", kind: "ci-confirm", idempotencyKey: "idem-1" },
    idempotencyKey: "idem-1",
    source: {
      repository: { owner: "zq-silk", name: "Yui" },
      commit: f.headCommit
    },
    params: { projectId: f.project.id, targetRef: "master" }
  });

  assert.equal(effect.outcome, "succeeded");
  assert.match(effect.externalId, /^gate:/);
  assert.match(effect.logs[0], /not CI evidence/);
});
