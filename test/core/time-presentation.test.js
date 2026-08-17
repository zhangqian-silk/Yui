import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TIME_ZONE,
  formatTimestamp,
  resolveTimeZone
} from "../../dist/output/timePresentation.js";
import { runConfigCommand } from "../../dist/commands/configCommands.js";

test("timestamps default to Beijing time without depending on the process timezone", () => {
  assert.equal(DEFAULT_TIME_ZONE, "Asia/Shanghai");
  assert.equal(resolveTimeZone(), "Asia/Shanghai");
  assert.equal(
    formatTimestamp("2026-07-22T15:19:19.450Z"),
    "2026-07-22 23:19:19 +08:00"
  );
});

test("timestamps support a configured IANA timezone and reject invalid values", () => {
  assert.equal(
    formatTimestamp("2026-07-22T15:19:19.450Z", "America/New_York"),
    "2026-07-22 11:19:19 -04:00"
  );
  assert.throws(() => resolveTimeZone("not/a-zone"), /timeZone.*IANA/i);
  assert.throws(() => formatTimestamp("not-a-time"), /timestamp/i);
});

test("config commands expose effective recovery settings and persist overrides", () => {
  let config = { schemaVersion: 1 };
  const store = {
    transaction: (execute) => execute(store),
    getConfig: () => structuredClone(config),
    saveConfig: (next) => { config = structuredClone(next); }
  };

  assert.equal(
    runConfigCommand(["show"], store),
    "Time zone: Asia/Shanghai\nReconciliation interval: 120 seconds\n"
      + "Leader next-action mode: display\n"
      + "Resources GC mode: report\n"
  );
  assert.equal(
    runConfigCommand(["set", "--time-zone", "Europe/London"], store),
    "Time zone set to Europe/London\n"
  );
  assert.equal(config.timeZone, "Europe/London");
  assert.equal(
    runConfigCommand(["set", "--reconciliation-interval-seconds", "45"], store),
    "Reconciliation interval set to 45 seconds\n"
  );
  assert.equal(config.reconciliationIntervalSeconds, 45);
  assert.equal(
    runConfigCommand(["show"], store),
    "Time zone: Europe/London\nReconciliation interval: 45 seconds\n"
      + "Leader next-action mode: display\n"
      + "Resources GC mode: report\n"
  );
});

test("review configuration stays small and reuses an existing Global Role", () => {
  let config = { schemaVersion: 1 };
  const reviewer = { name: "reviewer" };
  const store = {
    transaction: (execute) => execute(store),
    getConfig: () => structuredClone(config),
    saveConfig: (next) => { config = structuredClone(next); },
    getGlobalRole: (name) => name === reviewer.name ? reviewer : null
  };

  assert.equal(
    runConfigCommand(["review", "show"], store),
    "Review: disabled\n"
  );
  assert.equal(
    runConfigCommand(
      ["review", "set", "--role", "reviewer", "--trigger", "always"],
      store
    ),
    "Review set to reviewer (always; finding ledger: shadow)\n"
  );
  assert.deepEqual(config.review, {
    roleName: "reviewer",
    trigger: "always"
  });
  assert.equal(
    runConfigCommand(["review", "show"], store),
    "Review: reviewer (always; finding ledger: shadow)\n"
  );
  assert.equal(
    runConfigCommand(["review", "clear"], store),
    "Review disabled\n"
  );
  assert.equal(config.review, undefined);

  assert.throws(
    () => runConfigCommand(
      ["review", "set", "--role", "missing", "--trigger", "leader"],
      store
    ),
    /Global Role not found: missing/
  );
});

test("config commands reject invalid reconciliation intervals through shared validation", () => {
  const config = { schemaVersion: 1 };
  const store = {
    transaction: (execute) => execute(store),
    getConfig: () => structuredClone(config),
    saveConfig: () => assert.fail("invalid configuration must not be persisted")
  };

  for (const value of ["4", "301", "30.5", "invalid"]) {
    assert.throws(
      () => runConfigCommand(
        ["set", "--reconciliation-interval-seconds", value],
        store
      ),
      (error) => {
        assert.equal(error.code, "USAGE_ERROR");
        assert.match(error.message, /reconciliationIntervalSeconds must be an integer from 5 to 300/);
        return true;
      }
    );
  }
});

test("config commands validate and patch config inside one store transaction", () => {
  let config = { schemaVersion: 1, defaultAgent: "codex" };
  let transactionDepth = 0;
  const store = {
    transaction(execute) {
      transactionDepth += 1;
      try {
        return execute(store);
      } finally {
        transactionDepth -= 1;
      }
    },
    getConfig() {
      assert.equal(transactionDepth, 1, "config must be read inside the transaction");
      return structuredClone(config);
    },
    saveConfig(next) {
      assert.equal(transactionDepth, 1, "config must be saved inside the transaction");
      config = structuredClone(next);
    }
  };

  assert.equal(
    runConfigCommand(["set", "--time-zone", "Europe/London"], store),
    "Time zone set to Europe/London\n"
  );
  assert.deepEqual(config, {
    schemaVersion: 1,
    defaultAgent: "codex",
    timeZone: "Europe/London"
  });
});

test("config commands report invalid timezones as usage errors without starting a transaction", () => {
  const store = {
    transaction: () => assert.fail("invalid configuration must not start a write transaction"),
    getConfig: () => assert.fail("invalid configuration must not be read"),
    saveConfig: () => assert.fail("invalid configuration must not be persisted")
  };

  assert.throws(
    () => runConfigCommand(["set", "--time-zone", "not/a-zone"], store),
    (error) => {
      assert.equal(error.code, "USAGE_ERROR");
      assert.match(error.message, /timeZone must be a valid IANA timezone/);
      return true;
    }
  );
});
