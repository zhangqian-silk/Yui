import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "cli.js");

test("agent show selects the configured agent in a real terminal", () => {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);

  const result = runInTerminal(["agent", "show"], "\n", home);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Select agent/);
  assert.match(result.output, /\|\s+1\s+\|\s+codex\s+\|/);
  assert.match(result.output, /Agent: codex/);
});

test("agent remove asks for a default-No confirmation after interactive selection", () => {
  const home = createHome();
  run(["agent", "add", "codex", "--command", "codex"], home);

  const cancelled = runInTerminal(["agent", "remove"], "\n\n", home);

  assert.equal(cancelled.status, 0, cancelled.output);
  assert.match(cancelled.output, /Remove agent codex\? \[y\/N\]:/);
  assert.match(cancelled.output, /Cancelled\./);
  assert.match(run(["agent", "show", "codex"], home), /Agent: codex/);
});

test("task detail resolves Task then TaskRole through dependent terminal selections", async () => {
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

test("task environment scope is resolved before dependent role selection", () => {
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

test("an invalid explicit Task bypasses dependent selection and keeps the normal error", () => {
  const home = createTaskWithLeader();

  const result = runInTerminal(["task", "detail", "missing-task"], "", home);

  assert.equal(result.status, 3, result.output);
  assert.doesNotMatch(result.output, /Select task role/);
  assert.match(result.output, /TASK_NOT_FOUND: Task not found: missing-task/);
});

test("explicit, non-terminal, and JSON invocations remain deterministic", () => {
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

test("selector reports an actionable error without prompting when no candidates exist", async () => {
  const { store, node, resolveInteractiveArguments } = await selectionFixture();
  let asked = false;

  await assert.rejects(
    resolveInteractiveArguments(["agent", "show"], node, store, selectionIo([], () => { asked = true; })),
    /No agents are configured/
  );
  assert.equal(asked, false);
});

test("selector refuses to render more than twenty candidates", async () => {
  const { store, node, resolveInteractiveArguments, addAgent } = await selectionFixture();
  for (let index = 1; index <= 21; index += 1) {
    addAgent(`agent-${index}`);
  }

  await assert.rejects(
    resolveInteractiveArguments(["agent", "show"], node, store, selectionIo([])),
    /21 agents are available.*limited to 20.*taskmux agent list/s
  );
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
});

function createHome() {
  const home = mkdtempSync(join(tmpdir(), "taskmux-interactive-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "schema.json"), `${JSON.stringify({
    schemaVersion: 1,
    storageVersion: 3,
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

function run(args, home) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: isolatedEnv(home)
  });
}

function runInTerminal(args, input, home, extraEnv = {}) {
  const command = [process.execPath, cli, ...args].map(shellQuote).join(" ");
  const result = spawnSync("script", ["-qec", command, "/dev/null"], {
    input,
    encoding: "utf8",
    env: { ...isolatedEnv(home), ...extraEnv }
  });

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`.replaceAll("\r", "")
  };
}

function runInTerminalSteps(args, steps, home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const command = [process.execPath, cli, ...args].map(shellQuote).join(" ");
    const child = spawn("script", ["-qec", command, "/dev/null"], {
      env: { ...isolatedEnv(home), ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "";
    let stepIndex = 0;
    const consume = (chunk) => {
      output += chunk.toString().replaceAll("\r", "");
      const step = steps[stepIndex];
      if (step !== undefined && output.includes(step.prompt)) {
        stepIndex += 1;
        child.stdin.write(step.answer);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", reject);
    child.on("close", (status) => {
      child.stdin.end();
      resolve({ status, output });
    });
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
      store.saveConfiguredAgent(createConfiguredAgent(id, id, [], {}, new Date("2026-07-12T00:00:00.000Z")));
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
