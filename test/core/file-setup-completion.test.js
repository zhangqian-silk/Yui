import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  assert.match(readFileSync(installation.scriptPath, "utf8"), /task attempt/);
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
  const { BUILTIN_PROFILE_IDS } = await import("../../dist/profile/agentProfile.js");
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
  const env = {
    YUI_HOME: home,
    YUI_CLI_NAME: "yui-dev",
    HOME: userHome,
    PATH: bin,
    SHELL: "/bin/zsh"
  };
  const executor = { run: (command) => command === "tmux" ? "tmux 3.4" : "" };

  const rejectedInput = new PassThrough();
  const rejectedOutput = new PassThrough();
  rejectedInput.end("all\nclaude\n");
  await assert.rejects(
    runSetupCommand(
      [], env, executor,
      {
        input: rejectedInput,
        output: rejectedOutput,
        forceInteractive: true
      }
    ),
    /Codex.*Execution Attempt/
  );

  input.end(
    `all\ncodex\ncodex\ngpt-5.6-sol\nxhigh\ngpt-5.6-sol\nxhigh\n${workspace}\nskip\n`
  );
  const result = await runSetupCommand(
    [], env, executor,
    { input, output, forceInteractive: true }
  );

  assert.equal(existsSync(join(home, "schema.json")), true);
  const store = new FileTaskStore(home);
  assert.deepEqual(store.listConfiguredAgents().map(({ id }) => id).sort(), ["claude", "codex"]);
  assert.equal(store.getConfig().defaultAgent, "codex");
  assert.equal(store.getConfig().defaultWorkspace, workspace);
  assert.equal(store.getGlobalRole("operator").activeAgentId, "codex");
  assert.equal(store.getGlobalRole("leader").activeAgentId, "codex");
  assert.deepEqual(
    store.listAgentProfiles().map(({ id }) => id).sort(),
    [...BUILTIN_PROFILE_IDS].sort()
  );
  assert.equal(store.getAgentProfile("worker").agentId, "codex");
  assert.equal(store.getAgentProfile("explorer").defaultAccess, "read");
  assert.equal(store.getAgentProfile("implementer").defaultAccess, "write");
  assert.equal(store.getAgentProfile("reviewer").defaultAccess, "read");
  assert.equal(existsSync(join(home, "worktrees")), false);
  assert.deepEqual(store.getGlobalRole("operator").agentBindings.codex.config, {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh"
  });
  assert.deepEqual(store.getGlobalRole("leader").agentBindings.codex.config, {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh"
  });
  assert.match(rendered, /Choose Agents by number or name/);
  assert.match(rendered, /Choose default Agent \[codex\]/);
  assert.match(rendered, /Choose Operator Agent \[codex\]/);
  assert.match(rendered, /Leader Agent configuration: codex/);
  assert.match(rendered, /Operator Agent configuration: codex/);
  assert.match(rendered, /Select model/);
  assert.match(rendered, /Select reasoning effort/);
  assert.match(result, /Leader model: gpt-5\.6-sol/);
  assert.match(result, /Leader reasoning effort: xhigh/);
  assert.match(result, /Operator model: gpt-5\.6-sol/);
  assert.match(result, /Operator reasoning effort: xhigh/);
  assert.match(result, /Project workspace:/);
  assert.match(result, /Completion install skipped/);

  const operatorWithPermissions = store.getGlobalRole("operator");
  operatorWithPermissions.agentBindings.codex.config.permission = {
    sandbox: "workspace-write",
    approval: "never"
  };
  operatorWithPermissions.agentBindings.codex.config.search = true;
  store.saveGlobalRole(operatorWithPermissions);
  const { updateAgentProfile } = await import("../../dist/profile/agentProfile.js");
  const reviewerProfile = store.getAgentProfile("reviewer");
  store.saveAgentProfile(updateAgentProfile(
    reviewerProfile,
    { description: "Custom reviewer instructions." },
    new Date(Date.parse(reviewerProfile.updatedAt) + 1_000)
  ));

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
    repeated.getGlobalRole("leader").agentBindings.codex.config.effort,
    "xhigh"
  );
  assert.deepEqual(
    repeated.getGlobalRole("operator").agentBindings.codex.config.permission,
    { sandbox: "workspace-write", approval: "never" }
  );
  assert.equal(
    repeated.getGlobalRole("operator").agentBindings.codex.config.search,
    true
  );
  assert.equal(
    repeated.getAgentProfile("reviewer").description,
    "Custom reviewer instructions."
  );

  const changedWorkspace = join(root, "other-workspace");
  const changedInput = new PassThrough();
  const changedOutput = new PassThrough();
  changedInput.end([
    "all", "", "", "", "", "", "", changedWorkspace
  ].join("\n") + "\n");
  await assert.rejects(
    runSetupCommand(
      [], env, executor,
      { input: changedInput, output: changedOutput, forceInteractive: true }
    ),
    /workspace is fixed/i
  );
  assert.equal(new FileTaskStore(home).getConfig().defaultWorkspace, workspace);

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

  const switchOperatorInput = new PassThrough();
  const switchOperatorOutput = new PassThrough();
  switchOperatorInput.end("all\n\nclaude\n\n\n\n\n\nskip\n");
  await assert.doesNotReject(runSetupCommand(
    [], env, executor,
    { input: switchOperatorInput, output: switchOperatorOutput, forceInteractive: true }
  ));
  assert.equal(
    new FileTaskStore(home).getGlobalRole("operator").activeAgentId,
    "claude"
  );
  assert.equal(
    new FileTaskStore(home).getGlobalRole("leader").activeAgentId,
    "codex"
  );

  const restoreOperatorInput = new PassThrough();
  const restoreOperatorOutput = new PassThrough();
  restoreOperatorInput.end("all\n\ncodex\n\n\n\n\n\nskip\n");
  await assert.doesNotReject(runSetupCommand(
    [], env, executor,
    { input: restoreOperatorInput, output: restoreOperatorOutput, forceInteractive: true }
  ));
  assert.equal(
    new FileTaskStore(home).getGlobalRole("operator").activeAgentId,
    "codex"
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
  ), /cannot be reconfigured.*Session is running.*rerun yui setup/i);
  assert.equal(
    new FileTaskStore(home).getGlobalRole("operator").agentBindings.codex.config.model,
    undefined
  );
});

test("setup persists the canonical Project workspace behind a symbolic-link path", async (t) => {
  const { runSetupCommand } = await import("../../dist/setup/setupCommand.js");
  const { FileTaskStore } = await import("../../dist/storage/taskStore.js");
  const root = mkdtempSync(join(tmpdir(), "yui-file-setup-canonical-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realRoot = join(root, "real");
  const aliasRoot = join(root, "alias");
  const home = join(realRoot, "yui-home");
  const bin = join(root, "bin");
  const userHome = join(realRoot, "user");
  const workspace = join(aliasRoot, "workspace");
  mkdirSync(realRoot);
  symlinkSync(realRoot, aliasRoot);
  mkdirSync(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(codex, 0o755);
  const input = new PassThrough();
  input.end([
    "all", "", "", "", "", "", "", workspace, "skip"
  ].join("\n") + "\n");

  await runSetupCommand([], {
    YUI_HOME: home,
    HOME: userHome,
    PATH: bin,
    SHELL: "/bin/zsh"
  }, {
    run: () => "tmux 3.4"
  }, {
    input,
    output: new PassThrough(),
    forceInteractive: true
  });

  const store = new FileTaskStore(home);
  const canonicalWorkspace = realpathSync(join(realRoot, "workspace"));
  assert.equal(store.getConfig().defaultWorkspace, canonicalWorkspace);
  assert.equal(store.getGlobalRole("leader").workspace, canonicalWorkspace);
  assert.equal(store.getGlobalRole("operator").workspace, canonicalWorkspace);
});

test("rejected workspace change does not persist newly discovered Agents", async (t) => {
  const { runSetupCommand } = await import("../../dist/setup/setupCommand.js");
  const { FileTaskStore } = await import("../../dist/storage/taskStore.js");
  const root = mkdtempSync(join(tmpdir(), "yui-file-setup-agent-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "yui-home");
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  mkdirSync(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(codex, 0o755);
  const baseEnv = {
    YUI_HOME: home,
    HOME: join(root, "user"),
    PATH: bin,
    SHELL: "/bin/zsh"
  };
  const first = new PassThrough();
  first.end([
    "codex", "", "", "", "", "", "", workspace, "skip"
  ].join("\n") + "\n");
  await runSetupCommand([], baseEnv, { run: () => "tmux 3.4" }, {
    input: first,
    output: new PassThrough(),
    forceInteractive: true
  });

  const claude = join(bin, "claude");
  writeFileSync(claude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(claude, 0o755);
  const changed = new PassThrough();
  changed.end([
    "all", "", "", "", "", "", "", join(root, "other-workspace")
  ].join("\n") + "\n");
  await assert.rejects(
    runSetupCommand([], baseEnv, { run: () => "tmux 3.4" }, {
      input: changed,
      output: new PassThrough(),
      forceInteractive: true
    }),
    /workspace is fixed/i
  );

  assert.deepEqual(
    new FileTaskStore(home).listConfiguredAgents().map(({ id }) => id),
    ["codex"]
  );
});

test("fresh setup keeps the Project workspace outside YUI_HOME by default", async (t) => {
  const { runSetupCommand } = await import("../../dist/setup/setupCommand.js");
  const { FileTaskStore } = await import("../../dist/storage/taskStore.js");
  const root = mkdtempSync(join(tmpdir(), "yui-file-setup-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "yui-home");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(codex, 0o755);
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  input.end([
    "codex", "", "", "", "", "", "", "", "skip"
  ].join("\n") + "\n");

  await runSetupCommand([], {
    YUI_HOME: home,
    HOME: join(root, "user"),
    PATH: bin,
    SHELL: "/bin/zsh"
  }, {
    run: () => "tmux 3.4"
  }, {
    input,
    output,
    forceInteractive: true
  });

  assert.equal(new FileTaskStore(home).getConfig().defaultWorkspace, join(root, "workspace"));
  assert.match(rendered, /Project workspace for stable checkouts and managed worktrees/);
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
  input.end([
    "codex", "", "", "", "", "", "", workspace
  ].join("\n") + "\n");
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
  assert.equal(reloaded.getConfiguredAgent("codex"), null);
});
