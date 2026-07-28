import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
import {
  inspectCodexDeveloperInstructions,
  inspectCodexLaunchConfig
} from "../../dist/executor/codexConfigConflict.js";

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
  for (const argument of [
    "--resume=session",
    "--permission-mode",
    "-pr",
    "--allowedTools",
    "--name=custom",
    "-n"
  ]) {
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
    codexDeveloperInstructions: { status: "absent" },
    developerInstructions: "review carefully",
    skills: [{ id: "review", path: canonicalFirst, content: "Review skill body" }]
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
    "--config", `developer_instructions=${JSON.stringify([
      "review carefully",
      "Yui Role Skills are available at the paths below. Before performing work governed by one, read and follow its SKILL.md on demand; do not treat this list as a user message.",
      `- review: ${canonicalFirst}/SKILL.md`
    ].join("\n"))}`,
    "--ansi"
  ]);
  assert.equal(compiled.sessionStrategy, "runtime-discovery");
  assert.deepEqual(
    adapter.compileResume({
      agent,
      config,
      workspace: root,
      codexDeveloperInstructions: { status: "absent" },
      developerInstructions: "review carefully",
      skills: [{ id: "review", path: canonicalFirst, content: "Review skill body" }],
      nativeSessionId: "codex-session"
    }).argv,
    [...compiled.argv, "resume", "codex-session"]
  );
  assert.ok(!compiled.argv.some((argument) => argument.startsWith("Yui setup:")));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Codex refuses to replace native developer_instructions from the effective config", async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), "yui-codex-config-"));
  await writeFile(
    join(codexHome, "config.toml"),
    'developer_instructions = "native safety policy"\n',
    { mode: 0o600 }
  );
  const workspace = join(codexHome, "workspace");
  await mkdir(workspace);
  const adapter = resolveAgentAdapter("codex");

  assert.throws(() => adapter.compileNew({
    agent: configured("codex-personal", "codex", "/opt/bin/codex"),
    config: { adapterId: "codex" },
    workspace,
    codexDeveloperInstructions: inspectCodexDeveloperInstructions({
      environment: { CODEX_HOME: codexHome },
      workspace,
      systemConfigPath: join(codexHome, "missing-system.toml"),
      managedConfigPath: join(codexHome, "missing-managed.toml")
    }),
    developerInstructions: "Yui Role policy"
  }), /developer_instructions.*already configured/i);

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(codexHome, { recursive: true, force: true }));
  });
});

test("Codex config inspection applies the selected profile file and project layer", async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), "yui-codex-layers-"));
  const workspace = join(codexHome, "workspace");
  const projectConfig = join(workspace, ".codex");
  const systemConfigPath = join(codexHome, "missing-system.toml");
  const managedConfigPath = join(codexHome, "missing-managed.toml");
  const inspection = (profile) => inspectCodexDeveloperInstructions({
    environment: { CODEX_HOME: codexHome },
    workspace,
    ...(profile === undefined ? {} : { profile }),
    systemConfigPath,
    managedConfigPath
  });
  await mkdir(projectConfig, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), "", { mode: 0o600 });

  assert.equal(inspection("missing").status, "absent");
  const unreadableProfile = join(codexHome, "blocked.config.toml");
  await writeFile(unreadableProfile, "", { mode: 0o600 });
  await chmod(unreadableProfile, 0o000);
  assert.throws(
    () => inspection("blocked"),
    /could not be inspected.*blocked\.config\.toml/i
  );
  await chmod(unreadableProfile, 0o600);

  await writeFile(
    join(codexHome, "work.config.toml"),
    'developer_instructions = "selected profile"\n',
    { mode: 0o600 }
  );
  assert.deepEqual(inspection("work"), {
    status: "configured",
    source: join(codexHome, "work.config.toml")
  });

  await writeFile(join(codexHome, "work.config.toml"), "", { mode: 0o600 });
  await writeFile(
    join(codexHome, "config.toml"),
    `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
    { mode: 0o600 }
  );
  await writeFile(
    join(projectConfig, "config.toml"),
    '"developer_instructions" = "project policy"\n',
    { mode: 0o600 }
  );
  assert.deepEqual(inspection("work"), {
    status: "configured",
    source: join(projectConfig, "config.toml")
  });

  await writeFile(
    join(codexHome, "config.toml"),
    `[projects.${JSON.stringify(workspace)}]\ntrust_level = "untrusted"\n`,
    { mode: 0o600 }
  );
  assert.equal(inspection("work").status, "absent");

  await writeFile(join(projectConfig, "config.toml"), "", { mode: 0o600 });
  await writeFile(
    join(codexHome, "work.config.toml"),
    String.raw`"\u0064eveloper_instructions" = "escaped selected policy"` + "\n",
    { mode: 0o600 }
  );
  assert.deepEqual(inspection("work"), {
    status: "configured",
    source: join(codexHome, "work.config.toml")
  });

  await writeFile(join(codexHome, "work.config.toml"), "", { mode: 0o600 });
  await writeFile(
    join(codexHome, "config.toml"),
    String.raw`"\u0064eveloper_instructions" = "escaped root policy"` + "\n",
    { mode: 0o600 }
  );
  assert.deepEqual(inspection(), {
    status: "configured",
    source: join(codexHome, "config.toml")
  });

  await writeFile(
    join(codexHome, "config.toml"),
    [
      String.raw`"\U00000066oo" = "valid unrelated Unicode key"`,
      'note = "developer_instructions in a value is not a setting"',
      "# developer_instructions = \"comment only\"",
      "[nested]",
      'developer_instructions = "nested value"'
    ].join("\n"),
    { mode: 0o600 }
  );
  assert.equal(inspection().status, "absent");

  await writeFile(
    join(codexHome, "config.toml"),
    String.raw`"\U00000064eveloper_instructions" = "eight-digit escape"` + "\n",
    { mode: 0o600 }
  );
  assert.deepEqual(inspection(), {
    status: "configured",
    source: join(codexHome, "config.toml")
  });

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(codexHome, { recursive: true, force: true }));
  });
});

test("Codex config inspection lexes comments and string boundaries without hiding managed keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-codex-config-lexer-"));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const configPath = join(codexHome, "config.toml");
  await mkdir(codexHome);
  await mkdir(workspace);
  const inspect = () => inspectCodexLaunchConfig({
    environment: { CODEX_HOME: codexHome },
    workspace,
    systemConfigPath: join(root, "missing-system.toml"),
    managedConfigPath: join(root, "missing-managed.toml")
  });

  await writeFile(
    configPath,
    [
      'ordinary = 1 # a comment containing """ and \'\'\'',
      'basic = "a # is data and \'\'\' is not a multiline opener"',
      String.raw`escaped_basic = "escaped \"\"\" stays in one basic string"`,
      "literal = 'a # is data and \"\"\" is not a multiline opener'",
      'developer_instructions = "native policy"',
      'notify = ["native-notifier"]'
    ].join("\n"),
    { mode: 0o600 }
  );
  assert.deepEqual(inspect(), {
    developerInstructions: { status: "configured", source: configPath },
    notify: { status: "configured", source: configPath }
  });

  await writeFile(
    configPath,
    [
      'ordinary = """',
      "developer_instructions = \"multiline content, not a root assignment\"",
      "''' is still ordinary content in a multiline basic string",
      '"""',
      "literal = '''",
      'notify = ["multiline content, not a root assignment"]',
      '""" is still ordinary content in a multiline literal string',
      "'''",
      'notify = ["native-notifier"]'
    ].join("\n"),
    { mode: 0o600 }
  );
  assert.deepEqual(inspect(), {
    developerInstructions: { status: "absent" },
    notify: { status: "configured", source: configPath }
  });

  for (const malformed of [
    'ordinary = """\nunterminated',
    'ordinary = "unterminated',
    "ordinary = 'unterminated",
    'ordinary = 1 """not a legal second value"""\nnotify = ["must-not-be-hidden"]',
    'ordinary = [\nnotify = ["not an array element"]\n]',
    "this is not a TOML assignment\nnotify = [\"hidden-after-ambiguous-line\"]"
  ]) {
    await writeFile(configPath, malformed, { mode: 0o600 });
    assert.throws(
      inspect,
      /could not be inspected reliably.*(?:ambiguous|unterminated)/i
    );
  }

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Codex config inspection cannot miss a project layer behind custom root markers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-codex-project-root-"));
  const codexHome = join(root, "codex-home");
  const project = join(root, "project");
  const workspace = join(project, "nested", "workspace");
  const projectConfig = join(project, ".codex", "config.toml");
  await mkdir(codexHome);
  await mkdir(workspace, { recursive: true });
  await mkdir(join(project, ".codex"));
  await writeFile(
    join(codexHome, "config.toml"),
    [
      "project_root_markers = [",
      '  ".custom-root", # valid multiline TOML array',
      "]",
      `[projects.${JSON.stringify(project)}]`,
      'trust_level = "trusted"'
    ].join("\n"),
    { mode: 0o600 }
  );
  await writeFile(join(project, ".custom-root"), "", { mode: 0o600 });
  await writeFile(
    projectConfig,
    'developer_instructions = "project policy"\n',
    { mode: 0o600 }
  );

  assert.deepEqual(inspectCodexDeveloperInstructions({
    environment: { CODEX_HOME: codexHome },
    workspace,
    systemConfigPath: join(root, "missing-system.toml"),
    managedConfigPath: join(root, "missing-managed.toml")
  }), {
    status: "configured",
    source: projectConfig
  });

  await writeFile(
    join(codexHome, "config.toml"),
    [
      'project_root_markers = ["nested/.."]',
      `[projects.${JSON.stringify(project)}]`,
      'trust_level = "trusted"'
    ].join("\n")
  );
  assert.equal(inspectCodexDeveloperInstructions({
    environment: { CODEX_HOME: codexHome },
    workspace,
    systemConfigPath: join(root, "missing-system.toml"),
    managedConfigPath: join(root, "missing-managed.toml")
  }).status, "configured");

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Codex project trust accepts standard TOML forms and does not inherit arbitrary ancestors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-codex-trust-semantics-"));
  const codexHome = join(root, "codex-home");
  const project = join(root, "project");
  const workspace = join(project, "nested");
  const projectConfig = join(project, ".codex", "config.toml");
  await mkdir(codexHome);
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, ".codex"));
  await mkdir(workspace);
  await writeFile(projectConfig, 'developer_instructions = "project policy"\n');
  const inspect = () => inspectCodexDeveloperInstructions({
    environment: { CODEX_HOME: codexHome },
    workspace,
    systemConfigPath: join(root, "missing-system.toml"),
    managedConfigPath: join(root, "missing-managed.toml")
  });

  await writeFile(
    join(codexHome, "config.toml"),
    `projects.${JSON.stringify(project)}.trust_level = "trusted"\n`
  );
  assert.deepEqual(inspect(), { status: "configured", source: projectConfig });

  await writeFile(
    join(codexHome, "config.toml"),
    `projects = { ${JSON.stringify(project)} = { trust_level = "trusted" } }\n`
  );
  assert.deepEqual(inspect(), { status: "configured", source: projectConfig });

  await writeFile(
    join(codexHome, "config.toml"),
    `[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`
  );
  assert.equal(inspect().status, "absent");

  await writeFile(
    join(codexHome, "config.toml"),
    `[projects.${JSON.stringify(project)}]\ntrust_level = "maybe"\n`
  );
  assert.throws(inspect, /trust_level must be trusted or untrusted/i);

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Codex project layers are trusted independently and linked worktrees use the main root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-codex-worktree-trust-"));
  const codexHome = join(root, "codex-home");
  const main = join(root, "main");
  const worktree = join(root, "linked");
  await mkdir(codexHome);
  execFileSync("git", ["init", "-q", main]);
  execFileSync("git", ["-C", main, "config", "user.email", "yui@example.invalid"]);
  execFileSync("git", ["-C", main, "config", "user.name", "Yui Test"]);
  await writeFile(join(main, "README.md"), "test\n");
  execFileSync("git", ["-C", main, "add", "README.md"]);
  execFileSync("git", ["-C", main, "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", main, "worktree", "add", "-q", worktree]);
  const rootConfig = join(worktree, ".codex", "config.toml");
  const nested = join(worktree, "nested");
  await mkdir(join(worktree, ".codex"));
  await mkdir(join(nested, ".codex"), { recursive: true });
  await writeFile(rootConfig, 'developer_instructions = "root policy"\n');
  await writeFile(
    join(nested, ".codex", "config.toml"),
    'developer_instructions = "untrusted nested policy"\n'
  );
  await writeFile(
    join(codexHome, "config.toml"),
    [
      `[projects.${JSON.stringify(main)}]`,
      'trust_level = "trusted"',
      `[projects.${JSON.stringify(nested)}]`,
      'trust_level = "untrusted"'
    ].join("\n")
  );

  assert.deepEqual(inspectCodexDeveloperInstructions({
    environment: { CODEX_HOME: codexHome },
    workspace: nested,
    systemConfigPath: join(root, "missing-system.toml"),
    managedConfigPath: join(root, "missing-managed.toml")
  }), { status: "configured", source: rootConfig });

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("managed Codex policy cannot enable project discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-codex-managed-trust-"));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "project");
  const managedConfigPath = join(root, "managed.toml");
  await mkdir(codexHome);
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".codex"));
  await writeFile(join(codexHome, "config.toml"), "");
  await writeFile(
    managedConfigPath,
    `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`
  );
  await writeFile(
    join(workspace, ".codex", "config.toml"),
    'developer_instructions = "must remain undiscovered"\n'
  );

  assert.equal(inspectCodexDeveloperInstructions({
    environment: { CODEX_HOME: codexHome },
    workspace,
    systemConfigPath: join(root, "missing-system.toml"),
    managedConfigPath
  }).status, "absent");

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Codex config inspection includes system and managed defaults and fails closed when unreadable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-codex-host-layers-"));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const systemConfigPath = join(root, "system-config.toml");
  const managedConfigPath = join(root, "managed-config.toml");
  await mkdir(codexHome);
  await mkdir(workspace);
  await writeFile(join(codexHome, "config.toml"), "", { mode: 0o600 });
  const inspect = () => inspectCodexDeveloperInstructions({
    environment: { CODEX_HOME: codexHome },
    workspace,
    systemConfigPath,
    managedConfigPath
  });

  await writeFile(
    systemConfigPath,
    'developer_instructions = "system policy"\n',
    { mode: 0o600 }
  );
  assert.deepEqual(inspect(), {
    status: "configured",
    source: systemConfigPath
  });

  await writeFile(systemConfigPath, "", { mode: 0o600 });
  await writeFile(
    managedConfigPath,
    'developer_instructions = "managed policy"\n',
    { mode: 0o600 }
  );
  assert.deepEqual(inspect(), {
    status: "configured",
    source: managedConfigPath
  });

  await chmod(managedConfigPath, 0o000);
  assert.throws(inspect, /could not be inspected.*managed-config\.toml/i);
  await chmod(managedConfigPath, 0o600);

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Codex launch inspection ignores project notify and detects owned native layers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-codex-notify-layers-"));
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "project", "workspace");
  const systemConfigPath = join(root, "system-config.toml");
  const userConfigPath = join(codexHome, "config.toml");
  const profileConfigPath = join(codexHome, "work.config.toml");
  const projectConfigPath = join(workspace, ".codex", "config.toml");
  const managedConfigPath = join(root, "managed-config.toml");
  const paths = [
    systemConfigPath,
    userConfigPath,
    profileConfigPath,
    projectConfigPath,
    managedConfigPath
  ];
  await mkdir(codexHome);
  await mkdir(join(workspace, ".codex"), { recursive: true });
  const clear = async () => {
    await Promise.all(paths.map((path) => writeFile(path, "", { mode: 0o600 })));
  };
  const inspect = () => inspectCodexLaunchConfig({
    environment: { CODEX_HOME: codexHome },
    workspace,
    profile: "work",
    systemConfigPath,
    managedConfigPath
  });

  for (const path of paths.filter((path) => path !== projectConfigPath)) {
    await clear();
    await writeFile(path, 'notify = ["native-notifier"]\n', { mode: 0o600 });
    assert.deepEqual(inspect(), {
      developerInstructions: { status: "absent" },
      notify: { status: "configured", source: path }
    });
  }

  await clear();
  await writeFile(
    userConfigPath,
    `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
    { mode: 0o600 }
  );
  await writeFile(projectConfigPath, 'notify = ["project-notifier"]\n', { mode: 0o600 });
  assert.equal(inspect().notify.status, "absent");

  await clear();
  await writeFile(
    userConfigPath,
    String.raw`"\u006eotify" = ["escaped-notifier"]` + "\n",
    { mode: 0o600 }
  );
  assert.deepEqual(inspect().notify, {
    status: "configured",
    source: userConfigPath
  });

  await clear();
  await chmod(managedConfigPath, 0o000);
  assert.throws(inspect, /could not be inspected.*managed-config\.toml/i);
  await chmod(managedConfigPath, 0o600);

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Codex config inspection follows the launch HOME when CODEX_HOME is unset", async (t) => {
  const launchHome = await mkdtemp(join(tmpdir(), "yui-codex-launch-home-"));
  const codexHome = join(launchHome, ".codex");
  const workspace = join(launchHome, "workspace");
  await mkdir(codexHome, { recursive: true });
  await mkdir(workspace);
  await writeFile(
    join(codexHome, "config.toml"),
    'developer_instructions = "launch-home policy"\n',
    { mode: 0o600 }
  );

  assert.deepEqual(inspectCodexDeveloperInstructions({
    environment: { HOME: launchHome },
    workspace,
    systemConfigPath: join(launchHome, "missing-system.toml"),
    managedConfigPath: join(launchHome, "missing-managed.toml")
  }), {
    status: "configured",
    source: join(codexHome, "config.toml")
  });

  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(launchHome, { recursive: true, force: true }));
  });
});

test("Claude structured config compiles permissions and preallocated session lifecycle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-claude-context-"));
  const contextFile = join(root, "runtime", "session-contexts", "role.md");
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
  const compiled = adapter.compileNew({
    agent,
    config,
    workspace: "/tmp",
    developerInstructions: "Lead safely.",
    managedContextFile: contextFile,
    skills: [{ id: "yui-leader", path: "/skills/yui-leader", content: "Leader skill body." }]
  });

  assert.deepEqual(compiled.argv, [
    "--model", "sonnet",
    "--effort", "high",
    "--permission-mode", "acceptEdits",
    "--allowed-tools", "Read", "Bash(git status)",
    "--disallowed-tools", "WebFetch",
    "--settings", "/tmp/claude-settings.json",
    "--setting-sources", "user,project",
    "--append-system-prompt-file", contextFile,
    "--verbose"
  ]);
  assert.equal(
    await readFile(contextFile, "utf8"),
    "Lead safely.\n\n# Yui Skill: yui-leader\n\nLeader skill body."
  );
  assert.equal((await stat(contextFile)).mode & 0o777, 0o600);
  assert.equal(compiled.sessionStrategy, "preallocated");
  assert.deepEqual(
    adapter.compileResume({
      agent,
      config,
      workspace: "/tmp",
      developerInstructions: "Lead safely.",
      managedContextFile: contextFile,
      skills: [{ id: "yui-leader", path: "/skills/yui-leader", content: "Leader skill body." }],
      nativeSessionId: "claude-session"
    }).argv,
    [...compiled.argv, "--resume", "claude-session"]
  );
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
});

test("Claude writes large native session context to a private managed file instead of argv", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yui-claude-large-context-"));
  const contextFile = join(root, "managed", "role.md");
  const content = "x".repeat(140 * 1024);
  const adapter = resolveAgentAdapter("claude");
  const compiled = adapter.compileNew({
    agent: configured("claude-personal", "claude", "claude-wrapper"),
    config: { adapterId: "claude" },
    workspace: "/tmp",
    developerInstructions: content,
    managedContextFile: contextFile
  });

  assert.deepEqual(compiled.argv, ["--append-system-prompt-file", contextFile]);
  assert.equal(compiled.argv.some((argument) => argument.includes(content.slice(0, 1024))), false);
  assert.equal(await readFile(contextFile, "utf8"), content);
  assert.equal((await stat(contextFile)).mode & 0o777, 0o600);
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
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
            "Commands:",
            "  resume  Resume a previous session",
            "Options:",
            "  -c, --config <key=value>",
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

test("Codex compatibility uses a minimum version and required capability probe", () => {
  const inspect = (version, help) => inspectAgentCapabilities(
    configured("codex-personal", "codex", "codex-test"), {
      now: NOW,
      run(_command, args) {
        if (args[0] === "--version") {
          return { status: 0, stdout: `codex-cli ${version}\n`, stderr: "" };
        }
        if (args[0] === "--help") return { status: 0, stdout: help, stderr: "" };
        throw new Error(`unexpected probe: ${args.join(" ")}`);
      }
    }
  );
  const compatibleHelp = [
    "Commands:",
    "  resume  Resume a previous session",
    "Options:",
    "  -c, --config <key=value>",
    "  --sandbox <MODE> [possible values: read-only, workspace-write, danger-full-access]",
    "  --ask-for-approval <POLICY> [possible values: untrusted, on-request, never]"
  ].join("\n");

  const current = inspect("0.145.0", compatibleHelp);
  assert.equal(current.installation.status, "installed");
  assert.deepEqual(current.warnings, []);

  const future = inspect("0.146.0", compatibleHelp);
  assert.equal(future.installation.status, "installed");
  assert.match(future.warnings.join("\n"), /newer than.*tested/i);

  const tooOld = inspect("0.143.9", compatibleHelp);
  assert.equal(tooOld.installation.status, "unsupported-version");
  assert.match(tooOld.installation.reason, /minimum supported version.*0\.144\.1/i);

  const missingCapability = inspect("0.145.0", "Options:\n  --sandbox <MODE>");
  assert.equal(missingCapability.installation.status, "unsupported-version");
  assert.match(missingCapability.installation.reason, /--config.*resume/i);

  const failedProbe = inspectAgentCapabilities(
    configured("codex-personal", "codex", "codex-test"), {
      now: NOW,
      run(_command, args) {
        return args[0] === "--version"
          ? { status: 0, stdout: "codex-cli 0.145.0\n", stderr: "" }
          : { status: 2, stdout: "", stderr: "help failed" };
      }
    }
  );
  assert.equal(failedProbe.installation.status, "probe-failed");
  assert.match(failedProbe.installation.reason, /capability probe failed/i);
});
