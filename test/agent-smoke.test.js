import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

test("real Codex CLI exposes the TaskMux session recovery contract", {
  skip: process.env.TASKMUX_SMOKE_CODEX !== "1"
}, () => {
  const help = execFileSync(process.env.TASKMUX_CODEX_BIN ?? "codex", ["resume", "--help"], {
    encoding: "utf8"
  });

  assert.match(help, /SESSION_ID/);
  assert.match(help, /Resume a previous interactive session/);
});

test("real Claude CLI exposes explicit session start and recovery contracts", {
  skip: process.env.TASKMUX_SMOKE_CLAUDE !== "1"
}, () => {
  const help = execFileSync(process.env.TASKMUX_CLAUDE_BIN ?? "claude", ["--help"], {
    encoding: "utf8"
  });

  assert.match(help, /--session-id <uuid>/);
  assert.match(help, /--resume \[value\]/);
});
