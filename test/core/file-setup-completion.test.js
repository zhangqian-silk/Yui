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

function memoryStore(initial = { schemaVersion: 1 }) {
  let config = structuredClone(initial);
  return {
    getConfig: () => structuredClone(config),
    saveConfig: (next) => { config = structuredClone(next); }
  };
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
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-file-completion-"));
  t.after(() => rmSync(userHome, { recursive: true, force: true }));
  const store = memoryStore();
  const io = answers("3", "");

  const manager = new FileCompletionManager(store, {
      HOME: userHome,
      SHELL: "/bin/zsh",
      XDG_CONFIG_HOME: join(userHome, ".config")
    }, "taskmux-dev");
  const output = await runCompletionWizard(manager, io);

  const installation = store.getConfig().completionInstallations.fish;
  assert.ok(installation);
  assert.equal(io.prompts.length, 2);
  assert.match(io.prompts[0], /Choose shell by number or name \[zsh\] \(or skip\)/);
  assert.match(io.prompts[1], /Selected: Fish \(Install\)/);
  assert.match(output, /Completion fish installed/);
  assert.equal(existsSync(installation.scriptPath), true);
  assert.match(readFileSync(installation.scriptPath, "utf8"), /identity=taskmux-dev/);
  assert.match(readFileSync(installation.scriptPath, "utf8"), /task role/);
});

test("completion with a shell still confirms installation and startup activation", async (t) => {
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-file-completion-zsh-"));
  t.after(() => rmSync(userHome, { recursive: true, force: true }));
  const store = memoryStore();
  const io = answers("", "");

  const manager = new FileCompletionManager(
    store,
    { HOME: userHome, SHELL: "/bin/zsh", ZDOTDIR: userHome },
    "taskmux"
  );
  const output = await runCompletionWizard(manager, io, { shell: "zsh" });

  const installation = store.getConfig().completionInstallations.zsh;
  assert.ok(installation);
  assert.equal(io.prompts.length, 2);
  assert.doesNotMatch(io.prompts[0], /Choose shell/);
  assert.match(io.prompts[0], /Use these paths\? \[Y\/n\/customize\]/);
  assert.match(io.prompts[1], /Update .*\.zshrc.*\[Y\/n\]/s);
  assert.match(output, /Restart the current shell to activate completion: exec zsh/);
  assert.match(readFileSync(installation.activationPath, "utf8"), /taskmux completion shell=zsh/);
});

test("completion install keeps unrelated FileTaskStore configuration", async (t) => {
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-file-completion-config-"));
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
    "taskmux"
  );
  await runCompletionWizard(manager, io, { shell: "bash" });

  const config = store.getConfig();
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.defaultAgent, "codex");
  assert.equal(config.defaultWorkspace, "/work");
  assert.ok(config.completionInstallations.bash);
});

test("setup writes schema and configures selected Agents, default Agent, and Operator", async (t) => {
  const { runSetupCommand } = await import("../../dist/setup/setupCommand.js");
  const { FileTaskStore } = await import("../../dist/storage/taskStore.js");
  const root = mkdtempSync(join(tmpdir(), "taskmux-file-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "taskmux-home");
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
  input.end(`all\nclaude\ncodex\n${workspace}\nskip\n`);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CLI_NAME: "taskmux-dev",
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
  assert.match(rendered, /Choose Agents by number or name/);
  assert.match(rendered, /Choose default Agent \[codex\]/);
  assert.match(rendered, /Choose Operator Agent \[claude\]/);
  assert.match(result, /Completion install skipped/);

  const repeatInput = new PassThrough();
  const repeatOutput = new PassThrough();
  repeatInput.end("all\n\n\n\nskip\n");
  await assert.doesNotReject(runSetupCommand(
    [], env, executor,
    { input: repeatInput, output: repeatOutput, forceInteractive: true }
  ));
  assert.equal(new FileTaskStore(home).getGlobalRole("operator").activeAgentId, "codex");
});
