import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  recordRoleAgentSession,
  roleAgentSessionResumeMode,
  updateRoleAgentSessionStatus
} from "../dist/executor/agentExecutor.js";
import {
  assertReadOnlyAgentArgv,
  effectiveLaunchSnapshotsCompatible,
  resolveEffectiveLaunch
} from "../dist/executor/effectiveLaunch.js";
import { FileRoleLaunchPlanner } from "../dist/executor/fileRoleLaunchPlanner.js";
import { createProject } from "../dist/repository/project.js";
import { createReviewRound, startReviewRound } from "../dist/review/reviewRound.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../dist/role/role.js";
import { createAgentRun } from "../dist/run/agentRun.js";
import { formatAgentRunReceiptId } from "../dist/task/taskRecordReference.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { activateTask, createTask } from "../dist/task/task.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../dist/workItem/workItem.js";
import { createRoleWorkspace } from "../dist/worktree/roleWorkspace.js";

const START = new Date("2026-08-02T14:00:00.000Z");

test("isolated launch cutover freezes desired/effective identity and enforces native permissions", (t) => {
  const requestedRoot = process.env.YUI_LAUNCH_E2E_ROOT;
  const root = requestedRoot === undefined
    ? mkdtempSync(join(tmpdir(), "yui-launch-permissions-e2e-"))
    : resolve(requestedRoot);
  if (requestedRoot !== undefined) {
    assert.equal(existsSync(root), false, `E2E artifact root already exists: ${root}`);
    mkdirSync(root, { recursive: true });
  }
  t.after(() => {
    if (requestedRoot === undefined) rmSync(root, { recursive: true, force: true });
  });

  const home = join(root, "yui-home");
  const sourceRepository = initializeRepository(root);
  const commit = git(sourceRepository, "rev-parse", "HEAD");
  const nativeHome = join(root, "native-home");
  const codexHome = join(nativeHome, "codex");
  mkdirSync(codexHome, { recursive: true });
  const codexCommand = createCaptureAgent(root, "codex");
  const claudeCommand = createCaptureAgent(root, "claude");
  ensureStorageSchema(home, START);
  const store = new FileTaskStore(home);
  const codex = createConfiguredAgent(
    "codex-e2e", "codex", codexCommand, [], [], START
  );
  const claude = createConfiguredAgent(
    "claude-e2e", "claude", claudeCommand, [], [], START
  );
  const codexWriteBinding = createRoleAgentBinding(codex, {
    adapterId: "codex",
    model: "gpt-e2e",
    effort: "max",
    yolo: true,
    search: true,
    permission: { sandbox: "danger-full-access", approval: "never" }
  });
  const claudeWriteBinding = createRoleAgentBinding(claude, {
    adapterId: "claude",
    model: "claude-e2e",
    effort: "max",
    yolo: true,
    permission: { mode: "bypassPermissions" }
  });
  const project = createProject(
    "project-1",
    "fixture",
    sourceRepository,
    { stable: "HEAD", development: "HEAD" },
    START
  );
  const taskId = "task-1";
  const mainWorkspace = fixtureWorkspace({
    root,
    sourceRepository,
    commit,
    taskId,
    roleName: "leader",
    label: "main",
    owner: { type: "task" },
    access: "write"
  });
  const task = activateTask(createTask(taskId, "Launch permission cutover", START, {
    cwd: mainWorkspace.root,
    projectBindings: [{
      projectId: project.id,
      directory: "fixture",
      baseRef: project.developmentBranch
    }]
  }), START);

  const roleInputs = [
    ["leader", [codexWriteBinding], codex.id, mainWorkspace.root, "write"],
    ["codex-read", [codexWriteBinding], codex.id, mainWorkspace.root, "write"],
    ["claude-read", [claudeWriteBinding], claude.id, mainWorkspace.root, "write"],
    ["codex-write", [codexWriteBinding, claudeWriteBinding], codex.id, "pending", "write"],
    ["claude-write", [claudeWriteBinding], claude.id, "pending", "write"],
    ["codex-review", [codexWriteBinding], codex.id, "pending", "write"],
    ["claude-review", [claudeWriteBinding], claude.id, "pending", "write"],
    ["profile-read", [claudeWriteBinding], claude.id, "pending", "read"]
  ];
  const workspaces = new Map();
  for (const [roleName, , , workspace, ,] of roleInputs) {
    if (workspace !== "pending") continue;
    const number = workspaces.size + 1;
    workspaces.set(roleName, fixtureWorkspace({
      root,
      sourceRepository,
      commit,
      taskId,
      roleName,
      label: roleName,
      owner: { type: "work-item", workItemId: `work-item-${number}` },
      access: roleName.includes("review") ? "read" : "write"
    }));
  }
  const roles = new Map(roleInputs.map(([
    roleName, bindings, activeAgentId, workspace, defaultAccess
  ]) => {
    const resolvedWorkspace = workspace === "pending"
      ? workspaces.get(roleName).root
      : workspace;
    return [roleName, createRole(
      taskId,
      roleName,
      bindings,
      activeAgentId,
      resolvedWorkspace,
      START,
      {},
      defaultAccess
    )];
  }));

  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: codex.id,
      defaultWorkspace: root
    });
    tx.saveConfiguredAgent(codex);
    tx.saveConfiguredAgent(claude);
    tx.saveProject(project);
    tx.saveTask(task);
    for (const role of roles.values()) tx.saveRole(taskId, role);
    tx.saveRoleWorkspace(taskId, mainWorkspace);
  });

  const execution = [
    executionFixture(store, roles.get("codex-write"), workspaces.get("codex-write"), "work-item-1", "agent-run-1"),
    executionFixture(store, roles.get("claude-write"), workspaces.get("claude-write"), "work-item-2", "agent-run-2")
  ];
  const reviews = [
    reviewFixture(
      store,
      roles.get("codex-review"),
      workspaces.get("codex-review"),
      "work-item-3",
      "review-round-1",
      "agent-run-3"
    ),
    reviewFixture(
      store,
      roles.get("claude-review"),
      workspaces.get("claude-review"),
      "work-item-4",
      "review-round-2",
      "agent-run-4"
    )
  ];
  const profileReadItem = runningItem(
    "work-item-5", taskId, "profile-read", [project.id]
  );
  store.transaction((tx) => {
    tx.saveWorkItem(taskId, profileReadItem);
    tx.saveRoleWorkspace(taskId, workspaces.get("profile-read"));
  });
  const profileReadEffective = resolveEffectiveLaunch({
    role: store.getRole(taskId, "profile-read"),
    purpose: "execution",
    workspace: workspaces.get("profile-read"),
    workItemWriteProjectIds: [project.id]
  });
  assert.equal(profileReadEffective.access, "read");

  const planner = new FileRoleLaunchPlanner(home, store, {
    environment: {
      HOME: nativeHome,
      CODEX_HOME: codexHome,
      PATH: process.env.PATH
    },
    cliPath: join(process.cwd(), "dist", "cli.js"),
    createNativeSessionId: () => "claude-e2e-session"
  });
  const plans = {
    codexRead: taskPlan(planner, store, taskId, "codex-read", "launch-codex-read"),
    claudeRead: taskPlan(planner, store, taskId, "claude-read", "launch-claude-read"),
    codexWrite: taskPlan(planner, store, taskId, "codex-write", "launch-codex-write"),
    claudeWrite: taskPlan(planner, store, taskId, "claude-write", "launch-claude-write"),
    codexReview: taskPlan(planner, store, taskId, "codex-review", "launch-codex-review"),
    claudeReview: taskPlan(planner, store, taskId, "claude-review", "launch-claude-review")
  };
  const effective = {
    codexRead: resolveEffectiveLaunch({
      role: store.getRole(taskId, "codex-read"),
      purpose: "execution",
      workspace: mainWorkspace
    }),
    claudeRead: resolveEffectiveLaunch({
      role: store.getRole(taskId, "claude-read"),
      purpose: "execution",
      workspace: mainWorkspace
    }),
    codexWrite: execution[0].effective,
    claudeWrite: execution[1].effective,
    codexReview: reviews[0].effective,
    claudeReview: reviews[1].effective
  };

  for (const key of ["codexRead", "claudeRead", "codexReview", "claudeReview"]) {
    assert.equal(effective[key].access, "read");
    assertReadOnlyAgentArgv(effective[key], plans[key].launch.args);
  }
  assertCodexWrite(plans.codexWrite.launch.args);
  assertClaudeWrite(plans.claudeWrite.launch.args);
  for (const plan of Object.values(plans)) executePlan(plan);
  const initialCaptures = readCaptures(home);

  const historicalRun = structuredClone(store.getActiveAgentRun(taskId, "codex-write"));
  let sessions = createRoleSessionSet(
    { scope: "task", taskId, roleName: "codex-write" },
    historicalRun.effective.agentId,
    START
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: historicalRun.effective.agentId,
    adapterId: historicalRun.effective.adapterId,
    nativeSessionId: "codex-thread-before-desired-change",
    policy: "fixed",
    status: "running",
    effective: historicalRun.effective
  }, START);
  sessions = bindTaskRoleRun(sessions, {
    agentId: historicalRun.effective.agentId,
    runId: historicalRun.id,
    receiptId: formatAgentRunReceiptId(taskId, historicalRun.id)
  }, START);
  store.saveTaskRoleSessionSet(sessions);
  const historicalSession = structuredClone(
    store.getRoleSession(taskId, "codex-write")
  );

  const options = {
    now: () => new Date(START.getTime() + 1_000),
    yuiHome: home,
    runtime: {
      notifyStateChanged() {},
      notifyMailboxChanged() {},
      reconcileTask() {}
    }
  };
  runTaskCommand([
    "role", "update", taskId, "codex-write",
    "--agent", codex.id,
    "--model", "gpt-next",
    "--effort", "high",
    "--clear-yolo"
  ], store, options);
  runTaskCommand([
    "role", "update", taskId, "codex-write",
    "--agent", claude.id,
    "--model", "claude-next",
    "--effort", "max",
    "--yolo", "true"
  ], store, options);
  runTaskCommand([
    "role", "bind", taskId, "codex-write", claude.id
  ], store, options);
  runTaskCommand([
    "role", "update", taskId, "codex-write",
    "--agent", claude.id,
    "--clear-model", "--clear-effort", "--clear-yolo",
    "--clear-permission-mode"
  ], store, options);

  const desiredAfter = store.getRole(taskId, "codex-write");
  assert.equal(desiredAfter.activeAgentId, claude.id);
  assert.deepEqual(desiredAfter.agentBindings[claude.id].config, {
    adapterId: "claude"
  });
  assert.ok(desiredAfter.launchRevision > historicalRun.effective.sourceDesiredRevision);
  assert.deepEqual(store.getActiveAgentRun(taskId, "codex-write"), historicalRun);
  assert.deepEqual(store.getRoleSession(taskId, "codex-write"), historicalSession);
  assert.equal(
    store.getTaskRoleSessionSet(taskId, "codex-write").activeAgentId,
    codex.id
  );

  const driftPlan = planner.plan({
    taskId,
    roleName: "codex-write",
    agentId: historicalRun.effective.agentId,
    adapterId: historicalRun.effective.adapterId,
    effective: historicalRun.effective,
    mode: "resume",
    nativeSessionId: historicalSession.nativeSessionId,
    launchId: "launch-codex-drift"
  });
  assertCodexWrite(driftPlan.launch.args);
  executePlan(driftPlan);
  const desiredCodexEffective = resolveEffectiveLaunch({
    role: { ...desiredAfter, activeAgentId: codex.id },
    purpose: "execution",
    workspace: workspaces.get("codex-write"),
    workItemWriteProjectIds: [project.id]
  });
  const liveSessions = store.getTaskRoleSessionSet(taskId, "codex-write");
  assert.throws(
    () => roleAgentSessionResumeMode(
      liveSessions,
      codex.id,
      desiredCodexEffective
    ),
    /Stop the existing native process/i
  );
  assert.equal(
    roleAgentSessionResumeMode(
      updateRoleAgentSessionStatus(
        liveSessions,
        codex.id,
        "stopped",
        new Date(START.getTime() + 2_000)
      ),
      codex.id,
      desiredCodexEffective
    ),
    "new"
  );
  assert.equal(
    effectiveLaunchSnapshotsCompatible(historicalRun.effective, {
      ...historicalRun.effective,
      workspace: {
        ...historicalRun.effective.workspace,
        root: join(root, "incompatible-workspace")
      }
    }),
    false
  );
  assert.throws(() => resolveEffectiveLaunch({
    role: store.getRole(taskId, "claude-write"),
    purpose: "execution",
    workspace: { ...workspaces.get("claude-write"), entries: workspaces
      .get("claude-write").entries.map((entry) => ({ ...entry, access: "read" })) },
    workItemWriteProjectIds: [project.id]
  }), /write scope does not match/i);
  for (const reviewRole of ["codex-review", "claude-review"]) {
    assert.throws(() => resolveEffectiveLaunch({
      role: store.getRole(taskId, reviewRole),
      purpose: "review",
      workspace: workspaces.get(reviewRole),
      workItemWriteProjectIds: [],
      nativeReadOnlySupported: false
    }), /cannot express native read-only access/i);
  }

  const context = runTaskCommand(["context", taskId], store).output;
  assert.match(context, /Desired drift:\s+pending next launch/i);
  assert.match(context, /provenance:\s+resolved/i);
  const events = store.listEvents(taskId);
  assert.equal(events.some((event) => (
    event.type === "role.updated"
    && event.payload.desiredDrift === "pending-next-launch"
  )), true);

  const report = {
    schemaVersion: 1,
    taskId,
    sourceRepository: { path: sourceRepository, commit },
    storage: { aggregate: 12, storedTask: 11 },
    initialCaptures,
    driftCapture: readCapture(home, "codex-write", "codex"),
    effective,
    desiredAfter: {
      revision: desiredAfter.launchRevision,
      activeAgentId: desiredAfter.activeAgentId,
      config: desiredAfter.agentBindings[desiredAfter.activeAgentId].config
    },
    immutableRun: historicalRun,
    immutableSession: historicalSession,
    checks: {
      codexReadOnly: true,
      claudeReadOnly: true,
      codexWriteBypass: true,
      claudeWriteBypass: true,
      reviewsForcedReadOnly: true,
      desiredChangeNextLaunchOnly: true,
      scopeMismatchFailedClosed: true,
      nativeReadOnlyUnsupportedFailedClosed: true
    }
  };
  const reportPath = join(root, "launch-permissions-e2e-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  t.diagnostic(`launch/permission E2E artifacts: ${reportPath}`);
});

function executionFixture(store, role, workspace, workItemId, runId) {
  const item = runningItem(workItemId, role.taskId, role.name, ["project-1"]);
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace,
    workItemWriteProjectIds: item.writeProjectIds
  });
  const run = createAgentRun(
    runId,
    role.taskId,
    role.name,
    "new",
    `Execute ${workItemId}`,
    START,
    { workItemId, workspace, effective }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(role.taskId, item);
    tx.saveRoleWorkspace(role.taskId, workspace);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(role.taskId, updateRoleStatus(role, "running", START));
  });
  return run;
}

function reviewFixture(store, role, workspace, workItemId, roundId, runId) {
  const running = runningItem(workItemId, role.taskId, undefined, ["project-1"]);
  const item = submitWorkItemCandidate(running, {
    summary: `Candidate for ${workItemId}`,
    source: { type: "direct" },
    workspace
  }, START);
  const round = startReviewRound(createReviewRound(
    roundId,
    role.taskId,
    workItemId,
    item.candidates[0].id,
    role.name,
    "leader",
    START
  ), runId);
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "review",
    workspace,
    workItemWriteProjectIds: []
  });
  const run = createAgentRun(
    runId,
    role.taskId,
    role.name,
    "new",
    `Review ${workItemId}`,
    START,
    {
      workItemId,
      purpose: "review",
      reviewRoundId: roundId,
      workspace,
      effective
    }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(role.taskId, item);
    tx.saveRoleWorkspace(role.taskId, workspace);
    tx.saveReviewRound(role.taskId, round);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(role.taskId, updateRoleStatus(role, "running", START));
  });
  return run;
}

function runningItem(id, taskId, assignee, writeProjectIds) {
  return updateWorkItemStatus(createWorkItem(id, taskId, {
    title: id,
    assignee,
    writeProjectIds
  }, START), "running", START);
}

function taskPlan(planner, store, taskId, roleName, launchId) {
  const role = store.getRole(taskId, roleName);
  const run = store.getActiveAgentRun(taskId, roleName);
  const snapshot = run?.effective;
  const agentId = snapshot?.agentId ?? role.activeAgentId;
  const adapterId = snapshot?.adapterId ?? role.agentBindings[agentId].adapterId;
  return planner.plan({
    taskId,
    roleName,
    agentId,
    adapterId,
    ...(snapshot === undefined ? {} : { effective: snapshot }),
    mode: "new",
    launchId
  });
}

function assertCodexWrite(args) {
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(args.includes("--search"));
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("--ask-for-approval"), false);
}

function assertClaudeWrite(args) {
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.equal(args.includes("--permission-mode"), false);
}

function executePlan(plan) {
  const result = spawnSync(plan.launch.command, plan.launch.args, {
    cwd: plan.role.workspace,
    env: plan.launch.env,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
}

function readCaptures(home) {
  return Object.fromEntries([
    ["codexRead", readCapture(home, "codex-read", "codex")],
    ["claudeRead", readCapture(home, "claude-read", "claude")],
    ["codexWrite", readCapture(home, "codex-write", "codex")],
    ["claudeWrite", readCapture(home, "claude-write", "claude")],
    ["codexReview", readCapture(home, "codex-review", "codex")],
    ["claudeReview", readCapture(home, "claude-review", "claude")]
  ]);
}

function readCapture(home, roleName, adapterId) {
  return JSON.parse(readFileSync(
    join(home, "captures", `${roleName}-${adapterId}.json`),
    "utf8"
  ));
}

function createCaptureAgent(root, adapterId) {
  const path = join(root, `${adapterId}-capture-agent.mjs`);
  writeFileSync(path, [
    "#!/usr/bin/env node",
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const directory = join(process.env.YUI_HOME, "captures");',
    "mkdirSync(directory, { recursive: true });",
    "const target = join(directory, `${process.env.YUI_ROLE}-${process.env.YUI_ADAPTER_ID}.json`);",
    "writeFileSync(target, JSON.stringify({",
    "  argv: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  home: process.env.YUI_HOME,",
    "  workspace: process.env.YUI_WORKSPACE,",
    "  writableProjectIds: JSON.parse(process.env.YUI_WRITABLE_PROJECT_IDS || '[]')",
    "}, null, 2) + '\\n');",
    ""
  ].join("\n"));
  chmodSync(path, 0o700);
  return path;
}

function initializeRepository(root) {
  const repository = join(root, "source-repository");
  mkdirSync(repository, { recursive: true });
  git(repository, "init", "-q");
  git(repository, "config", "user.name", "Yui E2E");
  git(repository, "config", "user.email", "yui-e2e@example.invalid");
  writeFileSync(join(repository, "fixture.txt"), "launch permissions\n");
  git(repository, "add", "fixture.txt");
  git(repository, "commit", "-qm", "fixture base");
  return repository;
}

function fixtureWorkspace(input) {
  const workspaceRoot = join(input.root, "workspace", input.label);
  mkdirSync(workspaceRoot, { recursive: true });
  const projectPath = join(workspaceRoot, "fixture");
  execFileSync("git", ["clone", "-q", input.sourceRepository, projectPath]);
  return createRoleWorkspace({
    taskId: input.taskId,
    roleName: input.roleName,
    owner: input.owner,
    root: workspaceRoot,
    entries: [{
      projectId: "project-1",
      directory: "fixture",
      access: input.access,
      path: projectPath,
      branch: `e2e-${input.label}`,
      baseRef: "HEAD",
      baseCommit: input.commit
    }]
  }, START);
}

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8"
  }).trim();
}
