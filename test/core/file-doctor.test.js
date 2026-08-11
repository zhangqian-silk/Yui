import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
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
import { createUpdatePorts } from "../../dist/cli/updatePorts.js";
import { buildDoctorReport, runDoctorCommand } from "../../dist/doctor/doctor.js";
import { CliError } from "../../dist/errors/cliError.js";
import { MigrationRegistry } from "../../dist/storage/migration/index.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
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

function compatibleRegistry() {
  const registry = new MigrationRegistry();
  registry.registerCompatible({
    axis: "record",
    recordKind: "configuredAgent",
    fromVersion: 1,
    toVersion: 2,
    defaults: ["environment=[]"],
    validateSource: (snapshot) => {
      for (const agent of Object.values(snapshot.state.configuredAgents)) {
        assert.deepEqual(Object.keys(agent).sort(), [
          "adapterId", "baseArgs", "command", "createdAt", "id", "schemaVersion", "updatedAt"
        ]);
        assert.equal(agent.schemaVersion, 1);
      }
    },
    normalize: (snapshot) => ({
      ...snapshot,
      schemaManifest: {
        ...snapshot.schemaManifest,
        recordVersions: {
          ...snapshot.schemaManifest.recordVersions,
          configuredAgent: 2
        }
      },
      state: {
        ...snapshot.state,
        configuredAgents: Object.fromEntries(
          Object.entries(snapshot.state.configuredAgents).map(([id, agent]) => [
            id,
            { ...agent, schemaVersion: 2, environment: [] }
          ])
        )
      }
    })
  });
  return registry;
}

function compatibleDoctorFixture(t) {
  const root = temporaryRoot(t, "yui-file-doctor-compatible-");
  const home = join(root, "home");
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(createConfiguredAgent(
    "codex", "codex", "codex", [], [], new Date("2026-08-11T00:00:00.000Z")
  ));
  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.configuredAgents.codex.schemaVersion = 1;
  delete state.configuredAgents.codex.environment;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.recordVersions.configuredAgent = 1;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const before = snapshot(home);
  const report = buildDoctorReport(
    { YUI_HOME: home },
    { run() { throw new CommandExecutionError("COMMAND_NOT_FOUND"); } },
    { registry: compatibleRegistry(), latest: latestStorageVersionState() }
  );
  return { root, home, before, report };
}

function spawnResponse(stdout, status = 0) {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(""),
    status,
    signal: null
  };
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
        return "Usage: codex [OPTIONS] [PROMPT]\n  resume [SESSION_ID]\n"
          + "  -c, --config <key=value>\n"
          + "  --sandbox [possible values: read-only, workspace-write, danger-full-access]\n"
          + "  --ask-for-approval [possible values: untrusted, on-request, never]\n";
      }
      throw new CommandExecutionError("COMMAND_NOT_FOUND");
    }
  };

  const output = runDoctorCommand([], { YUI_HOME: home }, executor);

  assert.match(output, /^Yui doctor$/m);
  assert.match(output, /yui home\s+ok/);
  assert.match(output, /storage schema\s+ok\s+current=6 latest=6/);
  assert.match(output, /storage state\s+ok\s+readable agents=1/);
  assert.match(output, /git\s+ok\s+git: git version 2\.45\.1/);
  assert.match(output, /tmux\s+ok\s+tmux: tmux 3\.4/);
  assert.match(output, /agent:codex:command\s+ok\s+command=codex-custom adapter=codex version=0\.144\.4/);
  assert.match(output, /agent:codex:capability\s+ok\s+start resume interrupt nativeSession=runtime/);
  assert.match(output, /preInputReady=unsupported/);
  assert.deepEqual(calls, [
    ["git", ["--version"]],
    ["tmux", ["-V"]],
    ["codex-custom", ["--version"]],
    ["codex-custom", ["--help"]]
  ]);
  assert.deepEqual(snapshot(home), before);
});

test("doctor reports compatible-old storage as fully healthy without rewriting it", (t) => {
  const { home, before, report } = compatibleDoctorFixture(t);

  assert.equal(report.storage.healthy, true);
  assert.deepEqual(report.storage.blocking, []);
  for (const name of ["storage schema", "storage compatibility", "storage state"]) {
    assert.equal(report.checks.find((check) => check.name === name)?.status, "ok");
  }
  assert.deepEqual(snapshot(home), before);
});

test("real update-port verification accepts a compatible-old doctor report", (t) => {
  const { root, home, report } = compatibleDoctorFixture(t);
  const globalPrefix = join(root, "global");
  const activeBinary = join(globalPrefix, "bin", "yui");
  mkdirSync(join(globalPrefix, "bin"), { recursive: true });
  writeFileSync(activeBinary, "#!/bin/sh\n");
  const spawn = (command, args) => {
    if (command === "npm" && args.join(" ") === "prefix --global") {
      return spawnResponse(`${globalPrefix}\n`);
    }
    if (command === activeBinary && args.join(" ") === "--json doctor") {
      return spawnResponse(JSON.stringify({ ok: true, data: report }));
    }
    if (command === activeBinary && args.join(" ") === "--json version") {
      return spawnResponse(JSON.stringify({ ok: true, data: { version: "9.9.9" } }));
    }
    throw new Error(`Unexpected spawn: ${command} ${args.join(" ")}`);
  };
  const ports = createUpdatePorts({}, spawn);

  assert.doesNotThrow(() => ports.verify(
    { binaryPath: "/staged/yui", version: "9.9.9" },
    home
  ));
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
