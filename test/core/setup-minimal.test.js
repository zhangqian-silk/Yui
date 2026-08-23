import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runSetupCommand } from "../../dist/setup/setupCommand.js";
import { updateGlobalRole } from "../../dist/role/role.js";
import {
  initializeCompatibleTaskStore,
  openCompatibleFileTaskStore
} from "../../dist/storage/compatibleTaskStore.js";

test("setup creates only the configuration required to start Operator and execute Tasks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-setup-minimum-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  chmodSync(codex, 0o700);
  const env = {
    HOME: root,
    PATH: bin,
    YUI_HOME: home
  };
  const executor = {
    run(command, args) {
      assert.equal(command, "tmux");
      assert.deepEqual(args, ["-V"]);
      return "tmux 3.4";
    }
  };
  const setupIo = () => {
    const input = Readable.from([]);
    input.isTTY = false;
    return { input, output: new PassThrough(), forceInteractive: true };
  };

  const first = await runSetupCommand([], env, executor, setupIo());
  assert.match(first, /Operator configuration: created/);
  assert.match(first, /Leader configuration: created/);
  assert.match(first, /Setup did not configure Review, Worker, Profiles, or shell completion/);
  assert.equal(existsSync(join(home, "yui.db")), true);
  assert.equal(existsSync(join(home, "state.json")), false);

  let store = openCompatibleFileTaskStore(home);
  const config = store.getConfig();
  assert.equal(config.defaultAgent, "codex");
  assert.equal(config.review, undefined);
  assert.equal(config.completionInstallations, undefined);
  assert.deepEqual(store.listConfiguredAgents().map(({ id }) => id), ["codex"]);
  assert.deepEqual(store.listGlobalRoles().map(({ name }) => name), ["leader", "operator"]);
  assert.deepEqual(store.listAgentProfiles(), []);
  const operator = store.getGlobalRole("operator");
  assert.ok(operator);
  assert.equal(operator.agentBindings.codex.config.permission.strategy, "bypass");
  const leader = store.getGlobalRole("leader");
  assert.ok(leader);
  assert.equal(leader.activeAgentId, "codex");
  assert.equal(leader.agentBindings.codex.config.permission.strategy, "bypass");

  const createdTask = runTaskCommand(["create", "Verify minimum setup"], store);
  assert.equal(createdTask.kind, "output");
  const task = store.listTasks()[0];
  assert.ok(task);
  const taskLeader = store.getRole(task.id, "leader");
  assert.ok(taskLeader);
  assert.equal(taskLeader.activeAgentId, "codex");
  assert.equal(taskLeader.agentBindings.codex.config.permission.strategy, "bypass");
  runTaskCommand(["activate", task.id], store);
  assert.equal(store.getTask(task.id)?.status, "active");

  store.saveGlobalRole(updateGlobalRole(operator, {
    description: "Preserve this Operator configuration"
  }, new Date("2026-08-23T00:00:00.000Z")));
  store.saveGlobalRole(updateGlobalRole(leader, {
    description: "Preserve this Leader configuration"
  }, new Date("2026-08-23T00:00:00.000Z")));

  const second = await runSetupCommand([], env, executor, setupIo());
  assert.match(second, /Operator configuration: preserved/);
  assert.match(second, /Leader configuration: preserved/);
  store = openCompatibleFileTaskStore(home);
  assert.equal(
    store.getGlobalRole("operator")?.description,
    "Preserve this Operator configuration"
  );
  assert.equal(
    store.getGlobalRole("leader")?.description,
    "Preserve this Leader configuration"
  );
  assert.deepEqual(store.listGlobalRoles().map(({ name }) => name), ["leader", "operator"]);
});

test("setup never overwrites an unavailable configured Agent with a same-id builtin", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-setup-agent-safety-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const builtinCodex = join(bin, "codex");
  writeFileSync(builtinCodex, "#!/bin/sh\nexit 0\n");
  chmodSync(builtinCodex, 0o700);

  const configuredCommand = join(root, "missing-custom-codex");
  const store = initializeCompatibleTaskStore(home);
  store.saveConfiguredAgent(createConfiguredAgent(
    "codex",
    "codex",
    configuredCommand,
    [],
    [],
    new Date("2026-08-23T00:00:00.000Z")
  ));

  const input = Readable.from([]);
  input.isTTY = false;
  await assert.rejects(
    runSetupCommand(
      [],
      { HOME: root, PATH: bin, YUI_HOME: home },
      {
        run(command, args) {
          assert.equal(command, "tmux");
          assert.deepEqual(args, ["-V"]);
          return "tmux 3.4";
        }
      },
      { input, output: new PassThrough(), forceInteractive: true }
    ),
    /Setup never overwrites an existing Agent id/
  );

  assert.equal(openCompatibleFileTaskStore(home).getConfiguredAgent("codex")?.command, configuredCommand);
});
