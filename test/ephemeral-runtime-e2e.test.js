import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import {
  callController,
  ControllerClientError
} from "../dist/core/controllerClient.js";
import {
  domainIdentityPath,
  readEphemeralDomainIdentity
} from "../dist/controller/domainIdentity.js";
import { restartFileTaskController } from "../dist/controller/clientRuntime.js";
import { scanControllerResourceInventory } from "../dist/controller/resourceInventoryLinux.js";
import { createGlobalRole, createRoleAgentBinding } from "../dist/role/role.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createIsolatedRuntime } from "./helpers/isolatedRuntime.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("isolated runtime fixture records identity and tears down Controller plus Agent pane", async (t) => {
  const runtime = createIsolatedRuntime(t);
  await runtime.startController();
  const tmux = runtime.tmux();
  tmux.ensureRoleWindow(
    "task-ephemeral",
    { name: "worker", workspace: runtime.home },
    {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      env: Object.fromEntries(
        Object.entries(runtime.environment).filter(([, value]) => value !== undefined && value !== "")
      )
    }
  );
  const panes = tmux.inspectRolePaneInventory();
  assert.equal(panes.length, 1);
  assert.equal(panes[0].target.endsWith(":worker"), true);
  assert.deepEqual(runtime.identity.tmuxTargets, [panes[0].target]);
  assert.equal(runtime.identity.hostPid, process.pid);
  assert.equal(runtime.identity.token.length, 64);
});

test("Controller-created panes retain a fence across restart and expire safely", async (t) => {
  const runtime = createIsolatedRuntime(t);
  const agentCommand = join(runtime.root, "isolated-agent.sh");
  writeFileSync(agentCommand, "#!/bin/sh\nsleep 60\n", { mode: 0o700 });
  chmodSync(agentCommand, 0o700);
  const now = new Date("2026-08-06T00:00:00.000Z");
  const agent = createConfiguredAgent(
    "codex-controller-e2e",
    "codex",
    agentCommand,
    [],
    [],
    now
  );
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding(agent)],
    agent.id,
    runtime.home,
    now
  );
  new FileTaskStore(runtime.home).transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(role);
  });

  await runtime.startController();
  const ensured = await callController(runtime.home, "runtime.ensure-role-session", {
    scope: "global",
    roleName: role.name
  });
  assert.equal(ensured.sessionStarted, true);

  let recorded;
  for (let attempt = 0; attempt < 40 && recorded === undefined; attempt += 1) {
    const current = readEphemeralDomainIdentity(runtime.home);
    if (current.status === "valid" && current.identity.tmuxTargets.length > 0) {
      recorded = current.identity;
      break;
    }
    await delay(50);
  }
  assert.notEqual(recorded, undefined);
  const target = recorded.tmuxTargets[0];
  assert.match(target, /:operator$/u);

  await restartFileTaskController(runtime.home, { environment: runtime.environment });
  const afterRestart = readEphemeralDomainIdentity(runtime.home);
  assert.equal(afterRestart.status, "valid");
  assert.equal(afterRestart.identity.token, recorded.token);
  assert.ok(afterRestart.identity.tmuxTargets.includes(target));

  writeFileSync(domainIdentityPath(runtime.home), `${JSON.stringify({
    ...afterRestart.identity,
    hostPid: 99_999_999,
    hostProcessStartIdentity: "1"
  })}\n`);

  let residual;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await callController(runtime.home, "scheduler.scan", {}, { timeoutMs: 5_000 });
    } catch (error) {
      if (!(error instanceof ControllerClientError)
        || !["CONTROLLER_NOT_RUNNING", "CONTROLLER_UNAVAILABLE"].includes(error.code)) {
        throw error;
      }
    }
    residual = await scanControllerResourceInventory({
      currentHome: runtime.home,
      scope: "current",
      environment: runtime.environment
    });
    if (residual.resources.length === 0) break;
    await delay(50);
  }
  assert.deepEqual(residual.resources, []);
  assert.equal(readEphemeralDomainIdentity(runtime.home).status, "absent");
});
