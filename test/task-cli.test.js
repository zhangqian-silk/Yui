import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const cli = join(process.cwd(), "dist", "cli.js");

test("publishes package metadata with the taskmux command only", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

  assert.equal(packageJson.name, "@zq-silk/taskmux");
  assert.deepEqual(packageJson.bin, {
    taskmux: "./dist/cli.js"
  });
  assert.ok(packageJson.files.includes("skills"));
});

function runTaskmux(args, env) {
  return execFileSync("node", [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TASKMUX_CONTROLLER_MODE: "direct",
      ...env
    }
  });
}

function runTaskmuxFailure(args, env) {
  return spawnSync("node", [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TASKMUX_CONTROLLER_MODE: "direct",
      ...env
    }
  });
}

function runTaskmuxInteractive(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        TASKMUX_CONTROLLER_MODE: "direct",
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`taskmux exited with ${code}: ${stderr}`));
        return;
      }

      resolve(stdout);
    });

    child.stdin.end(input);
  });
}

function createFakeTmux(home) {
  const fakeTmux = join(home, "fake-tmux.js");
  const logFile = join(home, "tmux-calls.jsonl");

  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "has-session") process.exit(1);
if (args[0] === "list-windows") process.exit(0);
if (args[0] === "capture-pane") {
  process.stdout.write("recent reviewer output\\n");
  process.exit(0);
}
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return { fakeTmux, logFile };
}

function createStatusTmux(home) {
  const fakeTmux = join(home, "fake-status-tmux.js");

  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "list-windows") {
  process.stdout.write("rd\\n");
  process.exit(0);
}
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return fakeTmux;
}

function createExistingRoleTmux(home, roleName) {
  const fakeTmux = join(home, "fake-existing-role-tmux.js");
  const logFile = join(home, "existing-role-tmux-calls.jsonl");

  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "list-windows") process.stdout.write(${JSON.stringify(`${roleName}\n`)});
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return { fakeTmux, logFile };
}

function createStatefulTmux(home) {
  const fakeTmux = join(home, "fake-stateful-tmux.js");
  const logFile = join(home, "stateful-tmux-calls.jsonl");
  const stateFile = join(home, "stateful-tmux-windows.txt");

  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const state = process.env.FAKE_TMUX_STATE;
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "has-session") process.exit(existsSync(state) ? 0 : 1);
if (args[0] === "new-session") { writeFileSync(state, ""); process.exit(0); }
if (args[0] === "list-windows") { if (existsSync(state)) process.stdout.write(readFileSync(state, "utf8")); process.exit(0); }
if (args[0] === "new-window") {
  const name = args[args.indexOf("-n") + 1];
  const current = existsSync(state) ? readFileSync(state, "utf8").split("\\n").filter(Boolean) : [];
  if (!current.includes(name)) current.push(name);
  writeFileSync(state, current.join("\\n") + "\\n");
  process.exit(0);
}
if (args[0] === "kill-window") {
  const name = args.at(-1).split(":").at(-1);
  const current = existsSync(state) ? readFileSync(state, "utf8").split("\\n").filter((item) => item && item !== name) : [];
  writeFileSync(state, current.length === 0 ? "" : current.join("\\n") + "\\n");
  process.exit(0);
}
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return { fakeTmux, logFile, stateFile };
}

function createFailingDispatchTmux(home) {
  const fakeTmux = join(home, "fake-failing-dispatch-tmux.js");

  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "has-session" || args[0] === "new-session") process.exit(1);
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return fakeTmux;
}

function createFakeExecutable(home, name, output) {
  const executable = join(home, name);

  writeFileSync(
    executable,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(output)});
`
  );
  chmodSync(executable, 0o755);

  return executable;
}

function addRunner(home, id, command = id) {
  ensureTestStorageSchema(home);

  return runTaskmux(["runner", "add", id, "--command", command], {
    TASKMUX_HOME: home
  });
}

function addAgent(home, id, command = id) {
  ensureTestStorageSchema(home);

  return runTaskmux(["agent", "add", id, "--command", command], {
    TASKMUX_HOME: home
  });
}

function createTaskmuxHome() {
  return mkdtempSync(join(tmpdir(), "taskmux-test-"));
}

function createConfiguredHome() {
  const home = createTaskmuxHome();

  writeStorageSchema(home, 2);
  addRunner(home, "codex", "codex");
  addRunner(home, "claude", "claude");
  runTaskmux(["config", "set", "default-agent", "codex"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  return home;
}

function createPathExecutable(dir, name, body) {
  const executable = join(dir, name);

  writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(executable, 0o755);

  return executable;
}

function createShellExecutable(home, name, body) {
  const executable = join(home, name);

  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o755);

  return executable;
}

function tableRowRegex(item, status, detailPattern = ".*") {
  return new RegExp(`\\|\\s+${escapeRegex(item)}\\s+\\|\\s+${escapeRegex(status)}\\s+\\|\\s+${detailPattern}`);
}

function tableCellsRegex(...cells) {
  return new RegExp(`\\|\\s+${cells.map((cell) => cell instanceof RegExp ? cell.source : escapeRegex(cell)).join("\\s+\\|\\s+")}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeStorageSchema(home, storageVersion) {
  writeFileSync(
    join(home, "schema.json"),
    JSON.stringify({
      schemaVersion: 1,
      storageVersion,
      updatedAt: "2026-06-24T00:00:00.000Z"
    })
  );
}

function ensureTestStorageSchema(home) {
  if (!existsSync(join(home, "schema.json"))) {
    writeStorageSchema(home, 2);
  }
}

test("creates a task in the configured taskmux home", () => {
  const home = createConfiguredHome();

  const output = runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Created task task-1/);
  assert.match(output, /Refactor login page/);

  const task = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8")
  );
  const taskInfo = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8")
  );

  assert.equal(task.schemaVersion, 1);
  assert.equal(task.id, "task-1");
  assert.equal(task.status, undefined);
  assert.equal(task.archived, false);
  assert.equal(task.title, undefined);
  assert.equal(taskInfo.schemaVersion, 1);
  assert.equal(taskInfo.title, "Refactor login page");
});

test("creates tasks with the built-in leader role from configured runner defaults", () => {
  const home = createConfiguredHome();
  const leaderCli = createFakeExecutable(home, "leader-agent.js", "leader agent 1.0\n");

  addRunner(home, "leader-cli", leaderCli);
  runTaskmux(["config", "set", "default-agent", "leader-cli"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "create", "Leadable task"], {
    TASKMUX_HOME: home
  });
  const roles = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Assigned roles: leader/);
  assert.match(roles, tableCellsRegex("leader", "leader-cli", "idle", "/tmp/project-a"));
});

test("requires a leader role runner before creating a task", () => {
  const home = createTaskmuxHome();
  ensureTestStorageSchema(home);

  const result = runTaskmuxFailure(["task", "create", "Missing leader runner"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Role leader requires an agent or a configured global role/);
  assert.match(result.stderr, /taskmux role add leader --agent <agent-id>/);
});

test("normal commands require setup before writing storage", () => {
  const home = createTaskmuxHome();

  const result = runTaskmuxFailure(["task", "list"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: TaskMux is not initialized\. Run `taskmux setup`\./);
  assert.equal(existsSync(join(home, "schema.json")), false);
});

test("blocks normal commands when storage schema requires migration", () => {
  const home = createConfiguredHome();
  writeStorageSchema(home, 0);

  const result = runTaskmuxFailure(["task", "list"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Storage schema upgrade required: 0 -> 2/);
  assert.match(result.stderr, /Run `taskmux migrate`/);
});

test("migrates storage schema to the latest version", () => {
  const home = createConfiguredHome();
  writeStorageSchema(home, 0);

  const output = runTaskmux(["migrate"], {
    TASKMUX_HOME: home
  });
  const backupPath = output.match(/Backup: (.+)/)?.[1]?.trim();
  const schema = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));

  assert.match(output, /Migrated storage schema 0 -> 2/);
  assert.match(output, /Backup: /);
  assert.ok(backupPath);
  assert.equal(JSON.parse(readFileSync(join(backupPath, "schema.json"), "utf8")).storageVersion, 0);
  assert.equal(schema.schemaVersion, 1);
  assert.equal(schema.storageVersion, 2);
  assert.equal(typeof schema.updatedAt, "string");
  assert.match(
    runTaskmux(["task", "list"], { TASKMUX_HOME: home }),
    /No tasks found/
  );
});

test("migrates v1 tasks to archived markers and renames the system Operator", () => {
  const home = createTaskmuxHome();
  const taskDir = join(home, "tasks", "task-1");
  const assistantDir = join(home, "roles", "assistant");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(assistantDir, { recursive: true });
  writeStorageSchema(home, 1);
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    schemaVersion: 1,
    id: "task-1",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }));
  writeFileSync(join(taskDir, "info.json"), JSON.stringify({ schemaVersion: 1, title: "Legacy task" }));
  writeFileSync(join(assistantDir, "role.json"), JSON.stringify({ schemaVersion: 1, name: "assistant" }));

  const output = runTaskmux(["migrate"], { TASKMUX_HOME: home });
  const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));

  assert.match(output, /Migrated storage schema 1 -> 2/);
  assert.equal(task.archived, false);
  assert.equal(existsSync(join(home, "roles", "operator", "role.json")), true);
  assert.equal(existsSync(assistantDir), false);
});

test("creates explicit storage backups", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["backup"], {
    TASKMUX_HOME: home
  });
  const backupPath = output.match(/Created backup (.+)/)?.[1]?.trim();

  assert.ok(backupPath);
  assert.equal(existsSync(join(backupPath, "backups")), false);
  assert.equal(JSON.parse(readFileSync(join(backupPath, "schema.json"), "utf8")).storageVersion, 2);
  assert.equal(
    JSON.parse(readFileSync(join(backupPath, "tasks", "task-1", "info.json"), "utf8")).title,
    "Refactor login page"
  );
});

test("exports imports and prunes local data", () => {
  const sourceHome = createConfiguredHome();
  const targetHome = createConfiguredHome();
  const exportPath = join(sourceHome, "snapshot.json");

  runTaskmux(["config", "set", "default-agent", "codex"], {
    TASKMUX_HOME: sourceHome
  });
  runTaskmux(["task", "create", "Portable task", "--priority", "high"], {
    TASKMUX_HOME: sourceHome
  });
  runTaskmux(["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: sourceHome
  });
  runTaskmux(["task", "comment", "task-1", "Ship it"], {
    TASKMUX_HOME: sourceHome
  });

  const exportOutput = runTaskmux(["export", "--output", exportPath], {
    TASKMUX_HOME: sourceHome
  });
  assert.match(exportOutput, /Exported TaskMux data/);
  assert.equal(existsSync(exportPath), true);

  const importOutput = runTaskmux(["import", exportPath], {
    TASKMUX_HOME: targetHome
  });
  assert.match(importOutput, /Imported TaskMux data/);

  assert.match(runTaskmux(["task", "show", "task-1"], { TASKMUX_HOME: targetHome }), /Portable task/);
  assert.match(runTaskmux(["task", "roles", "task-1"], { TASKMUX_HOME: targetHome }), tableCellsRegex("rd", "codex"));
  assert.match(runTaskmux(["task", "comments", "task-1"], { TASKMUX_HOME: targetHome }), /Ship it/);
  assert.match(runTaskmux(["config", "show"], { TASKMUX_HOME: targetHome }), /Default agent: codex/);

  runTaskmux(["task", "delete", "task-1"], {
    TASKMUX_HOME: targetHome
  });
  assert.equal(existsSync(join(targetHome, "trash", "tasks", "task-1")), true);

  const pruneOutput = runTaskmux(["prune", "--trash"], {
    TASKMUX_HOME: targetHome
  });
  assert.match(pruneOutput, /Pruned trash tasks: 1/);
  assert.equal(existsSync(join(targetHome, "trash", "tasks", "task-1")), false);
});

test("dry-runs storage migrations without writing schema", () => {
  const home = createConfiguredHome();

  writeStorageSchema(home, 0);

  const output = runTaskmux(["migrate", "--dry-run"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Storage migration dry run 0 -> 2/);
  assert.match(output, /Backup would be created/);
  assert.match(readFileSync(join(home, "schema.json"), "utf8"), /"storageVersion":0/);
});

test("maintenance commands do not initialize missing storage", () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");

  const backup = runTaskmuxFailure(["backup"], { TASKMUX_HOME: home });
  const migrate = runTaskmuxFailure(["migrate"], { TASKMUX_HOME: home });
  const dryRun = runTaskmux(["migrate", "--dry-run"], { TASKMUX_HOME: home });

  assert.equal(backup.status, 4);
  assert.match(backup.stderr, /DATA_ERROR: TaskMux is not initialized\. Run `taskmux setup`\./);
  assert.equal(migrate.status, 4);
  assert.match(migrate.stderr, /DATA_ERROR: TaskMux is not initialized\. Run `taskmux setup`\./);
  assert.match(dryRun, /TaskMux is not initialized\. Run `taskmux setup`\./);
  assert.equal(existsSync(home), false);
});

test("reads edited task info from the user-editable info file", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(
    join(home, "tasks", "task-1", "info.json"),
    JSON.stringify({ schemaVersion: 1, title: "Edited task title" })
  );

  const showOutput = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });
  const listOutput = runTaskmux(["task", "list"], {
    TASKMUX_HOME: home
  });

  assert.match(showOutput, /Title: Edited task title/);
  assert.match(listOutput, tableCellsRegex("task-1", "ongoing", "Edited task title"));
});

test("keeps the last valid task value while preserving an invalid direct edit", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Last valid title"], { TASKMUX_HOME: home });
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");
  const { createResilientTaskStore } = await import("../dist/storage/resilientTaskStore.js");
  const diagnostics = [];
  const store = createResilientTaskStore(new FileTaskStore(home), (error) => diagnostics.push(error.message));
  const infoFile = join(home, "tasks", "task-1", "info.json");

  assert.equal(store.getTask("task-1").title, "Last valid title");
  writeFileSync(infoFile, "{ invalid json\n");
  assert.equal(store.getTask("task-1").title, "Last valid title");
  assert.equal(readFileSync(infoFile, "utf8"), "{ invalid json\n");
  assert.match(diagnostics[0], /Invalid task info record/);

  writeFileSync(infoFile, JSON.stringify({ schemaVersion: 1, title: "Reloaded valid title" }));
  assert.equal(store.getTask("task-1").title, "Reloaded valid title");
});

test("atomically replaces task snapshots instead of following a state-file symlink", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Protect local state writes"], { TASKMUX_HOME: home });
  const taskFile = join(home, "tasks", "task-1", "task.json");
  const sentinel = join(home, "sentinel-task.json");
  writeFileSync(sentinel, readFileSync(taskFile, "utf8"));
  unlinkSync(taskFile);
  symlinkSync(sentinel, taskFile);

  runTaskmux(["task", "archive", "task-1"], { TASKMUX_HOME: home });

  assert.equal(JSON.parse(readFileSync(sentinel, "utf8")).archived, false);
  assert.equal(JSON.parse(readFileSync(taskFile, "utf8")).archived, true);
  assert.equal(lstatSync(taskFile).isSymbolicLink(), false);
});

test("replays a staged complete snapshot after an interrupted write", async () => {
  const home = createTaskmuxHome();
  const target = join(home, "tasks", "task-1", "task.json");
  const recovery = await import("../dist/storage/recoveryJournal.js");

  recovery.stageSnapshotWrite(home, target, '{"schemaVersion":2,"archived":false}\n', "write-1");
  assert.equal(existsSync(target), false);

  const replayed = recovery.replayPendingSnapshotWrites(home);
  assert.deepEqual(replayed, [target]);
  assert.equal(readFileSync(target, "utf8"), '{"schemaVersion":2,"archived":false}\n');
  assert.deepEqual(readdirSync(join(home, "runtime", "recovery-journal")), []);
});

test("rebuilds the deletable SQLite index from authoritative task files", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Index this mission"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "work-item", "create", "task-1", "--title", "Index finite work", "--assignee", "leader"],
    { TASKMUX_HOME: home }
  );
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");
  const { rebuildDerivedIndex } = await import("../dist/storage/derivedIndex.js");
  const { default: Database } = await import("better-sqlite3");
  const indexFile = join(home, "runtime", "index.sqlite");

  rebuildDerivedIndex(home, new FileTaskStore(home));
  let database = new Database(indexFile, { readonly: true });
  assert.deepEqual(database.prepare("SELECT id, title, archived FROM tasks").get(), {
    id: "task-1", title: "Index this mission", archived: 0
  });
  assert.deepEqual(database.prepare("SELECT task_id, name FROM roles").get(), {
    task_id: "task-1", name: "leader"
  });
  assert.deepEqual(database.prepare("SELECT task_id, id, status FROM work_items").get(), {
    task_id: "task-1", id: "work-item-1", status: "pending"
  });
  database.close();

  unlinkSync(indexFile);
  rebuildDerivedIndex(home, new FileTaskStore(home));
  database = new Database(indexFile, { readonly: true });
  assert.equal(database.prepare("SELECT count(*) AS count FROM tasks").get().count, 1);
  database.close();
});

test("creates tasks with task board metadata", () => {
  const home = createConfiguredHome();

  const output = runTaskmux(
    [
      "task",
      "create",
      "Refactor login page",
      "--description",
      "Update the auth form",
      "--priority",
      "high",
      "--tag",
      "frontend",
      "--tag",
      "auth",
      "--due",
      "2026-07-01"
    ],
    { TASKMUX_HOME: home }
  );
  const taskInfo = JSON.parse(readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8"));
  const showOutput = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Created task task-1: Refactor login page/);
  assert.equal(taskInfo.description, "Update the auth form");
  assert.equal(taskInfo.priority, "high");
  assert.deepEqual(taskInfo.tags, ["frontend", "auth"]);
  assert.equal(taskInfo.dueAt, "2026-07-01");
  assert.match(showOutput, /Description: Update the auth form/);
  assert.match(showOutput, /Priority: high/);
  assert.match(showOutput, /Tags: frontend, auth/);
  assert.match(showOutput, /Due: 2026-07-01/);
});

test("stores defaults and creates templated tasks with default roles", () => {
  const home = createConfiguredHome();

  runTaskmux(["config", "set", "default-agent", "codex"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "create", "Build export flow", "--template", "feature"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Created task task-1: Build export flow/);
  assert.match(output, /Template: feature/);
  assert.match(output, /Assigned roles: leader, rd, reviewer/);

  const task = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(task, /Priority: medium/);
  assert.match(task, /Tags: feature/);

  const roles = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(roles, tableCellsRegex("leader", "codex", "idle", "/tmp/project-a"));
  assert.match(roles, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(roles, tableCellsRegex("reviewer", "codex", "idle", "/tmp/project-a"));

  const config = runTaskmux(["config", "show"], {
    TASKMUX_HOME: home
  });
  assert.match(config, /Default agent: codex/);
  assert.match(config, /Default workspace: \/tmp\/project-a/);
});

test("tracks current and last tasks for shorter workflows", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "First task"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "create", "Second task"], {
    TASKMUX_HOME: home
  });

  assert.match(runTaskmux(["task", "last"], { TASKMUX_HOME: home }), /task-2 Second task/);

  const setCurrent = runTaskmux(["task", "current", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(setCurrent, /Current task: task-1/);
  assert.match(runTaskmux(["task", "current"], { TASKMUX_HOME: home }), /task-1 First task/);
});

test("clones tasks with metadata and roles", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Original task", "--priority", "high", "--tag", "frontend", "--due", "2026-09-01"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "clone", "task-1", "--title", "Cloned task"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Cloned task task-1 -> task-2/);

  const task = runTaskmux(["task", "show", "task-2"], {
    TASKMUX_HOME: home
  });
  assert.match(task, /Title: Cloned task/);
  assert.match(task, /Priority: high/);
  assert.match(task, /Tags: frontend/);
  assert.match(task, /Due: 2026-09-01/);

  const roles = runTaskmux(["task", "roles", "task-2"], {
    TASKMUX_HOME: home
  });
  assert.match(roles, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
});

test("updates task board metadata", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(
    [
      "task",
      "update",
      "task-1",
      "--title",
      "Refactor checkout page",
      "--description",
      "Coordinate UI and validation work",
      "--priority",
      "urgent",
      "--tag",
      "checkout",
      "--tag",
      "blocked",
      "--due",
      "2026-08-02"
    ],
    { TASKMUX_HOME: home }
  );
  const showOutput = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Updated task task-1/);
  assert.match(showOutput, /Title: Refactor checkout page/);
  assert.match(showOutput, /Description: Coordinate UI and validation work/);
  assert.match(showOutput, /Priority: urgent/);
  assert.match(showOutput, /Tags: checkout, blocked/);
  assert.match(showOutput, /Due: 2026-08-02/);
});

test("clears task board metadata", () => {
  const home = createConfiguredHome();

  runTaskmux(
    [
      "task",
      "create",
      "Refactor login page",
      "--description",
      "Update the auth form",
      "--priority",
      "high",
      "--tag",
      "frontend",
      "--due",
      "2026-07-01"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(
    [
      "task",
      "update",
      "task-1",
      "--clear-description",
      "--clear-priority",
      "--clear-tags",
      "--clear-due"
    ],
    { TASKMUX_HOME: home }
  );
  const showOutput = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });
  const taskInfo = JSON.parse(readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8"));

  assert.match(output, /Updated task task-1/);
  assert.equal(taskInfo.title, "Refactor login page");
  assert.equal(taskInfo.description, undefined);
  assert.equal(taskInfo.priority, undefined);
  assert.equal(taskInfo.tags, undefined);
  assert.equal(taskInfo.dueAt, undefined);
  assert.doesNotMatch(showOutput, /Description:/);
  assert.doesNotMatch(showOutput, /Priority:/);
  assert.doesNotMatch(showOutput, /Tags:/);
  assert.doesNotMatch(showOutput, /Due:/);
});

test("filters and searches tasks on board metadata", () => {
  const home = createConfiguredHome();

  runTaskmux(
    ["task", "create", "Refactor login page", "--tag", "frontend", "--priority", "high"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Write release docs", "--tag", "docs", "--priority", "medium"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Fix auth token bug", "--tag", "backend", "--priority", "urgent"],
    { TASKMUX_HOME: home }
  );

  const frontendOutput = runTaskmux(["task", "list", "--tag", "frontend"], { TASKMUX_HOME: home });
  const tagOutput = runTaskmux(["task", "list", "--tag", "docs"], { TASKMUX_HOME: home });
  const priorityOutput = runTaskmux(["task", "list", "--priority", "urgent"], { TASKMUX_HOME: home });
  const searchOutput = runTaskmux(["task", "list", "--search", "release"], { TASKMUX_HOME: home });

  assert.match(frontendOutput, /Refactor login page/);
  assert.doesNotMatch(frontendOutput, /Fix auth token bug/);
  assert.doesNotMatch(frontendOutput, /Write release docs/);
  assert.match(tagOutput, /Write release docs/);
  assert.doesNotMatch(tagOutput, /Refactor login page/);
  assert.match(priorityOutput, /Fix auth token bug/);
  assert.doesNotMatch(priorityOutput, /Refactor login page/);
  assert.match(searchOutput, /Write release docs/);
  assert.doesNotMatch(searchOutput, /Fix auth token bug/);
});

test("renders a grouped task board with metadata filters", () => {
  const home = createConfiguredHome();

  runTaskmux(
    ["task", "create", "Plan checkout work", "--tag", "frontend", "--priority", "high"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Implement checkout work", "--tag", "frontend", "--priority", "urgent"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Write rollout notes", "--tag", "docs", "--priority", "medium"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "archive", "task-3"], { TASKMUX_HOME: home });

  const output = runTaskmux(["task", "board", "--tag", "frontend"], { TASKMUX_HOME: home });

  assert.match(output, /Ongoing/);
  assert.match(output, tableCellsRegex("Ongoing", "task-1", "Plan checkout work", "priority=high tags=frontend"));
  assert.match(output, tableCellsRegex("Ongoing", "task-2", "Implement checkout work", "priority=urgent tags=frontend"));
  assert.doesNotMatch(output, /Write rollout notes/);
  assert.match(output, /Archived/);
});

test("renders role status counts on the grouped task board", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Coordinate checkout flow"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(["task", "board", "--with-roles"], { TASKMUX_HOME: home });

  assert.match(output, tableCellsRegex("Ongoing", "task-1", "Coordinate checkout flow", "", "", "roles idle=3"));
});

test("deletes and restores tasks without losing task data", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page", "--due", "2026-07-01"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "comment", "task-1", "Keep task data."], {
    TASKMUX_HOME: home
  });

  const deleteOutput = runTaskmux(["task", "delete", "task-1"], {
    TASKMUX_HOME: home
  });
  const listOutput = runTaskmux(["task", "list"], { TASKMUX_HOME: home });
  const missingShow = runTaskmuxFailure(["task", "show", "task-1"], { TASKMUX_HOME: home });

  assert.match(deleteOutput, /Deleted task task-1/);
  assert.match(listOutput, /No tasks found/);
  assert.equal(missingShow.status, 3);
  assert.equal(existsSync(join(home, "trash", "tasks", "task-1", "info.json")), true);

  const restoreOutput = runTaskmux(["task", "restore", "task-1"], {
    TASKMUX_HOME: home
  });
  const showOutput = runTaskmux(["task", "show", "task-1"], { TASKMUX_HOME: home });
  const commentsOutput = runTaskmux(["task", "comments", "task-1"], { TASKMUX_HOME: home });

  assert.match(restoreOutput, /Restored task task-1/);
  assert.match(showOutput, /Due: 2026-07-01/);
  assert.match(commentsOutput, /Keep task data/);
});

test("rejects task records with inline titles", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  execFileSync("mkdir", ["-p", taskDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      title: "Legacy task title",
      status: "open",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );

  const result = runTaskmuxFailure(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task record: task-1/);
});

test("rejects task records missing editable task info", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  execFileSync("mkdir", ["-p", taskDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      status: "open",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );

  const result = runTaskmuxFailure(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task info record: task-1/);
});

test("lists tasks from the configured taskmux home", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "First task"], { TASKMUX_HOME: home });
  runTaskmux(["task", "create", "Second task"], { TASKMUX_HOME: home });

  const output = runTaskmux(["task", "list"], { TASKMUX_HOME: home });

  assert.match(output, tableCellsRegex("task-1", "ongoing", "First task"));
  assert.match(output, tableCellsRegex("task-2", "ongoing", "Second task"));
});

test("shows a task by id", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Task: task-1/);
  assert.match(output, /Title: Review checkout flow/);
  assert.match(output, /Archived: no/);
});

test("returns stable JSON envelopes for generic command success and failure", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Read JSON output"], { TASKMUX_HOME: home });
  const success = JSON.parse(
    runTaskmux(["task", "show", "task-1", "--json"], { TASKMUX_HOME: home })
  );
  const failed = runTaskmuxFailure(
    ["task", "show", "task-999", "--json"],
    { TASKMUX_HOME: home }
  );
  const error = JSON.parse(failed.stderr);

  assert.equal(success.ok, true);
  assert.match(success.output, /Task: task-1/);
  assert.equal(error.ok, false);
  assert.equal(error.code, "TASK_NOT_FOUND");
  assert.match(error.message, /task-999/);
});

test("preserves structured CLI errors across the Controller RPC boundary", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };

  try {
    const failed = runTaskmuxFailure(["task", "show", "task-999", "--json"], env);
    const error = JSON.parse(failed.stderr);

    assert.equal(failed.status, 3);
    assert.equal(error.code, "TASK_NOT_FOUND");
    assert.match(error.message, /task-999/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("updates the task archive marker", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });

  assert.match(
    runTaskmux(["task", "archive", "task-1"], { TASKMUX_HOME: home }),
    /Archived task task-1/
  );
  assert.match(
    runTaskmux(["task", "unarchive", "task-1"], { TASKMUX_HOME: home }),
    /Unarchived task task-1/
  );

  const task = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8")
  );
  assert.equal(task.status, undefined);
  assert.equal(task.archived, false);
});

test("persists an archive summary and discards stale automatic wakeups", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Archive a completed phase"], { TASKMUX_HOME: home });
  runTaskmux(["task", "wake", "task-1", "--reason", "old-trigger"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "archive", "task-1",
      "--reason", "Current phase has reached a stable point",
      "--summary", "Canary is complete; revisit when production traffic increases."
    ],
    { TASKMUX_HOME: home }
  );
  const archived = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));

  assert.equal(archived.archived, true);
  assert.equal(archived.archiveReason, "Current phase has reached a stable point");
  assert.match(archived.archiveSummary, /Canary is complete/);
  assert.match(archived.archivedAt, /^\d{4}-/);
  assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
  runTaskmux(["task", "comment", "task-1", "Keep this note for reactivation."], { TASKMUX_HOME: home });
  assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);

  runTaskmux(["task", "unarchive", "task-1"], { TASKMUX_HOME: home });
  const active = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));
  assert.equal(active.archived, false);
  assert.equal(active.archivedAt, undefined);
  assert.equal(active.archiveReason, undefined);
  assert.equal(active.archiveSummary, undefined);
});

test("keeps a task long-lived until it is explicitly archived", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Maintain the daily deployment check"], {
    TASKMUX_HOME: home
  });
  let task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));
  assert.equal(task.archived, false);

  runTaskmux(["task", "archive", "task-1"], { TASKMUX_HOME: home });
  task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));
  assert.equal(task.archived, true);

  const output = runTaskmux(["task", "unarchive", "task-1"], { TASKMUX_HOME: home });
  task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));
  assert.match(output, /Unarchived task task-1/);
  assert.equal(task.archived, false);
});

test("does not expose a ticket-style done transition for Tasks", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Continue improving deployments"], { TASKMUX_HOME: home });

  const result = runTaskmuxFailure(["task", "done", "task-1"], { TASKMUX_HOME: home });
  const task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Task commands/);
  assert.equal(task.status, undefined);
  assert.equal(task.archived, false);
});

test("assigns a role to an existing task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Assigned role rd to task-1/);
  assert.match(output, /Agent: codex/);
  assert.match(output, /Workspace: \/tmp\/project-a/);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  const roleInfo = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "info.json"), "utf8")
  );

  assert.equal(role.schemaVersion, 1);
  assert.equal(role.name, undefined);
  assert.equal(role.agent, "codex");
  assert.equal(role.workspace, "/tmp/project-a");
  assert.equal(role.status, "idle");
  assert.equal(roleInfo.schemaVersion, 1);
  assert.equal(roleInfo.name, "rd");
});

test("assigns multiple roles with one command", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Coordinate release"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(
    [
      "task",
      "assign-many",
      "task-1",
      "--role",
      "rd",
      "--role",
      "reviewer",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Assigned roles to task-1: rd, reviewer/);

  const roles = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(roles, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(roles, tableCellsRegex("reviewer", "codex", "idle", "/tmp/project-a"));
});

test("reads edited role info from the user-editable info file", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  writeFileSync(
    join(home, "tasks", "task-1", "roles", "rd", "info.json"),
    JSON.stringify({ schemaVersion: 1, name: "engineer" })
  );

  const rolesOutput = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  const detailOutput = runTaskmux(["task", "detail", "task-1", "engineer"], {
    TASKMUX_HOME: home
  });

  assert.match(rolesOutput, tableCellsRegex("engineer", "codex", "idle", "/tmp/project-a"));
  assert.match(detailOutput, /Role: engineer/);
});

test("rejects role records with inline names", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  const roleDir = join(taskDir, "roles", "rd");
  execFileSync("mkdir", ["-p", roleDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      status: "open",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(taskDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Current task title"
    })
  );
  writeFileSync(
    join(roleDir, "role.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "rd",
      agent: "codex",
      workspace: "/tmp/project-a",
      status: "idle",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );

  const result = runTaskmuxFailure(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role record: rd/);
});

test("rejects role records missing editable role info", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  const roleDir = join(taskDir, "roles", "rd");
  execFileSync("mkdir", ["-p", roleDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      status: "open",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(taskDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Current task title"
    })
  );
  writeFileSync(
    join(roleDir, "role.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: "codex",
      command: "codex",
      args: [],
      env: {},
      workspace: "/tmp/project-a",
      status: "idle",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );

  const result = runTaskmuxFailure(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role info record: rd/);
});

test("rejects role records missing command contract", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  const roleDir = join(taskDir, "roles", "rd");
  execFileSync("mkdir", ["-p", roleDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      status: "open",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(taskDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Current task title"
    })
  );
  writeFileSync(
    join(roleDir, "role.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: "codex",
      workspace: "/tmp/project-a",
      status: "idle",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(roleDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "rd"
    })
  );

  const result = runTaskmuxFailure(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role record: rd/);
});

test("rejects unsupported role agents", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "unknown",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Unsupported agent: unknown/);
  assert.match(result.stderr, /Supported agents: (codex, claude|claude, codex)/);
});

test("returns a usage exit code for unsupported agents", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "unknown",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Unsupported agent: unknown/);
});

test("lists roles for a task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(output, tableCellsRegex("reviewer", "claude", "idle", "/tmp/project-a"));
});

test("updates role runner and workspace", () => {
  const home = createConfiguredHome();
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");

  runTaskmux(["runner", "add", "agent-js", "--command", fakeAgent, "--arg", "--mode", "--arg", "review"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(
    ["task", "role", "update", "task-1", "rd", "--agent", "agent-js", "--workspace", "/tmp/project-b"],
    { TASKMUX_HOME: home }
  );
  const detailOutput = runTaskmux(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });
  const role = JSON.parse(readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8"));

  assert.match(output, /Updated role rd for task-1/);
  assert.match(detailOutput, /Agent: agent-js/);
  assert.match(detailOutput, /Workspace: \/tmp\/project-b/);
  assert.equal(role.command, fakeAgent);
  assert.deepEqual(role.args, ["--mode", "review"]);
  assert.equal(role.workspace, "/tmp/project-b");
});

test("renames roles and tmux windows", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "role", "rename", "task-1", "rd", "developer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });
  const rolesOutput = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.match(output, /Renamed role rd to developer for task-1/);
  assert.match(rolesOutput, tableCellsRegex("developer", "codex", "idle", "/tmp/project-a"));
  assert.doesNotMatch(rolesOutput, /rd\s+codex/);
  assert.deepEqual(calls[0], ["rename-window", "-t", "taskmux-task-1:rd", "developer"]);
});

test("rejects renaming the built-in leader role", () => {
  const home = createConfiguredHome();
  const leaderCli = createFakeExecutable(home, "leader-agent.js", "leader agent 1.0\n");

  addRunner(home, "leader-cli", leaderCli);
  runTaskmux(["task", "create", "Refactor login page", "--agent", "leader-cli", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(["task", "role", "rename", "task-1", "leader", "developer"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Built-in leader role cannot be renamed/);
});

test("enters a role through tmux without requiring real tmux", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "enter", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Attached role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(calls[0], ["has-session", "-t", "taskmux-task-1"]);
  assert.deepEqual(calls[1], ["new-session", "-d", "-s", "taskmux-task-1"]);
  assert.deepEqual(calls[2], ["list-windows", "-t", "taskmux-task-1", "-F", "#{window_name}"]);
  assert.deepEqual(calls[3], [
    "new-window",
    "-t",
    "taskmux-task-1",
    "-n",
    "rd",
    "-c",
    "/tmp/project-a",
    "codex"
  ]);
  assert.deepEqual(calls[4], ["attach-session", "-t", "taskmux-task-1:rd"]);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "running");
});

test("tails role output through tmux capture-pane", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "tail", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /recent reviewer output/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(calls[0], [
    "capture-pane",
    "-p",
    "-t",
    "taskmux-task-1:reviewer",
    "-S",
    "-80"
  ]);
});

test("shows role detail for a task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Task: task-1/);
  assert.match(output, /Role: rd/);
  assert.match(output, /Agent: codex/);
  assert.match(output, /Workspace: \/tmp\/project-a/);
  assert.match(output, /Status: idle/);
  assert.match(output, /Tmux: taskmux-task-1:rd/);
});

test("reads role transcript through tmux capture-pane", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "transcript", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /recent reviewer output/);
  assert.match(
    readFileSync(
      join(home, "tasks", "task-1", "roles", "reviewer", "transcript.log"),
      "utf8"
    ),
    /recent reviewer output/
  );
}
);

test("opens a task context summary", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "comment", "task-1", "Keep old session compatibility."], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "open", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Task: task-1/);
  assert.match(output, /Title: Refactor login page/);
  assert.match(output, /Roles: 2/);
  assert.match(output, /Comments: 1/);
  assert.match(output, /Next: taskmux task enter task-1 <role>/);
});

test("includes schedules cycles work items milestones and sessions in task context", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Expose durable progress context"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "60", "--cooldown-minutes", "15"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "cycle", "create", "task-1", "--cause", "explicit-wake", "--summary", "Plan the release"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "work-item", "create", "task-1", "--title", "Run canary", "--cycle", "cycle-1"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "milestone", "add", "task-1", "--title", "Plan approved", "--summary", "Release plan is approved"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "leader-session"],
    { TASKMUX_HOME: home }
  );

  const context = JSON.parse(
    runTaskmux(["task", "context", "task-1", "--format", "json"], { TASKMUX_HOME: home })
  );

  assert.equal(context.schedule.inactivityMinutes, 60);
  assert.deepEqual(context.cycles.map((cycle) => cycle.id), ["cycle-1"]);
  assert.deepEqual(context.workItems.map((item) => item.id), ["work-item-1"]);
  assert.deepEqual(context.milestones.map((milestone) => milestone.id), ["milestone-1"]);
  assert.equal(context.sessions.leader.nativeSessionId, "leader-session");
});

test("exports transcripts in markdown and json formats", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const markdownPath = join(home, "reviewer.md");

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "transcript", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const markdownOutput = runTaskmux(
    ["task", "transcript", "export", "task-1", "reviewer", "--format", "markdown", "--output", markdownPath],
    { TASKMUX_HOME: home }
  );
  assert.match(markdownOutput, /Exported transcript task-1 reviewer/);
  assert.match(readFileSync(markdownPath, "utf8"), /# Transcript task-1 reviewer/);
  assert.match(readFileSync(markdownPath, "utf8"), /recent reviewer output/);

  const jsonOutput = runTaskmux(
    ["task", "transcript", "export", "task-1", "reviewer", "--format", "json"],
    { TASKMUX_HOME: home }
  );
  const parsed = JSON.parse(jsonOutput);
  assert.equal(parsed.taskId, "task-1");
  assert.equal(parsed.role, "reviewer");
  assert.match(parsed.transcript, /recent reviewer output/);
});

test("renders role activity and task timeline", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "comment", "task-1", "Ready for review"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "transcript", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const activity = runTaskmux(["task", "activity", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(activity, /Task activity: task-1/);
  assert.match(activity, tableCellsRegex("reviewer", "claude", "idle", "1"));

  const timeline = runTaskmux(["task", "timeline", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(timeline, /task.created/);
  assert.match(timeline, /role.assigned/);
  assert.match(timeline, tableCellsRegex("comment", "comment-1", "Ready for review"));
});

test("renders a task handoff context as text", () => {
  const home = createConfiguredHome();

  runTaskmux(
    [
      "task",
      "create",
      "Refactor login page",
      "--description",
      "Update the auth form",
      "--priority",
      "high",
      "--tag",
      "frontend",
      "--due",
      "2026-07-01"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "comment", "task-1", "Keep old session compatibility."], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "context", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Task Context/);
  assert.match(output, /Task: task-1/);
  assert.match(output, /Title: Refactor login page/);
  assert.match(output, /Description: Update the auth form/);
  assert.match(output, /Priority: high/);
  assert.match(output, /Tags: frontend/);
  assert.match(output, /Due: 2026-07-01/);
  assert.match(output, /Roles/);
  assert.match(output, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(output, /Comments/);
  assert.match(output, tableCellsRegex("comment-1", "Keep old session compatibility."));
  assert.match(output, /Events/);
  assert.match(output, /task.created/);
  assert.match(output, /comment.added/);
});

test("renders a task handoff context as json with stored transcripts", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "comment", "task-1", "Check edge cases."], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "transcript", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const output = runTaskmux(["task", "context", "task-1", "--format", "json", "--include-transcripts"], {
    TASKMUX_HOME: home
  });
  const context = JSON.parse(output);

  assert.equal(context.task.id, "task-1");
  assert.equal(context.task.title, "Review checkout flow");
  const reviewerContext = context.roles.find((role) => role.name === "reviewer");
  assert.ok(reviewerContext);
  assert.equal(reviewerContext.transcript, "recent reviewer output\n");
  assert.equal(context.comments[0].body, "Check edge cases.");
  assert.equal(context.events[0].type, "task.created");
});

test("detaches a task role through tmux", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "detach", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Detached role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(calls[0], ["detach-client", "-s", "taskmux-task-1"]);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "detached");
});

test("shows role status", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "status", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: join(home, "missing-tmux")
  });

  assert.match(output, /Role: rd/);
  assert.match(output, /Status: idle/);
  assert.match(output, /Tmux: taskmux-task-1:rd/);
});

test("detects running role status from tmux", () => {
  const home = createConfiguredHome();
  const fakeTmux = createStatusTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "status", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, /Status: running/);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "running");
});

test("detects exited role status when tmux window is absent", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "status", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Status: exited/);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "exited");
});

test("refreshes every role status for a task", () => {
  const home = createConfiguredHome();
  const fakeTmux = createStatusTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "refresh", "task-1"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, /Refreshed task task-1 roles/);
  assert.match(output, tableCellsRegex("rd", "running"));
  assert.match(output, tableCellsRegex("reviewer", "exited"));

  const rd = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  const reviewer = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );
  assert.equal(rd.status, "running");
  assert.equal(reviewer.status, "exited");
});

test("restarts a role through tmux and updates status", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "kill", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const output = runTaskmux(["task", "restart", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Restarted role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls.at(-6), ["kill-window", "-t", "taskmux-task-1:rd"]);
  assert.deepEqual(calls.at(-1), ["attach-session", "-t", "taskmux-task-1:rd"]);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "running");
});

test("cleans stale role windows into exited status", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "cleanup", "task-1"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Cleaned task task-1 roles/);
  assert.match(output, tableCellsRegex("rd", "exited"));

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "exited");
});

test("stops a role through tmux and updates status", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "stop", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Stopped role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls[0], ["send-keys", "-t", "taskmux-task-1:rd", "C-c"]);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "exited");
});

test("kills a role tmux window and updates status", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "kill", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Killed role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls[0], ["kill-window", "-t", "taskmux-task-1:rd"]);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "exited");
});

test("adds and lists task comments", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const addOutput = runTaskmux(
    ["task", "comment", "task-1", "Keep old session compatibility."],
    { TASKMUX_HOME: home }
  );

  assert.match(addOutput, /Added comment to task-1/);

  const commentsFile = readFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(commentsFile[0].schemaVersion, 1);
  assert.equal(commentsFile[0].body, "Keep old session compatibility.");

  runTaskmux(["task", "comment", "task-1", "Reviewer should check copy."], {
    TASKMUX_HOME: home
  });

  const listOutput = runTaskmux(["task", "comments", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(listOutput, /Keep old session compatibility\./);
  assert.match(listOutput, /Reviewer should check copy\./);
});

test("records and lists task event history", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "comment", "task-1", "Keep old session compatibility."], {
    TASKMUX_HOME: home
  });

  const events = readFileSync(join(home, "tasks", "task-1", "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events[0].schemaVersion, 1);
  assert.equal(events[0].id, "event-1");
  assert.equal(events[0].type, "task.created");
  assert.equal(events[0].payload.title, "Refactor login page");
  assert.equal(events[1].type, "role.assigned");
  assert.deepEqual(events[1].payload, { role: "leader", agent: "codex" });
  assert.equal(events[2].type, "role.assigned");
  assert.deepEqual(events[2].payload, { role: "rd", agent: "codex" });
  assert.equal(events[3].type, "comment.added");
  assert.deepEqual(events[3].payload, { comment: "comment-1" });

  const output = runTaskmux(["task", "events", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, tableCellsRegex("event-1", /.*/, "task.created", "title=Refactor login page"));
  assert.match(output, tableCellsRegex("event-2", /.*/, "role.assigned", "role=leader agent=codex"));
  assert.match(output, tableCellsRegex("event-3", /.*/, "role.assigned", "role=rd agent=codex"));
  assert.match(output, tableCellsRegex("event-4", /.*/, "comment.added", "comment=comment-1"));
});

test("returns a data error exit code for invalid event schema", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(join(home, "tasks", "task-1", "events.jsonl"), "{\"schemaVersion\":2}\n");

  const result = runTaskmuxFailure(["task", "events", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid event record: task-1:1/);
});

test("returns a not found exit code for missing tasks", () => {
  const home = createConfiguredHome();

  const result = runTaskmuxFailure(["task", "show", "task-404"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /TASK_NOT_FOUND: Task not found: task-404/);
});

test("returns a role not found exit code for missing roles", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(["task", "detail", "task-1", "reviewer"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /ROLE_NOT_FOUND: Role not found: reviewer/);
});

test("returns a usage exit code for missing task shell ids", () => {
  const home = createConfiguredHome();

  const result = runTaskmuxFailure(["task", "shell"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Task id is required/);
});

test("returns a data error exit code for invalid task schema", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  execFileSync("mkdir", ["-p", taskDir]);
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: "task-1" }));

  const result = runTaskmuxFailure(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task record: task-1/);
});

test("returns a data error exit code for invalid task info schema", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(join(home, "tasks", "task-1", "info.json"), JSON.stringify({ schemaVersion: 2 }));

  const result = runTaskmuxFailure(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task info record: task-1/);
});

test("returns a data error exit code for invalid role schema", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  const roleDir = join(taskDir, "roles", "rd");
  execFileSync("mkdir", ["-p", roleDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      status: "open",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(taskDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Refactor login page"
    })
  );
  writeFileSync(join(roleDir, "role.json"), JSON.stringify({ schemaVersion: 2 }));

  const result = runTaskmuxFailure(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role record: rd/);
});

test("returns a data error exit code for invalid role info schema", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  writeFileSync(
    join(home, "tasks", "task-1", "roles", "rd", "info.json"),
    JSON.stringify({ schemaVersion: 2 })
  );

  const result = runTaskmuxFailure(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role info record: rd/);
});

test("returns a data error exit code for invalid comment schema", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "{\"schemaVersion\":2}\n");

  const result = runTaskmuxFailure(["task", "comments", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid comment record: task-1:1/);
});

test("adds lists and shows custom runners", () => {
  const home = createTaskmuxHome();
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");
  ensureTestStorageSchema(home);

  const addOutput = runTaskmux(
    [
      "runner",
      "add",
      "agent-js",
      "--command",
      fakeAgent,
      "--arg",
      "--model",
      "--arg",
      "review",
      "--env",
      "TASKMUX_MODE=dev"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(addOutput, /Added runner agent-js/);

  const runner = JSON.parse(
    readFileSync(join(home, "runners", "agent-js", "runner.json"), "utf8")
  );
  assert.equal(runner.schemaVersion, 1);
  assert.equal(runner.id, "agent-js");
  assert.equal(runner.command, fakeAgent);
  assert.deepEqual(runner.args, ["--model", "review"]);
  assert.deepEqual(runner.env, { TASKMUX_MODE: "dev" });

  const listOutput = runTaskmux(["runner", "list"], { TASKMUX_HOME: home });
  assert.match(listOutput, tableCellsRegex("agent-js", "custom", fakeAgent));

  const showOutput = runTaskmux(["runner", "show", "agent-js"], { TASKMUX_HOME: home });
  assert.match(showOutput, /Runner: agent-js/);
  assert.match(showOutput, new RegExp(`Command: ${fakeAgent.replaceAll("\\", "\\\\")}`));
  assert.match(showOutput, /Args: --model review/);
  assert.match(showOutput, /Env: TASKMUX_MODE=dev/);
});

test("does not expose codex or claude as default runners", () => {
  const home = createTaskmuxHome();
  ensureTestStorageSchema(home);

  const listOutput = runTaskmux(["runner", "list"], {
    TASKMUX_HOME: home
  });

  assert.match(listOutput, /No runners configured/);
  assert.doesNotMatch(listOutput, /codex\s+builtin/);
  assert.doesNotMatch(listOutput, /claude\s+builtin/);
});

test("adds lists shows and removes agents", () => {
  const home = createTaskmuxHome();
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");
  ensureTestStorageSchema(home);

  const addOutput = runTaskmux(
    ["agent", "add", "agent-js", "--command", fakeAgent, "--arg", "--model", "--arg", "review", "--env", "TASKMUX_MODE=dev"],
    { TASKMUX_HOME: home }
  );

  assert.match(addOutput, /Added agent agent-js/);

  const listOutput = runTaskmux(["agent", "list"], { TASKMUX_HOME: home });
  assert.match(listOutput, tableCellsRegex("agent-js", "custom", `${fakeAgent} --model review`));

  const showOutput = runTaskmux(["agent", "show", "agent-js"], { TASKMUX_HOME: home });
  assert.match(showOutput, /Agent: agent-js/);
  assert.match(showOutput, /Args: --model review/);
  assert.match(showOutput, /Env: TASKMUX_MODE=dev/);

  const removeOutput = runTaskmux(["agent", "remove", "agent-js"], { TASKMUX_HOME: home });
  assert.match(removeOutput, /Removed agent agent-js/);

  const result = runTaskmuxFailure(["agent", "show", "agent-js"], { TASKMUX_HOME: home });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /AGENT_NOT_FOUND: Agent not found: agent-js/);
});

test("configures global roles and binds copied roles to tasks", () => {
  const home = createTaskmuxHome();
  const codexAgent = createFakeExecutable(home, "codex-agent.js", "codex agent 1.0\n");
  const claudeAgent = createFakeExecutable(home, "claude-agent.js", "claude agent 1.0\n");

  addAgent(home, "codex", codexAgent);
  addAgent(home, "claude", claudeAgent);

  const addRoleOutput = runTaskmux(["role", "add", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  assert.match(addRoleOutput, /Added role reviewer/);
  assert.match(addRoleOutput, /Agent: claude/);

  runTaskmux(["config", "set", "default-agent", "codex"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], { TASKMUX_HOME: home });
  runTaskmux(["task", "create", "Review payment flow"], { TASKMUX_HOME: home });

  const bindOutput = runTaskmux(["task", "bind", "task-1", "reviewer"], { TASKMUX_HOME: home });
  assert.match(bindOutput, /Bound role reviewer to task-1/);
  assert.match(bindOutput, /Agent: claude/);

  runTaskmux(["role", "update", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-b"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "role", "update", "task-1", "reviewer", "--workspace", "/tmp/task-local"], {
    TASKMUX_HOME: home
  });

  const taskRole = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );
  const globalRole = JSON.parse(readFileSync(join(home, "roles", "reviewer", "role.json"), "utf8"));

  assert.equal(taskRole.agent, "claude");
  assert.equal(taskRole.workspace, "/tmp/task-local");
  assert.equal(globalRole.agent, "codex");
  assert.equal(globalRole.workspace, "/tmp/project-b");
});

test("copies descriptive role template fields into an independent task role", () => {
  const home = createConfiguredHome();

  runTaskmux(
    [
      "role", "add", "reviewer",
      "--agent", "codex",
      "--workspace", "/tmp/project-a",
      "--description", "Review risky changes",
      "--responsibility", "Check rollback safety",
      "--constraint", "Do not edit production",
      "--expected-output", "A concise review",
      "--system-prompt", "Be skeptical and evidence-driven.",
      "--skill", "security-review"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "create", "Review deployment"], { TASKMUX_HOME: home });
  runTaskmux(["task", "bind", "task-1", "reviewer"], { TASKMUX_HOME: home });
  const taskRole = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "info.json"), "utf8")
  );

  assert.equal(taskRole.description, "Review risky changes");
  assert.deepEqual(taskRole.responsibilities, ["Check rollback safety"]);
  assert.deepEqual(taskRole.constraints, ["Do not edit production"]);
  assert.equal(taskRole.expectedOutput, "A concise review");
  assert.equal(taskRole.systemPrompt, "Be skeptical and evidence-driven.");
  assert.deepEqual(taskRole.skills, ["security-review"]);
});

test("renders the agent and role board", () => {
  const home = createTaskmuxHome();
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");

  addAgent(home, "codex", fakeAgent);
  runTaskmux(["role", "add", "leader", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["board"], { TASKMUX_HOME: home });

  assert.match(output, /TaskMux board/);
  assert.match(output, /Agents/);
  assert.match(output, tableCellsRegex("codex", fakeAgent));
  assert.match(output, /Roles/);
  assert.match(output, tableCellsRegex("operator", "?", "?"));
  assert.match(output, /system:global user-facing/);
  assert.match(output, tableCellsRegex("leader", "codex", "/tmp/project-a"));
});

test("protects system roles and shows missing system role agents as question marks", () => {
  const home = createTaskmuxHome();
  ensureTestStorageSchema(home);

  const listOutput = runTaskmux(["role", "list"], { TASKMUX_HOME: home });
  assert.match(listOutput, tableCellsRegex("operator", "?", "?"));
  assert.match(listOutput, /system:global user-facing/);
  assert.match(listOutput, tableCellsRegex("leader", "?", "?"));
  assert.match(listOutput, /system:task leader and role/);

  const showOutput = runTaskmux(["role", "show", "operator"], { TASKMUX_HOME: home });
  assert.match(showOutput, /Role: operator/);
  assert.match(showOutput, /Agent: \?/);

  const operatorRemove = runTaskmuxFailure(["role", "remove", "operator"], { TASKMUX_HOME: home });
  assert.equal(operatorRemove.status, 2);
  assert.match(operatorRemove.stderr, /USAGE_ERROR: System role cannot be removed: operator/);

  const leaderRemove = runTaskmuxFailure(["role", "remove", "leader"], { TASKMUX_HOME: home });
  assert.equal(leaderRemove.status, 2);
  assert.match(leaderRemove.stderr, /USAGE_ERROR: System role cannot be removed: leader/);
});

test("keeps taskmux assistant as a legacy alias for Operator context", () => {
  const home = createTaskmuxHome();
  const logFile = join(home, "assistant-log.json");
  const assistantAgent = join(home, "codex");

  writeFileSync(
    assistantAgent,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const contextPath = process.env.TASKMUX_ASSISTANT_CONTEXT;
writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({
  args: process.argv.slice(2),
  home: process.env.TASKMUX_HOME,
  role: process.env.TASKMUX_ROLE,
  workspace: process.env.TASKMUX_WORKSPACE,
  contextPath,
  context: readFileSync(contextPath, "utf8")
}));
process.stdout.write("assistant ready\\n");
`
  );
  chmodSync(assistantAgent, 0o755);

  addAgent(home, "codex", assistantAgent);
  runTaskmux(["role", "add", "assistant", "--agent", "codex", "--workspace", home], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["assistant"], { TASKMUX_HOME: home });
  const log = JSON.parse(readFileSync(logFile, "utf8"));

  assert.match(output, /assistant ready/);
  assert.match(output, /Exited role assistant/);
  assert.equal(log.home, home);
  assert.equal(log.role, "assistant");
  assert.equal(log.workspace, home);
  assert.match(log.contextPath, /TASKMUX_OPERATOR\.md$/);
  assert.match(log.context, /Use `taskmux` commands/);
  assert.match(log.context, /Every task has a protected `leader` role/);
  assert.equal(log.args.length, 1);
  assert.match(log.args[0], /TaskMux Operator mode/);
  assert.match(log.args[0], /Do not perform Task work or edit TaskMux JSON storage directly/);
});

test("runs the Operator in its own persistent tmux session", () => {
  const home = createTaskmuxHome();
  const fakeAgent = createFakeExecutable(home, "operator-agent.js", "operator ready\n");
  const { fakeTmux, logFile } = createFakeTmux(home);

  writeStorageSchema(home, 2);
  addAgent(home, "codex", fakeAgent);
  runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", home], {
    TASKMUX_HOME: home
  });
  runTaskmux(["operator"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window" && call.includes("operator"));

  assert.ok(newWindow);
  assert.ok(calls.some((call) => call[0] === "attach-session" && call.at(-1) === "taskmux-operator:operator"));
  assert.match(newWindow.at(-1), /TASKMUX_OPERATOR_CONTEXT=/);
  assert.match(newWindow.at(-1), /operator-agent\.js/);
  assert.match(readFileSync(join(home, "operator", "TASKMUX_OPERATOR.md"), "utf8"), /Do not describe a draft as official/);
});

test("assigns custom runners and starts configured commands", () => {
  const home = createConfiguredHome();
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(
    [
      "runner",
      "add",
      "agent-js",
      "--command",
      fakeAgent,
      "--arg",
      "--model",
      "--arg",
      "review",
      "--env",
      "TASKMUX_MODE=dev"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const assignOutput = runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "agent-js",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(assignOutput, /Assigned role rd to task-1/);
  assert.match(assignOutput, /Agent: agent-js/);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.agent, "agent-js");
  assert.equal(role.command, fakeAgent);
  assert.deepEqual(role.args, ["--model", "review"]);
  assert.deepEqual(role.env, { TASKMUX_MODE: "dev" });

  runTaskmux(["task", "enter", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls[3], [
    "new-window",
    "-t",
    "taskmux-task-1",
    "-n",
    "rd",
    "-c",
    "/tmp/project-a",
    `env TASKMUX_MODE=dev ${fakeAgent} --model review`
  ]);
});

test("removes custom runners", () => {
  const home = createConfiguredHome();
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");

  runTaskmux(["runner", "add", "agent-js", "--command", fakeAgent], {
    TASKMUX_HOME: home
  });

  const removeOutput = runTaskmux(["runner", "remove", "agent-js"], {
    TASKMUX_HOME: home
  });

  assert.match(removeOutput, /Removed runner agent-js/);

  const result = runTaskmuxFailure(["runner", "show", "agent-js"], {
    TASKMUX_HOME: home
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /RUNNER_NOT_FOUND: Runner not found: agent-js/);
});

test("runs doctor checks with configured executables", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "default-agent.js", "default agent 1.0\n");

  writeStorageSchema(home, 2);
  addAgent(home, "default-agent", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "default-agent"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, /TaskMux doctor/);
  assert.match(output, /\|\s+Check\s+\|\s+Status\s+\|\s+Detail\s+\|/);
  assert.match(output, tableRowRegex("node", "ok", "v"));
  assert.match(output, tableRowRegex("tmux", "ok", "tmux 3\\.4"));
  assert.match(output, tableRowRegex("agent:default-agent", "ok", "default agent 1\\.0"));
  assert.doesNotMatch(output, /codex\s+ok/);
  assert.doesNotMatch(output, /claude\s+ok/);
  assert.match(output, tableRowRegex("taskmux home", "ok"));
  assert.match(output, tableRowRegex("default agent", "ok", "default-agent"));
  assert.match(output, tableRowRegex("storage schema", "ok", "current=2 latest=2"));
  assert.match(output, tableRowRegex("storage permissions", "ok", "read-write"));
  assert.match(output, tableRowRegex("storage records", "ok", "tasks=0 roles=0 globalRoles=0 agents=1"));
  assert.match(output, new RegExp(home.replaceAll("\\", "\\\\")));
});

test("doctor reports missing default agent", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  writeStorageSchema(home, 2);

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("default agent", "missing", "run taskmux setup"));
});

test("doctor does not initialize a missing taskmux home", () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");
  const fakeTmux = createFakeExecutable(parent, "fake-tmux.js", "tmux 3.4\n");

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("taskmux home", "missing", "run taskmux setup"));
  assert.match(output, tableRowRegex("storage schema", "missing", "run taskmux setup"));
  assert.match(output, tableRowRegex("storage permissions", "missing", "run taskmux setup"));
  assert.match(output, tableRowRegex("storage records", "missing", "run taskmux setup"));
  assert.equal(existsSync(home), false);
});

test("doctor guides users when storage schema needs migration", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  writeStorageSchema(home, 0);

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("storage schema", "upgrade-required", "current=0 latest=2; run taskmux migrate"));
});

test("doctor reports invalid storage records without failing", () => {
  const home = createConfiguredHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(join(home, "tasks", "task-1", "task.json"), JSON.stringify({ schemaVersion: 2 }));

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("storage records", "invalid", "Invalid task record: task-1"));
});

test("runs doctor checks for custom runner executables", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");
  ensureTestStorageSchema(home);

  runTaskmux(["runner", "add", "agent-js", "--command", fakeAgent], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("agent:agent-js", "ok", "custom agent 1\\.0"));
});

test("starts the default dashboard after doctor checks pass", async () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "leader-agent.js", "leader agent 1.0\n");

  addRunner(home, "leader-cli", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "leader-cli"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "create", "Dashboard task"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "current", "task-1"], {
    TASKMUX_HOME: home
  });

  const output = await runTaskmuxInteractive([], "board\nq\n", {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, /TaskMux doctor/);
  assert.match(output, tableRowRegex("tmux", "ok", "tmux 3\\.4"));
  assert.match(output, tableRowRegex("agent:leader-cli", "ok", "leader agent 1\\.0"));
  assert.match(output, /TaskMux dashboard/);
  assert.match(output, /Current task: task-1\s+Dashboard task/);
  assert.match(output, /Board/);
  assert.match(output, tableCellsRegex("Ongoing", "task-1", "Dashboard task", "", "", "roles idle=1"));
  assert.match(output, /taskmux>/);
});

test("blocks the default dashboard when doctor checks fail", () => {
  const home = createTaskmuxHome();

  const result = runTaskmuxFailure([], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: join(home, "missing-tmux")
  });

  assert.equal(result.status, 4);
  assert.match(result.stdout, /TaskMux doctor/);
  assert.match(result.stdout, tableRowRegex("tmux", "missing"));
  assert.doesNotMatch(result.stdout, /TaskMux dashboard/);
  assert.match(result.stderr, /DATA_ERROR: Doctor checks failed: tmux=missing/);
});

test("setup prints a tmux install plan without changing the system", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  createPathExecutable(fakeBin, "codex", "process.stdout.write('codex 1.0\\n');");
  createPathExecutable(fakeBin, "apt-get", "process.stdout.write('apt 2.0\\n');");
  createPathExecutable(fakeBin, "sudo", "process.stdout.write('sudo 1.0\\n');");

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\n\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: join(home, "missing-tmux"),
      PATH: fakeBin
    }
  );

  assert.match(output, /TaskMux setup complete/);
  assert.match(output, /Tmux is not installed/);
  assert.match(output, /Install with apt-get/);
  assert.match(output, /Install tmux now\? \[y\/N\]: /);
  assert.match(output, /(sudo )?apt-get update/);
  assert.match(output, /(sudo )?apt-get install -y tmux/);
  assert.match(output, /Skipped tmux installation/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.doesNotMatch(output, /taskmux setup --yes/);
});

test("setup requires an interactive terminal", () => {
  const home = createTaskmuxHome();

  const result = runTaskmuxFailure(["setup"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: join(home, "missing-tmux")
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Setup requires an interactive terminal/);
  assert.match(result.stderr, /taskmux config set default-agent <agent-id>/);
  assert.match(result.stderr, /taskmux config set default-workspace <path>/);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(join(home, "schema.json")), false);
});

test("setup interactively selects a default agent from numbered candidates", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  createPathExecutable(fakeBin, "codex", "process.stdout.write('codex 1.0\\n');");

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: process.execPath,
      PATH: fakeBin
    }
  );

  assert.match(output, /Default agent candidates/i);
  assert.doesNotMatch(output, /TaskMux home \[/);
  assert.match(output, /\|\s+#\s+\|\s+Agent\s+\|\s+Command\s+\|\s+Status\s+\|/i);
  assert.match(output, /\|\s+1\s+\|\s+codex\s+\|\s+codex\s+\|\s+installed\s+\|/i);
  assert.match(output, /\|\s+\d+\s+\|\s+claude\s+\|\s+claude\s+\|\s+missing\s+\|/i);
  assert.match(output, /\|\s+\d+\s+\|\s+gemini\s+\|\s+gemini\s+\|\s+missing\s+\|/i);
  assert.match(output, /\|\s+\d+\s+\|\s+qwen\s+\|\s+qwen\s+\|\s+missing\s+\|/i);
  assert.doesNotMatch(output, /Default agent id/);
  assert.doesNotMatch(output, /Command for agent/);
  assert.doesNotMatch(output, /Default workspace \[/);
  assert.doesNotMatch(output, tableRowRegex("agent", "configured"));
  assert.match(output, /TaskMux setup complete/);
  assert.match(output, /TaskMux home initialized/);
  assert.match(output, /Workspace initialized under TaskMux home/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.doesNotMatch(output, /TaskMux setup\nStatus/);

  const config = runTaskmux(["config", "show"], { TASKMUX_HOME: home });
  const agent = runTaskmux(["agent", "show", "codex"], { TASKMUX_HOME: home });
  const board = runTaskmux(["board"], { TASKMUX_HOME: home });
  const workspace = join(home, "workspace");

  assert.match(config, /Default agent: codex/);
  assert.match(config, new RegExp(`Default workspace: ${escapeRegex(workspace)}`));
  assert.match(config, tableRowRegex("default-agent", "configured", "command=codex"));
  assert.doesNotMatch(config, /command=codex; found in PATH/);
  assert.match(config, tableRowRegex("workspace", "configured", escapeRegex(workspace)));
  assert.match(config, tableRowRegex("role:operator", "configured", `agent=codex workspace=${escapeRegex(workspace)}`));
  assert.match(config, tableRowRegex("role:leader", "configured", `agent=codex workspace=${escapeRegex(workspace)}`));
  assert.match(agent, /Agent: codex/);
  assert.match(agent, /Command: codex/);
  assert.match(board, tableCellsRegex("operator", "codex", workspace));
  assert.match(board, tableCellsRegex("leader", "codex", workspace));
  assert.equal(existsSync(workspace), true);
});

test("setup initializes a missing taskmux home before writing storage data", async () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");
  const fakeBin = join(parent, "bin");
  mkdirSync(fakeBin);
  createPathExecutable(fakeBin, "codex", "process.stdout.write('codex 1.0\\n');");

  assert.equal(existsSync(home), false);

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: process.execPath,
      PATH: fakeBin
    }
  );

  assert.match(output, /TaskMux home initialized[\s\S]*Workspace initialized[\s\S]*TaskMux setup complete/);
  assert.equal(existsSync(home), true);
  assert.equal(existsSync(join(home, "schema.json")), true);
  assert.equal(existsSync(join(home, "config.json")), true);
  assert.equal(existsSync(join(home, "workspace")), true);
});

test("setup can install tmux after interactive confirmation", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  const logFile = join(home, "setup.log");
  const installedMarker = join(home, "tmux-installed");
  const fakeTmux = join(home, "tmux");
  mkdirSync(fakeBin);

  createPathExecutable(fakeBin, "codex", "process.stdout.write('codex 1.0\\n');");
  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const { existsSync } = require("node:fs");
if (!existsSync(${JSON.stringify(installedMarker)})) process.exit(1);
process.stdout.write("tmux 3.4\\n");
`
  );
  chmodSync(fakeTmux, 0o755);

  createPathExecutable(
    fakeBin,
    "apt-get",
    `const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("apt 2.0\\n");
  process.exit(0);
}
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(["apt-get", ...args]) + "\\n");
if (args.join(" ") === "install -y tmux") writeFileSync(${JSON.stringify(installedMarker)}, "ok\\n");
process.stdout.write("apt 2.0\\n");
`
  );
  createPathExecutable(
    fakeBin,
    "sudo",
    `const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("sudo 1.0\\n");
  process.exit(0);
}
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(["sudo", ...args]) + "\\n");
if (args.join(" ") === "apt-get install -y tmux") writeFileSync(${JSON.stringify(installedMarker)}, "ok\\n");
process.stdout.write("sudo 1.0\\n");
`
  );

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\ny\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: fakeTmux,
      PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
    }
  );
  const log = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

  assert.match(output, /Install tmux now\? \[y\/N\]: /);
  assert.match(output, /Tmux installed/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.deepEqual(log.map((entry) => entry[0] === "sudo" ? entry.slice(1) : entry), [
    ["apt-get", "update"],
    ["apt-get", "install", "-y", "tmux"]
  ]);
});

test("setup reports unavailable default agent commands", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  mkdirSync(fakeBin);

  const output = await runTaskmuxInteractive(
    ["setup"],
    "taskmux-missing-agent-cli\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: fakeTmux,
      PATH: fakeBin
    }
  );

  assert.match(
    runTaskmux(["config", "show"], { TASKMUX_HOME: home }),
    tableRowRegex("default-agent", "configured", "command=taskmux-missing-agent-cli; not found in PATH")
  );
  assert.doesNotMatch(output, /TaskMux setup\nStatus/);
});

test("setup configures system roles from the default agent", async () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "default-agent.js", "default agent 1.0\n");

  addAgent(home, "default-agent", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "default-agent"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", "/tmp/system-workspace"], { TASKMUX_HOME: home });

  const output = await runTaskmuxInteractive(
    ["setup"],
    "\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: fakeTmux
    }
  );
  const board = runTaskmux(["board"], { TASKMUX_HOME: home });

  const config = runTaskmux(["config", "show"], { TASKMUX_HOME: home });
  const workspace = join(home, "workspace");

  assert.match(output, /TaskMux setup complete/);
  assert.match(output, /TaskMux home initialized/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.match(config, tableRowRegex("default-agent", "configured", "command=.*default-agent\\.js"));
  assert.match(config, tableRowRegex("workspace", "configured", escapeRegex(workspace)));
  assert.match(config, tableRowRegex("role:operator", "configured", `agent=default-agent workspace=${escapeRegex(workspace)}`));
  assert.match(config, tableRowRegex("role:leader", "configured", `agent=default-agent workspace=${escapeRegex(workspace)}`));
  assert.match(board, tableCellsRegex("operator", "default-agent", workspace));
  assert.match(board, tableCellsRegex("leader", "default-agent", workspace));
});

test("non-interactive setup does not configure roles", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "default-agent.js", "default agent 1.0\n");

  addAgent(home, "default-agent", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "default-agent"], { TASKMUX_HOME: home });

  const result = runTaskmuxFailure(["setup"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });
  const board = runTaskmux(["board"], { TASKMUX_HOME: home });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Setup requires an interactive terminal/);
  assert.match(board, tableCellsRegex("operator", "?", "?"));
  assert.match(board, tableCellsRegex("leader", "?", "?"));
});

test("setup prompts through existing config and keeps values on enter", async () => {
  const home = createTaskmuxHome();
  const fakeTmux = createShellExecutable(home, "fake-tmux", "printf 'tmux 3.4\\n'\n");
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  createPathExecutable(fakeBin, "codex", "process.stdout.write('codex 1.0\\n');");

  addAgent(home, "codex", "codex");
  runTaskmux(["config", "set", "default-agent", "codex"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", "/tmp/existing-workspace"], { TASKMUX_HOME: home });

  const output = await runTaskmuxInteractive(
    ["setup"],
    "\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: fakeTmux,
      PATH: fakeBin
    }
  );
  const config = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(output, /Default agent candidates/i);
  assert.match(output, /\|\s+1\s+\|\s+codex\s+\|\s+codex\s+\|\s+installed\s+\|\s+yes\s+\|/i);
  assert.match(output, /Choose default agent by number or name \[codex\]: /);
  assert.doesNotMatch(output, /Default workspace \[/);
  assert.doesNotMatch(output, tableRowRegex("agent", "ok"));
  assert.match(output, /TaskMux setup complete/);
  assert.match(output, /TaskMux home initialized/);
  assert.match(output, /Tmux already installed/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.doesNotMatch(output, /TaskMux setup\nStatus/);
  assert.match(config, /Default agent: codex/);
  assert.match(config, new RegExp(`Default workspace: ${escapeRegex(join(home, "workspace"))}`));
  assert.match(config, tableRowRegex("default-agent", "configured", "command=codex"));
  assert.doesNotMatch(config, /command=codex; found in PATH/);
  assert.match(config, tableRowRegex("workspace", "configured", escapeRegex(join(home, "workspace"))));
});

test("setup --yes is not supported", () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");
  const result = runTaskmuxFailure(["setup", "--yes"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Setup usage: taskmux setup \[tmux\]/);
  assert.equal(existsSync(home), false);
});

test("runs an interactive task shell", async () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = await runTaskmuxInteractive(
    ["task", "shell", "task-1"],
    "summary\nupdate --priority high --due 2026-07-01\nsummary\nr\ncomment hello from shell\nc\ne\na\nt\ncontext\nq\n",
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Task: task-1/);
  assert.match(output, /taskmux task-1>/);
  assert.match(output, /Updated task task-1/);
  assert.match(output, /Priority: high/);
  assert.match(output, /Due: 2026-07-01/);
  assert.match(output, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(output, /Added comment to task-1: hello from shell/);
  assert.match(output, /hello from shell/);
  assert.match(output, /task\.created/);
  assert.match(output, /role\.assigned/);
  assert.match(output, /comment\.added/);
  assert.match(output, /Task activity: task-1/);
  assert.match(output, /Task timeline: task-1/);
  assert.match(output, /Task Context/);
});

test("creates a task-local custom topic", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Plan data migration"], { TASKMUX_HOME: home });
  const output = runTaskmux(
    [
      "task",
      "topic",
      "create",
      "task-1",
      "--id",
      "data-migration",
      "--name",
      "数据迁移",
      "--description",
      "数据结构变更、迁移过程与兼容性处理"
    ],
    { TASKMUX_HOME: home }
  );
  const topics = JSON.parse(readFileSync(join(home, "tasks", "task-1", "topics.json"), "utf8"));

  assert.match(output, /Created topic data-migration for task task-1/);
  assert.equal(topics.schemaVersion, 1);
  assert.deepEqual(topics.customTopics.map(({ createdAt, ...topic }) => topic), [
    {
      id: "data-migration",
      name: "数据迁移",
      description: "数据结构变更、迁移过程与兼容性处理",
      createdBy: "user"
    }
  ]);
  assert.match(topics.customTopics[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("lists built-in and task-local topics together", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Plan data migration"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task",
      "topic",
      "create",
      "task-1",
      "--id",
      "data-migration",
      "--name",
      "数据迁移",
      "--description",
      "数据结构变更、迁移过程与兼容性处理"
    ],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(["task", "topic", "list", "task-1"], { TASKMUX_HOME: home });

  for (const topic of [
    "requirements",
    "architecture",
    "ui",
    "implementation",
    "testing",
    "deployment",
    "operations",
    "security",
    "data-migration"
  ]) {
    assert.match(output, new RegExp(topic));
  }
  assert.match(output, /数据迁移/);
});

test("warns about custom topic naming without blocking it", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Prepare deployment"], { TASKMUX_HOME: home });
  const output = runTaskmux(
    [
      "task",
      "topic",
      "create",
      "task-1",
      "--id",
      "Deployment Check",
      "--name",
      "部署检查",
      "--description",
      "发布前检查"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Created topic Deployment Check/);
  assert.match(output, /Warning: topic ids conventionally use lower-case kebab-case/);
});

test("keeps operator input as a draft until it is submitted", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Investigate deployment failures"], { TASKMUX_HOME: home });
  const draftOutput = runTaskmux(
    ["task", "input", "draft", "task-1", "Production fails only in the canary environment."],
    { TASKMUX_HOME: home }
  );
  const draft = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "input-draft.json"), "utf8")
  );

  assert.match(draftOutput, /Saved input draft for task task-1/);
  assert.equal(draft.body, "Production fails only in the canary environment.");
  assert.equal(existsSync(join(home, "tasks", "task-1", "comments.jsonl")), false);

  const submitOutput = runTaskmux(["task", "input", "submit", "task-1"], {
    TASKMUX_HOME: home
  });
  const comments = readFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const events = readFileSync(join(home, "tasks", "task-1", "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const pendingWakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );

  assert.match(submitOutput, /Submitted input draft for task task-1/);
  assert.equal(comments.at(-1).body, "Production fails only in the canary environment.");
  assert.equal(comments.at(-1).author, "operator");
  assert.equal(events.at(-1).type, "task.input_submitted");
  assert.deepEqual(pendingWakeup.reasons, ["operator-input"]);
  assert.equal(pendingWakeup.requestCount, 1);
  assert.equal(existsSync(join(home, "tasks", "task-1", "input-draft.json")), false);
});

test("creates a cycle and a finite work item inside a long-lived task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Keep production deployments healthy"], { TASKMUX_HOME: home });
  const cycleOutput = runTaskmux(
    ["task", "cycle", "create", "task-1", "--cause", "explicit-wake", "--summary", "Check today's release"],
    { TASKMUX_HOME: home }
  );
  const workItemOutput = runTaskmux(
    [
      "task",
      "work-item",
      "create",
      "task-1",
      "--title",
      "Run canary checks",
      "--cycle",
      "cycle-1",
      "--assignee",
      "leader",
      "--topic",
      "testing",
      "--topic",
      "deployment"
    ],
    { TASKMUX_HOME: home }
  );
  const cycle = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "cycles", "cycle-1.json"), "utf8")
  );
  const workItem = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "work-items", "work-item-1.json"), "utf8")
  );

  assert.match(cycleOutput, /Created cycle cycle-1 for task task-1/);
  assert.equal(cycle.cause, "explicit-wake");
  assert.equal(cycle.status, "active");
  assert.match(workItemOutput, /Created work item work-item-1 for task task-1/);
  assert.equal(workItem.cycleId, "cycle-1");
  assert.equal(workItem.assignee, "leader");
  assert.equal(workItem.status, "pending");
  assert.deepEqual(workItem.topics, ["testing", "deployment"]);

  runTaskmux(
    [
      "task", "work-item", "update", "task-1", "work-item-1",
      "--status", "completed",
      "--outcome", "Canary checks passed"
    ],
    { TASKMUX_HOME: home }
  );
  const completed = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "work-items", "work-item-1.json"), "utf8")
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome, "Canary checks passed");
  assert.match(completed.endedAt, /^\d{4}-/);

  runTaskmux(
    ["task", "cycle", "end", "task-1", "cycle-1", "--summary", "Canary cycle completed successfully"],
    { TASKMUX_HOME: home }
  );
  const endedCycle = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "cycles", "cycle-1.json"), "utf8")
  );
  assert.equal(endedCycle.status, "ended");
  assert.equal(endedCycle.summary, "Canary cycle completed successfully");
  assert.match(endedCycle.endedAt, /^\d{4}-/);

  const initialCycle = runTaskmux(
    ["task", "cycle", "create", "task-1", "--cause", "task-created", "--summary", "Initial stewardship"],
    { TASKMUX_HOME: home }
  );
  assert.match(initialCycle, /Created cycle cycle-2/);
});

test("coalesces comments and explicit triggers into one leader wakeup", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Track an external release"], { TASKMUX_HOME: home });
  runTaskmux(["task", "comment", "task-1", "The vendor moved the release date."], {
    TASKMUX_HOME: home
  });
  const output = runTaskmux(
    ["task", "wake", "task-1", "--reason", "review-time"],
    { TASKMUX_HOME: home }
  );
  const pendingWakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );

  assert.match(output, /Queued leader wakeup for task task-1/);
  assert.deepEqual(pendingWakeup.reasons, ["user-comment", "review-time"]);
  assert.equal(pendingWakeup.requestCount, 2);
});

test("starts and reaches the controller through authenticated loopback RPC", () => {
  const home = createConfiguredHome();

  try {
    const startOutput = runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    const status = JSON.parse(
      runTaskmux(["controller", "status", "--json"], { TASKMUX_HOME: home })
    );
    const discovery = JSON.parse(
      readFileSync(join(home, "runtime", "controller.json"), "utf8")
    );

    assert.match(startOutput, /Controller started/);
    assert.equal(discovery.host, "127.0.0.1");
    assert.equal(discovery.apiVersion, 1);
    assert.match(discovery.token, /^[a-f0-9]{64}$/);
    assert.equal(status.running, true);
    assert.equal(status.pid, discovery.pid);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("controller replays staged snapshot writes before serving requests", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Original title"], { TASKMUX_HOME: home });
  const recovery = await import("../dist/storage/recoveryJournal.js");
  const target = join(home, "tasks", "task-1", "info.json");
  recovery.stageSnapshotWrite(
    home,
    target,
    `${JSON.stringify({ schemaVersion: 1, title: "Recovered title" }, null, 2)}\n`,
    "controller-replay"
  );

  try {
    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    assert.equal(JSON.parse(readFileSync(target, "utf8")).title, "Recovered title");
    assert.deepEqual(readdirSync(join(home, "runtime", "recovery-journal")), []);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("controller rebuilds and refreshes its derived SQLite index", async () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };
  const { default: Database } = await import("better-sqlite3");
  runTaskmux(["task", "create", "Existing indexed task"], { TASKMUX_HOME: home });
  const indexFile = join(home, "runtime", "index.sqlite");

  try {
    runTaskmux(["controller", "start"], env);
    let database = new Database(indexFile, { readonly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM tasks").get().count, 1);
    database.close();

    runTaskmux(["task", "create", "Controller indexed task"], env);
    database = new Database(indexFile, { readonly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM tasks").get().count, 2);
    database.close();
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("controller file watcher reloads a valid direct edit into the derived index", async () => {
  const home = createConfiguredHome();
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
  };
  const { default: Database } = await import("better-sqlite3");
  runTaskmux(["task", "create", "Before direct edit"], { TASKMUX_HOME: home });

  try {
    runTaskmux(["controller", "start"], env);
    writeFileSync(
      join(home, "tasks", "task-1", "info.json"),
      JSON.stringify({ schemaVersion: 1, title: "After direct edit" })
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    const database = new Database(join(home, "runtime", "index.sqlite"), { readonly: true });
    assert.equal(database.prepare("SELECT title FROM tasks WHERE id = 'task-1'").get().title, "After direct edit");
    database.close();
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("controller serves the last valid value and logs an invalid direct edit", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };
  runTaskmux(["task", "create", "Controller cached title"], { TASKMUX_HOME: home });

  try {
    runTaskmux(["controller", "start"], env);
    assert.match(runTaskmux(["task", "show", "task-1"], env), /Controller cached title/);
    const infoFile = join(home, "tasks", "task-1", "info.json");
    writeFileSync(infoFile, "{ invalid json\n");

    assert.match(runTaskmux(["task", "show", "task-1"], env), /Controller cached title/);
    assert.equal(readFileSync(infoFile, "utf8"), "{ invalid json\n");
    const diagnostics = readFileSync(join(home, "runtime", "logs", "controller.jsonl"), "utf8");
    assert.match(diagnostics, /storage.invalid_edit/);
    assert.match(diagnostics, /Invalid task info record/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("controller primes individual role values before an invalid direct edit", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };
  runTaskmux(["task", "create", "Cache role records"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );

  try {
    runTaskmux(["controller", "start"], env);
    const roleInfo = join(home, "tasks", "task-1", "roles", "reviewer", "info.json");
    writeFileSync(roleInfo, "{ invalid json\n");
    assert.match(runTaskmux(["task", "detail", "task-1", "reviewer"], env), /Role: reviewer/);
    assert.equal(readFileSync(roleInfo, "utf8"), "{ invalid json\n");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("removes a stale discovery file when its live pid does not answer Controller health", () => {
  const home = createConfiguredHome();
  const discoveryFile = join(home, "runtime", "controller.json");
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(discoveryFile, JSON.stringify({
    schemaVersion: 1,
    apiVersion: 1,
    host: "127.0.0.1",
    port: 1,
    pid: process.pid,
    token: "not-a-controller",
    startedAt: new Date().toISOString()
  }));

  const status = JSON.parse(runTaskmux(["controller", "status", "--json"], { TASKMUX_HOME: home }));
  assert.equal(status.running, false);
  assert.equal(existsSync(discoveryFile), false);
});

test("uses an exclusive process lock for Controller startup", async () => {
  const home = createConfiguredHome();
  const controller = await import("../dist/controller/controller.js");

  assert.equal(typeof controller.acquireControllerLock, "function");
  const release = controller.acquireControllerLock(home, process.pid);
  assert.throws(() => controller.acquireControllerLock(home, process.pid), /Controller startup is locked/);
  release();

  const releaseAgain = controller.acquireControllerLock(home, process.pid);
  releaseAgain();
});

test("controller applies a mutating RPC request id only once", async () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Deduplicate wakeups"], { TASKMUX_HOME: home });
  try {
    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    const discovery = JSON.parse(
      readFileSync(join(home, "runtime", "controller.json"), "utf8")
    );
    const request = {
      apiVersion: 1,
      requestId: "same-request-id",
      method: "wakeup.merge",
      params: { taskId: "task-1", reason: "explicit-wake" }
    };
    const invoke = () => fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    assert.equal((await invoke()).status, 200);
    assert.equal((await invoke()).status, 200);
    const wakeup = JSON.parse(
      readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
    );
    assert.equal(wakeup.requestCount, 1);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("auto-starts the Controller and routes ordinary task commands through RPC", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile
  };

  try {
    const output = runTaskmux(["task", "create", "Create through the Controller"], env);
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));

    assert.match(output, /Created task task-1/);
    assert.equal(discovery.host, "127.0.0.1");
    assert.equal(JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8")).archived, false);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("starts the dedicated Leader's first run after task creation", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createExistingRoleTmux(home, "leader");
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
  };

  try {
    runTaskmux(["task", "create", "Start Leader stewardship"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    const run = JSON.parse(
      readFileSync(join(home, "runtime", "active-runs", "task-1", "leader.json"), "utf8")
    );
    const cycle = JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "cycles", "cycle-1.json"), "utf8")
    );
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(run.mode, "new");
    assert.match(run.input, /# TaskMux Leader/);
    assert.match(run.input, /task-created/);
    assert.equal(cycle.cause, "task-created");
    assert.match(cycle.summary, /task-created/);
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
    assert.ok(calls.some((call) => call[0] === "new-window" && call.includes("leader")));
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("routes configuration and role mutations through the same Controller", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };

  try {
    runTaskmux(["config", "set", "default-workspace", "/tmp/controller-workspace"], env);
    runTaskmux(
      ["role", "add", "controller-reviewer", "--agent", "codex", "--workspace", "/tmp/controller-workspace"],
      env
    );

    assert.equal(existsSync(join(home, "runtime", "controller.json")), true);
    assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).defaultWorkspace, "/tmp/controller-workspace");
    assert.equal(
      JSON.parse(readFileSync(join(home, "roles", "controller-reviewer", "role.json"), "utf8")).agent,
      "codex"
    );
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("deduplicates a generic task command RPC by request id", async () => {
  const home = createConfiguredHome();

  try {
    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const request = {
      apiVersion: 1,
      requestId: "same-task-command",
      method: "task.command",
      params: { args: ["create", "Create exactly once"] }
    };
    const invoke = () => fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    assert.equal((await invoke()).status, 200);
    assert.equal((await invoke()).status, 200);
    assert.deepEqual(
      readdirSync(join(home, "tasks")).filter((name) => name.startsWith("task-")),
      ["task-1"]
    );
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("stores child roles as parent-only descriptive constraints", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review the deployment architecture"], { TASKMUX_HOME: home });
  const output = runTaskmux(
    [
      "task",
      "role",
      "child",
      "task-1",
      "deployment-reviewer",
      "--parent",
      "leader",
      "--description",
      "Review deployment changes",
      "--responsibility",
      "Find rollback risks",
      "--constraint",
      "Do not modify production",
      "--expected-output",
      "A concise risk report"
    ],
    { TASKMUX_HOME: home }
  );
  const roleDir = join(home, "tasks", "task-1", "roles", "deployment-reviewer");
  const childRole = JSON.parse(readFileSync(join(roleDir, "info.json"), "utf8"));

  assert.match(output, /Created child role deployment-reviewer for parent leader/);
  assert.equal(childRole.architecture, "child");
  assert.equal(childRole.parentRole, "leader");
  assert.deepEqual(childRole.responsibilities, ["Find rollback risks"]);
  assert.deepEqual(childRole.constraints, ["Do not modify production"]);
  assert.equal(childRole.expectedOutput, "A concise risk report");
  assert.equal("agent" in childRole, false);
  assert.equal("skills" in childRole, false);
  assert.equal(existsSync(join(roleDir, "role.json")), false);
});

test("injects child role descriptions into the parent dispatch only", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review deployment"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "role", "child", "task-1", "risk-reviewer",
      "--parent", "leader",
      "--description", "Review rollback risk",
      "--responsibility", "Check data compatibility",
      "--constraint", "Do not deploy",
      "--expected-output", "Risk report"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Plan the review"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );
  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const injectedInput = calls[4][4];

  assert.match(injectedInput, /risk-reviewer/);
  assert.match(injectedInput, /Review rollback risk/);
  assert.match(injectedInput, /Check data compatibility/);
  assert.match(injectedInput, /Do not deploy/);
  assert.match(injectedInput, /Risk report/);
  assert.match(injectedInput, /Plan the review/);
});

test("removes child role constraints when their parent role is removed", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review deployment"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task", "role", "child", "task-1", "risk-checker",
      "--parent", "reviewer",
      "--description", "Check risks",
      "--expected-output", "Risk notes"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "role", "remove", "task-1", "reviewer"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Removed role reviewer and 1 child role/);
  assert.equal(existsSync(join(home, "tasks", "task-1", "roles", "reviewer")), false);
  assert.equal(existsSync(join(home, "tasks", "task-1", "roles", "risk-checker")), false);
});

test("creates a git worktree for an independent task role", () => {
  const home = createConfiguredHome();
  const repository = join(home, "project");
  const worktree = join(home, "worktrees", "reviewer");
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-b", "master"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "taskmux@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "TaskMux Test"], { cwd: repository });
  writeFileSync(join(repository, "README.md"), "initial\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });

  runTaskmux(["task", "create", "Review release", "--workspace", repository], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", repository],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(
    ["task", "worktree", "create", "task-1", "reviewer", "--path", worktree, "--branch", "taskmux/reviewer"],
    { TASKMUX_HOME: home }
  );
  const metadata = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "worktree.json"), "utf8")
  );
  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );

  assert.match(output, /Created worktree for task-1\/reviewer/);
  assert.equal(existsSync(join(worktree, ".git")), true);
  assert.equal(metadata.branch, "taskmux/reviewer");
  assert.equal(metadata.path, worktree);
  assert.equal(role.workspace, worktree);
});

test("keeps the leader native session fixed until explicit replacement", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Maintain a long-running release"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-1"],
    { TASKMUX_HOME: home }
  );
  const rejected = runTaskmuxFailure(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-2"],
    { TASKMUX_HOME: home }
  );

  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Leader session replacement must be explicit/);

  const output = runTaskmux(
    [
      "task", "session", "replace", "task-1", "leader",
      "--native-id", "codex-session-2",
      "--reason", "irrecoverable native session"
    ],
    { TASKMUX_HOME: home }
  );
  const session = JSON.parse(
    readFileSync(join(home, "runtime", "role-sessions", "task-1", "leader.json"), "utf8")
  );

  assert.match(output, /Replaced native session for task-1\/leader/);
  assert.equal(session.agent, "codex");
  assert.equal(session.nativeSessionId, "codex-session-2");
  assert.equal(session.policy, "fixed");
  assert.deepEqual(session.previousSessionIds, ["codex-session-1"]);
});

test("builds Codex start and recovery plans through the unified executor adapter", async () => {
  const { resolveAgentExecutor } = await import("../dist/executor/executorRegistry.js");
  const role = {
    schemaVersion: 1,
    name: "reviewer",
    agent: "codex",
    command: "codex",
    args: ["--full-auto"],
    env: { CODEX_HOME: "/tmp/codex" },
    workspace: "/tmp/project-a",
    status: "idle",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
  const session = {
    schemaVersion: 1,
    taskId: "task-1",
    roleName: "reviewer",
    agent: "codex",
    nativeSessionId: "codex-thread-1",
    policy: "leader-controlled",
    status: "ready",
    previousSessionIds: [],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };

  const executor = resolveAgentExecutor("codex");
  assert.deepEqual(executor.prepare({
    taskId: "task-1", role, mode: "new", session: null,
    now: new Date("2026-07-11T00:00:00.000Z")
  }), {
    launch: { command: "codex", args: ["--full-auto"], env: { CODEX_HOME: "/tmp/codex" } },
    session: null
  });
  assert.deepEqual(executor.prepare({
    taskId: "task-1", role, mode: "resume", session,
    now: new Date("2026-07-11T00:00:00.000Z")
  }), {
    launch: {
      command: "codex",
      args: ["--full-auto", "resume", "codex-thread-1"],
      env: { CODEX_HOME: "/tmp/codex" }
    },
    session
  });
});

test("preallocates and records a native session id for a new Claude dispatch", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Delegate a Claude review"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    env
  );

  const session = JSON.parse(
    readFileSync(join(home, "runtime", "role-sessions", "task-1", "reviewer.json"), "utf8")
  );
  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window" && call.includes("reviewer"));

  assert.match(session.nativeSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(session.agent, "claude");
  assert.ok(newWindow);
  assert.match(newWindow.at(-1), new RegExp(`claude --session-id ${session.nativeSessionId}`));
  assert.match(newWindow.at(-1), new RegExp(`TASKMUX_NATIVE_SESSION_ID=${session.nativeSessionId}`));
});

test("asks a new Codex role to register the executor-provided thread id", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Register a Codex session"], env);
  runTaskmux(
    ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Begin stewardship"],
    env
  );
  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const literalInput = calls.find((call) => call[0] === "send-keys" && call[1] === "-l");

  assert.ok(literalInput);
  assert.match(literalInput.at(-1), /CODEX_THREAD_ID/);
  assert.match(literalInput.at(-1), /task session record/);
});

test("replaces an existing tmux role window when the Leader selects a new session", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createExistingRoleTmux(home, "reviewer");
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Restart a role with fresh context"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Start from fresh context"],
    env
  );

  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call[0] === "kill-window" && call.at(-1) === "taskmux-task-1:reviewer"));
  assert.ok(calls.some((call) => call[0] === "new-window" && call.includes("reviewer")));
});

test("dispatches a role synchronously while its agent work continues in tmux", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Continue release work"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-1"],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(
    ["task", "dispatch", "task-1", "leader", "--mode", "resume", "--input", "Continue the next work item"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );
  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.match(output, /Dispatch accepted for task-1\/leader \(resume\)/);
  assert.match(calls[3].at(-1), /TASKMUX_TASK_ID=task-1/);
  assert.match(calls[3].at(-1), /codex resume codex-session-1$/);
  assert.deepEqual(calls[4].slice(0, 4), ["send-keys", "-l", "-t", "taskmux-task-1:leader"]);
  assert.match(calls[4][4], /# TaskMux Leader/);
  assert.match(calls[4][4], /Continue the next work item$/);
  assert.deepEqual(calls[5], ["send-keys", "-t", "taskmux-task-1:leader", "Enter"]);
});

test("links a dispatch run to its finite WorkItem and Topics", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Review deployment safety"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    [
      "task", "work-item", "create", "task-1",
      "--title", "Review rollback safety", "--assignee", "reviewer", "--topic", "deployment"
    ],
    env
  );
  runTaskmux(
    [
      "task", "dispatch", "task-1", "reviewer", "--mode", "new",
      "--work-item", "work-item-1", "--topic", "testing", "--input", "Run the review"
    ],
    env
  );

  const run = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json"), "utf8")
  );
  const workItem = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "work-items", "work-item-1.json"), "utf8")
  );

  assert.equal(run.workItemId, "work-item-1");
  assert.deepEqual(run.topics, ["deployment", "testing"]);
  assert.match(run.input, /WorkItem work-item-1: Review rollback safety/);
  assert.equal(workItem.status, "running");

  runTaskmux(
    ["task", "yield", "task-1", "reviewer", "--summary", "Rollback safety is verified."],
    env
  );
  const completedWorkItem = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "work-items", "work-item-1.json"), "utf8")
  );
  assert.equal(completedWorkItem.status, "completed");
  assert.equal(completedWorkItem.outcome, "Rollback safety is verified.");
  assert.match(completedWorkItem.endedAt, /^\d{4}-/);
});

test("injects TaskMux role context and the matching system skill into a dispatch", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review release context"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window" && call.includes("reviewer"));
  const literalInput = calls.find((call) => call[0] === "send-keys" && call[1] === "-l");

  assert.ok(newWindow);
  assert.match(newWindow.at(-1), new RegExp(`TASKMUX_HOME=${home.replaceAll("/", "\\/")}`));
  assert.match(newWindow.at(-1), /TASKMUX_TASK_ID=task-1/);
  assert.match(newWindow.at(-1), /TASKMUX_ROLE=reviewer/);
  assert.match(newWindow.at(-1), /TASKMUX_RUN_ID=agent-run-1/);
  assert.match(newWindow.at(-1), /TASKMUX_WORKSPACE=\/tmp\/project-a/);
  assert.ok(literalInput);
  assert.match(literalInput.at(-1), /# TaskMux Worker/);
  assert.match(literalInput.at(-1), /Review the release/);
});

test("rejects a second dispatch while the same role already has an active run", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Avoid overlapping role work"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "First round"],
    env
  );

  const rejected = runTaskmuxFailure(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Overlapping round"],
    env
  );

  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /already has an active agent run/);
});

test("records an agent run and wakes the leader when an independent role yields", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review release risks"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review rollback risks"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );
  const activeRunPath = join(home, "runtime", "active-runs", "task-1", "reviewer.json");
  const activeRun = JSON.parse(readFileSync(activeRunPath, "utf8"));

  assert.equal(activeRun.status, "active");
  assert.equal(activeRun.roleName, "reviewer");

  const output = runTaskmux(
    ["task", "yield", "task-1", "reviewer", "--summary", "Rollback requires a database compatibility check."],
    { TASKMUX_HOME: home }
  );
  const storedRun = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json"), "utf8")
  );
  const pendingWakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );

  assert.match(output, /Yielded agent-run-1 from task-1\/reviewer/);
  assert.equal(existsSync(activeRunPath), false);
  assert.equal(storedRun.status, "yielded");
  assert.equal(storedRun.summary, "Rollback requires a database compatibility check.");
  assert.deepEqual(pendingWakeup.reasons, ["role-result"]);
});

test("resolves context and yield scope from the role session environment", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const baseEnv = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Use scoped role commands"], baseEnv);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    baseEnv
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review"],
    baseEnv
  );
  const roleEnv = { ...baseEnv, TASKMUX_TASK_ID: "task-1", TASKMUX_ROLE: "reviewer" };

  runTaskmux(["task", "session", "record", "--native-id", "scoped-session"], roleEnv);
  const context = JSON.parse(runTaskmux(["task", "context", "--format", "json"], roleEnv));
  const yielded = runTaskmux(["task", "yield", "--summary", "Review is complete"], roleEnv);

  assert.equal(context.task.id, "task-1");
  assert.equal(context.sessions.reviewer.nativeSessionId, "scoped-session");
  assert.match(yielded, /Yielded agent-run-1 from task-1\/reviewer/);
});

test("wakes an inactive unarchived task only when no agent run is active", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Wait for an external deployment"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "0", "--cooldown-minutes", "30"],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(["controller", "scan"], { TASKMUX_HOME: home });
  const wakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );

  assert.match(output, /Queued 1 task wakeup/);
  assert.deepEqual(wakeup.reasons, ["inactivity"]);

  runTaskmux(["task", "archive", "task-1"], { TASKMUX_HOME: home });
  const secondScan = runTaskmux(["controller", "scan"], { TASKMUX_HOME: home });
  assert.match(secondScan, /Queued 0 task wakeups/);
});

test("suppresses a repeated inactivity wakeup during the configured cooldown", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "50"
  };

  runTaskmux(["task", "create", "Avoid repeated idle reviews"], env);
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-1"],
    env
  );
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "0", "--cooldown-minutes", "60"],
    env
  );
  runTaskmux(["task", "wake", "task-1", "--reason", "initial-review"], env);

  try {
    runTaskmux(["controller", "start"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }

  runTaskmux(["task", "yield", "task-1", "leader", "--summary", "No action needed yet."], env);
  const scan = runTaskmux(["controller", "scan"], env);
  const schedule = JSON.parse(readFileSync(join(home, "tasks", "task-1", "schedule.json"), "utf8"));

  assert.match(scan, /Queued 0 task wakeups/);
  assert.match(schedule.lastLeaderWakeupAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
});

test("expires an abandoned agent run and wakes the leader once", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "25",
    TASKMUX_AGENT_RUN_TTL_MS: "25"
  };

  runTaskmux(["task", "create", "Recover an abandoned review"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    env
  );

  try {
    runTaskmux(["controller", "start"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    const storedRun = JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json"), "utf8")
    );
    const reviewer = JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
    );
    const events = readFileSync(join(home, "tasks", "task-1", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(storedRun.status, "expired");
    assert.equal(reviewer.status, "idle");
    assert.match(storedRun.endedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(existsSync(join(home, "runtime", "active-runs", "task-1", "reviewer.json")), false);
    assert.equal(events.filter((event) => event.type === "leader.wakeup_dispatched").length, 1);
    assert.match(
      events.find((event) => event.type === "leader.wakeup_dispatched").payload.reasons,
      /role-run-expired/
    );
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("fails an active role run immediately when its tmux window has exited", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_AGENT_RUN_TTL_MS: "99999999"
  };

  runTaskmux(["task", "create", "Notice a failed review process"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    env
  );

  runTaskmux(["controller", "scan"], env);
  const storedRun = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json"), "utf8")
  );
  const wakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );
  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );

  assert.equal(storedRun.status, "failed");
  assert.equal(role.status, "exited");
  assert.equal(existsSync(join(home, "runtime", "active-runs", "task-1", "reviewer.json")), false);
  assert.deepEqual(wakeup.reasons, ["role-run-failed"]);
});

test("controller periodically performs the inactivity safety scan", () => {
  const home = createConfiguredHome();
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "50"
  };

  runTaskmux(["task", "create", "Keep an unattended task moving"], env);
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "0", "--cooldown-minutes", "30"],
    env
  );

  try {
    runTaskmux(["controller", "start"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    const wakeup = JSON.parse(
      readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
    );
    assert.deepEqual(wakeup.reasons, ["inactivity"]);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("controller recovers the fixed leader session to process a pending wakeup", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "50"
  };

  runTaskmux(["task", "create", "Process submitted information"], env);
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-1"],
    env
  );
  runTaskmux(["task", "comment", "task-1", "The release is now available."], env);

  try {
    runTaskmux(["controller", "start"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    const activeRun = JSON.parse(
      readFileSync(join(home, "runtime", "active-runs", "task-1", "leader.json"), "utf8")
    );
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(activeRun.roleName, "leader");
    assert.equal(activeRun.mode, "resume");
    assert.match(activeRun.input, /user-comment/);
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
    assert.match(calls[3].at(-1), /TASKMUX_HOME=/);
    assert.match(calls[3].at(-1), /TASKMUX_TASK_ID=task-1/);
    assert.match(calls[3].at(-1), /TASKMUX_ROLE=leader/);
    assert.match(calls[3].at(-1), /TASKMUX_RUN_ID=agent-run-1/);
    assert.match(calls[3].at(-1), /codex resume codex-session-1/);
    assert.match(activeRun.input, /# TaskMux Leader/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("pauses leader wakeups after recovery failure until the session is explicitly replaced", () => {
  const home = createConfiguredHome();
  const fakeTmux = createFailingDispatchTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "25"
  };

  runTaskmux(["task", "create", "Repair a broken Leader session"], env);
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "broken-session"],
    env
  );
  runTaskmux(["task", "wake", "task-1", "--reason", "scheduled-review"], env);

  try {
    runTaskmux(["controller", "start"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    const failure = JSON.parse(
      readFileSync(join(home, "runtime", "leader-failures", "task-1.json"), "utf8")
    );
    const context = JSON.parse(
      runTaskmux(["task", "context", "task-1", "--format", "json"], env)
    );

    assert.equal(failure.nativeSessionId, "broken-session");
    assert.equal(failure.attemptCount, 1);
    assert.equal(context.leaderFailure.attemptCount, 1);
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), true);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }

  runTaskmux(
    [
      "task", "session", "replace", "task-1", "leader",
      "--native-id", "replacement-session", "--reason", "original session is irrecoverable"
    ],
    env
  );
  assert.equal(existsSync(join(home, "runtime", "leader-failures", "task-1.json")), false);
});

test("coalesces one-off review and recurring schedule firings without reopening the task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Run the daily deployment check"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "schedule", "set", "task-1",
      "--inactivity-minutes", "999999",
      "--cooldown-minutes", "30",
      "--review-at", "2020-01-01T00:00:00.000Z",
      "--every-minutes", "1440",
      "--next-at", "2020-01-01T00:00:00.000Z"
    ],
    { TASKMUX_HOME: home }
  );

  const firstScan = runTaskmux(["controller", "scan"], { TASKMUX_HOME: home });
  const wakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );
  const schedule = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "schedule.json"), "utf8")
  );
  const task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));

  assert.match(firstScan, /Queued 1 task wakeup/);
  assert.deepEqual(wakeup.reasons, ["review-time", "schedule"]);
  assert.equal(schedule.reviewAt, undefined);
  assert.ok(Date.parse(schedule.recurring.nextAt) > Date.now());
  assert.equal(task.archived, false);
  assert.match(runTaskmux(["controller", "scan"], { TASKMUX_HOME: home }), /Queued 0 task wakeups/);
});

test("persists the leader brief and curated milestones in user-readable files", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Modernize deployment"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "brief", "update", "task-1",
      "--objective", "Make deployments repeatable",
      "--boundary", "Do not change the cloud provider",
      "--focus", "Canary verification",
      "--leader-summary", "The release pipeline works; rollback is still manual."
    ],
    { TASKMUX_HOME: home }
  );
  const milestoneOutput = runTaskmux(
    [
      "task", "milestone", "add", "task-1",
      "--title", "Canary pipeline verified",
      "--summary", "The canary environment now deploys and rolls back cleanly.",
      "--topic", "deployment",
      "--topic", "testing"
    ],
    { TASKMUX_HOME: home }
  );
  const brief = readFileSync(join(home, "tasks", "task-1", "brief.md"), "utf8");
  const timeline = readFileSync(join(home, "tasks", "task-1", "timeline.md"), "utf8");
  const milestone = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "milestones", "milestone-1.json"), "utf8")
  );
  const context = JSON.parse(
    runTaskmux(["task", "context", "task-1", "--format", "json"], { TASKMUX_HOME: home })
  );

  assert.match(brief, /## Objective\n\nMake deployments repeatable/);
  assert.match(brief, /## Current focus\n\nCanary verification/);
  assert.match(milestoneOutput, /Added milestone milestone-1/);
  assert.deepEqual(milestone.topics, ["deployment", "testing"]);
  assert.match(timeline, /Canary pipeline verified/);
  assert.match(timeline, /The canary environment now deploys/);
  assert.match(context.brief, /Make deployments repeatable/);
  assert.deepEqual(context.topics.builtIn.map((topic) => topic.id).slice(0, 2), ["requirements", "architecture"]);
});

test("records and supersedes durable decisions with Topic associations", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Choose a deployment strategy"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "decision", "record", "task-1",
      "--title", "Use canary deployment",
      "--rationale", "Canary limits rollback impact while preserving feedback speed.",
      "--topic", "architecture", "--topic", "deployment"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task", "decision", "supersede", "task-1", "decision-1",
      "--reason", "The platform now provides native blue-green routing."
    ],
    { TASKMUX_HOME: home }
  );

  const context = JSON.parse(
    runTaskmux(["task", "context", "task-1", "--format", "json"], { TASKMUX_HOME: home })
  );
  const timeline = readFileSync(join(home, "tasks", "task-1", "timeline.md"), "utf8");

  assert.equal(context.decisions[0].id, "decision-1");
  assert.equal(context.decisions[0].status, "superseded");
  assert.deepEqual(context.decisions[0].topics, ["architecture", "deployment"]);
  assert.match(context.decisions[0].supersededReason, /blue-green/);
  assert.match(timeline, /Use canary deployment/);
});

test("shows durable focus and finite progress on the task board", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Track release progress"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "brief", "update", "task-1",
      "--objective", "Ship safely",
      "--focus", "Canary validation",
      "--leader-summary", "Preparing the first canary"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "work-item", "create", "task-1", "--title", "Run canary"],
    { TASKMUX_HOME: home }
  );

  const board = runTaskmux(["task", "board", "--with-roles"], { TASKMUX_HOME: home });
  assert.match(board, /focus=Canary validation/);
  assert.match(board, /work pending=1/);
});
