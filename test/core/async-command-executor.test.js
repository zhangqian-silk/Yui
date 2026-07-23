import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandExecutionError,
  NodeCommandExecutor
} from "../../dist/tmux/commandExecutor.js";

test("NodeCommandExecutor runAsync leaves the event loop available and preserves argv", async () => {
  const executor = new NodeCommandExecutor();
  let eventLoopAdvanced = false;
  const execution = executor.runAsync(process.execPath, [
    "-e",
    "setTimeout(() => process.stdout.write(process.argv[1]), 20)",
    String.raw`literal ; $HOME "quotes" \slashes`
  ], { timeoutMs: 1_000 });
  setImmediate(() => {
    eventLoopAdvanced = true;
  });

  assert.equal(await execution, String.raw`literal ; $HOME "quotes" \slashes`);
  assert.equal(eventLoopAdvanced, true);
});

test("NodeCommandExecutor runAsync reports a stable timeout", async () => {
  const executor = new NodeCommandExecutor();
  const startedAt = Date.now();

  await assert.rejects(
    executor.runAsync(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000)"
    ], {
      timeoutMs: 50
    }),
    (error) => error instanceof CommandExecutionError && error.code === "COMMAND_TIMED_OUT"
  );
  assert.ok(Date.now() - startedAt < 200, "timeout must not wait for a cooperative child exit");
});
