import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "cli.js");
const scriptSupport = detectScriptSupport();
const ptyTest = scriptSupport === null
  ? { skip: "compatible util-linux script is unavailable" }
  : { timeout: 10_000 };

test("agent show selects the configured agent in a real terminal", ptyTest, () => {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);

  const result = runInTerminal(["agent", "show"], "\n", home);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Select agent/);
  assert.match(result.output, /\|\s+1\s+\|\s+codex\s+\|/);
  assert.match(result.output, /Agent: codex/);
});

test("agent remove asks for a default-No confirmation after interactive selection", ptyTest, () => {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);

  const cancelled = runInTerminal(["agent", "remove"], "\n\n", home);

  assert.equal(cancelled.status, 0, cancelled.output);
  assert.match(cancelled.output, /Remove agent codex\? \[y\/N\]:/);
  assert.match(cancelled.output, /Cancelled\./);
  assert.match(run(["agent", "show", "codex"], home), /Agent: codex/);
});

test("task detail resolves Task then TaskRole through dependent terminal selections", ptyTest, async () => {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);
  run(["config", "set", "default-agent", "codex"], home);
  run(["config", "set", "default-workspace", home], home);
  run(["task", "create", "Interactive task"], home);

  const result = await runInTerminalSteps(
    ["task", "detail"],
    [
      { prompt: "Choose task", answer: "1\n" },
      { prompt: "Choose task role", answer: "1\n" }
    ],
    home
  );

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Select task/);
  assert.match(result.output, /Select task role/);
  assert.match(result.output, /Task: task-1/);
  assert.match(result.output, /Role: leader/);
});

test("task environment scope is resolved before dependent role selection", ptyTest, () => {
  const home = createTaskWithLeader();

  const result = runInTerminal(
    ["task", "detail"],
    "1\n",
    home,
    { TASKMUX_TASK_ID: "task-1" }
  );

  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /^Select task$/m);
  assert.match(result.output, /^Select task role: task-1$/m);
  assert.match(result.output, /Role: leader/);
});

test("an invalid explicit Task bypasses dependent selection and keeps the original validator error", ptyTest, () => {
  const home = createTaskWithLeader();

  const result = runInTerminal(["task", "detail", "missing-task"], "", home);

  assert.equal(result.status, 2, result.output);
  assert.doesNotMatch(result.output, /Select task role/);
  assert.match(result.output, /USAGE_ERROR: Role name is required/);
});

test("task assign does not select a Task when the free-form role is missing", ptyTest, () => {
  const home = createTaskWithLeader();

  const result = runInTerminal([
    "task", "assign", "--agent", "codex", "--workspace", home
  ], "", home);

  assert.equal(result.status, 3, result.output);
  assert.doesNotMatch(result.output, /Select task/);
  assert.match(result.output, /TASK_NOT_FOUND: Task not found: --agent/);
});

test("task assign does not repair unknown options into a writable invocation", ptyTest, () => {
  const home = createTaskWithLeader();

  const result = runInTerminal([
    "task", "assign", "task-1", "--bogus", "x", "--workspace", home, "--agent"
  ], "", home);

  assert.equal(result.status, 2, result.output);
  assert.doesNotMatch(result.output, /Select agent/);
  assert.match(result.output, /USAGE_ERROR: Unexpected argument: x/);
  assert.doesNotMatch(run(["task", "roles", "task-1"], home), /--bogus/);
});

test("terminal work item status without an outcome does not start enum selection", ptyTest, () => {
  const home = createTaskWithLeader();
  run(["task", "work-item", "create", "task-1", "--title", "Review"], home);

  const result = runInTerminal([
    "task", "work-item", "update", "task-1", "work-item-1", "--status"
  ], "", home);

  assert.equal(result.status, 2, result.output);
  assert.doesNotMatch(result.output, /Select status/);
  assert.match(result.output, /USAGE_ERROR: --status is required/);
});

test("explicit terminal work item status without an outcome does not start entity selection", ptyTest, () => {
  const home = createTaskWithLeader();
  run(["task", "work-item", "create", "task-1", "--title", "Review"], home);

  const result = runInTerminal([
    "task", "work-item", "update", "task-1", "--status", "completed"
  ], "", home);

  assert.equal(result.status, 2, result.output);
  assert.doesNotMatch(result.output, /Select work item/);
  assert.match(result.output, /USAGE_ERROR: Work item not found: --status/);
});

test("an incomplete free-form option blocks unrelated enum selection", ptyTest, () => {
  const home = createTaskWithLeader();

  const result = runInTerminal([
    "task", "update", "task-1", "--title", "--priority"
  ], "", home);

  assert.equal(result.status, 2, result.output);
  assert.doesNotMatch(result.output, /Select priority/);
  assert.match(result.output, /USAGE_ERROR: --title is required/);
});

test("an invalid explicit dispatch role bypasses work item selection and keeps the original validator error", ptyTest, () => {
  const home = createTaskWithLeader();

  const result = runInTerminal([
    "task", "dispatch", "task-1", "missing-role",
    "--mode", "new", "--work-item", "--input", "review"
  ], "", home);

  assert.equal(result.status, 3, result.output);
  assert.doesNotMatch(result.output, /Select work item|no open work items/i);
  assert.match(result.output, /ROLE_NOT_FOUND: Role not found: missing-role/);
});

test("explicit, non-terminal, and JSON invocations remain deterministic", ptyTest, () => {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);

  const explicit = runInTerminal(["agent", "show", "codex"], "", home);
  assert.equal(explicit.status, 0, explicit.output);
  assert.doesNotMatch(explicit.output, /Select agent/);
  assert.match(explicit.output, /Agent: codex/);

  const nonTerminal = spawnSync(process.execPath, [cli, "agent", "show"], {
    encoding: "utf8",
    env: isolatedEnv(home)
  });
  assert.equal(nonTerminal.status, 2);
  assert.doesNotMatch(`${nonTerminal.stdout}${nonTerminal.stderr}`, /Select agent/);
  assert.match(nonTerminal.stderr, /USAGE_ERROR: Agent id is required/);

  const json = spawnSync(process.execPath, [cli, "agent", "show", "--json"], {
    encoding: "utf8",
    env: isolatedEnv(home)
  });
  assert.equal(json.status, 2);
  assert.doesNotMatch(`${json.stdout}${json.stderr}`, /Select agent/);
  assert.deepEqual(JSON.parse(json.stderr), {
    ok: false,
    code: "USAGE_ERROR",
    message: "Agent id is required.",
    details: {}
  });
});

test("new selector policies preserve explicit, non-terminal, and JSON command behavior", ptyTest, () => {
  const home = createTaskWithLeader();
  createGlobalRole(home, "reviewer");

  for (const [args, expected] of [
    [["config", "set", "default-agent", "codex"], /Set default-agent: codex/],
    [["role", "show", "reviewer"], /Role: reviewer/],
    [["task", "show", "task-1"], /Task: task-1/]
  ]) {
    const explicit = runInTerminal(args, "", home);
    assert.equal(explicit.status, 0, explicit.output);
    assert.doesNotMatch(explicit.output, /^Select /m);
    assert.match(explicit.output, expected);
  }

  for (const [args, expected] of [
    [["config", "set", "default-agent"], /USAGE_ERROR: Config value is required/],
    [["role", "show"], /USAGE_ERROR: Role name is required/],
    [["task", "show"], /USAGE_ERROR: Task id is required/]
  ]) {
    const nonTerminal = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: isolatedEnv(home)
    });
    assert.equal(nonTerminal.status, 2);
    assert.doesNotMatch(`${nonTerminal.stdout}${nonTerminal.stderr}`, /^Select /m);
    assert.match(nonTerminal.stderr, expected);
  }

  const json = spawnSync(process.execPath, [cli, "config", "set", "default-agent", "--json"], {
    encoding: "utf8",
    env: isolatedEnv(home)
  });
  assert.equal(json.status, 2);
  assert.doesNotMatch(`${json.stdout}${json.stderr}`, /^Select /m);
  assert.deepEqual(JSON.parse(json.stderr), {
    ok: false,
    code: "USAGE_ERROR",
    message: "Config value is required.",
    details: {}
  });
});

test("Controller-routed selection starts the Controller before reading candidates", ptyTest, async () => {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);
  let discoveryAtPrompt = null;

  try {
    const result = await runInTerminalSteps(
      ["agent", "show"],
      [{
        prompt: "Choose agent",
        answer: "1\n",
        onPrompt() {
          const discoveryPath = join(home, "runtime", "controller.json");
          discoveryAtPrompt = existsSync(discoveryPath)
            ? JSON.parse(readFileSync(discoveryPath, "utf8"))
            : null;
        }
      }],
      home,
      { TASKMUX_CONTROLLER_MODE: "auto" }
    );

    assert.equal(result.status, 0, result.output);
    assert.equal(typeof discoveryAtPrompt?.pid, "number");
    assert.match(result.output, /Agent: codex/);
  } finally {
    spawnSync(process.execPath, [cli, "controller", "stop"], {
      encoding: "utf8",
      env: { ...isolatedEnv(home), TASKMUX_CONTROLLER_MODE: "auto" },
      timeout: 5_000
    });
  }
});

test("config set default-agent selects a configured agent in a real terminal", ptyTest, () => {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);

  const result = runInTerminal(["config", "set", "default-agent"], "\n", home);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Select agent/);
  assert.match(result.output, /Set default-agent: codex/);
  assert.match(run(["config", "show"], home), /default-agent\s+\|\s+configured\s+\|\s+agent=codex/);
});

test("role show selects system placeholders after Controller recovery", ptyTest, async () => {
  const home = createHome();
  let discoveryAtPrompt = null;

  try {
    const result = await runInTerminalSteps(
      ["role", "show"],
      [{
        prompt: "Choose global role",
        answer: "operator\n",
        onPrompt() {
          const discoveryPath = join(home, "runtime", "controller.json");
          discoveryAtPrompt = existsSync(discoveryPath)
            ? JSON.parse(readFileSync(discoveryPath, "utf8"))
            : null;
        }
      }],
      home,
      { TASKMUX_CONTROLLER_MODE: "auto" }
    );

    assert.equal(result.status, 0, result.output);
    assert.equal(typeof discoveryAtPrompt?.pid, "number");
    assert.match(result.output, /Role: operator/);
    assert.match(result.output, /System: global user-facing CLI operator/);
    assert.match(result.output, /Agent: \?/);
  } finally {
    stopController(home);
  }
});

test("role remove excludes system roles and confirms an interactively selected custom role", ptyTest, () => {
  const home = createHome();
  createGlobalRole(home, "reviewer");

  const cancelled = runInTerminal(["role", "remove"], "\n\n", home);

  assert.equal(cancelled.status, 0, cancelled.output);
  assert.match(cancelled.output, /Select global role/);
  assert.match(cancelled.output, /reviewer/);
  assert.doesNotMatch(cancelled.output, /\|\s+(operator|leader)\s+\|/);
  assert.match(cancelled.output, /Remove role reviewer\? \[y\/N\]:/);
  assert.match(cancelled.output, /Cancelled\./);
  assert.match(run(["role", "show", "reviewer"], home), /Role: reviewer/);
});

test("role enter selects configured roles but not missing system placeholders", ptyTest, () => {
  const home = createHome();
  createGlobalRole(home, "reviewer", "true");

  const result = runInTerminal(["role", "enter"], "\n", home);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Select global role/);
  assert.match(result.output, /reviewer/);
  assert.doesNotMatch(result.output, /\|\s+(operator|leader)\s+\|/);
  assert.match(result.output, /Exited role reviewer/);
});

test("single-Task commands select from active and archived stored Tasks", ptyTest, () => {
  const home = createTaskWithLeader();
  run(["task", "create", "Archived task"], home);
  run(["task", "archive", "task-2"], home);

  const show = runInTerminal(["task", "show"], "task-2\n", home);
  assert.equal(show.status, 0, show.output);
  assert.match(show.output, /Select task/);
  assert.match(show.output, /Archived task/);
  assert.match(show.output, /Task: task-2/);
  assert.match(show.output, /Archived: yes/);

  const topics = runInTerminal(["task", "topic", "list"], "task-1\n", home);
  assert.equal(topics.status, 0, topics.output);
  assert.match(topics.output, /Select task/);
  assert.match(topics.output, /Task topics: task-1/);
});

test("task status and transcript export resolve Task then TaskRole", ptyTest, async () => {
  const home = createTaskWithLeader();
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");
  new FileTaskStore(home).saveTranscript("task-1", "leader", "stored transcript\n");

  const status = await runInTerminalSteps(
    ["task", "status"],
    [
      { prompt: "Choose task", answer: "\n" },
      { prompt: "Choose task role", answer: "\n" }
    ],
    home
  );
  assert.equal(status.status, 0, status.output);
  assert.match(status.output, /Task: task-1/);
  assert.match(status.output, /Role: leader/);

  const transcript = await runInTerminalSteps(
    ["task", "transcript", "export"],
    [
      { prompt: "Choose task", answer: "\n" },
      { prompt: "Choose task role", answer: "\n" }
    ],
    home
  );
  assert.equal(transcript.status, 0, transcript.output);
  assert.match(transcript.output, /stored transcript/);
});

test("selectors insert omitted references before complete command options", ptyTest, async () => {
  const home = createTaskWithLeader();
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");
  new FileTaskStore(home).saveTranscript("task-1", "leader", "stored transcript\n");

  const context = runInTerminal(["task", "context", "--include-transcripts"], "\n", home);
  assert.equal(context.status, 0, context.output);
  assert.match(context.output, /Select task/);
  assert.match(context.output, /^Task Context$/m);

  const transcript = await runInTerminalSteps(
    ["task", "transcript", "export", "--format", "markdown"],
    [
      { prompt: "Choose task", answer: "\n" },
      { prompt: "Choose task role", answer: "\n" }
    ],
    home
  );
  assert.equal(transcript.status, 0, transcript.output);
  assert.match(transcript.output, /# Transcript task-1 leader/);
  assert.match(transcript.output, /stored transcript/);
});

test("unknown trailing options never trigger selection while explicit value-less catalog enums do", ptyTest, async () => {
  const home = createTaskWithLeader();

  for (const args of [["task", "context", "--unknown"]]) {
    const result = runInTerminal(args, "", home);
    assert.equal(result.status, 3, result.output);
    assert.doesNotMatch(result.output, /Select task/);
    assert.match(result.output, /TASK_NOT_FOUND: Task not found: --/);
  }

  const finite = await runInTerminalSteps(
    ["task", "context", "--format"],
    [
      { prompt: "Choose format", answer: "text\n" },
      { prompt: "Choose task", answer: "\n" }
    ],
    home
  );
  assert.equal(finite.status, 0, finite.output);
  assert.match(finite.output, /Select format/);
  assert.match(finite.output, /^Task Context$/m);

  const structured = runInTerminal(["task", "context", "--format", "json"], "", home);
  assert.equal(structured.status, 3, structured.output);
  assert.doesNotMatch(structured.output, /Select task/);
  assert.match(structured.output, /TASK_NOT_FOUND: Task not found: --format/);
});

test("Task and role environment scope bypasses dependent status selection", ptyTest, () => {
  const home = createTaskWithLeader();

  const result = runInTerminal(
    ["task", "status"],
    "",
    home,
    { TASKMUX_TASK_ID: "task-1", TASKMUX_ROLE: "leader" }
  );

  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /Select task/);
  assert.doesNotMatch(result.output, /Select task role/);
  assert.match(result.output, /Task: task-1/);
  assert.match(result.output, /Role: leader/);
});

test("explicit transcript export scope overrides Task and role environment scope", ptyTest, async () => {
  const home = createTaskWithLeader();
  run(["task", "create", "Explicit task"], home);
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");
  new FileTaskStore(home).saveTranscript("task-2", "leader", "explicit-task-transcript\n");

  const result = runInTerminal(
    ["task", "transcript", "export", "task-2", "leader"],
    "",
    home,
    { TASKMUX_TASK_ID: "task-1", TASKMUX_ROLE: "missing-role" }
  );

  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /Select task/);
  assert.doesNotMatch(result.output, /Select task role/);
  assert.match(result.output, /explicit-task-transcript/);
});

test("Task and role environment scope is inserted before transcript export options", ptyTest, async () => {
  const home = createTaskWithLeader();
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");
  new FileTaskStore(home).saveTranscript("task-1", "leader", "scoped transcript\n");

  const result = runInTerminal(
    ["task", "transcript", "export", "--format", "markdown"],
    "",
    home,
    { TASKMUX_TASK_ID: "task-1", TASKMUX_ROLE: "leader" }
  );

  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /Select task/);
  assert.doesNotMatch(result.output, /Select task role/);
  assert.match(result.output, /# Transcript task-1 leader/);
  assert.match(result.output, /scoped transcript/);
});

test("task delete asks for default-No confirmation only after interactive selection", ptyTest, () => {
  const home = createTaskWithLeader();

  const cancelled = runInTerminal(["task", "delete"], "\n\n", home);

  assert.equal(cancelled.status, 0, cancelled.output);
  assert.match(cancelled.output, /Delete task task-1\? \[y\/N\]:/);
  assert.match(cancelled.output, /Cancelled\./);
  assert.match(run(["task", "show", "task-1"], home), /Task: task-1/);

  const explicit = runInTerminal(["task", "delete", "task-1"], "", home);
  assert.equal(explicit.status, 0, explicit.output);
  assert.doesNotMatch(explicit.output, /Delete task task-1\?/);
  assert.match(explicit.output, /Deleted task task-1/);
});

test("an explicit scoped role overrides TASKMUX_ROLE", ptyTest, () => {
  const home = createTaskWithLeader();
  run(["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", home], home);

  const result = runInTerminal(
    ["task", "detail", "reviewer"],
    "",
    home,
    { TASKMUX_TASK_ID: "task-1", TASKMUX_ROLE: "leader" }
  );

  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /Select task role/);
  assert.match(result.output, /Role: reviewer/);
});

test("structured command-local output disables interactive selection", async () => {
  const selection = await import("../dist/cli/interactiveSelection.js");
  assert.equal(typeof selection.allowsInteractiveSelection, "function");
  assert.equal(selection.allowsInteractiveSelection(["task", "context", "--format", "json"], false), false);
  assert.equal(selection.allowsInteractiveSelection(["task", "transcript", "export", "--format", "json"], false), false);
  assert.equal(selection.allowsInteractiveSelection(["task", "context", "--format", "text"], false), true);
  assert.equal(selection.allowsInteractiveSelection(["agent", "show"], true), false);
});

test("selector reports an actionable error without prompting when no candidates exist", async () => {
  const { store, node, resolveInteractiveArguments } = await selectionFixture();
  let asked = false;

  await assert.rejects(
    resolveInteractiveArguments(["agent", "show"], node, store, selectionIo([], () => { asked = true; })),
    /No agents are configured/
  );
  assert.equal(asked, false);
});

test("selector paginates and filters arbitrarily large candidate sets while keeping the default visible", async () => {
  const { store, node, resolveInteractiveArguments, addAgent } = await selectionFixture();
  for (let index = 1; index <= 45; index += 1) {
    addAgent(`agent-${String(index).padStart(2, "0")}`);
  }
  store.saveConfig({ schemaVersion: 1, defaultAgent: "agent-35" });
  const writes = [];

  const result = await resolveInteractiveArguments(
    ["agent", "show"],
    node,
    store,
    selectionIo(["p", "n", "/agent-42", ""], undefined, writes)
  );

  assert.deepEqual(result.args, ["agent", "show", "agent-42"]);
  assert.match(writes.join(""), /Agents — 21-40 of 45/);
  assert.match(writes.join(""), /Agents — 1-20 of 45/);
  assert.match(writes.join(""), /Agents — 1-1 of 1 \(filtered from 45\)/);
  assert.match(writes.join(""), /agent-35.*yes/);
});

test("selector accepts an exact value outside the visible page", async () => {
  const { store, node, resolveInteractiveArguments, addAgent } = await selectionFixture();
  for (let index = 1; index <= 45; index += 1) {
    addAgent(`agent-${String(index).padStart(2, "0")}`);
  }

  const result = await resolveInteractiveArguments(
    ["agent", "show"],
    node,
    store,
    selectionIo(["agent-45"])
  );

  assert.deepEqual(result.args, ["agent", "show", "agent-45"]);
});

test("task enter resolves Task then TaskRole and an explicit Task only resolves its Role", async () => {
  const [{ FileTaskStore }, { routeInvocation }, { resolveInteractiveArguments }] = await Promise.all([
    import("../dist/storage/taskStore.js"),
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactiveSelection.js")
  ]);
  const home = createTaskWithLeader();
  const store = new FileTaskStore(home);
  const invocation = routeInvocation(["task", "enter"]);
  assert.equal(invocation.kind, "execute");

  const both = await resolveInteractiveArguments(
    ["task", "enter"],
    invocation.node,
    store,
    selectionIo(["", ""]),
    { preferredRole: "leader" }
  );
  assert.deepEqual(both.args, ["task", "enter", "task-1", "leader"]);

  const roleOnly = await resolveInteractiveArguments(
    ["task", "enter", "task-1"],
    invocation.node,
    store,
    selectionIo([""]),
    { preferredRole: "leader" }
  );
  assert.deepEqual(roleOnly.args, ["task", "enter", "task-1", "leader"]);
});

test("catalog finite enums resolve only required missing positions and explicit value-less options", async () => {
  const [{ FileTaskStore }, { routeInvocation }, { resolveInteractiveArguments }] = await Promise.all([
    import("../dist/storage/taskStore.js"),
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactiveSelection.js")
  ]);
  const store = new FileTaskStore(createHome());

  const optionInvocation = routeInvocation(["task", "list", "--priority"]);
  assert.equal(optionInvocation.kind, "execute");
  const option = await resolveInteractiveArguments(
    ["task", "list", "--priority"],
    optionInvocation.node,
    store,
    selectionIo(["high"])
  );
  assert.deepEqual(option.args, ["task", "list", "--priority", "high"]);

  const positionalInvocation = routeInvocation(["config", "unset", "completion"]);
  assert.equal(positionalInvocation.kind, "execute");
  const positional = await resolveInteractiveArguments(
    ["config", "unset", "completion"],
    positionalInvocation.node,
    store,
    selectionIo(["zsh"])
  );
  assert.deepEqual(positional.args, ["config", "unset", "completion", "zsh"]);

  const optionalInvocation = routeInvocation(["task", "list"]);
  assert.equal(optionalInvocation.kind, "execute");
  let asked = false;
  const optional = await resolveInteractiveArguments(
    ["task", "list"],
    optionalInvocation.node,
    store,
    selectionIo([], () => { asked = true; })
  );
  assert.equal(optional.kind, "unchanged");
  assert.equal(asked, false);

  const currentInvocation = routeInvocation(["task", "current"]);
  assert.equal(currentInvocation.kind, "execute");
  const current = await resolveInteractiveArguments(
    ["task", "current"],
    currentInvocation.node,
    store,
    selectionIo([], () => { asked = true; })
  );
  assert.equal(current.kind, "unchanged");
  assert.equal(asked, false);

  asked = false;
  const createInvocation = routeInvocation(["task", "create", "--priority"]);
  assert.equal(createInvocation.kind, "execute");
  const incompleteCreate = await resolveInteractiveArguments(
    ["task", "create", "--priority"],
    createInvocation.node,
    store,
    selectionIo([], () => { asked = true; })
  );
  assert.equal(incompleteCreate.kind, "unchanged");
  assert.equal(asked, false);

  const completionInvocation = routeInvocation(["config", "set", "completion"]);
  assert.equal(completionInvocation.kind, "execute");
  const incompleteCompletion = await resolveInteractiveArguments(
    ["config", "set", "completion"],
    completionInvocation.node,
    store,
    selectionIo([], () => { asked = true; })
  );
  assert.equal(incompleteCompletion.kind, "unchanged");
  assert.equal(asked, false);
});

test("selector retries invalid input and accepts an exact candidate value", async () => {
  const { store, node, resolveInteractiveArguments, addAgent } = await selectionFixture();
  addAgent("claude");
  addAgent("codex");
  const writes = [];

  const result = await resolveInteractiveArguments(
    ["agent", "show"],
    node,
    store,
    selectionIo(["missing", "codex"], undefined, writes)
  );

  assert.equal(result.kind, "resolved");
  assert.deepEqual(result.args, ["agent", "show", "codex"]);
  assert.match(writes.join(""), /Unknown agent: missing/);
});

test("selector accepts a number and uses the configured default on Enter", async () => {
  const numbered = await selectionFixture();
  numbered.addAgent("claude");
  numbered.addAgent("codex");
  const byNumber = await numbered.resolveInteractiveArguments(
    ["agent", "show"],
    numbered.node,
    numbered.store,
    selectionIo(["2"])
  );
  assert.deepEqual(byNumber.args, ["agent", "show", "codex"]);

  numbered.store.saveConfig({ schemaVersion: 1, defaultAgent: "claude" });
  const byDefault = await numbered.resolveInteractiveArguments(
    ["agent", "show"],
    numbered.node,
    numbered.store,
    selectionIo([""])
  );
  assert.deepEqual(byDefault.args, ["agent", "show", "claude"]);
});

test("selector treats skip, q, and EOF as cancellation", async () => {
  for (const answer of ["skip", "q", undefined]) {
    const fixture = await selectionFixture();
    fixture.addAgent("codex");
    const result = await fixture.resolveInteractiveArguments(
      ["agent", "show"],
      fixture.node,
      fixture.store,
      selectionIo([answer])
    );
    assert.equal(result.kind, "cancelled");
  }
});

test("interaction policy validation rejects missing dependencies and incompatible providers", async () => {
  const { validateInteractionPolicies } = await import("../dist/cli/interactionPolicy.js");

  assert.throws(() => validateInteractionPolicies([{
    commandPath: ["task", "detail"],
    selectors: [{
      argumentIndex: 3,
      entity: "agent",
      provider: "configured-agents",
      dependsOn: 2,
      actionTarget: true
    }]
  }]), /dependency must reference an earlier selector/);

  assert.throws(() => validateInteractionPolicies([{
    commandPath: ["agent", "show"],
    selectors: [{
      argumentIndex: 2,
      entity: "task",
      provider: "configured-agents",
      actionTarget: true
    }]
  }]), /provider configured-agents is incompatible with task/);

  assert.throws(() => validateInteractionPolicies([{
    commandPath: ["task", "detail"],
    selectors: [{
      argumentIndex: 2,
      entity: "task",
      provider: "tasks",
      dependsOn: 2,
      actionTarget: true
    }]
  }]), /dependency must reference an earlier selector/);

  assert.throws(() => validateInteractionPolicies([{
    commandPath: ["task", "list"],
    selectors: [{
      option: "--missing",
      entity: "agent",
      provider: "configured-agents",
      actionTarget: false
    }]
  }]), /selector option is not catalog-owned.*--missing/);

  assert.throws(() => validateInteractionPolicies([{
    commandPath: ["task", "show"],
    selectors: [{ argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true }],
    requiredOptions: ["--missing"]
  }]), /required option is not catalog-owned.*--missing/);
});

test("interaction policies cover the approved read and delete command matrix", async () => {
  const [{ routeInvocation }, { findInteractionPolicy }] = await Promise.all([
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactionPolicy.js")
  ]);
  const expected = new Map([
    ["config set default-agent", [[3, "configured-agents"]]],
    ["role show", [[2, "global-roles-for-show"]]],
    ["role remove", [[2, "removable-global-roles"]]],
    ["role enter", [[2, "configured-global-roles"]]],
    ...[
      "task show", "task open", "task context", "task roles", "task comments",
      "task events", "task activity", "task timeline"
    ].map((path) => [path, [[2, "tasks"]]]),
    ["task topic list", [[3, "tasks"]]],
    ...["task status", "task tail", "task transcript"].map((path) => [path, [
      [2, "tasks"], [3, "task-roles"]
    ]]),
    ["task enter", [[2, "tasks"], [3, "task-roles"]]],
    ["task transcript export", [[3, "tasks"], [4, "task-roles-with-transcripts"]]],
    ["task delete", [[2, "tasks"]]]
  ]);

  for (const [path, selectors] of expected) {
    const invocation = routeInvocation(path.split(" "));
    assert.equal(invocation.kind, "execute", path);
    const policy = findInteractionPolicy(invocation.node);
    assert.ok(policy, path);
    assert.deepEqual(
      policy.selectors.map((selector) => [selector.argumentIndex, selector.provider]),
      selectors,
      path
    );
  }
});

test("global-role providers mirror show, remove, and enter command domains", async () => {
  const [{ FileTaskStore }, { getSelectionCandidates }] = await Promise.all([
    import("../dist/storage/taskStore.js"),
    import("../dist/cli/interactionCandidates.js")
  ]);
  const home = createHome();
  createGlobalRole(home, "reviewer");
  const store = new FileTaskStore(home);

  const show = getSelectionCandidates({
    argumentIndex: 2,
    entity: "global-role",
    provider: "global-roles-for-show",
    actionTarget: true
  }, store, ["role", "show"]);
  assert.deepEqual(show.candidates.map(({ value }) => value), ["leader", "operator", "reviewer"]);
  assert.deepEqual(
    show.candidates.filter(({ value }) => value !== "reviewer").map(({ cells }) => cells[1]),
    ["?", "?"]
  );

  const removable = getSelectionCandidates({
    argumentIndex: 2,
    entity: "global-role",
    provider: "removable-global-roles",
    actionTarget: true
  }, store, ["role", "remove"]);
  assert.deepEqual(removable.candidates.map(({ value }) => value), ["reviewer"]);

  const configured = getSelectionCandidates({
    argumentIndex: 2,
    entity: "global-role",
    provider: "configured-global-roles",
    actionTarget: true
  }, store, ["role", "enter"]);
  assert.deepEqual(configured.candidates.map(({ value }) => value), ["reviewer"]);
});

test("domain providers enumerate trash, drafts, topics, active cycles, open work items, and active decisions", async () => {
  const [{ FileTaskStore }, { getSelectionCandidates }] = await Promise.all([
    import("../dist/storage/taskStore.js"),
    import("../dist/cli/interactionCandidates.js")
  ]);
  const home = createTaskWithLeader();
  run(["task", "create", "Trash me"], home);
  run(["task", "delete", "task-2"], home);
  run(["task", "input", "draft", "task-1", "pending input"], home);
  run(["task", "topic", "create", "task-1", "--id", "custom-topic", "--name", "Custom", "--description", "Custom topic"], home);
  run(["task", "cycle", "create", "task-1", "--cause", "explicit-wake", "--summary", "Active cycle"], home);
  run(["task", "cycle", "create", "task-1", "--cause", "explicit-wake", "--summary", "Ended cycle"], home);
  run(["task", "cycle", "end", "task-1", "cycle-2", "--summary", "Done"], home);
  run(["task", "work-item", "create", "task-1", "--title", "Open item", "--cycle", "cycle-1", "--assignee", "leader"], home);
  run(["task", "work-item", "create", "task-1", "--title", "Closed item", "--assignee", "leader"], home);
  run(["task", "work-item", "update", "task-1", "work-item-2", "--status", "completed", "--outcome", "Done"], home);
  run(["task", "decision", "record", "task-1", "--title", "Active decision", "--rationale", "Keep"], home);
  run(["task", "decision", "record", "task-1", "--title", "Old decision", "--rationale", "Replace"], home);
  run(["task", "decision", "supersede", "task-1", "decision-2", "--reason", "Obsolete"], home);
  const store = new FileTaskStore(home);
  store.saveTranscript("task-1", "leader", "stored transcript\n");
  run(["task", "assign", "task-1", "zeta", "--agent", "codex", "--workspace", home], home);
  run(["task", "assign", "task-1", "alpha", "--agent", "codex", "--workspace", home], home);

  const providerValues = (provider, args = ["task", "test", "task-1"]) => getSelectionCandidates({
    argumentIndex: 3,
    entity: "task",
    provider,
    dependsOn: 2,
    actionTarget: true
  }, store, args).candidates.map(({ value }) => value);

  assert.deepEqual(providerValues("trashed-tasks", ["task", "restore"]), ["task-2"]);
  assert.deepEqual(providerValues("tasks-with-input-drafts", ["task", "input", "submit"]), ["task-1"]);
  assert.deepEqual(providerValues("active-cycles"), ["cycle-1"]);
  assert.deepEqual(providerValues("open-work-items"), ["work-item-1"]);
  assert.deepEqual(providerValues("active-decisions"), ["decision-1"]);
  assert.deepEqual(providerValues("task-roles-with-transcripts"), ["leader"]);
  assert.deepEqual(providerValues("task-topics").slice(-1), ["custom-topic"]);
  assert.ok(providerValues("task-topics").includes("requirements"));
  assert.deepEqual(providerValues("task-roles"), ["alpha", "leader", "zeta"]);
  run(["task", "work-item", "create", "task-1", "--title", "Zeta item", "--assignee", "zeta"], home);
  assert.deepEqual(
    providerValues("dispatch-work-items", ["task", "dispatch", "task-1", "leader", "--work-item"]),
    ["work-item-1"]
  );
  assert.deepEqual(providerValues("work-items"), ["work-item-1", "work-item-2", "work-item-3"]);
});

test("interaction policies cover remaining Task-owned enumerable domains", async () => {
  const [{ routeInvocation }, { findInteractionPolicy }] = await Promise.all([
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactionPolicy.js")
  ]);
  const expected = new Map([
    ["task restore", [[2, "trashed-tasks"]]],
    ["task input submit", [[3, "tasks-with-input-drafts"]]],
    ["task cycle end", [[3, "tasks"], [4, "active-cycles"]]],
    ["task work-item update", [[3, "tasks"], [4, "work-items"]]],
    ["task decision supersede", [[3, "tasks"], [4, "active-decisions"]]],
    ["task topic summarize", [[3, "tasks"], ["--topic", "task-topics"]]]
  ]);

  for (const [path, selectors] of expected) {
    const invocation = routeInvocation(path.split(" "));
    assert.equal(invocation.kind, "execute", path);
    const policy = findInteractionPolicy(invocation.node);
    assert.ok(policy, path);
    assert.deepEqual(
      policy.selectors.map((selector) => [selector.option ?? selector.argumentIndex, selector.provider]),
      selectors,
      path
    );
  }
});

test("interaction policy registry covers every approved enumerable reference command", async () => {
  const [{ routeInvocation }, { findInteractionPolicy }] = await Promise.all([
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactionPolicy.js")
  ]);
  const expectedPaths = [
    "role add", "role update",
    "task clone", "task update", "task archive", "task unarchive", "task shell", "task refresh", "task cleanup", "task wake",
    "task assign", "task bind", "task assign-many", "task role child", "task role update", "task role remove",
    "task detach", "task stop", "task kill", "task restart",
    "task topic create", "task topic summarize", "task cycle create", "task cycle end",
    "task work-item create", "task work-item update", "task session record", "task session replace",
    "task dispatch", "task yield", "task schedule set", "task brief update", "task milestone add",
    "task decision record", "task decision supersede", "task worktree create", "task worktree remove"
  ];

  for (const path of expectedPaths) {
    const invocation = routeInvocation(path.split(" "));
    assert.equal(invocation.kind, "execute", path);
    assert.ok(findInteractionPolicy(invocation.node), path);
  }

  for (const excluded of ["task current", "task comment", "task input draft", "task role rename"] ) {
    const invocation = routeInvocation(excluded.split(" "));
    assert.equal(invocation.kind, "execute", excluded);
    assert.equal(findInteractionPolicy(invocation.node), undefined, excluded);
  }
});

test("value-less dynamic options allow their parent Task to resolve before the option candidate", async () => {
  const [{ FileTaskStore }, { routeInvocation }, { resolveInteractiveArguments }] = await Promise.all([
    import("../dist/storage/taskStore.js"),
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactiveSelection.js")
  ]);
  const home = createTaskWithLeader();
  run(["task", "topic", "create", "task-1", "--id", "custom-topic", "--name", "Custom", "--description", "Custom topic"], home);
  const store = new FileTaskStore(home);
  const invocation = routeInvocation(["task", "topic", "summarize", "--topic", "--summary", "Summary"]);
  assert.equal(invocation.kind, "execute");

  const result = await resolveInteractiveArguments(
    ["task", "topic", "summarize", "--topic", "--summary", "Summary"],
    invocation.node,
    store,
    selectionIo(["", "custom-topic"])
  );

  assert.deepEqual(result.args, [
    "task", "topic", "summarize", "task-1", "--topic", "custom-topic", "--summary", "Summary"
  ]);
});

test("incomplete free-form requirements and invalid explicit parents bypass domain prompts", async () => {
  const [{ FileTaskStore }, { routeInvocation }, { resolveInteractiveArguments }] = await Promise.all([
    import("../dist/storage/taskStore.js"),
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactiveSelection.js")
  ]);
  const store = new FileTaskStore(createTaskWithLeader());
  const invocation = routeInvocation(["task", "decision", "supersede"]);
  assert.equal(invocation.kind, "execute");
  let asked = false;

  const incomplete = await resolveInteractiveArguments(
    ["task", "decision", "supersede"],
    invocation.node,
    store,
    selectionIo([], () => { asked = true; })
  );
  assert.equal(incomplete.kind, "unchanged");
  assert.equal(asked, false);

  const invalidParent = await resolveInteractiveArguments(
    ["task", "decision", "supersede", "missing-task", "--reason", "obsolete"],
    invocation.node,
    store,
    selectionIo([], () => { asked = true; })
  );
  assert.equal(invalidParent.kind, "unchanged");
  assert.equal(asked, false);
});

test("Task shell reuses its readline boundary for missing enumerable references", ptyTest, async () => {
  const home = createTaskWithLeader();
  const result = await runInTerminalSteps(
    ["task", "shell", "task-1"],
    [
      { prompt: "taskmux task-1>", answer: "detail\n" },
      { prompt: "Choose task role", answer: "\n" },
      { prompt: "taskmux task-1>", answer: "q\n" }
    ],
    home
  );

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Select task role: task-1/);
  assert.match(result.output, /Role: leader/);
  assert.doesNotMatch(result.output, /USAGE_ERROR: Role name is required/);
});

test("Task shell keeps interactive selection disabled in global JSON mode", ptyTest, async () => {
  const home = createTaskWithLeader();
  const result = await runInTerminalSteps(
    ["task", "shell", "task-1", "--json"],
    [
      { prompt: "taskmux task-1>", answer: "detail\n" },
      { prompt: "USAGE_ERROR: Role name is required.", answer: "q\n" }
    ],
    home
  );

  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /Select task role/);
  assert.match(result.output, /USAGE_ERROR: Role name is required\./);
});

function createHome() {
  const home = mkdtempSync(join(tmpdir(), "taskmux-interactive-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "schema.json"), `${JSON.stringify({
    schemaVersion: 1,
    storageVersion: 4,
    updatedAt: "2026-07-12T00:00:00.000Z"
  }, null, 2)}\n`);
  return home;
}

function createTaskWithLeader() {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);
  run(["config", "set", "default-agent", "codex"], home);
  run(["config", "set", "default-workspace", home], home);
  run(["task", "create", "Interactive task"], home);
  return home;
}

function createGlobalRole(home, name, command = "codex") {
  run(["agent", "add", "role-agent", "--adapter", "codex", "--command", command], home);
  run(["config", "set", "default-workspace", home], home);
  run(["role", "add", name, "--agent", "role-agent", "--workspace", home], home);
}

function run(args, home) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: isolatedEnv(home)
  });
}

function runInTerminal(args, input, home, extraEnv = {}) {
  if (scriptSupport === null) {
    throw new Error("compatible util-linux script is unavailable");
  }
  const command = [process.execPath, cli, ...args].map(shellQuote).join(" ");
  const result = spawnSync(scriptSupport, ["-qec", command, "/dev/null"], {
    input,
    encoding: "utf8",
    env: { ...isolatedEnv(home), ...extraEnv },
    timeout: 5_000,
    killSignal: "SIGKILL"
  });

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`.replaceAll("\r", "")
  };
}

function runInTerminalSteps(args, steps, home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    if (scriptSupport === null) {
      reject(new Error("compatible util-linux script is unavailable"));
      return;
    }
    const command = [process.execPath, cli, ...args].map(shellQuote).join(" ");
    const child = spawn(scriptSupport, ["-qec", command, "/dev/null"], {
      env: { ...isolatedEnv(home), ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    let output = "";
    let stepIndex = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(new Error(`PTY command timed out after 5000ms: ${output}`));
    }, 5_000);
    const consume = (chunk) => {
      output += chunk.toString().replaceAll("\r", "");
      const step = steps[stepIndex];
      if (step !== undefined && output.includes(step.prompt)) {
        stepIndex += 1;
        step.onPrompt?.();
        child.stdin.write(step.answer);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      resolve({ status, output });
    });
  });
}

function stopController(home) {
  spawnSync(process.execPath, [cli, "controller", "stop"], {
    encoding: "utf8",
    env: { ...isolatedEnv(home), TASKMUX_CONTROLLER_MODE: "auto" },
    timeout: 5_000
  });
}

function isolatedEnv(home) {
  return {
    ...process.env,
    HOME: home,
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "direct"
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function detectScriptSupport() {
  const result = spawnSync("script", ["--version"], {
    encoding: "utf8",
    timeout: 2_000
  });
  return result.status === 0 && /util-linux/i.test(`${result.stdout}${result.stderr}`) ? "script" : null;
}

async function selectionFixture() {
  const [{ FileTaskStore }, { createConfiguredAgent }, { routeInvocation }, { resolveInteractiveArguments }] = await Promise.all([
    import("../dist/storage/taskStore.js"),
    import("../dist/agent/agent.js"),
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactiveSelection.js")
  ]);
  const home = createHome();
  const store = new FileTaskStore(home);
  const invocation = routeInvocation(["agent", "show"]);
  assert.equal(invocation.kind, "execute");

  return {
    store,
    node: invocation.node,
    resolveInteractiveArguments,
    addAgent(id) {
      store.saveConfiguredAgent(createConfiguredAgent(id, id, id, [], [], new Date("2026-07-12T00:00:00.000Z")));
    }
  };
}

function selectionIo(answers, onQuestion, writes = []) {
  let index = 0;
  return {
    interactive: true,
    json: false,
    width: 100,
    write(value) {
      writes.push(value);
    },
    async question() {
      onQuestion?.();
      const answer = answers[index];
      index += 1;
      return answer;
    }
  };
}
