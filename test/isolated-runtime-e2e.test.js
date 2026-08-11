import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createIsolatedRuntime } from "./helpers/isolatedRuntime.js";

test("isolated integration owns and removes its exact Controller and tmux namespace", async (t) => {
  const runtime = createIsolatedRuntime(t);
  await runtime.startController();
  const tmux = runtime.tmux();
  tmux.ensureRoleWindow(
    "task-isolated",
    { name: "worker", workspace: runtime.root },
    {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      env: runtime.environment
    }
  );

  const panes = tmux.inspectRolePaneInventory();
  assert.equal(panes.length, 1);
  assert.equal(panes[0].taskId, "task-isolated");
  assert.equal(panes[0].roleName, "worker");
  assert.equal(runtime.identity.domainKind, "ephemeral-test");
  assert.equal(runtime.identity.token.length, 64);

  await runtime.teardown();
  assert.equal(existsSync(runtime.root), false);
});

test("isolated runtime cannot redirect its owned YUI_HOME through environment overrides", async (t) => {
  const runtime = createIsolatedRuntime(t, {
    environment: { YUI_HOME: "/tmp/foreign-yui-home" }
  });

  assert.equal(runtime.environment.YUI_HOME, runtime.home);
  await runtime.teardown();
  assert.equal(existsSync(runtime.root), false);
});
