import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  configuredAgentToDefinition,
  createConfiguredAgent
} from "../../dist/agent/agent.js";
import { supportedAgentAdapterIds } from "../../dist/agent/adapterCatalog.js";
import { validateAgentRawArguments } from "../../dist/agent/argumentPolicy.js";
import {
  inspectAgentCapabilities,
  resolveAgentAdapter
} from "../../dist/executor/agentAdapter.js";

const NOW = new Date("2026-07-19T00:00:00.000Z");

function configured(id, adapterId, command, baseArgs = []) {
  return configuredAgentToDefinition(createConfiguredAgent(
    id,
    adapterId,
    command,
    baseArgs,
    [],
    NOW
  ));
}

test("ConfiguredAgent is a serializable adapter-owned FileTaskStore record", () => {
  const record = createConfiguredAgent(
    " reviewer ",
    "codex",
    " codex-wrapper ",
    ["--no-alt-screen"],
    [{ target: "OPENAI_API_KEY", source: "process", sourceName: "OPENAI_API_KEY", required: true }],
    NOW
  );
  assert.deepEqual(JSON.parse(JSON.stringify(record)), {
    schemaVersion: 2,
    id: "reviewer",
    adapterId: "codex",
    command: "codex-wrapper",
    baseArgs: ["--no-alt-screen"],
    environment: [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "OPENAI_API_KEY",
      required: true
    }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  });
});

test("Agent adapters expose the stable Codex and Claude catalog", () => {
  assert.deepEqual(supportedAgentAdapterIds(), ["claude", "codex"]);

  const codex = resolveAgentAdapter("codex");
  assert.equal(codex.supportedVersion, "0.144.1");
  assert.deepEqual(codex.capabilities, {
    recover: true,
    interrupt: true,
    nativeSessionDiscovery: "runtime"
  });

  const claude = resolveAgentAdapter("claude");
  assert.equal(claude.supportedVersion, "2.1.207");
  assert.equal(claude.capabilities.nativeSessionDiscovery, "preallocated");
  assert.throws(() => resolveAgentAdapter("unknown"), /unsupported/i);
});

test("rawArgs cannot take ownership of structured, lifecycle, or secret-bearing options", () => {
  for (const argument of [
    "--model=gpt-test",
    "--search",
    "resume",
    "-mp",
    "--",
    "--api-key=sk-sensitive-value"
  ]) {
    assert.throws(
      () => validateAgentRawArguments("codex", [argument]),
      /reserved|secret/i,
      argument
    );
  }
  for (const argument of ["--resume=session", "--permission-mode", "-pr", "--allowedTools"]) {
    assert.throws(
      () => validateAgentRawArguments("claude", [argument]),
      /reserved/i,
      argument
    );
  }

  assert.doesNotThrow(() => validateAgentRawArguments("codex", ["--no-alt-screen"]));
  assert.doesNotThrow(() => validateAgentRawArguments("claude", ["--verbose"]));
});

test("Codex structured config compiles deterministically for new and resume launches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-agent-adapter-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const canonicalFirst = await realpath(first);
  const canonicalSecond = await realpath(second);
  const agent = configured("codex-personal", "codex", "/opt/bin/codex", ["--no-alt-screen"]);
  const config = {
    adapterId: "codex",
    model: "gpt-test",
    effort: "high",
    permission: { sandbox: "workspace-write", approval: "on-request" },
    search: true,
    profile: "work",
    additionalDirectories: [second, first, second],
    advanced: { rawArgs: ["--ansi"] }
  };
  const adapter = resolveAgentAdapter("codex");
  const compiled = adapter.compileNew({
    agent,
    config,
    workspace: root,
    systemPrompt: "review carefully"
  });

  assert.deepEqual(compiled.argv, [
    "--no-alt-screen",
    "--config", "check_for_update_on_startup=false",
    "--model", "gpt-test",
    "--config", "model_reasoning_effort=\"high\"",
    "--sandbox", "workspace-write",
    "--ask-for-approval", "on-request",
    "--search",
    "--profile", "work",
    "--add-dir", canonicalFirst,
    "--add-dir", canonicalSecond,
    "--ansi"
  ]);
  assert.equal(compiled.sessionStrategy, "runtime-discovery");
  assert.deepEqual(
    adapter.compileResume({
      agent,
      config,
      workspace: root,
      systemPrompt: "review carefully",
      nativeSessionId: "codex-session"
    }).argv,
    [...compiled.argv, "resume", "codex-session"]
  );
  assert.ok(!compiled.argv.some((argument) => argument.startsWith("Yui setup:")));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Claude structured config compiles permissions and preallocated session lifecycle", () => {
  const agent = configured("claude-personal", "claude", "claude-wrapper");
  const config = {
    adapterId: "claude",
    model: "sonnet",
    effort: "high",
    permission: {
      mode: "acceptEdits",
      allowedTools: ["Read", "Bash(git status)"],
      disallowedTools: ["WebFetch"]
    },
    settingsFile: "/tmp/claude-settings.json",
    settingsSources: ["user", "project"],
    advanced: { rawArgs: ["--verbose"] }
  };
  const adapter = resolveAgentAdapter("claude");
  const compiled = adapter.compileNew({ agent, config, workspace: "/tmp" });

  assert.deepEqual(compiled.argv, [
    "--model", "sonnet",
    "--effort", "high",
    "--permission-mode", "acceptEdits",
    "--allowed-tools", "Read", "Bash(git status)",
    "--disallowed-tools", "WebFetch",
    "--settings", "/tmp/claude-settings.json",
    "--setting-sources", "user,project",
    "--verbose"
  ]);
  assert.equal(compiled.sessionStrategy, "preallocated");
  assert.deepEqual(
    adapter.compileResume({
      agent,
      config,
      workspace: "/tmp",
      nativeSessionId: "claude-session"
    }).argv,
    [...compiled.argv, "--resume", "claude-session"]
  );
});

test("capability inspection probes version and installed CLI metadata without launch arguments", () => {
  const calls = [];
  const result = inspectAgentCapabilities(
    configured("codex-personal", "codex", "codex-test", ["--no-alt-screen"]), {
    now: NOW,
    run(command, args) {
      calls.push([command, args]);
      if (args[0] === "--version") return { status: 0, stdout: "codex-cli 0.144.4\n", stderr: "" };
      if (args[0] === "--help") {
        return {
          status: 0,
          stdout: [
            "  --sandbox <MODE> [possible values: read-only, workspace-write, danger-full-access]",
            "  --ask-for-approval <POLICY> [possible values: untrusted, on-request, never]"
          ].join("\n"),
          stderr: ""
        };
      }
      throw new Error(`unexpected probe: ${args.join(" ")}`);
    }
    });

  assert.deepEqual(calls, [
    ["codex-test", ["--version"]],
    ["codex-test", ["--help"]]
  ]);
  assert.equal(result.installation.status, "installed");
  assert.equal(result.installation.version, "0.144.4");
  assert.deepEqual(
    result.fields.find(({ key }) => key === "permission.sandbox").choices,
    ["read-only", "workspace-write", "danger-full-access"]
  );
});
