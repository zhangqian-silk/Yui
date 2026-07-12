import assert from "node:assert/strict";
import { test } from "node:test";

test("update runner uses exact npm argv with inherited process settings", async () => {
  const { runUpdateCommand } = await import("../dist/cli/updateCommand.js");
  let invocation;
  const status = runUpdateCommand((command, args, options) => {
    invocation = { command, args, options };
    return { pid: 1, output: [], stdout: null, stderr: null, status: 0, signal: null };
  });

  assert.equal(status, 0);
  assert.equal(invocation.command, "npm");
  assert.deepEqual(invocation.args, ["install", "--global", "@zq-silk/taskmux@latest"]);
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env, process.env);
  assert.equal(invocation.options.cwd, process.cwd());
});

test("update runner propagates npm failures", async () => {
  const { runUpdateCommand } = await import("../dist/cli/updateCommand.js");
  const status = runUpdateCommand(() => ({
    pid: 1,
    output: [],
    stdout: null,
    stderr: null,
    status: 7,
    signal: null
  }));

  assert.equal(status, 7);
});

test("update runner reports spawn failures as runtime errors", async () => {
  const { runUpdateCommand } = await import("../dist/cli/updateCommand.js");

  assert.throws(
    () => runUpdateCommand(() => ({
      pid: 0,
      output: [],
      stdout: null,
      stderr: null,
      status: null,
      signal: null,
      error: new Error("npm missing")
    })),
    (error) => error.code === "RUNTIME_ERROR" && /Failed to start npm: npm missing/.test(error.message)
  );
});
