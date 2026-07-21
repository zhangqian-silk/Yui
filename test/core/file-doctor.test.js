import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runDoctorCommand } from "../../dist/doctor/doctor.js";
import { CliError } from "../../dist/errors/cliError.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { CommandExecutionError } from "../../dist/tmux/commandExecutor.js";

function temporaryRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).map((entry) => {
    const path = join(root, String(entry));
    const metadata = statSync(path);
    return {
      path: relative(root, path),
      kind: metadata.isDirectory() ? "directory" : "file",
      mode: metadata.mode & 0o777,
      content: metadata.isFile() ? readFileSync(path, "utf8") : undefined
    };
  });
}

test("FileTaskStore doctor reports schema, state, tools, and configured Agent capabilities without writes", (t) => {
  const root = temporaryRoot(t, "yui-file-doctor-");
  const home = join(root, "home");
  ensureStorageSchema(home, new Date("2026-07-19T00:00:00.000Z"));
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(createConfiguredAgent(
    "codex",
    "codex",
    "codex-custom",
    [],
    [],
    new Date("2026-07-19T00:00:00.000Z")
  ));
  store.saveConfig({
    ...store.getConfig(),
    defaultAgent: "codex",
    defaultWorkspace: join(root, "workspace")
  });
  const before = snapshot(home);
  const calls = [];
  const executor = {
    run(command, args) {
      calls.push([command, args]);
      if (command === "git") return "git version 2.45.1\n";
      if (command === "tmux") return "tmux 3.4\n";
      if (command === "codex-custom" && args[0] === "--version") {
        return "codex-cli 0.144.4\n";
      }
      if (command === "codex-custom" && args[0] === "--help") {
        return "  --sandbox [possible values: read-only, workspace-write, danger-full-access]\n"
          + "  --ask-for-approval [possible values: untrusted, on-request, never]\n";
      }
      throw new CommandExecutionError("COMMAND_NOT_FOUND");
    }
  };

  const output = runDoctorCommand([], { YUI_HOME: home }, executor);

  assert.match(output, /^Yui doctor$/m);
  assert.match(output, /yui home\s+ok/);
  assert.match(output, /storage schema\s+ok\s+current=5 latest=5/);
  assert.match(output, /storage state\s+ok\s+readable agents=1/);
  assert.match(output, /git\s+ok\s+git: git version 2\.45\.1/);
  assert.match(output, /tmux\s+ok\s+tmux: tmux 3\.4/);
  assert.match(output, /agent:codex:command\s+ok\s+command=codex-custom adapter=codex version=0\.144\.4/);
  assert.match(output, /agent:codex:capability\s+ok\s+start resume interrupt nativeSession=runtime/);
  assert.deepEqual(calls, [
    ["git", ["--version"]],
    ["tmux", ["-V"]],
    ["codex-custom", ["--version"]],
    ["codex-custom", ["--help"]]
  ]);
  assert.deepEqual(snapshot(home), before);
});

test("doctor reports a missing home without creating it", (t) => {
  const root = temporaryRoot(t, "yui-file-doctor-missing-");
  const home = join(root, "does-not-exist");
  const executor = {
    run(command) {
      if (command === "git") return "git version 2.45.1";
      throw new CommandExecutionError("COMMAND_NOT_FOUND");
    }
  };

  const output = runDoctorCommand([], { YUI_HOME: home }, executor);

  assert.match(output, /yui home\s+missing\s+run yui setup/);
  assert.match(output, /storage schema\s+missing\s+run yui setup/);
  assert.match(output, /storage state\s+missing\s+run yui setup/);
  assert.match(output, /git\s+ok/);
  assert.match(output, /tmux\s+missing/);
  assert.equal(existsSync(home), false);
});

test("doctor reports an unreadable state as invalid and does not repair it", (t) => {
  const root = temporaryRoot(t, "yui-file-doctor-invalid-");
  const home = join(root, "home");
  ensureStorageSchema(home, new Date("2026-07-19T00:00:00.000Z"));
  const statePath = join(home, "state.json");
  writeFileSync(statePath, "{not json}\n", { mode: 0o600 });
  const before = snapshot(home);

  const output = runDoctorCommand([], { YUI_HOME: home }, {
    run(command) { return command === "git" ? "git version 2.45.1" : "tmux 3.4"; }
  });

  assert.match(output, /storage schema\s+ok/);
  assert.match(output, /storage state\s+invalid\s+Invalid state\.json/);
  assert.equal(readFileSync(statePath, "utf8"), "{not json}\n");
  assert.deepEqual(snapshot(home), before);
});

test("doctor rejects operands before inspecting storage or running commands", () => {
  let calls = 0;
  assert.throws(
    () => runDoctorCommand(["repair"], { YUI_HOME: "/does/not/matter" }, {
      run() { calls += 1; return ""; }
    }),
    (error) => error instanceof CliError
      && error.code === "USAGE_ERROR"
      && /yui doctor/.test(error.message)
  );
  assert.equal(calls, 0);
});
