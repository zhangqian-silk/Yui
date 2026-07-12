import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("catalog validation rejects duplicate sibling command names", async () => {
  const catalog = await import("../dist/cli/commandCatalog.js");
  assert.equal(typeof catalog.validateCommandCatalog, "function");

  const duplicate = {
    name: "taskmux",
    path: ["taskmux"],
    summary: "root",
    kind: "group",
    usage: ["taskmux"],
    hidden: false,
    options: [],
    children: [
      { name: "same", path: ["taskmux", "same"], summary: "one", kind: "leaf", usage: ["taskmux same"], hidden: false, options: [], children: [] },
      { name: "same", path: ["taskmux", "same"], summary: "two", kind: "leaf", usage: ["taskmux same"], hidden: false, options: [], children: [] }
    ]
  };

  assert.throws(() => catalog.validateCommandCatalog(duplicate), /Duplicate command path: taskmux same/);
});

test("catalog covers every public root, group, nested, and leaf path", async () => {
  const { listPublicCommandPaths, ROOT_COMMAND } = await import("../dist/cli/commandCatalog.js");
  const paths = new Set(listPublicCommandPaths());
  const required = [
    "help", "version", "update", "completion", "doctor", "setup", "backup", "export", "import", "prune", "operator",
    "controller", "controller start", "controller status", "controller stop", "controller scan",
    "config", "config show", "config set", "config set default-agent", "config set default-workspace", "config unset", "config unset default-agent", "config unset default-workspace",
    "agent", "agent add", "agent list", "agent show", "agent remove",
    "role", "role add", "role list", "role show", "role update", "role remove", "role enter",
    "task", "task create", "task update", "task list", "task board", "task show", "task current", "task last", "task clone", "task archive", "task unarchive", "task open", "task context", "task delete", "task restore", "task shell", "task assign", "task bind", "task assign-many", "task roles", "task enter", "task tail", "task detail", "task status", "task refresh", "task transcript", "task transcript export", "task activity", "task timeline", "task detach", "task stop", "task kill", "task restart", "task cleanup", "task comment", "task comments", "task events", "task wake", "task dispatch", "task yield",
    "task role", "task role child", "task role update", "task role rename", "task role remove",
    "task topic", "task topic create", "task topic list", "task topic summarize",
    "task input", "task input draft", "task input submit",
    "task cycle", "task cycle create", "task cycle end",
    "task work-item", "task work-item create", "task work-item update",
    "task session", "task session record", "task session replace",
    "task schedule", "task schedule set", "task brief", "task brief update", "task milestone", "task milestone add",
    "task decision", "task decision record", "task decision supersede", "task worktree", "task worktree create"
  ];

  for (const path of required) {
    assert.equal(paths.has(path), true, `missing catalog path: ${path}`);
  }
  assert.equal(paths.has("controller serve"), false);
  assert.equal(paths.has("assistant"), false);
  assert.equal(Object.isFrozen(ROOT_COMMAND), true);
});

test("catalog is the only rendered command-help source", () => {
  const sources = [
    "src/cli.ts",
    "src/commands/agentCommands.ts",
    "src/commands/configCommands.ts",
    "src/commands/globalRoleCommands.ts",
    "src/commands/taskCommands.ts"
  ].map((path) => readFileSync(path, "utf8")).join("\n");

  assert.doesNotMatch(sources, /const usage = `TaskMux/);
  assert.doesNotMatch(sources, /function (?:taskUsage|agentUsage|configUsage|globalRoleUsage)\(/);
});
