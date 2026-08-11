import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../dist/executor/effectiveLaunch.js";
import { createWorkItemChangeSet } from "../dist/integration/changeSet.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../dist/integration/integrationAttempt.js";
import { createProject } from "../dist/repository/project.js";
import { createGlobalRole, createRoleAgentBinding } from "../dist/role/role.js";
import { attachReviewRoundWorkspace } from "../dist/review/reviewRound.js";
import { createEmptyRegistry } from "../dist/storage/migration/index.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { classifyHome } from "../dist/storage/upgrade/homeClassification.js";
import { latestStorageVersionState } from "../dist/storage/upgrade/recordVersions.js";
import { createManagedWorkspace } from "../dist/worktree/managedWorkspace.js";
import {
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../dist/workItem/workItem.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const NOW = new Date("2026-08-09T00:00:00.000Z");

function aggregateV16Home(t, { durableGraph = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "yui-aggregate-v16-v17-"));
  const home = join(base, "home");
  assert.ok(home.startsWith(tmpdir()), `test Home must be under the temp dir: ${home}`);
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));

  ensureStorageSchema(home, new Date("2026-08-09T00:00:00.000Z"));
  const store = new FileTaskStore(home);
  store.saveConfig({
    ...store.getConfig(),
    review: { roleName: "reviewer", trigger: "final" }
  });
  const durable = durableGraph ? seedDurableGraph(base, store) : null;

  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.aggregateSchemaVersion = 16;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.schemaVersion = 16;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { base, home, durable };
}

function seedDurableGraph(base, store) {
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const projectPath = join(base, "project-one");
  mkdirSync(projectPath, { recursive: true });
  const leader = createGlobalRole(
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    base,
    NOW
  );
  store.transaction((tx) => {
    tx.saveConfig({
      ...tx.getConfig(),
      defaultAgent: agent.id,
      defaultWorkspace: base,
      review: { roleName: "reviewer", trigger: "final" }
    });
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(leader);
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      base,
      NOW
    ));
    tx.saveProject(createProject(
      "project-1",
      "project-one",
      projectPath,
      { stable: "main", development: "main" },
      NOW
    ));
  });

  const effective = resolveEffectiveLaunch({ role: leader, purpose: "execution" });
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: leader.name },
    agent.id,
    NOW
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "native-v16-preserved",
    policy: "fixed",
    status: "stopped",
    effective
  }, NOW);
  store.saveGlobalRoleSessionSet(sessions);

  runTaskCommand([
    "create", "aggregate migration fixture", "--project", "project-1",
    "--require-integration"
  ], store, { now: () => NOW });
  const task = store.getTask("task-1");
  runTaskCommand(["activate", task.id], store, { now: () => NOW });
  runTaskCommand(["work", "create", task.id, "preserve records"], store, {
    now: () => NOW
  });
  const item = store.getWorkItem(task.id, "work-item-1");
  const leaderOptions = {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  runTaskCommand(["work", "update", item.id, "running"], store, leaderOptions);
  store.transaction((tx) => {
    const running = tx.getWorkItem(task.id, item.id);
    const candidate = submitWorkItemCandidate(running, {
      summary: "candidate preserved across aggregate migration",
      source: { type: "direct" }
    }, NOW);
    tx.saveWorkItem(task.id, candidate);
    tx.saveWorkItem(task.id, updateWorkItemStatus(candidate, "completed", NOW, "accepted"));
    tx.saveChangeSet(task.id, createWorkItemChangeSet({
      id: "change-set-1",
      taskId: task.id,
      projectId: "project-1",
      workItemId: item.id,
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      branch: "yui/task-1/work-item-1",
      changedPaths: ["src/change.ts"]
    }, NOW));
    const attempt = createIntegrationAttempt({
      id: "integration-1",
      taskId: task.id,
      projectId: "project-1",
      targetRef: "yui/task-1/main",
      expectedHead: "a".repeat(40),
      changeSetIds: ["change-set-1"],
      checkCommands: []
    }, NOW);
    tx.saveIntegrationAttempt(task.id, updateIntegrationAttempt(
      attempt,
      { status: "committed", candidateCommit: "b".repeat(40) },
      NOW
    ));
  });

  runTaskCommand(
    ["complete", task.id, "--summary", "request final review"],
    store,
    {
      ...leaderOptions,
      actualTaskReviewCandidate: {
        schemaVersion: 1,
        projects: [{ projectId: "project-1", commit: "b".repeat(40) }]
      }
    }
  );
  const round = store.listReviewRounds(task.id)[0];
  const binding = task.projectBindings[0];
  const workspaceRoot = join(base, "review-workspace");
  const workspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: task.id, reviewRoundId: round.id },
    root: workspaceRoot,
    entries: [{
      projectId: binding.projectId,
      directory: binding.directory,
      access: "write",
      path: join(workspaceRoot, binding.directory),
      branch: `yui/${task.id}/${round.id}`,
      baseRef: round.taskCandidate.projects[0].commit,
      baseCommit: round.taskCandidate.projects[0].commit
    }]
  }, NOW);
  store.transaction((tx) => {
    tx.saveManagedWorkspace(workspace);
    tx.saveReviewRound(task.id, attachReviewRoundWorkspace(round, workspace));
  });
  return {
    taskId: task.id,
    workItemId: item.id,
    reviewRoundId: round.id,
    integrationAttemptId: "integration-1",
    sessionRoleName: leader.name
  };
}

function runCli(home, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("YUI_"))
  );
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: process.cwd(),
    env: { ...env, YUI_HOME: home, NO_COLOR: "1" },
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.length === 0 ? null : JSON.parse(result.stdout)
  };
}

function sourceSnapshot(base, home) {
  return {
    baseEntries: readdirSync(base).sort(),
    homeEntries: readdirSync(home).sort(),
    manifest: readFileSync(join(home, "schema.json"), "utf8"),
    state: readFileSync(join(home, "state.json"), "utf8")
  };
}

test("production doctor and dry-run recognize an aggregate-v16 final policy Home", (t) => {
  const { base, home } = aggregateV16Home(t);
  const before = sourceSnapshot(base, home);

  const doctor = runCli(home, ["--json", "doctor"]);
  const compatibility = doctor.json.data.checks.find(
    ({ name }) => name === "storage compatibility"
  );
  assert.match(compatibility.detail, /MIGRATABLE.*aggregate=16\/17/);
  assert.doesNotMatch(compatibility.detail, /missing-step/);
  assert.deepEqual(sourceSnapshot(base, home), before, "doctor must be read-only");

  const dryRun = runCli(home, ["--json", "upgrade", "--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(dryRun.json.data.outcome, "dry-run");
  assert.deepEqual(dryRun.json.data.report.steps, [{
    axis: "aggregate",
    fromVersion: 16,
    toVersion: 17,
    transition: "offline-migration",
    declaredEffects: []
  }]);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.deepEqual(sourceSnapshot(base, home), before, "dry-run must not mutate the source Home");
});

test("normal commands refuse raw v16 while execute preserves the durable graph", (t) => {
  const { home, durable } = aggregateV16Home(t, { durableGraph: true });
  const beforeStateText = readFileSync(join(home, "state.json"), "utf8");
  const beforeManifestText = readFileSync(join(home, "schema.json"), "utf8");
  const beforeState = JSON.parse(beforeStateText);

  const refused = runCli(home, ["--json", "config", "review", "show"]);
  assert.equal(refused.status, 5);
  assert.match(
    `${refused.stdout}${refused.stderr}`,
    /Storage requires an offline migration/
  );

  const upgraded = runCli(home, ["--json", "upgrade"]);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(upgraded.json.data.outcome, "upgraded");
  assert.ok(upgraded.json.data.backupPath);
  const afterManifest = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
  const afterState = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  const expectedState = structuredClone(beforeState);
  expectedState.schemaVersion = 17;
  assert.equal(afterManifest.aggregateSchemaVersion, 17);
  assert.deepEqual(afterState, expectedState);

  assert.ok(afterState.tasks[durable.taskId]);
  assert.ok(afterState.tasks[durable.taskId].workItems[durable.workItemId]);
  assert.ok(afterState.tasks[durable.taskId].reviewRounds[durable.reviewRoundId]);
  assert.ok(
    afterState.tasks[durable.taskId].integrationAttempts[durable.integrationAttemptId]
  );
  assert.ok(Object.values(afterState.tasks[durable.taskId].managedWorkspaces).some(
    ({ owner }) => owner.type === "review-round"
      && owner.reviewRoundId === durable.reviewRoundId
  ));
  assert.ok(afterState.globalRoleSessionSets[durable.sessionRoleName]);

  assert.equal(
    readFileSync(join(upgraded.json.data.backupPath, "schema.json"), "utf8"),
    beforeManifestText
  );
  assert.equal(
    readFileSync(join(upgraded.json.data.backupPath, "state.json"), "utf8"),
    beforeStateText
  );
  assert.doesNotThrow(() => new FileTaskStore(home).listTasks());
});

test("an aggregate-v16 consumer sees migrated v17 as a future Home", (t) => {
  const { home } = aggregateV16Home(t);
  const upgraded = runCli(home, ["--json", "upgrade"]);
  assert.equal(upgraded.status, 0, upgraded.stderr);

  const current = latestStorageVersionState();
  const oldConsumer = classifyHome({
    home,
    registry: createEmptyRegistry(),
    latest: { ...current, aggregate: 16 }
  });
  assert.equal(oldConsumer.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(oldConsumer.classification.blocker.reason, "future-version");
  assert.equal(oldConsumer.classification.blocker.axis, "aggregate");
  assert.equal(oldConsumer.classification.blocker.found, 17);
  assert.equal(oldConsumer.classification.blocker.supported, 16);
});

test("aggregate migration fails closed when state and manifest identities disagree", (t) => {
  const { base, home } = aggregateV16Home(t);
  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.schemaVersion = 15;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const before = sourceSnapshot(base, home);

  const dryRun = runCli(home, ["--json", "upgrade", "--dry-run"]);
  assert.equal(dryRun.status, 5);
  assert.equal(dryRun.json.data.outcome, "blocked");
  assert.equal(dryRun.json.data.stage, "validate");
  assert.match(dryRun.json.data.message, /state\.json schemaVersion 16/);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.deepEqual(sourceSnapshot(base, home), before);
});

test("malformed aggregate-v16 state is CORRUPTED and never reaches migration", (t) => {
  const { base, home } = aggregateV16Home(t);
  writeFileSync(join(home, "state.json"), "{ invalid json");
  const before = sourceSnapshot(base, home);

  const doctor = runCli(home, ["--json", "doctor"]);
  const compatibility = doctor.json.data.checks.find(
    ({ name }) => name === "storage compatibility"
  );
  assert.match(compatibility.detail, /CORRUPTED/);
  const dryRun = runCli(home, ["--json", "upgrade", "--dry-run"]);
  assert.equal(dryRun.status, 5);
  assert.equal(dryRun.json.data.outcome, "blocked");
  assert.equal(dryRun.json.data.stage, "corruption");
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.deepEqual(sourceSnapshot(base, home), before);
});
