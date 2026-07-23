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

test("config commands expose the effective timezone and persist an override", () => {
  let config = { schemaVersion: 1 };
  const store = {
    getConfig: () => structuredClone(config),
    saveConfig: (next) => { config = structuredClone(next); }
  };

  assert.match(runConfigCommand(["show"], store), /Time zone: Asia\/Shanghai/);
  assert.equal(
    runConfigCommand(["set", "--time-zone", "Europe/London"], store),
    "Time zone set to Europe/London\n"
  );
  assert.equal(config.timeZone, "Europe/London");
  assert.match(runConfigCommand(["show"], store), /Time zone: Europe\/London/);
});
