import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import {
  answerInputRequest,
  autoResolveInputRequest,
  cancelInputRequest,
  createInputRequest
} from "../dist/input/inputRequest.js";
import {
  blockAgentRunForInput,
  createAgentRun,
  resumeBlockedAgentRun,
  yieldAgentRun
} from "../dist/run/agentRun.js";
import { scanOfflineInputResolutions } from "../dist/scheduler/offlineInputResolution.js";
import {
  runExportCommand,
  runImportCommand
} from "../dist/commands/maintenanceCommands.js";
import { compileDispatchInput } from "../dist/context/dispatchContext.js";
import { createGlobalRole, createRole } from "../dist/role/role.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { renderPortableSnapshotV3 } from "../dist/storage/portableExport.js";
import {
  PortableImportError,
  applyPortableImportPlanInTransaction,
  planPortableImport
} from "../dist/storage/portableImport.js";
import { createPortableFileStoreImportTarget } from "../dist/storage/portableFileStore.js";
import {
  MAX_PORTABLE_SNAPSHOT_BYTES,
  snapshotPortableSnapshotV3
} from "../dist/storage/portableSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const now = new Date("2026-07-15T00:00:00.000Z");

function configuredAgent() {
  return createConfiguredAgent("codex", "codex", "codex", [], [], now);
}

function configuredAgentFor(id, adapterId = id) {
  return createConfiguredAgent(id, adapterId, adapterId, [], [], now);
}

function binding(agentId = "codex", adapterId = agentId) {
  return { agentId, adapterId, config: { adapterId } };
}

function createGitWorkspace(prefix) {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", workspace], { stdio: "ignore" });
  return workspace;
}

function createRepositoryPortableSource(t, label = "taskmux-portable-repository-source-") {
  const source = FileTaskStore.createEphemeralWorkspace(label);
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-repository-output-"));
  const output = join(outputDir, "portable.json");
  const workspace = createGitWorkspace("taskmux-portable-repository-workspace-");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  source.saveConfiguredAgent(configuredAgent());
  source.saveGlobalRole(createGlobalRole("operator", [binding()], "codex", workspace, now));
  assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);
  return { source, output, workspace };
}

function createDirectoryPortableSource(t, label = "taskmux-portable-directory-source-") {
  const source = FileTaskStore.createEphemeralWorkspace(label);
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-directory-output-"));
  const output = join(outputDir, "portable.json");
  const workspace = mkdtempSync(join(tmpdir(), "taskmux-portable-directory-workspace-"));
  t.after(() => {
    source.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  source.saveConfiguredAgent(configuredAgent());
  source.saveGlobalRole(createGlobalRole("operator", [binding()], "codex", workspace, now));
  assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);
  return { source, output, workspace };
}

function multiAgentBindings() {
  return [
    binding("claude", "claude"),
    binding("codex", "codex")
  ];
}

function configuredSkill(id, content) {
  return {
    schemaVersion: 1,
    id,
    content,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

function persistPortableAgents(store) {
  store.saveConfiguredAgent(configuredAgentFor("claude", "claude"));
  store.saveConfiguredAgent(configuredAgentFor("codex", "codex"));
}

function importedStore(root) {
  return new FileTaskStore(root);
}

function runPortableImport(target, input, transactionId) {
  return executeDomainTransaction(
    target.rootDirectory(),
    transactionId,
    (workingRoot) => runImportCommand([
      input,
      "--workspace-map",
      "default=default"
    ], importedStore(workingRoot))
  );
}

function dispatch(store, taskId, roleName, input) {
  return store.runReadSnapshot((reader) => {
    const role = reader.getRole(taskId, roleName);
    assert.ok(role);
    return compileDispatchInput(reader, taskId, role, input);
  });
}

function requester(agentRunId) {
  return {
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    sessionRoot: "/host/source-session-root",
    nativeSessionId: `native-source-${agentRunId}`,
    agentRunId
  };
}

function terminalRun(id, statusAt) {
  return yieldAgentRun(
    createAgentRun(id, "task-1", "leader", "new", `Run ${id}`, now),
    `Finished ${id}`,
    statusAt
  );
}

function userRequiredInput(id, agentRunId) {
  return createInputRequest(
    id,
    "task-1",
    requester(agentRunId),
    {
      question: `Question ${id}`,
      choices: [{ key: "continue", label: "Continue" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
}

function configurePortableInputStore(store, workspace) {
  store.saveConfiguredAgent(configuredAgent());
  store.saveConfig({
    schemaVersion: 1,
    defaultAgent: "codex",
    defaultWorkspace: workspace
  });
}

test("FileTaskStore portable export projects role v2 without reading or leaking host authorities", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-file-store-source-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-file-store-output-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  source.saveConfiguredAgent(configuredAgent());
  source.saveConfig({
    schemaVersion: 1,
    defaultAgent: "codex",
    defaultWorkspace: "/host/source-workspace"
  });
  source.saveGlobalRole(createGlobalRole(
    "operator",
    [binding()],
    "codex",
    "/host/source-workspace",
    now
  ));
  source.saveTask(createTask("task-1", "Portable file store", now));
  source.saveRole("task-1", createRole(
    "task-1",
    "leader",
    [binding()],
    "codex",
    "/host/source-workspace",
    now
  ));

  const forbidden = [
    "getGlobalRoleSessionSet",
    "getRoleSessionSet",
    "listGlobalRoleSessionSets",
    "listRoleSessionSets",
    "listAllRoleSessionSets",
    "getAgentSession",
    "nativeSessionIdentityClaims",
    "getRoleWorktree",
    "listRoleWorktrees",
    "getActiveAgentRun",
    "getPendingWakeup",
    "listPendingWakeups"
  ];
  const originals = new Map(forbidden.map((name) => [name, FileTaskStore.prototype[name]]));
  for (const name of forbidden) {
    FileTaskStore.prototype[name] = () => {
      throw new Error(`portable export must not read ${name}`);
    };
  }
  try {
    assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);
  } finally {
    for (const [name, method] of originals) {
      FileTaskStore.prototype[name] = method;
    }
  }

  const snapshot = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(snapshot.schemaVersion, 3);
  assert.deepEqual(snapshot.agentRequirements, [{
    schemaVersion: 1,
    agentId: "codex",
    adapterId: "codex"
  }]);
  assert.deepEqual(snapshot.semantic.map((record) => record.authority), [
    "config",
    "global-role",
    "task",
    "task-role",
    "task-topics"
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /host\/source-workspace|session|runtime|worktree/i);
});

test("FileTaskStore imports a non-default repository workspace into a clean Git target without an anchor Role", (t) => {
  const { output, workspace: sourceWorkspace } = createRepositoryPortableSource(t);
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-clean-repository-target-");
  const targetWorkspace = createGitWorkspace("taskmux-portable-clean-repository-workspace-");
  t.after(() => {
    target.disposeEphemeralWorkspace();
    rmSync(targetWorkspace, { recursive: true, force: true });
  });

  target.saveConfiguredAgent(configuredAgent());
  target.saveConfig({ schemaVersion: 1 });
  assert.equal(target.listGlobalRoles().length, 0);
  assert.doesNotMatch(readFileSync(output, "utf8"), new RegExp(targetWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(executeDomainTransaction(
    target.rootDirectory(),
    "portable-clean-repository-target",
    (workingRoot) => runImportCommand(
      [output, "--workspace-map", `repository-1=${targetWorkspace}`],
      new FileTaskStore(workingRoot)
    )
  ), /Imported TaskMux portable data/);

  assert.equal(target.getGlobalRole("operator").workspace, targetWorkspace);
  assert.equal(target.getGlobalRole("anchor"), null);
  const manifest = readFileSync(output, "utf8");
  assert.doesNotMatch(manifest, new RegExp(sourceWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(manifest, new RegExp(targetWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("FileTaskStore imports a non-Git Role workspace into a clean canonical directory target", (t) => {
  const { output, workspace: sourceWorkspace } = createDirectoryPortableSource(t);
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-clean-directory-target-");
  const targetWorkspace = mkdtempSync(join(tmpdir(), "taskmux-portable-clean-directory-workspace-"));
  t.after(() => {
    target.disposeEphemeralWorkspace();
    rmSync(targetWorkspace, { recursive: true, force: true });
  });

  target.saveConfiguredAgent(configuredAgent());
  target.saveConfig({ schemaVersion: 1 });
  assert.equal(target.listGlobalRoles().length, 0);

  assert.match(executeDomainTransaction(
    target.rootDirectory(),
    "portable-clean-directory-target",
    (workingRoot) => runImportCommand(
      [output, "--workspace-map", `repository-1=${targetWorkspace}`],
      new FileTaskStore(workingRoot)
    )
  ), /Imported TaskMux portable data/);

  assert.equal(target.getGlobalRole("operator").workspace, targetWorkspace);
  assert.doesNotMatch(readFileSync(output, "utf8"), new RegExp(sourceWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(readFileSync(output, "utf8"), new RegExp(targetWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("FileTaskStore accepts a canonical non-Git existing workspace binding", (t) => {
  const { output } = createDirectoryPortableSource(t, "taskmux-portable-existing-directory-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-existing-directory-target-");
  const targetWorkspace = mkdtempSync(join(tmpdir(), "taskmux-portable-existing-directory-workspace-"));
  t.after(() => {
    target.disposeEphemeralWorkspace();
    rmSync(targetWorkspace, { recursive: true, force: true });
  });

  target.saveConfiguredAgent(configuredAgent());
  target.saveGlobalRole(createGlobalRole("anchor", [binding()], "codex", targetWorkspace, now));
  assert.match(executeDomainTransaction(
    target.rootDirectory(),
    "portable-existing-directory-binding",
    (workingRoot) => runImportCommand(
      [output, "--workspace-map", "repository-1=repository-1"],
      new FileTaskStore(workingRoot)
    )
  ), /Imported TaskMux portable data/);
  assert.equal(target.getGlobalRole("operator").workspace, targetWorkspace);
});

test("FileTaskStore reuses direct workspace bindings across repeated plans", (t) => {
  const { output } = createDirectoryPortableSource(t, "taskmux-portable-stable-plan-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-stable-plan-target-");
  const targetWorkspace = mkdtempSync(join(tmpdir(), "taskmux-portable-stable-plan-workspace-"));
  t.after(() => {
    target.disposeEphemeralWorkspace();
    rmSync(targetWorkspace, { recursive: true, force: true });
  });

  target.saveConfiguredAgent(configuredAgent());
  const raw = readFileSync(output, "utf8");
  assert.deepEqual(executeDomainTransaction(
    target.rootDirectory(),
    "portable-stable-repeated-plan",
    (workingRoot) => {
      const importTarget = createPortableFileStoreImportTarget(new FileTaskStore(workingRoot));
      const mappings = [{
        schemaVersion: 1,
        sourceBindingId: "repository-1",
        targetWorkspacePath: targetWorkspace
      }];
      const firstPlan = planPortableImport(raw, mappings, importTarget);
      const secondPlan = planPortableImport(raw, mappings, importTarget);
      assert.deepEqual(firstPlan.entries.map((entry) => entry.action), ["create"]);
      assert.deepEqual(secondPlan.entries.map((entry) => entry.action), ["create"]);
      return applyPortableImportPlanInTransaction(firstPlan, importTarget);
    }
  ), {
    schemaVersion: 1,
    created: 1,
    noOp: 0
  });
  assert.equal(target.getGlobalRole("operator").workspace, targetWorkspace);
});

test("FileTaskStore rejects unsafe, incompatible, and path-drifted direct Role workspace mappings", (t) => {
  const { output } = createRepositoryPortableSource(t, "taskmux-portable-repository-rejections-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-repository-rejections-target-");
  const targetWorkspace = createGitWorkspace("taskmux-portable-repository-rejections-workspace-");
  const postApplyWorkspace = createGitWorkspace("taskmux-portable-repository-post-apply-workspace-");
  const nonGitWorkspace = mkdtempSync(join(tmpdir(), "taskmux-portable-non-git-workspace-"));
  const symlinkWorkspace = join(tmpdir(), `taskmux-portable-repository-link-${Date.now()}-${Math.random()}`);
  t.after(() => {
    target.disposeEphemeralWorkspace();
    rmSync(targetWorkspace, { recursive: true, force: true });
    rmSync(postApplyWorkspace, { recursive: true, force: true });
    rmSync(nonGitWorkspace, { recursive: true, force: true });
    rmSync(symlinkWorkspace, { force: true });
  });

  target.saveConfiguredAgent(configuredAgent());
  target.saveConfig({ schemaVersion: 1, defaultWorkspace: nonGitWorkspace });
  symlinkSync(targetWorkspace, symlinkWorkspace, "dir");

  for (const [index, mapping] of [
    "repository-1=default",
    `repository-1=${symlinkWorkspace}`
  ].entries()) {
    assert.throws(
      () => executeDomainTransaction(
        target.rootDirectory(),
        `portable-rejection-${index + 1}`,
        (workingRoot) => runImportCommand(
          [output, "--workspace-map", mapping],
          new FileTaskStore(workingRoot)
        )
      ),
      /Portable (workspace mapping is invalid|import requirements are unavailable)/
    );
    assert.equal(target.getGlobalRole("operator"), null);
  }

  const raw = readFileSync(output, "utf8");
  executeDomainTransaction(target.rootDirectory(), "portable-repository-drift", (workingRoot) => {
    const transactionStore = new FileTaskStore(workingRoot);
    const importTarget = createPortableFileStoreImportTarget(transactionStore);
    const plan = planPortableImport(raw, [{
      schemaVersion: 1,
      sourceBindingId: "repository-1",
      targetWorkspacePath: targetWorkspace
    }], importTarget);
    rmSync(targetWorkspace, { recursive: true, force: true });
    mkdirSync(targetWorkspace);
    assert.throws(
      () => applyPortableImportPlanInTransaction(plan, importTarget),
      (error) => error instanceof PortableImportError && error.code === "IMPORT_DRIFT"
    );
  });
  assert.equal(target.getGlobalRole("operator"), null);

  assert.throws(
    () => executeDomainTransaction(target.rootDirectory(), "portable-repository-post-apply-drift", (workingRoot) => {
      const transactionStore = new FileTaskStore(workingRoot);
      const importTarget = createPortableFileStoreImportTarget(transactionStore);
      const plan = planPortableImport(raw, [{
        schemaVersion: 1,
        sourceBindingId: "repository-1",
        targetWorkspacePath: postApplyWorkspace
      }], importTarget);
      const originalSaveGlobalRole = FileTaskStore.prototype.saveGlobalRole;
      FileTaskStore.prototype.saveGlobalRole = function patchedSaveGlobalRole(...args) {
        originalSaveGlobalRole.apply(this, args);
        rmSync(postApplyWorkspace, { recursive: true, force: true });
        mkdirSync(postApplyWorkspace);
      };
      try {
        return applyPortableImportPlanInTransaction(plan, importTarget);
      } finally {
        FileTaskStore.prototype.saveGlobalRole = originalSaveGlobalRole;
      }
    }),
    (error) => error instanceof PortableImportError && error.code === "IMPORT_DRIFT"
  );
  assert.equal(target.getGlobalRole("operator"), null);
});

test("FileTaskStore rejects duplicate direct workspace targets and preserves binding-id compatibility", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-duplicate-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-duplicate-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-duplicate-output-"));
  const output = join(outputDir, "portable.json");
  const sourceOne = createGitWorkspace("taskmux-portable-duplicate-source-one-");
  const sourceTwo = createGitWorkspace("taskmux-portable-duplicate-source-two-");
  const targetWorkspace = createGitWorkspace("taskmux-portable-duplicate-target-workspace-");
  const targetWorkspaceTwo = createGitWorkspace("taskmux-portable-duplicate-target-workspace-two-");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(sourceOne, { recursive: true, force: true });
    rmSync(sourceTwo, { recursive: true, force: true });
    rmSync(targetWorkspace, { recursive: true, force: true });
    rmSync(targetWorkspaceTwo, { recursive: true, force: true });
  });

  source.saveConfiguredAgent(configuredAgent());
  source.saveGlobalRole(createGlobalRole("operator", [binding()], "codex", sourceOne, now));
  source.saveTask(createTask("task-1", "second workspace", now));
  source.saveRole("task-1", createRole("task-1", "leader", [binding()], "codex", sourceTwo, now));
  assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);

  target.saveConfiguredAgent(configuredAgent());
  assert.throws(
    () => executeDomainTransaction(
      target.rootDirectory(),
      "portable-duplicate-workspace-target",
      (workingRoot) => runImportCommand([
        output,
        "--workspace-map", `repository-1=${targetWorkspace}`,
        "--workspace-map", `repository-2=${targetWorkspace}`
      ], new FileTaskStore(workingRoot))
    ),
    /Portable workspace mapping is invalid/
  );
  assert.equal(target.getGlobalRole("operator"), null);

  target.saveGlobalRole(createGlobalRole("anchor", [binding()], "codex", targetWorkspace, now));
  target.saveGlobalRole(createGlobalRole("anchor-two", [binding()], "codex", targetWorkspaceTwo, now));
  assert.match(executeDomainTransaction(
    target.rootDirectory(),
    "portable-existing-binding-id",
    (workingRoot) => runImportCommand([
      output,
      "--workspace-map", "repository-1=repository-1",
      "--workspace-map", "repository-2=repository-2"
    ], new FileTaskStore(workingRoot))
  ), /Imported TaskMux portable data/);
  assert.ok([targetWorkspace, targetWorkspaceTwo].includes(target.getGlobalRole("operator").workspace));
  assert.ok([targetWorkspace, targetWorkspaceTwo].includes(target.getRole("task-1", "leader").workspace));
});

test("FileTaskStore rolls back direct workspace imports after post-apply failure", (t) => {
  const { output } = createRepositoryPortableSource(t, "taskmux-portable-rollback-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-rollback-target-");
  const targetWorkspace = createGitWorkspace("taskmux-portable-rollback-workspace-");
  t.after(() => {
    target.disposeEphemeralWorkspace();
    rmSync(targetWorkspace, { recursive: true, force: true });
  });

  target.saveConfiguredAgent(configuredAgent());
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFailpoint = process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
  try {
    process.env.NODE_ENV = "test";
    process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = "after-apply";
    assert.throws(
      () => executeDomainTransaction(
        target.rootDirectory(),
        "portable-direct-workspace-rollback",
        (workingRoot) => runImportCommand(
          [output, "--workspace-map", `repository-1=${targetWorkspace}`],
          new FileTaskStore(workingRoot)
        )
      ),
      /Portable import failed/
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFailpoint === undefined) delete process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
    else process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = previousFailpoint;
  }
  assert.equal(target.getGlobalRole("operator"), null);
});

test("portable input history redacts native tuples, imports terminal records atomically, and skips open input/runtime runs", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-input-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-input-target-");
  const rollbackTarget = FileTaskStore.createEphemeralWorkspace("taskmux-portable-input-rollback-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-input-output-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rollbackTarget.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  configurePortableInputStore(source, "/host/source-workspace");
  source.saveGlobalRole(createGlobalRole(
    "operator",
    [binding()],
    "codex",
    "/host/source-workspace",
    now
  ));
  source.saveTask(createTask("task-1", "Portable input history", now));
  source.saveRole("task-1", createRole(
    "task-1",
    "leader",
    [binding()],
    "codex",
    "/host/source-workspace",
    now
  ));

  const transitionedAt = new Date("2026-07-15T00:01:00.000Z");
  const cancelled = cancelInputRequest(
    userRequiredInput("input-cancelled", "run-cancelled"),
    "The task no longer needs this choice.",
    transitionedAt
  );
  source.saveInputRequest(cancelled);
  source.saveAgentRun(resumeBlockedAgentRun(
    blockAgentRunForInput(
      createAgentRun("run-cancelled", "task-1", "leader", "new", "Waiting for cancellation", now),
      cancelled.id,
      transitionedAt
    ),
    cancelled.id,
    transitionedAt
  ));

  const answered = answerInputRequest(
    userRequiredInput("input-answered", "run-answered"),
    "resolution-answered",
    { choiceKey: "continue", text: "ignored" },
    "online",
    transitionedAt
  );
  source.saveInputRequest(answered.request);
  source.saveInputResolution(answered.resolution);
  source.saveAgentRun(blockAgentRunForInput(
    createAgentRun("run-answered", "task-1", "leader", "new", "Waiting for answer wakeup", now),
    answered.request.id,
    transitionedAt
  ));

  source.saveAgentRun(terminalRun("run-auto", transitionedAt));

  const autoOpen = createInputRequest(
    "input-auto",
    "task-1",
    requester("run-auto"),
    {
      question: "Use the safe default?",
      choices: [{ key: "continue", label: "Continue" }],
      blockedRefs: [],
      resolutionPolicy: {
        mode: "offline-recommended",
        recommendation: { choiceKey: "continue", reason: "The default is safe." },
        offlineTimeoutMs: 60_000
      }
    },
    now
  );
  const autoResolved = autoResolveInputRequest(
    autoOpen,
    "resolution-auto",
    "offline",
    transitionedAt
  );
  source.saveInputRequest(autoResolved.request);
  source.saveInputResolution(autoResolved.resolution);

  const open = userRequiredInput("input-open", "run-blocked");
  source.saveInputRequest(open);
  source.saveAgentRun(blockAgentRunForInput(
    createAgentRun("run-blocked", "task-1", "leader", "new", "Waiting for input", now),
    open.id,
    transitionedAt
  ));
  source.saveAgentRun(createAgentRun(
    "run-active",
    "task-1",
    "leader",
    "new",
    "Still running",
    now
  ));

  assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);
  const snapshot = JSON.parse(readFileSync(output, "utf8"));
  const histories = snapshot.semantic.filter((record) => record.authority === "input-request-history");
  assert.deepEqual(histories.map((record) => record.key), [
    "task-1/input-answered",
    "task-1/input-auto",
    "task-1/input-cancelled"
  ]);
  assert.equal(snapshot.semantic.some((record) =>
    record.authority === "input-request-history" && record.key === "task-1/input-open"
  ), false);
  assert.equal(snapshot.semantic.some((record) =>
    record.authority === "agent-run-history" &&
      [
        "task-1/run-active",
        "task-1/run-answered",
        "task-1/run-blocked",
        "task-1/run-cancelled"
      ].includes(record.key)
  ), false);
  assert.deepEqual(
    histories.map((history) => ({
      key: history.key,
      requesterRunReferences: history.references
        .filter((reference) => reference.authority === "agent-run-history")
        .map((reference) => reference.key)
    })),
    [
      { key: "task-1/input-answered", requesterRunReferences: [] },
      { key: "task-1/input-auto", requesterRunReferences: ["task-1/run-auto"] },
      { key: "task-1/input-cancelled", requesterRunReferences: [] }
    ]
  );
  for (const history of histories) {
    assert.deepEqual(
      Object.keys(history.payload.requester).sort(),
      ["adapterId", "agentId", "agentRunId", "roleName"]
    );
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /source-session-root|native-source-/);

  const missingTerminalRunLink = structuredClone(snapshot);
  const autoHistory = missingTerminalRunLink.semantic.find((record) =>
    record.authority === "input-request-history" && record.key === "task-1/input-auto"
  );
  assert.ok(autoHistory);
  autoHistory.references = autoHistory.references.filter((reference) =>
    reference.authority !== "agent-run-history"
  );
  assert.equal(snapshotPortableSnapshotV3(missingTerminalRunLink), null);

  const danglingNonportableRunLink = structuredClone(snapshot);
  const cancelledHistory = danglingNonportableRunLink.semantic.find((record) =>
    record.authority === "input-request-history" && record.key === "task-1/input-cancelled"
  );
  assert.ok(cancelledHistory);
  cancelledHistory.references.unshift({
    lifecycle: "live",
    authority: "agent-run-history",
    key: "task-1/run-cancelled"
  });
  assert.equal(snapshotPortableSnapshotV3(danglingNonportableRunLink), null);

  configurePortableInputStore(target, "/target/workspace");
  assert.match(executeDomainTransaction(
    target.rootDirectory(),
    "portable-input-import",
    (workingRoot) => runImportCommand(
      [output, "--workspace-map", "default=default"],
      new FileTaskStore(workingRoot)
    )
  ), /Created: \d+/);

  assert.deepEqual(
    target.listInputRequests("task-1").map((request) => `${request.id}:${request.status}`),
    [
      "input-answered:answered",
      "input-auto:auto-resolved",
      "input-cancelled:cancelled"
    ]
  );
  for (const request of target.listInputRequests("task-1")) {
    assert.equal(Object.hasOwn(request.requester, "sessionRoot"), false);
    assert.equal(Object.hasOwn(request.requester, "nativeSessionId"), false);
  }
  assert.equal(target.getInputResolution("task-1", "resolution-answered").requestId, "input-answered");
  assert.equal(target.getInputResolution("task-1", "resolution-auto").requestId, "input-auto");
  assert.deepEqual(
    scanOfflineInputResolutions(
      target,
      { state: "offline" },
      new Date("2026-07-15T00:02:00.000Z"),
      () => "unexpected-resolution"
    ),
    { started: [], resolved: [], cleared: [] }
  );

  configurePortableInputStore(rollbackTarget, "/rollback/workspace");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFailpoint = process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
  process.env.NODE_ENV = "test";
  process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = "after-apply";
  try {
    assert.throws(
      () => executeDomainTransaction(
        rollbackTarget.rootDirectory(),
        "portable-input-rollback",
        (workingRoot) => runImportCommand(
          [output, "--workspace-map", "default=default"],
          new FileTaskStore(workingRoot)
        )
      ),
      /Portable import failed/
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFailpoint === undefined) delete process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
    else process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = previousFailpoint;
  }
  assert.equal(rollbackTarget.getTask("task-1"), null);
  assert.deepEqual(rollbackTarget.listInputRequests("task-1"), []);
});

test("portable FileTaskStore import and export enforce the shared exact 8 MiB cap without partial state", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-cap-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-cap-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-cap-output-"));
  const oversizedOutput = join(outputDir, "oversized-export.json");
  const exactInput = join(outputDir, "exact-import.json");
  const tooLargeInput = join(outputDir, "too-large-import.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  source.saveTask(createTask(
    "task-oversized",
    "Oversized portable snapshot",
    now,
    { description: "x".repeat(MAX_PORTABLE_SNAPSHOT_BYTES) }
  ));
  assert.throws(
    () => runExportCommand(["--output", oversizedOutput], source),
    /Portable export failed/
  );
  assert.equal(existsSync(oversizedOutput), false);

  const emptyManifest = renderPortableSnapshotV3({
    listAuthorityIds: () => [],
    readAuthorityRecords: () => [],
    readWorkspaceBindings: () => [],
    readAgentRequirements: () => []
  }, now.toISOString()).manifest;
  const exact = `${emptyManifest}${" ".repeat(
    MAX_PORTABLE_SNAPSHOT_BYTES - Buffer.byteLength(emptyManifest, "utf8")
  )}`;
  assert.equal(Buffer.byteLength(exact, "utf8"), MAX_PORTABLE_SNAPSHOT_BYTES);
  writeFileSync(exactInput, exact);
  assert.match(executeDomainTransaction(
    target.rootDirectory(),
    "portable-cap-exact",
    (workingRoot) => runImportCommand([exactInput], new FileTaskStore(workingRoot))
  ), /Created: 0/);

  writeFileSync(tooLargeInput, `${exact} `);
  assert.throws(
    () => executeDomainTransaction(
      target.rootDirectory(),
      "portable-cap-too-large",
      (workingRoot) => runImportCommand([tooLargeInput], new FileTaskStore(workingRoot))
    ),
    /exceeds the 8 MiB limit/
  );
  assert.equal(target.getTask("task-oversized"), null);
});

test("portable configured Skills participate in the shared exact 8 MiB export cap", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-cap-source-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-configured-skill-cap-output-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  source.saveConfiguredAgent(configuredAgent());
  source.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/source-workspace" });
  source.saveConfiguredSkill(configuredSkill(
    "oversized-skill",
    "x".repeat(MAX_PORTABLE_SNAPSHOT_BYTES)
  ));
  source.saveGlobalRole(createGlobalRole(
    "operator",
    [binding()],
    "codex",
    "/host/source-workspace",
    now,
    { skills: ["oversized-skill"] }
  ));

  assert.throws(
    () => runExportCommand(["--output", output], source),
    /Portable export failed/
  );
  assert.equal(existsSync(output), false);
});

test("configured Skill storage rejects unsafe identifiers", (t) => {
  const store = FileTaskStore.createEphemeralWorkspace("taskmux-configured-skill-id-");
  t.after(() => store.disposeEphemeralWorkspace());

  assert.throws(
    () => store.saveConfiguredSkill(configuredSkill("../outside", "# Invalid")),
    /Invalid configured Skill record/
  );
  assert.throws(
    () => store.getConfiguredSkill("../outside"),
    /Invalid configured Skill id/
  );
});

test("portable export publishes atomically without replacing an existing destination", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-no-clobber-source-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-no-clobber-output-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  source.saveTask(createTask("task-1", "No clobber", now));
  writeFileSync(output, "existing portable snapshot\n");
  assert.throws(
    () => runExportCommand(["--output", output], source),
    (error) => error instanceof Error && "code" in error && error.code === "EEXIST"
  );
  assert.equal(readFileSync(output, "utf8"), "existing portable snapshot\n");
});

test("portable configured Skills round-trip across multi-Agent Global and Task Roles before Role writes", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-configured-skill-output-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  persistPortableAgents(source);
  source.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/source-workspace" });
  source.saveConfiguredSkill(configuredSkill(
    "architecture-review",
    "# Architecture review\n\nPreserve domain boundaries."
  ));
  source.saveConfiguredSkill(configuredSkill(
    "security-review",
    "# Security review\n\nInspect trust boundaries."
  ));
  source.saveGlobalRole(createGlobalRole(
    "operator",
    multiAgentBindings(),
    "codex",
    "/host/source-workspace",
    now,
    { skills: ["architecture-review", "security-review"] }
  ));
  source.saveTask(createTask("task-1", "Portable configured skills", now));
  source.saveRole("task-1", createRole(
    "task-1",
    "leader",
    multiAgentBindings(),
    "claude",
    "/host/source-workspace",
    now,
    {
      responsibilities: ["Coordinate the review."],
      skills: ["security-review", "architecture-review"]
    }
  ));

  assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);
  const snapshot = JSON.parse(readFileSync(output, "utf8"));
  const exportedSkills = snapshot.semantic
    .filter((record) => record.authority === "configured-skill")
    .map((record) => record.payload);
  assert.deepEqual(exportedSkills, [
    configuredSkill("architecture-review", "# Architecture review\n\nPreserve domain boundaries."),
    configuredSkill("security-review", "# Security review\n\nInspect trust boundaries.")
  ]);
  assert.deepEqual(
    snapshot.semantic.find((record) => record.authority === "global-role").payload.skills,
    ["architecture-review", "security-review"]
  );
  assert.deepEqual(
    snapshot.semantic.find((record) => record.authority === "task-role").payload.skills,
    ["security-review", "architecture-review"]
  );

  persistPortableAgents(target);
  target.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/target-workspace" });
  const writes = [];
  const originalSaveConfiguredSkill = FileTaskStore.prototype.saveConfiguredSkill;
  const originalSaveGlobalRole = FileTaskStore.prototype.saveGlobalRole;
  const originalSaveRole = FileTaskStore.prototype.saveRole;
  FileTaskStore.prototype.saveConfiguredSkill = function (skill) {
    writes.push(`skill:${skill.id}`);
    return originalSaveConfiguredSkill.call(this, skill);
  };
  FileTaskStore.prototype.saveGlobalRole = function (role) {
    writes.push(`global-role:${role.name}`);
    return originalSaveGlobalRole.call(this, role);
  };
  FileTaskStore.prototype.saveRole = function (taskId, role) {
    writes.push(`task-role:${taskId}/${role.name}`);
    return originalSaveRole.call(this, taskId, role);
  };
  try {
    assert.match(
      runPortableImport(target, output, "portable-configured-skill-roundtrip"),
      /Created: 6/
    );
  } finally {
    FileTaskStore.prototype.saveConfiguredSkill = originalSaveConfiguredSkill;
    FileTaskStore.prototype.saveGlobalRole = originalSaveGlobalRole;
    FileTaskStore.prototype.saveRole = originalSaveRole;
  }

  const firstRoleWrite = writes.findIndex((entry) => entry.startsWith("global-role:") || entry.startsWith("task-role:"));
  assert.ok(firstRoleWrite > 0);
  assert.ok(writes.slice(0, firstRoleWrite).every((entry) => entry.startsWith("skill:")));
  assert.deepEqual(target.getGlobalRole("operator")?.skills, ["architecture-review", "security-review"]);
  assert.deepEqual(target.getRole("task-1", "leader")?.skills, ["security-review", "architecture-review"]);
  assert.deepEqual(target.getConfiguredSkill("architecture-review"), configuredSkill(
    "architecture-review",
    "# Architecture review\n\nPreserve domain boundaries."
  ));
  assert.deepEqual(target.getConfiguredSkill("security-review"), configuredSkill(
    "security-review",
    "# Security review\n\nInspect trust boundaries."
  ));
  assert.equal(
    dispatch(target, "task-1", "leader", "Review now"),
    dispatch(source, "task-1", "leader", "Review now")
  );
});

test("portable export round-trips every configured Skill once in deterministic order, including unassigned Skills", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-unassigned-configured-skill-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-unassigned-configured-skill-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-unassigned-configured-skill-output-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  persistPortableAgents(source);
  source.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/source-workspace" });
  source.saveConfiguredSkill(configuredSkill("z-unassigned", "# Unassigned\n\nReusable by a future Role."));
  source.saveConfiguredSkill(configuredSkill("a-assigned", "# Assigned\n\nUsed by the operator."));
  source.saveGlobalRole(createGlobalRole(
    "operator",
    multiAgentBindings(),
    "codex",
    "/host/source-workspace",
    now,
    { skills: ["a-assigned"] }
  ));

  assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);
  const snapshot = JSON.parse(readFileSync(output, "utf8"));
  const exportedSkillIds = snapshot.semantic
    .filter((record) => record.authority === "configured-skill")
    .map((record) => record.key);
  assert.deepEqual(exportedSkillIds, ["a-assigned", "z-unassigned"]);
  assert.equal(new Set(exportedSkillIds).size, exportedSkillIds.length);
  assert.deepEqual(
    snapshot.semantic.find((record) => record.authority === "global-role").references,
    [{ lifecycle: "live", authority: "configured-skill", key: "a-assigned" }]
  );

  persistPortableAgents(target);
  target.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/target-workspace" });
  assert.match(
    runPortableImport(target, output, "portable-unassigned-configured-skill-roundtrip"),
    /Created:/
  );
  assert.deepEqual(
    target.getConfiguredSkill("a-assigned"),
    configuredSkill("a-assigned", "# Assigned\n\nUsed by the operator.")
  );
  assert.deepEqual(
    target.getConfiguredSkill("z-unassigned"),
    configuredSkill("z-unassigned", "# Unassigned\n\nReusable by a future Role.")
  );
  assert.deepEqual(target.getGlobalRole("operator")?.skills, ["a-assigned"]);
});

test("portable export fails closed when a referenced configured Skill is missing", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-missing-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-configured-skill-missing-output-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  persistPortableAgents(source);
  source.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/source-workspace" });
  source.saveGlobalRole(createGlobalRole(
    "operator",
    multiAgentBindings(),
    "codex",
    "/host/source-workspace",
    now,
    { skills: ["missing-skill"] }
  ));

  assert.throws(
    () => runExportCommand(["--output", output], source),
    /Portable export failed/
  );
  assert.equal(existsSync(output), false);
});

test("portable import rolls back configured Skills and Role references when apply fails", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-rollback-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-rollback-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-configured-skill-rollback-output-"));
  const output = join(outputDir, "portable.json");
  const previousFailpoint = process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
  const previousNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    if (previousFailpoint === undefined) {
      delete process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT;
    } else {
      process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = previousFailpoint;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  persistPortableAgents(source);
  source.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/source-workspace" });
  source.saveConfiguredSkill(configuredSkill("security-review", "# Security review\n\nDo not leak secrets."));
  source.saveTask(createTask("task-1", "Rollback configured skill", now));
  source.saveRole("task-1", createRole(
    "task-1",
    "leader",
    multiAgentBindings(),
    "codex",
    "/host/source-workspace",
    now,
    { skills: ["security-review"] }
  ));
  runExportCommand(["--output", output], source);

  persistPortableAgents(target);
  target.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/target-workspace" });
  process.env.NODE_ENV = "test";
  process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT = "after-apply";
  assert.throws(
    () => runPortableImport(target, output, "portable-configured-skill-rollback"),
    /Portable import failed/
  );
  assert.equal(target.getConfiguredSkill("security-review"), null);
  assert.equal(target.getTask("task-1"), null);
  assert.equal(target.getRole("task-1", "leader"), null);
});

test("portable configured Skill export rejects symlinked physical Skill trees", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-symlink-source-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-configured-skill-symlink-output-"));
  const external = mkdtempSync(join(tmpdir(), "taskmux-portable-configured-skill-external-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });

  persistPortableAgents(source);
  source.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/source-workspace" });
  source.saveConfiguredSkill(configuredSkill("security-review", "# Security review\n\nOriginal."));
  source.saveGlobalRole(createGlobalRole(
    "operator",
    multiAgentBindings(),
    "codex",
    "/host/source-workspace",
    now,
    { skills: ["security-review"] }
  ));
  writeFileSync(join(external, "SKILL.md"), "# Security review\n\nSymlink target.");
  rmSync(join(source.rootDirectory(), "skills", "security-review"), { recursive: true, force: true });
  symlinkSync(external, join(source.rootDirectory(), "skills", "security-review"), "dir");

  assert.throws(
    () => runExportCommand(["--output", output], source),
    /Portable export failed/
  );
  assert.equal(existsSync(output), false);
});

test("portable configured Skill imports fail closed on foreign, duplicate, and hash-drifted records", (t) => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-reject-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-portable-configured-skill-reject-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-portable-configured-skill-reject-output-"));
  const output = join(outputDir, "portable.json");
  t.after(() => {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  });

  persistPortableAgents(source);
  source.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/source-workspace" });
  source.saveConfiguredSkill(configuredSkill("security-review", "# Security review\n\nSource content."));
  source.saveGlobalRole(createGlobalRole(
    "operator",
    multiAgentBindings(),
    "codex",
    "/host/source-workspace",
    now,
    { skills: ["security-review"] }
  ));
  runExportCommand(["--output", output], source);
  const snapshot = JSON.parse(readFileSync(output, "utf8"));

  persistPortableAgents(target);
  target.saveConfig({ schemaVersion: 1, defaultWorkspace: "/host/target-workspace" });
  target.saveConfiguredSkill(configuredSkill("security-review", "# Security review\n\nForeign target content."));
  assert.throws(
    () => runPortableImport(target, output, "portable-configured-skill-foreign"),
    /Portable import conflicts/
  );
  assert.equal(
    target.getConfiguredSkill("security-review")?.content,
    "# Security review\n\nForeign target content."
  );
  assert.equal(target.getGlobalRole("operator"), null);

  const duplicate = structuredClone(snapshot);
  duplicate.semantic.push(structuredClone(
    duplicate.semantic.find((record) => record.authority === "configured-skill")
  ));
  const duplicateInput = join(outputDir, "duplicate.json");
  writeFileSync(duplicateInput, JSON.stringify(duplicate));
  assert.throws(
    () => runPortableImport(target, duplicateInput, "portable-configured-skill-duplicate"),
    /Portable import snapshot is invalid/
  );

  const hashDrift = structuredClone(snapshot);
  hashDrift.semantic.find((record) => record.authority === "configured-skill").payload.content =
    "# Security review\n\nTampered content.";
  const hashDriftInput = join(outputDir, "hash-drift.json");
  writeFileSync(hashDriftInput, JSON.stringify(hashDrift));
  assert.throws(
    () => runPortableImport(target, hashDriftInput, "portable-configured-skill-hash-drift"),
    /Portable import snapshot is invalid/
  );
});
