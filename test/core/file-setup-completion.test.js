import assert from "node:assert/strict";
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
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runCompletionWizard } from "../../dist/cli/completionWizard.js";
import { FileCompletionManager } from "../../dist/completion/fileCompletionManager.js";
import {
  createWorkMailbox,
  enqueueSignal
} from "../../dist/coordination/workMailbox.js";

function memoryStore(initial = { schemaVersion: 1 }) {
  let config = structuredClone(initial);
  const store = {
    transaction: (execute) => execute(store),
    getConfig: () => structuredClone(config),
    saveConfig: (next) => { config = structuredClone(next); }
  };
  return store;
}

function answers(...values) {
  const prompts = [];
  return {
    prompts,
    interactive: true,
    json: false,
    width: 100,
    write: () => {},
    question: async (prompt) => {
      prompts.push(prompt);
      return values.shift() ?? "";
    }
  };
}

test("completion without a shell interactively selects one and persists it", async (t) => {
  const userHome = mkdtempSync(join(tmpdir(), "yui-file-completion-"));
  t.after(() => rmSync(userHome, { recursive: true, force: true }));
  const store = memoryStore();
  const io = answers("3", "");

  const manager = new FileCompletionManager(store, {
      HOME: userHome,
      SHELL: "/bin/zsh",
      XDG_CONFIG_HOME: join(userHome, ".config")
    }, "yui-dev");
  const output = await runCompletionWizard(manager, io);

  const installation = store.getConfig().completionInstallations.fish;
  assert.ok(installation);
  assert.equal(io.prompts.length, 2);
  assert.match(io.prompts[0], /Choose shell by number or name \[zsh\] \(or skip\)/);
  assert.match(io.prompts[1], /Selected: Fish \(Install\)/);
  assert.match(output, /Completion fish installed/);
  assert.equal(existsSync(installation.scriptPath), true);
  assert.match(readFileSync(installation.scriptPath, "utf8"), /identity=yui-dev/);
  assert.match(readFileSync(installation.scriptPath, "utf8"), /task role/);
});

test("completion with a shell still confirms installation and startup activation", async (t) => {
  const userHome = mkdtempSync(join(tmpdir(), "yui-file-completion-zsh-"));
  t.after(() => rmSync(userHome, { recursive: true, force: true }));
  const store = memoryStore();
  const io = answers("", "");

  const manager = new FileCompletionManager(
    store,
    { HOME: userHome, SHELL: "/bin/zsh", ZDOTDIR: userHome },
    "yui"
  );
  const output = await runCompletionWizard(manager, io, { shell: "zsh" });

  const installation = store.getConfig().completionInstallations.zsh;
  assert.ok(installation);
  assert.equal(io.prompts.length, 2);
  assert.doesNotMatch(io.prompts[0], /Choose shell/);
  assert.match(io.prompts[0], /Use these paths\? \[Y\/n\/customize\]/);
  assert.match(io.prompts[1], /Update .*\.zshrc.*\[Y\/n\]/s);
  assert.match(output, /Restart the current shell to activate completion: exec zsh/);
  assert.match(readFileSync(installation.activationPath, "utf8"), /yui completion shell=zsh/);
});

test("completion install keeps unrelated FileTaskStore configuration", async (t) => {
  const userHome = mkdtempSync(join(tmpdir(), "yui-file-completion-config-"));
  t.after(() => rmSync(userHome, { recursive: true, force: true }));
  const store = memoryStore({
    schemaVersion: 1,
    defaultAgent: "codex",
    defaultWorkspace: "/work"
  });
  const io = answers("", "n");

  const manager = new FileCompletionManager(
    store,
    { HOME: userHome, SHELL: "/bin/bash" },
    "yui"
  );
  await runCompletionWizard(manager, io, { shell: "bash" });

  const config = store.getConfig();
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.defaultAgent, "codex");
  assert.equal(config.defaultWorkspace, "/work");
  assert.ok(config.completionInstallations.bash);
});

test("setup configures selected Agents plus Leader and Operator model settings", async (t) => {
  const { runSetupCommand } = await import("../../dist/setup/setupCommand.js");
  const { FileTaskStore } = await import("../../dist/storage/taskStore.js");
  const root = mkdtempSync(join(tmpdir(), "yui-file-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "yui-home");
  const bin = join(root, "bin");
  const userHome = join(root, "user");
  const workspace = join(root, "operator-workspace");
  mkdirSync(bin);
  for (const command of ["codex", "claude"]) {
    const path = join(bin, command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  input.end(
    `all\nclaude\ncodex\nclaude-opus\nhigh\ngpt-5.6-sol\nxhigh\n${workspace}\nskip\n`
  );
  const env = {
    YUI_HOME: home,
    YUI_CLI_NAME: "yui-dev",
    HOME: userHome,
    PATH: bin,
    SHELL: "/bin/zsh"
  };
  const executor = { run: (command) => command === "tmux" ? "tmux 3.4" : "" };

  const result = await runSetupCommand(
    [], env, executor,
    { input, output, forceInteractive: true }
  );

  assert.equal(existsSync(join(home, "schema.json")), true);
  const store = new FileTaskStore(home);
  assert.deepEqual(store.listConfiguredAgents().map(({ id }) => id).sort(), ["claude", "codex"]);
  assert.equal(store.getConfig().defaultAgent, "claude");
  assert.equal(store.getConfig().defaultWorkspace, workspace);
  assert.equal(store.getGlobalRole("operator").activeAgentId, "codex");
  assert.equal(store.getGlobalRole("leader").activeAgentId, "claude");
  assert.deepEqual(store.getGlobalRole("operator").agentBindings.codex.config, {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh"
  });
  assert.deepEqual(store.getGlobalRole("leader").agentBindings.claude.config, {
    adapterId: "claude",
    model: "claude-opus",
    effort: "high"
  });
  assert.match(rendered, /Choose Agents by number or name/);
  assert.match(rendered, /Choose default Agent \[codex\]/);
  assert.match(rendered, /Choose Operator Agent \[claude\]/);
  assert.match(rendered, /Leader model for claude \[CLI default\]/);
  assert.match(rendered, /Leader reasoning effort for claude \[CLI default\]/);
  assert.match(rendered, /Operator model for codex \[CLI default\]/);
  assert.match(rendered, /Operator reasoning effort for codex \[CLI default\]/);
  assert.match(result, /Leader model: claude-opus/);
  assert.match(result, /Leader reasoning effort: high/);
  assert.match(result, /Operator model: gpt-5\.6-sol/);
  assert.match(result, /Operator reasoning effort: xhigh/);
  assert.match(result, /Completion install skipped/);

  const operatorWithPermissions = store.getGlobalRole("operator");
  operatorWithPermissions.agentBindings.codex.config.permission = {
    sandbox: "workspace-write",
    approval: "never"
  };
  operatorWithPermissions.agentBindings.codex.config.search = true;
  store.saveGlobalRole(operatorWithPermissions);

  const repeatInput = new PassThrough();
  const repeatOutput = new PassThrough();
  repeatInput.end("all\n\n\n\n\n\n\n\nskip\n");
  await assert.doesNotReject(runSetupCommand(
    [], env, executor,
    { input: repeatInput, output: repeatOutput, forceInteractive: true }
  ));
  const repeated = new FileTaskStore(home);
  assert.equal(repeated.getGlobalRole("operator").activeAgentId, "codex");
  assert.equal(
    repeated.getGlobalRole("operator").agentBindings.codex.config.model,
    "gpt-5.6-sol"
  );
  assert.equal(
    repeated.getGlobalRole("leader").agentBindings.claude.config.effort,
    "high"
  );
  assert.deepEqual(
    repeated.getGlobalRole("operator").agentBindings.codex.config.permission,
    { sandbox: "workspace-write", approval: "never" }
  );
  assert.equal(
    repeated.getGlobalRole("operator").agentBindings.codex.config.search,
    true
  );

  const clearInput = new PassThrough();
  const clearOutput = new PassThrough();
  clearInput.end("all\n\n\n\n\ndefault\ndefault\n\nskip\n");
  await assert.doesNotReject(runSetupCommand(
    [], env, executor,
    { input: clearInput, output: clearOutput, forceInteractive: true }
  ));
  assert.deepEqual(
    new FileTaskStore(home).getGlobalRole("operator").agentBindings.codex.config,
    {
      adapterId: "codex",
      permission: { sandbox: "workspace-write", approval: "never" },
      search: true
    }
  );

  const { createRoleSessionSet, recordRoleAgentSession } = await import(
    "../../dist/executor/agentExecutor.js"
  );
  const now = new Date("2026-07-25T00:00:00.000Z");
  store.saveGlobalRoleSessionSet(recordRoleAgentSession(
    createRoleSessionSet(
      { scope: "global", roleName: "operator" },
      "codex",
      now
    ),
    {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "codex-thread",
      policy: "fixed",
      status: "running"
    },
    now
  ));
  const runningInput = new PassThrough();
  const runningOutput = new PassThrough();
  runningInput.end("all\n\n\n\n\ngpt-new\n\n\n");
  await assert.rejects(runSetupCommand(
    [], env, executor,
    { input: runningInput, output: runningOutput, forceInteractive: true }
  ), /cannot be changed while its native process is running/i);
  assert.equal(
    new FileTaskStore(home).getGlobalRole("operator").agentBindings.codex.config.model,
    undefined
  );
});

test("setup rolls back config and both system Roles when one lifecycle gate rejects creation", async (t) => {
  const { runSetupCommand } = await import("../../dist/setup/setupCommand.js");
  const { ensureStorageSchema } = await import("../../dist/storage/storageSchema.js");
  const { FileTaskStore } = await import("../../dist/storage/taskStore.js");
  const root = mkdtempSync(join(tmpdir(), "yui-file-setup-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "yui-home");
  const bin = join(root, "bin");
  const userHome = join(root, "user");
  const workspace = join(root, "operator-workspace");
  mkdirSync(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(codex, 0o755);
  ensureStorageSchema(home);
  const initialConfig = {
    schemaVersion: 1,
    reconciliationIntervalSeconds: 45,
    timeZone: "Europe/London"
  };
  const store = new FileTaskStore(home);
  store.saveConfig(initialConfig);
  store.saveWorkMailbox(enqueueSignal(
    createWorkMailbox({ kind: "global-role-runtime", roleName: "leader" }),
    {
      reason: "runtime-cleanup-required",
      refs: [],
      occurredAt: "2026-07-24T00:00:00.000Z"
    }
  ));
  const input = new PassThrough();
  const output = new PassThrough();
  input.end(`codex\n\n\n${workspace}\n`);
  const env = {
    YUI_HOME: home,
    HOME: userHome,
    PATH: bin,
    SHELL: "/bin/zsh"
  };

  await assert.rejects(
    runSetupCommand(
      [],
      env,
      { run: () => "tmux 3.4" },
      { input, output, forceInteractive: true }
    ),
    /runtime lifecycle transition/i
  );

  const reloaded = new FileTaskStore(home);
  assert.deepEqual(reloaded.getConfig(), initialConfig);
  assert.equal(reloaded.getGlobalRole("operator"), null);
  assert.equal(reloaded.getGlobalRole("leader"), null);
  assert.notEqual(reloaded.getConfiguredAgent("codex"), null);
});
