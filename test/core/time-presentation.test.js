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
    getConfig: () => structuredClone(config),
    saveConfig: (next) => { config = structuredClone(next); }
  };

  assert.equal(
    runConfigCommand(["show"], store),
    "Time zone: Asia/Shanghai\nReconciliation interval: 120 seconds\n"
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
  );
});

test("config commands reject invalid reconciliation intervals through shared validation", () => {
  const config = { schemaVersion: 1 };
  const store = {
    getConfig: () => structuredClone(config),
    saveConfig: () => assert.fail("invalid configuration must not be persisted")
  };

  for (const value of ["4", "301", "30.5", "invalid"]) {
    assert.throws(
      () => runConfigCommand(
        ["set", "--reconciliation-interval-seconds", value],
        store
      ),
      /reconciliationIntervalSeconds must be an integer from 5 to 300/
    );
  }
});
