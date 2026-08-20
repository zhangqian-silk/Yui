import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createConfiguredAgent } from "../../dist/agent/agent.js";

export function createStartupReadyClaudeAgent(
  home,
  now,
  id = "claude-startup-ready"
) {
  const command = join(home, `${id}.cjs`);
  const cliEntry = join(process.cwd(), "dist", "cli.js");
  writeFileSync(command, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const started = spawnSync(process.execPath, [${JSON.stringify(cliEntry)}, "internal", "runtime-hook"], {
  encoding: "utf8",
  env: process.env,
  input: JSON.stringify({
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: process.env.YUI_NATIVE_SESSION_ID
  })
});
if (started.status !== 0) {
  process.stderr.write(started.stderr || started.stdout || "mock Claude startup hook failed\\n");
  process.exit(started.status ?? 1);
}
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
  chmodSync(command, 0o755);
  return createConfiguredAgent(id, "claude", command, [], [], now);
}
