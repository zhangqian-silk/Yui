import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildManagedClaudeInput,
  runManagedClaudeProcess
} from "../../dist/executor/managedClaudeRunner.js";

test("managed Claude input is one newline-terminated stream-json user frame", () => {
  const prompt = "第一行\n第二行 💥";
  const encoded = buildManagedClaudeInput(prompt);

  assert.equal(encoded.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(encoded), {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }]
    }
  });
});

test("managed Claude drains output while delivering a large UTF-8 prompt on stdin", async () => {
  const prompt = "中文💥\n".repeat(32_768);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk) => { output += chunk; });

  const script = [
    "process.stdout.write('x'.repeat(128 * 1024));",
    "process.stdin.setEncoding('utf8');",
    "let buffered = '';",
    "process.stdin.on('data', chunk => {",
    "  buffered += chunk;",
    "  const newline = buffered.indexOf('\\n');",
    "  if (newline < 0) return;",
    "  const frame = JSON.parse(buffered.slice(0, newline));",
    "  process.stdout.write('\\n' + JSON.stringify({ prompt: frame.message.content[0].text }), () => process.exit(0));",
    "});"
  ].join("\n");

  const exitCode = await runManagedClaudeProcess({
    command: process.execPath,
    args: ["-e", script],
    prompt,
    stdout,
    stderr
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(output.slice(output.indexOf("\n") + 1)).prompt, prompt);
});
