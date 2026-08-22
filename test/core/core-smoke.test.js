import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import {
  assertRegistryCoversBaselineToCurrent,
  createProductionRegistry
} from "../../dist/storage/migration/index.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { validateAgentLaunchConfiguration } from "../../dist/executor/agentConfigurationCatalog.js";
import { runExecutionAudit } from "../../dist/observability/executionAudit.js";
import { createAgentRun, failAgentRun } from "../../dist/run/agentRun.js";
import {
  createSessionLaunchRequest,
  RuntimeLaunchFailure,
  TmuxSessionHost
} from "../../dist/runtime/index.js";

const root = resolve(import.meta.dirname, "../..");

test("the packaged CLI starts and exposes the core workflow", () => {
  const help = execFileSync(process.execPath, [join(root, "dist", "cli.js"), "help"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.match(help, /Yui/u);
  const commands = listPublicCommandPaths();
  for (const command of ["setup", "update", "upgrade", "task create", "task list"]) {
    assert.ok(commands.includes(command), `missing core command: ${command}`);
  }
});

test("the SQLite Task path persists one normal Task and Message", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-20T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const task = activateTask(createTask(store.nextTaskId(), "Core smoke", now), now);
  store.saveTask(task);
  const message = createTaskMessage(
    store.nextMessageId(task.id),
    task.id,
    "Keep the core path healthy.",
    "user",
    { type: "user" },
    now,
    { wakePolicy: "leader" }
  );
  store.saveMessage(task.id, message);
  store.close();

  const reopened = new SqliteTaskStore(home);
  assert.equal(reopened.getTask(task.id)?.status, "active");
  assert.deepEqual(reopened.listMessages(task.id), [message]);
  reopened.close();
});

test("the production migration graph advances the normal aggregate path", () => {
  const registry = createProductionRegistry();
  assert.doesNotThrow(() => assertRegistryCoversBaselineToCurrent(registry));
  const step = registry.lookup("aggregate", undefined, 18);
  assert.notEqual(step, undefined);
  const source = {
    schemaManifest: { aggregateSchemaVersion: 18 },
    state: { schemaVersion: 18, tasks: {} }
  };
  step.preconditions(source);
  const migrated = step.transform(source);
  assert.equal(migrated.schemaManifest.aggregateSchemaVersion, 19);
  assert.equal(migrated.state.schemaVersion, 19);
});

test("the built-in Agent Drivers are available through the shared registry", () => {
  const drivers = builtinAgentDriverRegistry();
  assert.equal(drivers.requireByAdapterId("codex").id, "openai/codex");
  assert.equal(drivers.requireByAdapterId("claude").id, "anthropic/claude-code");
});

// Issue 02: managed Codex launch failures must be diagnosed at the failing
// phase instead of degrading to a generic command-execution error.

const launchWorkspace = "/tmp/yui-core-smoke-launch";
const launchEffective = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent",
  adapterId: "codex",
  profileAccess: "write",
  model: "gpt-bad",
  effort: "xhigh",
  search: false,
  permission: { strategy: "default" },
  writeProjectIds: [],
  workspace: { root: launchWorkspace, entries: [] },
  context: {}
};
const launchCatalog = {
  schemaVersion: 1,
  agentId: "agent",
  adapterId: "codex",
  models: [{
    value: "gpt-good",
    label: "Good",
    isDefault: true,
    efforts: [{ value: "low", label: "low" }, { value: "high", label: "high" }]
  }],
  fields: [],
  warnings: []
};

test("launch configuration validation rejects unsupported model and effort before launch", () => {
  assert.throws(
    () => validateAgentLaunchConfiguration(launchCatalog, {
      adapterId: "codex",
      model: "gpt-bad",
      permission: { strategy: "default" }
    }),
    /field=model.*supported=\["gpt-good"\]/u
  );
  assert.throws(
    () => validateAgentLaunchConfiguration(launchCatalog, {
      adapterId: "codex",
      effort: "xhigh",
      permission: { strategy: "default" }
    }),
    /field=effort.*supported=\["low","high"\]/u
  );
});

test("TmuxSessionHost runs launch validation before creating the provider process", async () => {
  let ensured = false;
  const planner = {
    plan: () => ({
      role: { name: "reviewer", workspace: launchWorkspace },
      launch: { command: "codex", args: ["--model", "gpt-bad"], env: {} },
      session: null,
      initialPromptRunId: "run-1"
    })
  };
  const tmux = {
    ensureRoleWindow: () => { ensured = true; return true; },
    inspectRolePane: () => ({ target: "tmux:0", dead: false, currentCommand: "codex" }),
    killRole: () => undefined
  };
  const host = new TmuxSessionHost(planner, tmux, {
    validateLaunch: async () => {
      throw new Error("field=model actual=gpt-bad supported=[gpt-good]");
    }
  });
  await assert.rejects(
    host.start(createSessionLaunchRequest({
      launchId: "launch-1",
      owner: { scope: "task", taskId: "task-1", roleName: "reviewer" },
      agentId: "agent",
      adapterId: "codex",
      effective: launchEffective,
      workspace: launchWorkspace,
      runId: "run-1",
      mode: "new"
    })),
    (error) => {
      assert.ok(error instanceof RuntimeLaunchFailure);
      assert.equal(error.diagnostic.phase, "validation");
      assert.equal(error.diagnostic.kind, "config");
      assert.deepEqual(error.diagnostic.argv, ["codex", "--model", "gpt-bad"]);
      assert.equal(ensured, false);
      return true;
    }
  );
});

test("TmuxSessionHost backstops an unresponsive agent and stops the host", async () => {
  let killed = false;
  const planner = {
    plan: () => ({
      role: { name: "reviewer", workspace: launchWorkspace },
      launch: { command: "codex", args: ["--model", "gpt-good"], env: {} },
      session: null,
      initialPromptRunId: "run-1"
    })
  };
  const tmux = {
    ensureRoleWindow: () => true,
    probeRoleStatus: () => "running",
    inspectRolePane: () => ({ target: "tmux:0", dead: false, currentCommand: "codex" }),
    captureRolePane: () => "",
    killRole: () => { killed = true; }
  };
  const host = new TmuxSessionHost(planner, tmux, {
    inactivityTimeoutMs: 25,
    waitForNativeSession: () => new Promise(() => undefined)
  });
  await assert.rejects(
    host.start(createSessionLaunchRequest({
      launchId: "launch-1",
      owner: { scope: "task", taskId: "task-1", roleName: "reviewer" },
      agentId: "agent",
      adapterId: "codex",
      effective: launchEffective,
      workspace: launchWorkspace,
      runId: "run-1",
      mode: "new"
    })),
    (error) => {
      assert.ok(error instanceof RuntimeLaunchFailure);
      assert.equal(error.diagnostic.phase, "native-session-discovery");
      assert.equal(error.diagnostic.kind, "timeout");
      assert.match(error.diagnostic.detail, /no signal/);
      assert.equal(killed, true);
      return true;
    }
  );
});

test("execution audit projects structured launch failure phase and kind", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-audit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-22T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const task = activateTask(createTask(store.nextTaskId(), "Audit smoke", now), now);
  store.saveTask(task);
  const run = failAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "reviewer",
    "new",
    "Review",
    now,
    { effective: launchEffective, purpose: "review" }
  ), "Role Run could not start: failurePhase=native-session-discovery failureKind=timeout argv=[\"codex\"]", now);
  store.saveAgentRun(run);
  const report = runExecutionAudit(home, {}, {
    openStore: () => store,
    directorySize: () => null
  });
  assert.equal(report.runs.status, "ok");
  assert.equal(report.runs.data.launchFailures.total, 1);
  assert.equal(report.runs.data.launchFailures.byPhase["native-session-discovery"], 1);
  assert.equal(report.runs.data.launchFailures.byKind.timeout, 1);
});
