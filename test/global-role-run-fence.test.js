import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runGlobalRoleCommand } from "../dist/commands/globalRoleCommands.js";
import { createGlobalRole } from "../dist/role/role.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";

const cli = join(process.cwd(), "dist", "cli.js");
const now = new Date("2026-07-14T00:00:00.000Z");

function binding(agentId, adapterId = agentId) {
  return { agentId, adapterId, config: { adapterId } };
}

function agent(id, command) {
  return {
    schemaVersion: 2,
    id,
    adapterId: id,
    command,
    baseArgs: [],
    environment: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function waitFor(predicate, failureMessage) {
  const deadline = Date.now() + 5_000;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(failureMessage));
        return;
      }
      setTimeout(inspect, 20);
    };
    inspect();
  });
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function releaseChild(child, resultPromise, release) {
  if (child === undefined || child.exitCode !== null) return;
  writeFileSync(release, "release");
  const exited = await Promise.race([
    resultPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000))
  ]);
  if (exited) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([
    resultPromise,
    new Promise((resolve) => setTimeout(resolve, 1_000))
  ]);
}

test("global role entry durably fences active-Agent switches until the direct child exits", async () => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-global-role-run-fence-"));
  const entered = join(home, "agent-entered");
  const release = join(home, "release-agent");
  const executable = join(home, "blocking-codex.js");
  writeFileSync(executable, `#!${process.execPath}
const { existsSync, writeFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.144.1\\n");
  process.exit(0);
}
writeFileSync(${JSON.stringify(entered)}, "entered");
const poll = setInterval(() => {
  if (existsSync(${JSON.stringify(release)})) {
    clearInterval(poll);
    process.exit(0);
  }
}, 20);
`);
  chmodSync(executable, 0o700);

  const store = new FileTaskStore(home);
  let enterChild;
  let enterResultPromise;
  try {
    ensureStorageSchema(home);
    store.saveConfiguredAgent(agent("codex", executable));
    store.saveConfiguredAgent(agent("claude", join(home, "unused-claude")));
    store.saveGlobalRole(createGlobalRole(
      "reviewer",
      [binding("codex"), binding("claude")],
      "codex",
      home,
      now
    ));

    enterChild = spawn(process.execPath, [cli, "role", "enter", "reviewer"], {
      env: {
        ...process.env,
        TASKMUX_CONTROLLER_MODE: "direct",
        TASKMUX_HOME: home
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    enterResultPromise = childResult(enterChild);
    await waitFor(
      () => existsSync(entered) && store.getActiveAgentRun("operator", "reviewer") !== null,
      "global role entry did not publish its active-run claim"
    );

    assert.equal(enterChild.exitCode, null);
    assert.throws(
      () => runGlobalRoleCommand(
        ["update", "reviewer", "--active-agent", "claude"],
        new FileTaskStore(home),
        { tmux: { probeRoleStatus: () => "exited" } }
      ),
      /active AgentRun/i
    );
    assert.equal(store.getGlobalRole("reviewer").activeAgentId, "codex");

    writeFileSync(release, "release");
    const result = await enterResultPromise;
    assert.deepEqual(result, {
      code: 0,
      signal: null,
      stdout: "Exited role reviewer\n",
      stderr: ""
    });
    assert.equal(store.getActiveAgentRun("operator", "reviewer"), null);

    assert.match(
      runGlobalRoleCommand(
        ["update", "reviewer", "--active-agent", "claude"],
        new FileTaskStore(home),
        { tmux: { probeRoleStatus: () => "exited" } }
      ),
      /Updated role reviewer/
    );
    assert.equal(store.getGlobalRole("reviewer").activeAgentId, "claude");
  } finally {
    if (enterResultPromise !== undefined) {
      await releaseChild(enterChild, enterResultPromise, release);
    }
    rmSync(home, { recursive: true, force: true });
  }
});
