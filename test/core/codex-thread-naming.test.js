import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setCodexThreadName } from "../../dist/execution/codexThreadNaming.js";

test("Codex thread naming sends the bounded App Server request", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-app-server-name-"));
  const command = join(root, "fake-codex");
  writeFileSync(command, `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (message.method === "thread/name/set") {
    if (message.params.threadId !== "thread-1") process.exit(2);
    if (message.params.name !== "Yui · Task · Worker") process.exit(3);
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
});
`);
  chmodSync(command, 0o700);

  await setCodexThreadName({
    command,
    environment: process.env,
    threadId: "thread-1",
    name: "Yui · Task · Worker"
  });
});

test("Codex thread naming is bounded when App Server does not respond", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-app-server-name-timeout-"));
  const command = join(root, "fake-codex");
  writeFileSync(command, `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
});
`);
  chmodSync(command, 0o700);

  const startedAt = Date.now();
  await assert.rejects(
    setCodexThreadName({
      command,
      environment: process.env,
      threadId: "thread-1",
      name: "Yui · Bounded naming",
      timeoutMs: 500
    }),
    /Timed out setting Codex thread name/
  );
  assert.ok(Date.now() - startedAt < 1_500);
});
