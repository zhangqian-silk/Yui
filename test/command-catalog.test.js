import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

function leaf(name, path = ["taskmux", name]) {
  return {
    name,
    path,
    summary: name,
    kind: "leaf",
    usage: [path.join(" ")],
    hidden: false,
    sections: [],
    options: [],
    optionValues: {},
    argumentValues: {},
    fileOptions: [],
    fileArguments: [],
    executableOptions: [],
    commandPathArguments: false,
    values: [],
    children: []
  };
}

function rootWith(children, sections) {
  return {
    name: "taskmux",
    path: ["taskmux"],
    summary: "root",
    kind: "group",
    usage: ["taskmux"],
    hidden: false,
    sections,
    options: [],
    optionValues: {},
    argumentValues: {},
    fileOptions: [],
    fileArguments: [],
    executableOptions: [],
    commandPathArguments: false,
    values: [],
    children
  };
}

test("catalog validation rejects duplicate sibling command names", async () => {
  const catalog = await import("../dist/cli/commandCatalog.js");
  assert.equal(typeof catalog.validateCommandCatalog, "function");

  const duplicate = rootWith(
    [leaf("same"), { ...leaf("same"), summary: "two" }],
    [{ id: "main", title: "Main", entries: ["same", "same"] }]
  );

  assert.throws(() => catalog.validateCommandCatalog(duplicate), /Duplicate command path: taskmux same/);
});

test("catalog validation rejects missing, unknown, and ambiguously ordered section entries", async () => {
  const { validateCommandCatalog } = await import("../dist/cli/commandCatalog.js");
  const one = leaf("one");
  const two = leaf("two");

  assert.throws(
    () => validateCommandCatalog(rootWith([one], [])),
    /missing from command sections: taskmux one/i
  );
  assert.throws(
    () => validateCommandCatalog(rootWith([one], [{ id: "main", title: "Main", entries: ["missing"] }])),
    /unknown section entry: taskmux missing/i
  );
  assert.throws(
    () => validateCommandCatalog(rootWith([one, two], [
      { id: "main", title: "Main", entries: ["one"] },
      { id: "later", title: "Later", entries: ["one", "two"] }
    ])),
    /duplicate section entry: taskmux one/i
  );
  assert.throws(
    () => validateCommandCatalog(rootWith([one], [
      { id: "main", title: "Main", entries: ["one"] },
      { id: "main", title: "Again", entries: [] }
    ])),
    /duplicate command section: taskmux main/i
  );
});

test("catalog validation rejects duplicate tokens and removed alias surfaces", async () => {
  const { validateCommandCatalog } = await import("../dist/cli/commandCatalog.js");
  const commandAndValue = rootWith(
    [leaf("same")],
    [{ id: "main", title: "Main", entries: ["same"] }]
  );
  commandAndValue.values = [{ name: "same", summary: "same value", section: "main" }];

  assert.throws(() => validateCommandCatalog(commandAndValue), /duplicate command token: taskmux same/i);

  for (const alias of ["-h", "--help", "-v", "--version"]) {
    const catalog = rootWith([], []);
    catalog.options = [alias];
    assert.throws(() => validateCommandCatalog(catalog), /reserved alias token/i, alias);
  }
});

test("catalog validation rejects ambiguous completion ownership", async () => {
  const { validateCommandCatalog } = await import("../dist/cli/commandCatalog.js");
  const catalog = rootWith([], []);
  catalog.options = ["--target"];

  catalog.fileOptions = ["--target", "--target"];
  assert.throws(() => validateCommandCatalog(catalog), /duplicate file completion option/i);

  catalog.fileOptions = [];
  catalog.executableOptions = ["--target", "--target"];
  assert.throws(() => validateCommandCatalog(catalog), /duplicate executable completion option/i);

  catalog.executableOptions = ["--target"];
  catalog.optionValues = { "--target": ["one"] };
  assert.throws(() => validateCommandCatalog(catalog), /multiple completion owners.*--target/i);

  catalog.optionValues = {};
  catalog.fileOptions = ["--target"];
  assert.throws(() => validateCommandCatalog(catalog), /multiple completion owners.*--target/i);

  catalog.fileOptions = [];
  catalog.executableOptions = [];
  catalog.argumentValues = { 0: ["one"] };
  catalog.fileArguments = [0];
  assert.throws(() => validateCommandCatalog(catalog), /multiple completion owners.*argument 0/i);
});

test("catalog validation rejects empty enum metadata", async () => {
  const { validateCommandCatalog } = await import("../dist/cli/commandCatalog.js");

  const emptyName = rootWith([], [{ id: "values", title: "Values", entries: [""] }]);
  emptyName.values = [{ name: "", summary: "value" }];
  assert.throws(() => validateCommandCatalog(emptyName), /command value name is required/i);

  const emptySummary = rootWith([], [{ id: "values", title: "Values", entries: ["one"] }]);
  emptySummary.values = [{ name: "one", summary: "" }];
  assert.throws(() => validateCommandCatalog(emptySummary), /command value summary is required.*one/i);

  const optionEnum = rootWith([], []);
  optionEnum.options = ["--kind"];
  optionEnum.optionValues = { "--kind": [""] };
  assert.throws(() => validateCommandCatalog(optionEnum), /empty option value.*--kind/i);

  const argumentEnum = rootWith([], []);
  argumentEnum.argumentValues = { 0: [""] };
  assert.throws(() => validateCommandCatalog(argumentEnum), /empty argument value.*argument 0/i);
});

test("catalog validation permits only one command-path provider", async () => {
  const { validateCommandCatalog } = await import("../dist/cli/commandCatalog.js");
  const first = { ...leaf("first"), commandPathArguments: true };
  const second = { ...leaf("second"), commandPathArguments: true };
  const catalog = rootWith(
    [first, second],
    [{ id: "main", title: "Main", entries: ["first", "second"] }]
  );

  assert.throws(() => validateCommandCatalog(catalog), /multiple command-path providers.*taskmux/i);
});

test("catalog declares stable semantic sections for every command group", async () => {
  const { ROOT_COMMAND } = await import("../dist/cli/commandCatalog.js");
  assert.deepEqual(ROOT_COMMAND.sections.map(({ id, title }) => ({ id, title })), [
    { id: "workflow", title: "Workflow" },
    { id: "configuration", title: "Configuration" },
    { id: "operations", title: "Operations" },
    { id: "data", title: "Data" },
    { id: "support", title: "Support" }
  ]);

  const visit = (node) => {
    if (node.children.length > 0 || node.values.length > 0) {
      assert.ok(node.sections.length > 0, `${node.path.join(" ")} has no semantic sections`);
    }
    node.children.forEach(visit);
  };
  visit(ROOT_COMMAND);
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
