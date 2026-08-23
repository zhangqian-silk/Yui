import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import { renderCompletion } from "../../dist/cli/completion.js";
import { CONFIG_KEYS } from "../../dist/commands/configCommands.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "dist", "cli.js");

/**
 * Every CLI invocation runs with a sanitized environment: the managed Task
 * runtime descriptors in the parent process must not leak into the child, or
 * the CLI requires an exact control-plane invocation.
 */
function cliEnv(home) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    YUI_HOME: home
  };
}

function isolatedHome(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  new SqliteTaskStore(home).close();
  return home;
}

function seedReviewerRole(home) {
  const store = new SqliteTaskStore(home);
  const binding = createRoleAgentBinding({ id: "claude", adapterId: "claude" });
  store.saveGlobalRole(createGlobalRole(
    "reviewer",
    [binding],
    "claude",
    home,
    new Date("2026-08-21T00:00:00.000Z")
  ));
  store.close();
}

function runCli(home, args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: cliEnv(home)
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches one rendered table row: two-space indent, label, padding, value. */
function tableRow(label, value) {
  return new RegExp(`^  ${escapeRegExp(label)}[ ]+${escapeRegExp(value)}$`, "m");
}

function assertTableFrame(output) {
  assert.match(output, /^Yui configuration$/m);
  assert.match(output, /^  Setting[ ]+Value$/m);
  assert.match(output, /^  ─+[ ]+─+$/m);
}

test("config show reports the unified effective configuration as a table", (t) => {
  const home = isolatedHome(t);
  const shown = runCli(home, ["config", "show"]);
  assert.equal(shown.status, 0);
  assertTableFrame(shown.stdout);
  for (const [label, value] of [
    ["Time zone", "Asia/Shanghai"],
    ["Reconciliation interval", "120 seconds"],
    ["Leader next-action mode", "display"],
    ["Resources GC mode", "report"],
    ["Resources GC auto-quarantine", "off"],
    ["Review", "disabled"]
  ]) {
    assert.match(shown.stdout, tableRow(label, value), `missing row: ${label}`);
  }
});

const scalarKeys = [
  {
    domain: "system",
    key: "time-zone",
    showLabel: "Time zone",
    value: "Europe/London",
    setMessage: "Time zone set to Europe/London",
    showValue: "Europe/London",
    clearMessage: "Time zone reset to Asia/Shanghai",
    defaultValue: "Asia/Shanghai",
    invalid: { value: "Not/AZone", error: /timeZone must be a valid IANA timezone/ }
  },
  {
    domain: "runtime",
    key: "reconciliation-interval-seconds",
    showLabel: "Reconciliation interval",
    value: "60",
    setMessage: "Reconciliation interval set to 60 seconds",
    showValue: "60 seconds",
    clearMessage: "Reconciliation interval reset to 120 seconds",
    defaultValue: "120 seconds",
    invalid: { value: "4", error: /must be an integer from 5 to 300/ }
  },
  {
    domain: "workflow",
    key: "leader-next-action",
    showLabel: "Leader next-action mode",
    value: "enforce",
    setMessage: "Leader next-action mode set to enforce",
    showValue: "enforce",
    clearMessage: "Leader next-action mode reset to display",
    defaultValue: "display",
    invalid: { value: "bogus", error: /must be display, warn, or enforce/ }
  },
  {
    domain: "resources",
    key: "resources-gc-mode",
    showLabel: "Resources GC mode",
    value: "quarantine",
    setMessage: "Resources GC mode set to quarantine",
    showValue: "quarantine",
    clearMessage: "Resources GC mode reset to report",
    defaultValue: "report",
    invalid: { value: "bogus", error: /must be 'report' or 'quarantine'/ }
  },
  {
    domain: "resources",
    key: "resources-gc-auto-quarantine",
    showLabel: "Resources GC auto-quarantine",
    value: "true",
    setMessage: "Resources GC auto-quarantine set to on",
    showValue: "on",
    clearMessage: "Resources GC auto-quarantine reset to off",
    defaultValue: "off",
    invalid: { value: "bogus", error: /must be a boolean/ }
  }
];

for (const key of scalarKeys) {
  test(`config set and clear round-trip the ${key.key} key`, (t) => {
    const home = isolatedHome(t);
    const set = runCli(home, ["config", key.domain, "set", key.key, key.value]);
    assert.equal(set.status, 0, set.stderr);
    assert.ok(set.stdout.includes(key.setMessage));
    assert.match(runCli(home, ["config", "show"]).stdout, tableRow(key.showLabel, key.showValue));

    const invalid = runCli(home, ["config", key.domain, "set", key.key, key.invalid.value]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, key.invalid.error);
    assert.match(invalid.stderr, /config set usage: yui config/);

    const cleared = runCli(home, ["config", key.domain, "clear", key.key]);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.ok(cleared.stdout.includes(key.clearMessage));
    assert.match(runCli(home, ["config", "show"]).stdout, tableRow(key.showLabel, key.defaultValue));
  });
}

test("new runtime, workflow, resource, and tool policies round-trip through their domains", (t) => {
  const home = isolatedHome(t);
  const commands = [
    ["runtime", "controller-task-concurrency", "8"],
    ["runtime", "agent-launch-inactivity-timeout-seconds", "180"],
    ["runtime", "delivery-timeout-seconds", "90"],
    ["runtime", "provider-retry-delays-seconds", "1,4,9,20"],
    ["runtime", "provider-retry-max-window-seconds", "300"],
    ["workflow", "leader-semantic-budget-turns", "5"],
    ["resources", "resources-quarantine-ttl-hours", "48"],
    ["tools", "tmux-history-limit", "200000"],
    ["tools", "telemetry-enabled", "true"]
  ];
  for (const [domain, key, value] of commands) {
    const result = runCli(home, ["config", domain, "set", key, value]);
    assert.equal(result.status, 0, `${domain}/${key}: ${result.stderr}`);
  }
  const health = runCli(home, [
    "config", "runtime", "set", "runtime-health",
    "--quiet-after-seconds", "120",
    "--diagnostic-after-seconds", "240",
    "--stall-after-seconds", "900"
  ]);
  assert.equal(health.status, 0, health.stderr);

  const shown = runCli(home, ["--json", "config", "show"]);
  assert.equal(shown.status, 0, shown.stderr);
  const data = JSON.parse(shown.stdout).data;
  assert.equal(data.runtime.controllerTaskConcurrency, 8);
  assert.equal(data.runtime.agentLaunchInactivityTimeoutSeconds, 180);
  assert.equal(data.runtime.deliveryTimeoutSeconds, 90);
  assert.deepEqual(data.runtime.providerRetryDelaysSeconds, [1, 4, 9, 20]);
  assert.equal(data.runtime.providerRetryMaxWindowSeconds, 300);
  assert.deepEqual(data.runtime.runtimeHealth, {
    quietAfterSeconds: 120,
    diagnosticAfterSeconds: 240,
    stallAfterSeconds: 900
  });
  assert.equal(data.workflow.leaderSemanticBudgetTurns, 5);
  assert.equal(data.resources.resourcesQuarantineTtlHours, 48);
  assert.equal(data.tools.tmuxHistoryLimit, 200000);
  assert.equal(data.tools.telemetryEnabled, true);
});

test("config workflow set review manages the optional global review rule", (t) => {
  const home = isolatedHome(t);
  seedReviewerRole(home);

  const set = runCli(home, ["config", "workflow", "set", "review", "--role", "reviewer", "--trigger", "always"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /Review set to reviewer \(always; finding ledger: shadow; delta recheck: disabled\)/);
  assert.match(
    runCli(home, ["config", "show"]).stdout,
    tableRow("Review", "reviewer (always; finding ledger: shadow)")
  );

  const upgraded = runCli(home, [
    "config", "workflow", "set", "review",
    "--role", "reviewer", "--trigger", "final", "--finding-ledger", "enforce"
  ]);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.match(upgraded.stdout, /Review set to reviewer \(final; finding ledger: enforce; delta recheck: disabled\)/);
  assert.match(
    runCli(home, ["config", "show"]).stdout,
    tableRow("Review", "reviewer (final; finding ledger: enforce)")
  );

  const cleared = runCli(home, ["config", "workflow", "clear", "review"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /Review disabled/);
  assert.match(runCli(home, ["config", "show"]).stdout, tableRow("Review", "disabled"));
});

test("config workflow set review rejects unknown Roles and malformed options", (t) => {
  const home = isolatedHome(t);

  const missingRole = runCli(home, [
    "config", "workflow", "set", "review", "--role", "missing", "--trigger", "always"
  ]);
  assert.equal(missingRole.status, 2);
  assert.match(missingRole.stderr, /Global Role not found: missing/);

  const badTrigger = runCli(home, [
    "config", "workflow", "set", "review", "--role", "reviewer", "--trigger", "bogus"
  ]);
  assert.equal(badTrigger.status, 2);
  assert.match(badTrigger.stderr, /config set usage: yui config .* set review/);

  const incomplete = runCli(home, ["config", "workflow", "set", "review", "--role", "reviewer"]);
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /config set usage: yui config .* set review/);
});

test("removed config aliases and unknown keys fail against the grouped command tree", (t) => {
  const home = isolatedHome(t);

  for (const command of ["agent", "role", "profile", "completion"]) {
    const removed = runCli(home, [command, "list"]);
    assert.equal(removed.status, 2, command);
    assert.match(removed.stderr, new RegExp(`Unknown command: ${command}`));
  }

  for (const args of [
    ["config", "review", "show"],
    ["config", "review", "set", "--role", "reviewer", "--trigger", "always"],
    ["config", "leader-next-action", "set", "enforce"],
    ["config", "leader-next-action", "clear"]
  ]) {
    const result = runCli(home, args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /Unknown command: config/);
    assert.ok(result.stderr.includes("Configuration domains:"));
  }

  const unknownSet = runCli(home, ["config", "system", "set", "bogus", "x"]);
  assert.equal(unknownSet.status, 2);
  assert.match(unknownSet.stderr, /Unknown system config key: bogus/);

  const unknownClear = runCli(home, ["config", "system", "clear", "bogus"]);
  assert.equal(unknownClear.status, 2);
  assert.match(unknownClear.stderr, /Unknown system config key: bogus/);

  for (const removedKey of [
    "provider-retry-max-window-ms", "yield-receipt-replay", "git-bin", "telemetry-mode"
  ]) {
    const removed = runCli(home, ["config", "runtime", "set", removedKey, "true"]);
    assert.equal(removed.status, 2, removedKey);
    assert.match(removed.stderr, /Unknown runtime config key/);
  }

  const noCommand = runCli(home, ["config"]);
  assert.equal(noCommand.status, 2);
  assert.match(noCommand.stderr, /Command required after: config/);
});

test("agent, role, and profile configuration execute only through config domains", (t) => {
  const home = isolatedHome(t);
  const workspace = join(tmpdir(), `yui-config-workspace-${Date.now()}`);
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const addedAgent = runCli(home, [
    "config", "agent", "add", "codex", "--command", "/bin/true"
  ]);
  assert.equal(addedAgent.status, 0, addedAgent.stderr);
  assert.equal(runCli(home, [
    "config", "system", "set", "default-agent", "codex"
  ]).status, 0);
  const invalidWorkspace = join(home, "managed-workspace");
  const rejectedWorkspace = runCli(home, [
    "config", "system", "set", "default-workspace", invalidWorkspace
  ]);
  assert.equal(rejectedWorkspace.status, 2);
  assert.match(rejectedWorkspace.stderr, /outside YUI_HOME/);
  assert.equal(existsSync(invalidWorkspace), false);
  assert.equal(runCli(home, [
    "config", "system", "set", "default-workspace", workspace
  ]).status, 0);
  const addedRole = runCli(home, [
    "config", "role", "add", "worker", "--agent", "codex", "--workspace", workspace
  ]);
  assert.equal(addedRole.status, 0, addedRole.stderr);
  const roleContext = runCli(home, ["--json", "session", "context", "worker"]);
  assert.equal(roleContext.status, 0, roleContext.stderr);
  assert.equal(JSON.parse(JSON.parse(roleContext.stdout).output).identity.roleName, "worker");
  const resetProfiles = runCli(home, ["config", "profile", "reset"]);
  assert.equal(resetProfiles.status, 0, resetProfiles.stderr);

  const shown = runCli(home, ["--json", "config", "show"]);
  assert.equal(shown.status, 0, shown.stderr);
  const data = JSON.parse(shown.stdout).data;
  assert.equal(data.system.defaultAgent, "codex");
  assert.equal(data.system.defaultWorkspace, workspace);
  assert.equal(data.system.valueSources["default-agent"], "stored");
  assert.equal(data.roles.system.worker.name, "worker");
  assert.deepEqual(data.profiles.map(({ id }) => id), [
    "explorer", "implementer", "reviewer", "worker"
  ]);
});

test("config help introduces every domain and every catalog node has examples", (t) => {
  const home = isolatedHome(t);

  const help = runCli(home, ["config", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Inspect:/);
  assert.match(help.stdout, /Configuration domains:/);
  for (const domain of [
    "system", "runtime", "workflow", "resources", "tools",
    "agent", "role", "profile", "completion"
  ]) {
    assert.match(help.stdout, new RegExp(`^  ${domain}\\s`, "m"));
  }
  assert.match(help.stdout, /Examples:/);

  const systemHelp = runCli(home, ["config", "system", "--help"]);
  assert.equal(systemHelp.status, 0);
  assert.match(systemHelp.stdout, /show\s+Show effective system configuration/);
  assert.match(systemHelp.stdout, /set\s+Set one system configuration key/);
  assert.match(systemHelp.stdout, /clear\s+Reset one system configuration key/);

  for (const [domain, keys] of Object.entries({
    system: ["time-zone"],
    runtime: ["reconciliation-interval-seconds", "runtime-health", "provider-retry-delays-seconds"],
    workflow: ["leader-next-action", "leader-semantic-budget-turns", "review"],
    resources: ["resources-gc-mode", "resources-gc-auto-quarantine", "resources-quarantine-ttl-hours"],
    tools: ["tmux-bin", "tmux-history-limit", "telemetry-enabled"]
  })) {
    for (const command of ["set", "clear"]) {
      const keyHelp = runCli(home, ["config", domain, command, "--help"]);
      assert.equal(keyHelp.status, 0);
      assert.match(keyHelp.stdout, /Configuration keys:/);
      for (const key of keys) {
        assert.match(keyHelp.stdout, new RegExp(`^  ${key}\\s`, "m"));
      }
    }
  }

  const paths = listPublicCommandPaths();
  assert.ok(paths.includes("config show"));
  assert.ok(paths.includes("config system set"));
  assert.ok(paths.includes("config runtime set"));
  assert.ok(paths.includes("config workflow set"));
  assert.ok(paths.includes("config resources set"));
  assert.ok(paths.includes("config tools set"));
  assert.ok(paths.includes("config agent list"));
  assert.ok(paths.includes("config role list"));
  assert.ok(paths.includes("config profile list"));
  assert.ok(paths.includes("config completion"));
  assert.ok(paths.includes("session context"));
  assert.ok(paths.includes("session enter"));
  assert.ok(!paths.includes("agent"));
  assert.ok(!paths.includes("role"));
  assert.ok(!paths.includes("profile"));
  assert.ok(!paths.includes("completion"));
  assert.ok(!paths.includes("config role context"));
  assert.ok(!paths.includes("config review"));
  assert.ok(!paths.includes("config review set"));
  assert.ok(!paths.includes("config leader-next-action"));
});

test("config describe exposes structured effects, values, and examples without opening Home", (t) => {
  const home = join(tmpdir(), `yui-uninitialized-${Date.now()}`);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const described = runCli(home, ["--json", "config", "describe", "workflow"]);
  assert.equal(described.status, 0, described.stderr);
  const payload = JSON.parse(described.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.path, "config workflow");
  assert.ok(payload.data.examples.includes("yui config workflow show"));
  const set = payload.data.children.find(({ path }) => path === "config workflow set");
  assert.ok(set);
  assert.ok(set.values.some(({ name, summary, takesEffect }) =>
    name === "review"
    && summary.includes("disabled")
    && takesEffect.includes("next Candidate")));
  assert.deepEqual(set.optionValues["--trigger"], ["always", "leader", "final"]);

  const rejected = runCli(home, ["config", "describe", "show"]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Config describe usage/);
});

test("config completion follows the grouped catalog, including an option-like prefix", (t) => {
  const home = join(tmpdir(), `yui-completion-uninitialized-${Date.now()}`);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const domains = runCli(home, [
    "config", "completion", "candidates", "", "--", "config"
  ]);
  assert.equal(domains.status, 0, domains.stderr);
  assert.deepEqual(domains.stdout.trim().split("\n"), [
    "show", "describe", "system", "runtime", "workflow", "resources", "tools",
    "agent", "role", "profile", "completion"
  ]);

  const reviewOptions = runCli(home, [
    "config", "completion", "candidates", "--", "--", "config", "workflow", "set", "review"
  ]);
  assert.equal(reviewOptions.status, 0, reviewOptions.stderr);
  assert.match(reviewOptions.stdout, /^--role$/m);
  assert.match(reviewOptions.stdout, /^--trigger$/m);

  for (const shell of ["bash", "zsh", "fish"]) {
    const script = renderCompletion(shell);
    assert.match(script, /# yui command: config agent/);
    assert.match(script, /yui config completion candidates/);
    assert.doesNotMatch(script, /command yui completion candidates/);
  }
});

test("config show honors the stored leaderNextActionMode and review fields", (t) => {
  const home = isolatedHome(t);
  const store = new SqliteTaskStore(home);
  store.saveConfig({
    ...store.getConfig(),
    leaderNextActionMode: "enforce",
    review: { roleName: "reviewer", trigger: "always" }
  });
  store.close();

  const shown = runCli(home, ["config", "show"]);
  assert.equal(shown.status, 0, shown.stderr);
  assertTableFrame(shown.stdout);
  assert.match(shown.stdout, tableRow("Leader next-action mode", "enforce"));
  assert.match(shown.stdout, tableRow("Review", "reviewer (always; finding ledger: shadow)"));
});

test("config show --json emits the effective configuration as structured data", (t) => {
  const home = isolatedHome(t);
  const result = runCli(home, ["config", "show", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.system.timeZone, "Asia/Shanghai");
  assert.equal(payload.data.runtime.reconciliationIntervalSeconds, 120);
  assert.equal(payload.data.workflow.review, null);
  assert.equal(payload.data.system.valueSources["time-zone"], "default");
  assert.equal(payload.data.workflow.valueSources.review, "default");
  const projectedKeys = ["system", "runtime", "workflow", "resources", "tools"]
    .flatMap((domain) => Object.keys(payload.data[domain].valueSources));
  assert.deepEqual(projectedKeys, [...CONFIG_KEYS]);
  assert.deepEqual(payload.data.agents, []);
  assert.deepEqual(payload.data.roles.system, {
    operator: null,
    leader: null,
    worker: null
  });
  assert.deepEqual(payload.data.profiles, []);
  assert.deepEqual(payload.data.completion.map(({ shell, status }) => ({ shell, status })), [
    { shell: "bash", status: "Not installed" },
    { shell: "zsh", status: "Not installed" },
    { shell: "fish", status: "Not installed" }
  ]);
});

test("config show --json reflects stored leaderNextActionMode and review fields", (t) => {
  const home = isolatedHome(t);
  const store = new SqliteTaskStore(home);
  store.saveConfig({
    ...store.getConfig(),
    leaderNextActionMode: "warn",
    review: { roleName: "reviewer", trigger: "final", findingLedger: "enforce" }
  });
  store.close();

  const result = runCli(home, ["config", "show", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.workflow.leaderNextActionMode, "warn");
  assert.deepEqual(payload.data.workflow.review, {
    roleName: "reviewer",
    trigger: "final",
    findingLedger: "enforce",
    deltaRecheck: "disabled",
    deltaRecheckMaxChangedLines: 200,
    deltaRecheckMaxChangedFiles: 5
  });
});
