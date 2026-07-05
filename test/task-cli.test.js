import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});

function runTaskmux(args, env) {
  return execFileSync("node", [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

function runTaskmuxFailure(args, env) {
  return spawnSync("node", [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

function runTaskmuxInteractive(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
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
  return runTaskmux(["runner", "add", id, "--command", command], {
    TASKMUX_HOME: home
  });
}

function addAgent(home, id, command = id) {
  return runTaskmux(["agent", "add", id, "--command", command], {
    TASKMUX_HOME: home
  });
}

function createTaskmuxHome() {
  return mkdtempSync(join(tmpdir(), "taskmux-test-"));
}

function createConfiguredHome() {
  const home = createTaskmuxHome();

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
  assert.equal(task.status, "open");
  assert.equal(task.title, undefined);
  assert.equal(taskInfo.schemaVersion, 1);
  assert.equal(taskInfo.title, "Refactor login page");
});

test("creates tasks with the built-in owner role from configured runner defaults", () => {
  const home = createConfiguredHome();
  const ownerCli = createFakeExecutable(home, "owner-agent.js", "owner agent 1.0\n");

  addRunner(home, "owner-cli", ownerCli);
  runTaskmux(["config", "set", "default-agent", "owner-cli"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "create", "Ownable task"], {
    TASKMUX_HOME: home
  });
  const roles = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Assigned roles: owner/);
  assert.match(roles, /owner\towner-cli\tidle\t\/tmp\/project-a/);
});

test("requires an owner role runner before creating a task", () => {
  const home = createTaskmuxHome();

  const result = runTaskmuxFailure(["task", "create", "Missing owner runner"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Role owner requires an agent or a configured global role/);
  assert.match(result.stderr, /taskmux role add owner --agent <agent-id>/);
});

test("initializes the latest storage schema manifest on first startup", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const schema = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));

  assert.equal(schema.schemaVersion, 1);
  assert.equal(schema.storageVersion, 1);
  assert.equal(typeof schema.updatedAt, "string");
});

test("blocks normal commands when storage schema requires migration", () => {
  const home = createConfiguredHome();
  writeStorageSchema(home, 0);

  const result = runTaskmuxFailure(["task", "list"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Storage schema upgrade required: 0 -> 1/);
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

  assert.match(output, /Migrated storage schema 0 -> 1/);
  assert.match(output, /Backup: /);
  assert.ok(backupPath);
  assert.equal(JSON.parse(readFileSync(join(backupPath, "schema.json"), "utf8")).storageVersion, 0);
  assert.equal(schema.schemaVersion, 1);
  assert.equal(schema.storageVersion, 1);
  assert.equal(typeof schema.updatedAt, "string");
  assert.match(
    runTaskmux(["task", "list"], { TASKMUX_HOME: home }),
    /No tasks found/
  );
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
  assert.equal(JSON.parse(readFileSync(join(backupPath, "schema.json"), "utf8")).storageVersion, 1);
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
  assert.match(runTaskmux(["task", "roles", "task-1"], { TASKMUX_HOME: targetHome }), /rd\tcodex/);
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

  assert.match(output, /Storage migration dry run 0 -> 1/);
  assert.match(output, /Backup would be created/);
  assert.match(readFileSync(join(home, "schema.json"), "utf8"), /"storageVersion":0/);
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
  assert.match(listOutput, /task-1\s+open\s+Edited task title/);
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
      "--owner",
      "alex",
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
  assert.equal(taskInfo.owner, "alex");
  assert.equal(taskInfo.dueAt, "2026-07-01");
  assert.match(showOutput, /Description: Update the auth form/);
  assert.match(showOutput, /Priority: high/);
  assert.match(showOutput, /Tags: frontend, auth/);
  assert.match(showOutput, /Owner: alex/);
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
  assert.match(output, /Assigned roles: owner, rd, reviewer/);

  const task = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(task, /Priority: medium/);
  assert.match(task, /Tags: feature/);

  const roles = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(roles, /owner\tcodex\tidle\t\/tmp\/project-a/);
  assert.match(roles, /rd\tcodex\tidle\t\/tmp\/project-a/);
  assert.match(roles, /reviewer\tcodex\tidle\t\/tmp\/project-a/);

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

  assert.match(runTaskmux(["task", "last"], { TASKMUX_HOME: home }), /task-2\tSecond task/);

  const setCurrent = runTaskmux(["task", "current", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(setCurrent, /Current task: task-1/);
  assert.match(runTaskmux(["task", "current"], { TASKMUX_HOME: home }), /task-1\tFirst task/);
});

test("clones tasks with metadata and roles", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Original task", "--priority", "high", "--tag", "frontend", "--owner", "alex"], {
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
  assert.match(task, /Owner: alex/);

  const roles = runTaskmux(["task", "roles", "task-2"], {
    TASKMUX_HOME: home
  });
  assert.match(roles, /rd\tcodex\tidle\t\/tmp\/project-a/);
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
      "--owner",
      "maya",
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
  assert.match(showOutput, /Owner: maya/);
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
      "--owner",
      "alex",
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
      "--clear-owner",
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
  assert.equal(taskInfo.owner, undefined);
  assert.equal(taskInfo.dueAt, undefined);
  assert.doesNotMatch(showOutput, /Description:/);
  assert.doesNotMatch(showOutput, /Priority:/);
  assert.doesNotMatch(showOutput, /Tags:/);
  assert.doesNotMatch(showOutput, /Owner:/);
  assert.doesNotMatch(showOutput, /Due:/);
});

test("filters and searches tasks on board metadata", () => {
  const home = createConfiguredHome();

  runTaskmux(
    ["task", "create", "Refactor login page", "--tag", "frontend", "--owner", "alex", "--priority", "high"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Write release docs", "--tag", "docs", "--owner", "maya", "--priority", "medium"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Fix auth token bug", "--tag", "backend", "--owner", "alex", "--priority", "urgent"],
    { TASKMUX_HOME: home }
  );

  const ownerOutput = runTaskmux(["task", "list", "--owner", "alex"], { TASKMUX_HOME: home });
  const tagOutput = runTaskmux(["task", "list", "--tag", "docs"], { TASKMUX_HOME: home });
  const priorityOutput = runTaskmux(["task", "list", "--priority", "urgent"], { TASKMUX_HOME: home });
  const searchOutput = runTaskmux(["task", "list", "--search", "release"], { TASKMUX_HOME: home });

  assert.match(ownerOutput, /Refactor login page/);
  assert.match(ownerOutput, /Fix auth token bug/);
  assert.doesNotMatch(ownerOutput, /Write release docs/);
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
    ["task", "create", "Plan checkout work", "--tag", "frontend", "--owner", "alex", "--priority", "high"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Implement checkout work", "--tag", "frontend", "--owner", "alex", "--priority", "urgent"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Write rollout notes", "--tag", "docs", "--owner", "maya", "--priority", "medium"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "start", "task-2"], { TASKMUX_HOME: home });
  runTaskmux(["task", "done", "task-3"], { TASKMUX_HOME: home });

  const output = runTaskmux(["task", "board", "--owner", "alex"], { TASKMUX_HOME: home });

  assert.match(output, /Open/);
  assert.match(output, /task-1\s+Plan checkout work\s+priority=high owner=alex tags=frontend/);
  assert.match(output, /Active/);
  assert.match(output, /task-2\s+Implement checkout work\s+priority=urgent owner=alex tags=frontend/);
  assert.match(output, /Done/);
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
  runTaskmux(["task", "start", "task-1"], { TASKMUX_HOME: home });

  const output = runTaskmux(["task", "board", "--with-roles"], { TASKMUX_HOME: home });

  assert.match(output, /task-1\s+Coordinate checkout flow\s+roles idle=3/);
});

test("deletes and restores tasks without losing task data", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page", "--owner", "alex"], {
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
  assert.match(showOutput, /Owner: alex/);
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

  assert.match(output, /task-1\s+open\s+First task/);
  assert.match(output, /task-2\s+open\s+Second task/);
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
  assert.match(output, /Status: open/);
});

test("updates task lifecycle status", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });

  assert.match(
    runTaskmux(["task", "start", "task-1"], { TASKMUX_HOME: home }),
    /Started task task-1/
  );
  assert.match(
    runTaskmux(["task", "done", "task-1"], { TASKMUX_HOME: home }),
    /Completed task task-1/
  );
  assert.match(
    runTaskmux(["task", "archive", "task-1"], { TASKMUX_HOME: home }),
    /Archived task task-1/
  );
  assert.match(
    runTaskmux(["task", "reopen", "task-1"], { TASKMUX_HOME: home }),
    /Reopened task task-1/
  );

  const task = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8")
  );
  assert.equal(task.status, "open");
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
  assert.match(roles, /rd\tcodex\tidle\t\/tmp\/project-a/);
  assert.match(roles, /reviewer\tcodex\tidle\t\/tmp\/project-a/);
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

  assert.match(rolesOutput, /engineer\s+codex\s+idle\s+\/tmp\/project-a/);
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

  assert.match(output, /rd\s+codex\s+idle\s+\/tmp\/project-a/);
  assert.match(output, /reviewer\s+claude\s+idle\s+\/tmp\/project-a/);
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
  assert.match(rolesOutput, /developer\s+codex\s+idle\s+\/tmp\/project-a/);
  assert.doesNotMatch(rolesOutput, /rd\s+codex/);
  assert.deepEqual(calls[0], ["rename-window", "-t", "taskmux-task-1:rd", "developer"]);
});

test("rejects renaming the built-in owner role", () => {
  const home = createConfiguredHome();
  const ownerCli = createFakeExecutable(home, "owner-agent.js", "owner agent 1.0\n");

  addRunner(home, "owner-cli", ownerCli);
  runTaskmux(["task", "create", "Refactor login page", "--agent", "owner-cli", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(["task", "role", "rename", "task-1", "owner", "developer"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Built-in owner role cannot be renamed/);
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
  assert.match(activity, /reviewer\tclaude\tidle\ttranscriptLines=1/);

  const timeline = runTaskmux(["task", "timeline", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(timeline, /task.created/);
  assert.match(timeline, /role.assigned/);
  assert.match(timeline, /comment\tcomment-1\tReady for review/);
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
      "--owner",
      "alex",
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
  runTaskmux(["task", "start", "task-1"], { TASKMUX_HOME: home });
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
  assert.match(output, /Owner: alex/);
  assert.match(output, /Due: 2026-07-01/);
  assert.match(output, /Roles/);
  assert.match(output, /rd\s+codex\s+idle\s+\/tmp\/project-a/);
  assert.match(output, /Comments/);
  assert.match(output, /comment-1\s+Keep old session compatibility\./);
  assert.match(output, /Events/);
  assert.match(output, /task.created/);
  assert.match(output, /task.status_changed/);
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
    TASKMUX_HOME: home
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
  assert.match(output, /rd\s+running/);
  assert.match(output, /reviewer\s+exited/);

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
  assert.match(output, /rd\s+exited/);

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
  runTaskmux(["task", "start", "task-1"], {
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
  assert.deepEqual(events[1].payload, { role: "owner", agent: "codex" });
  assert.equal(events[2].type, "task.status_changed");
  assert.deepEqual(events[2].payload, { from: "open", to: "active" });
  assert.equal(events[3].type, "role.assigned");
  assert.deepEqual(events[3].payload, { role: "rd", agent: "codex" });
  assert.equal(events[4].type, "comment.added");
  assert.deepEqual(events[4].payload, { comment: "comment-1" });

  const output = runTaskmux(["task", "events", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /event-1\s+.+\s+task\.created\s+title=Refactor login page/);
  assert.match(output, /event-2\s+.+\s+role\.assigned\s+role=owner agent=codex/);
  assert.match(output, /event-3\s+.+\s+task\.status_changed\s+from=open to=active/);
  assert.match(output, /event-4\s+.+\s+role\.assigned\s+role=rd agent=codex/);
  assert.match(output, /event-5\s+.+\s+comment\.added\s+comment=comment-1/);
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
  assert.match(listOutput, new RegExp(`agent-js\\s+custom\\s+${fakeAgent.replaceAll("\\", "\\\\")}`));

  const showOutput = runTaskmux(["runner", "show", "agent-js"], { TASKMUX_HOME: home });
  assert.match(showOutput, /Runner: agent-js/);
  assert.match(showOutput, new RegExp(`Command: ${fakeAgent.replaceAll("\\", "\\\\")}`));
  assert.match(showOutput, /Args: --model review/);
  assert.match(showOutput, /Env: TASKMUX_MODE=dev/);
});

test("does not expose codex or claude as default runners", () => {
  const home = createTaskmuxHome();

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

  const addOutput = runTaskmux(
    ["agent", "add", "agent-js", "--command", fakeAgent, "--arg", "--model", "--arg", "review", "--env", "TASKMUX_MODE=dev"],
    { TASKMUX_HOME: home }
  );

  assert.match(addOutput, /Added agent agent-js/);

  const listOutput = runTaskmux(["agent", "list"], { TASKMUX_HOME: home });
  assert.match(listOutput, new RegExp(`agent-js\\s+custom\\s+${fakeAgent.replaceAll("\\", "\\\\")} --model review`));

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

test("renders the agent and role board", () => {
  const home = createTaskmuxHome();
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");

  addAgent(home, "codex", fakeAgent);
  runTaskmux(["role", "add", "owner", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["board"], { TASKMUX_HOME: home });

  assert.match(output, /TaskMux board/);
  assert.match(output, /Agents/);
  assert.match(output, new RegExp(`codex\\s+${fakeAgent.replaceAll("\\", "\\\\")}`));
  assert.match(output, /Roles/);
  assert.match(output, /assistant\s+\?\s+\?\s+system:global user-facing assistant/);
  assert.match(output, /owner\s+codex\s+\/tmp\/project-a/);
});

test("protects system roles and shows missing system role agents as question marks", () => {
  const home = createTaskmuxHome();

  const listOutput = runTaskmux(["role", "list"], { TASKMUX_HOME: home });
  assert.match(listOutput, /assistant\s+\?\s+\?\s+system:global user-facing assistant/);
  assert.match(listOutput, /owner\s+\?\s+\?\s+system:task owner and role scheduler/);

  const showOutput = runTaskmux(["role", "show", "assistant"], { TASKMUX_HOME: home });
  assert.match(showOutput, /Role: assistant/);
  assert.match(showOutput, /Agent: \?/);

  const assistantRemove = runTaskmuxFailure(["role", "remove", "assistant"], { TASKMUX_HOME: home });
  assert.equal(assistantRemove.status, 2);
  assert.match(assistantRemove.stderr, /USAGE_ERROR: System role cannot be removed: assistant/);

  const ownerRemove = runTaskmuxFailure(["role", "remove", "owner"], { TASKMUX_HOME: home });
  assert.equal(ownerRemove.status, 2);
  assert.match(ownerRemove.stderr, /USAGE_ERROR: System role cannot be removed: owner/);
});

test("enters the system assistant role through its configured agent", () => {
  const home = createTaskmuxHome();
  const assistantAgent = createFakeExecutable(home, "assistant-agent.js", "assistant ready\\n");

  addAgent(home, "assistant-agent", assistantAgent);
  runTaskmux(["role", "add", "assistant", "--agent", "assistant-agent", "--workspace", home], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["role", "enter", "assistant"], { TASKMUX_HOME: home });

  assert.match(output, /assistant ready/);
  assert.match(output, /Exited role assistant/);
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
  assert.match(output, tableRowRegex("storage schema", "ok", "current=1 latest=1"));
  assert.match(output, tableRowRegex("storage permissions", "ok", "read-write"));
  assert.match(output, tableRowRegex("storage records", "ok", "tasks=0 roles=0 globalRoles=0 agents=1"));
  assert.match(output, new RegExp(home.replaceAll("\\", "\\\\")));
});

test("doctor reports missing default agent", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("default agent", "missing", "run taskmux setup"));
});

test("doctor guides users when storage schema needs migration", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  writeStorageSchema(home, 0);

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("storage schema", "upgrade-required", "current=0 latest=1; run taskmux migrate"));
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
  const fakeAgent = createFakeExecutable(home, "owner-agent.js", "owner agent 1.0\n");

  addRunner(home, "owner-cli", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "owner-cli"], {
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
  assert.match(output, tableRowRegex("agent:owner-cli", "ok", "owner agent 1\\.0"));
  assert.match(output, /TaskMux dashboard/);
  assert.match(output, /Current task: task-1\s+Dashboard task/);
  assert.match(output, /Board/);
  assert.match(output, /task-1\s+Dashboard task\s+roles idle=1/);
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

test("setup prints a tmux install plan without changing the system", () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  createPathExecutable(fakeBin, "apt-get", "process.stdout.write('apt 2.0\\n');");

  const output = runTaskmux(["setup"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: join(home, "missing-tmux"),
    PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
  });

  assert.match(output, /TaskMux setup/);
  assert.match(output, /\|\s+Item\s+\|\s+Status\s+\|\s+Detail\s+\|/);
  assert.match(output, tableRowRegex("tmux", "missing", "install with apt-get"));
  assert.match(output, tableRowRegex("tmux", "plan", "(sudo )?apt-get update"));
  assert.match(output, tableRowRegex("tmux", "plan", "(sudo )?apt-get install -y tmux"));
  assert.match(output, /taskmux setup --yes/);
});

test("setup reports missing required config in non-interactive mode", () => {
  const home = createTaskmuxHome();

  const output = runTaskmux(["setup"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: join(home, "missing-tmux")
  });

  assert.match(output, tableRowRegex("config", "mode", "non-interactive"));
  assert.match(output, tableRowRegex("config", "next", "Run taskmux setup in an interactive terminal to configure"));
  assert.match(output, tableRowRegex("config", "missing", "Run taskmux setup\\."));
  assert.doesNotMatch(output, tableRowRegex("default-workspace", "missing"));
  assert.match(output, tableRowRegex("assistant", "pending", "agent=\\?"));
  assert.match(output, tableRowRegex("owner", "pending", "agent=\\?"));
});

test("setup interactively selects a default agent from numbered candidates", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  createPathExecutable(fakeBin, "codex", "process.stdout.write('codex 1.0\\n');");

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\n/tmp/setup-workspace\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: process.execPath,
      PATH: fakeBin
    }
  );

  assert.match(output, /Default agent candidates/i);
  assert.match(output, /\|\s+#\s+\|\s+Agent\s+\|\s+Command\s+\|\s+Status\s+\|/i);
  assert.match(output, /\|\s+1\s+\|\s+codex\s+\|\s+codex\s+\|\s+installed\s+\|/i);
  assert.match(output, /\|\s+\d+\s+\|\s+claude\s+\|\s+claude\s+\|\s+missing\s+\|/i);
  assert.match(output, /\|\s+\d+\s+\|\s+gemini\s+\|\s+gemini\s+\|\s+missing\s+\|/i);
  assert.match(output, /\|\s+\d+\s+\|\s+qwen\s+\|\s+qwen\s+\|\s+missing\s+\|/i);
  assert.doesNotMatch(output, /Default agent id/);
  assert.doesNotMatch(output, /Command for agent/);
  assert.match(output, /Default workspace \[/);
  assert.match(output, tableRowRegex("config", "mode", "interactive"));
  assert.match(output, tableRowRegex("agent", "configured", "codex command=codex; found in PATH"));
  assert.match(output, tableRowRegex("config", "configured", "agent=codex workspace=\\/tmp\\/setup-workspace"));
  assert.doesNotMatch(output, tableRowRegex("default-agent", "configured"));
  assert.match(output, tableRowRegex("assistant", "configured", "agent=codex workspace=\\/tmp\\/setup-workspace"));
  assert.match(output, tableRowRegex("owner", "configured", "agent=codex workspace=\\/tmp\\/setup-workspace"));

  const config = runTaskmux(["config", "show"], { TASKMUX_HOME: home });
  const agent = runTaskmux(["agent", "show", "codex"], { TASKMUX_HOME: home });
  const board = runTaskmux(["board"], { TASKMUX_HOME: home });

  assert.match(config, /Default agent: codex/);
  assert.match(config, /Default workspace: \/tmp\/setup-workspace/);
  assert.match(agent, /Agent: codex/);
  assert.match(agent, /Command: codex/);
  assert.match(board, /assistant\s+codex\s+\/tmp\/setup-workspace/);
  assert.match(board, /owner\s+codex\s+\/tmp\/setup-workspace/);
});

test("setup configures system roles from the default agent", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "default-agent.js", "default agent 1.0\n");

  addAgent(home, "default-agent", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "default-agent"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", "/tmp/system-workspace"], { TASKMUX_HOME: home });

  const output = runTaskmux(["setup"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });
  const board = runTaskmux(["board"], { TASKMUX_HOME: home });

  assert.match(output, tableRowRegex("assistant", "configured", "agent=default-agent workspace=\\/tmp\\/system-workspace"));
  assert.match(output, tableRowRegex("owner", "configured", "agent=default-agent workspace=\\/tmp\\/system-workspace"));
  assert.doesNotMatch(output, tableRowRegex("default-agent", "ok", "default-agent"));
  assert.match(board, /assistant\s+default-agent\s+\/tmp\/system-workspace/);
  assert.match(board, /owner\s+default-agent\s+\/tmp\/system-workspace/);
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
    "\n\n",
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
  assert.match(output, /Default workspace \[\/tmp\/existing-workspace\]: /);
  assert.match(output, tableRowRegex("agent", "ok", "codex command=codex; found in PATH"));
  assert.match(output, tableRowRegex("config", "configured", "agent=codex workspace=\\/tmp\\/existing-workspace"));
  assert.doesNotMatch(output, tableRowRegex("default-agent", "configured"));
  assert.match(output, tableRowRegex("tmux", "ok", "already installed"));
  assert.match(config, /Default agent: codex/);
  assert.match(config, /Default workspace: \/tmp\/existing-workspace/);
});

test("setup --yes installs tmux through the detected package manager", () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  const logFile = join(home, "setup.log");
  const installedMarker = join(home, "tmux-installed");
  const fakeTmux = join(home, "tmux");
  mkdirSync(fakeBin);

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
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args.join(" ") === "apt-get install -y tmux") writeFileSync(${JSON.stringify(installedMarker)}, "ok\\n");
`
  );

  const output = runTaskmux(["setup", "--yes"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
  });
  const log = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

  assert.match(output, /TaskMux setup/);
  assert.match(output, tableRowRegex("tmux", "ok", "installed"));
  assert.deepEqual(log, [
    ["apt-get", "update"],
    ["apt-get", "install", "-y", "tmux"]
  ]);
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
    "summary\nupdate --priority high --owner shell-owner\nsummary\nr\ncomment hello from shell\nc\ne\na\nt\ncontext\nq\n",
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Task: task-1/);
  assert.match(output, /taskmux task-1>/);
  assert.match(output, /Updated task task-1/);
  assert.match(output, /Priority: high/);
  assert.match(output, /Owner: shell-owner/);
  assert.match(output, /rd\s+codex\s+idle\s+\/tmp\/project-a/);
  assert.match(output, /Added comment to task-1: hello from shell/);
  assert.match(output, /hello from shell/);
  assert.match(output, /task\.created/);
  assert.match(output, /role\.assigned/);
  assert.match(output, /comment\.added/);
  assert.match(output, /Task activity: task-1/);
  assert.match(output, /Task timeline: task-1/);
  assert.match(output, /Task Context/);
});
