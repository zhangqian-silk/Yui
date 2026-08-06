import assert from "node:assert/strict";
import test from "node:test";

import { createIsolatedRuntime } from "./helpers/isolatedRuntime.js";

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
