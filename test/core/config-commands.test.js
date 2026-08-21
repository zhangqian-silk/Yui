import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
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

test("config show reports the unified effective configuration", (t) => {
  const home = isolatedHome(t);
  const shown = runCli(home, ["config", "show"]);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /Time zone: Asia\/Shanghai/);
  assert.match(shown.stdout, /Reconciliation interval: 120 seconds/);
  assert.match(shown.stdout, /Leader next-action mode: display/);
  assert.match(shown.stdout, /Resources GC mode: report/);
  assert.match(shown.stdout, /Resources GC auto-quarantine: off/);
  assert.match(shown.stdout, /Review: disabled/);
});

const scalarKeys = [
  {
    key: "time-zone",
    value: "Europe/London",
    setMessage: "Time zone set to Europe/London",
    showLine: "Time zone: Europe/London",
    clearMessage: "Time zone reset to Asia/Shanghai",
    defaultLine: "Time zone: Asia/Shanghai",
    invalid: { value: "Not/AZone", error: /timeZone must be a valid IANA timezone/ }
  },
  {
    key: "reconciliation-interval-seconds",
    value: "60",
    setMessage: "Reconciliation interval set to 60 seconds",
    showLine: "Reconciliation interval: 60 seconds",
    clearMessage: "Reconciliation interval reset to 120 seconds",
    defaultLine: "Reconciliation interval: 120 seconds",
    invalid: { value: "4", error: /must be an integer from 5 to 300/ }
  },
  {
    key: "leader-next-action",
    value: "enforce",
    setMessage: "Leader next-action mode set to enforce",
    showLine: "Leader next-action mode: enforce",
    clearMessage: "Leader next-action mode reset to display",
    defaultLine: "Leader next-action mode: display",
    invalid: { value: "bogus", error: /must be display, warn, or enforce/ }
  },
  {
    key: "resources-gc-mode",
    value: "quarantine",
    setMessage: "Resources GC mode set to quarantine",
    showLine: "Resources GC mode: quarantine",
    clearMessage: "Resources GC mode reset to report",
    defaultLine: "Resources GC mode: report",
    invalid: { value: "bogus", error: /must be 'report' or 'quarantine'/ }
  },
  {
    key: "resources-gc-auto-quarantine",
    value: "true",
    setMessage: "Resources GC auto-quarantine set to on",
    showLine: "Resources GC auto-quarantine: on",
    clearMessage: "Resources GC auto-quarantine reset to off",
    defaultLine: "Resources GC auto-quarantine: off",
    invalid: { value: "bogus", error: /must be a boolean/ }
  }
];

for (const key of scalarKeys) {
  test(`config set and clear round-trip the ${key.key} key`, (t) => {
    const home = isolatedHome(t);
    const set = runCli(home, ["config", "set", key.key, key.value]);
    assert.equal(set.status, 0, set.stderr);
    assert.ok(set.stdout.includes(key.setMessage));
    assert.ok(runCli(home, ["config", "show"]).stdout.includes(key.showLine));

    const invalid = runCli(home, ["config", "set", key.key, key.invalid.value]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, key.invalid.error);
    assert.match(invalid.stderr, /Config set usage: yui config set/);

    const cleared = runCli(home, ["config", "clear", key.key]);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.ok(cleared.stdout.includes(key.clearMessage));
    assert.ok(runCli(home, ["config", "show"]).stdout.includes(key.defaultLine));
  });
}

test("config set review manages the global review rule through the unified keys", (t) => {
  const home = isolatedHome(t);
  seedReviewerRole(home);

  const set = runCli(home, ["config", "set", "review", "--role", "reviewer", "--trigger", "always"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /Review set to reviewer \(always; finding ledger: shadow\)/);
  assert.match(runCli(home, ["config", "show"]).stdout, /Review: reviewer \(always; finding ledger: shadow\)/);

  const upgraded = runCli(home, [
    "config", "set", "review",
    "--role", "reviewer", "--trigger", "final", "--finding-ledger", "enforce"
  ]);
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.match(upgraded.stdout, /Review set to reviewer \(final; finding ledger: enforce\)/);
  assert.match(runCli(home, ["config", "show"]).stdout, /Review: reviewer \(final; finding ledger: enforce\)/);

  const cleared = runCli(home, ["config", "clear", "review"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /Review disabled/);
  assert.match(runCli(home, ["config", "show"]).stdout, /Review: disabled/);
});

test("config set review rejects unknown Roles and malformed options", (t) => {
  const home = isolatedHome(t);

  const missingRole = runCli(home, [
    "config", "set", "review", "--role", "missing", "--trigger", "always"
  ]);
  assert.equal(missingRole.status, 2);
  assert.match(missingRole.stderr, /Global Role not found: missing/);

  const badTrigger = runCli(home, [
    "config", "set", "review", "--role", "reviewer", "--trigger", "bogus"
  ]);
  assert.equal(badTrigger.status, 2);
  assert.match(badTrigger.stderr, /Config set usage: yui config set review/);

  const incomplete = runCli(home, ["config", "set", "review", "--role", "reviewer"]);
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /Config set usage: yui config set review/);
});

test("removed strategy subcommands and unknown keys fail with unified usage", (t) => {
  const home = isolatedHome(t);

  for (const args of [
    ["config", "review", "show"],
    ["config", "review", "set", "--role", "reviewer", "--trigger", "always"],
    ["config", "leader-next-action", "set", "enforce"],
    ["config", "leader-next-action", "clear"]
  ]) {
    const result = runCli(home, args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /Unknown command: config/);
    // The error help renders the unified command group: show/set/clear only.
    assert.ok(result.stderr.includes("Set one Yui configuration key"));
    assert.ok(!result.stderr.includes("Configure WorkItem review"));
    assert.ok(!result.stderr.includes("Leader next-action/duplicate-guard"));
  }

  const unknownSet = runCli(home, ["config", "set", "bogus", "x"]);
  assert.equal(unknownSet.status, 2);
  assert.match(unknownSet.stderr, /Unknown config key: bogus/);

  const unknownClear = runCli(home, ["config", "clear", "bogus"]);
  assert.equal(unknownClear.status, 2);
  assert.match(unknownClear.stderr, /Unknown config key: bogus/);

  const noCommand = runCli(home, ["config"]);
  assert.equal(noCommand.status, 2);
  assert.match(noCommand.stderr, /Command required after: config/);
});

test("config help lists only the unified commands and documents every config key", (t) => {
  const home = isolatedHome(t);

  const help = runCli(home, ["config", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Commands:/);
  assert.match(help.stdout, /show\s+Show effective Yui configuration/);
  assert.match(help.stdout, /set\s+Set one Yui configuration key/);
  assert.match(help.stdout, /clear\s+Reset one Yui configuration key/);
  assert.doesNotMatch(help.stdout, /^  review\s/m);
  assert.doesNotMatch(help.stdout, /^  leader-next-action\s/m);

  for (const command of ["set", "clear"]) {
    const keyHelp = runCli(home, ["config", command, "--help"]);
    assert.equal(keyHelp.status, 0);
    assert.match(keyHelp.stdout, /Configuration keys:/);
    for (const key of [
      "time-zone",
      "reconciliation-interval-seconds",
      "leader-next-action",
      "resources-gc-mode",
      "resources-gc-auto-quarantine",
      "review"
    ]) {
      assert.match(keyHelp.stdout, new RegExp(`^  ${key}\\s`, "m"));
    }
  }

  const paths = listPublicCommandPaths();
  assert.ok(paths.includes("config show"));
  assert.ok(paths.includes("config set"));
  assert.ok(paths.includes("config clear"));
  assert.ok(!paths.includes("config review"));
  assert.ok(!paths.includes("config review set"));
  assert.ok(!paths.includes("config leader-next-action"));
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
  assert.match(shown.stdout, /Leader next-action mode: enforce/);
  assert.match(shown.stdout, /Review: reviewer \(always; finding ledger: shadow\)/);
});
