import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  YUI_VERSION,
  yuiVersionIdentity
} from "../../dist/version.js";

test("Yui exposes one release identity for CLI, Controller and storage diagnostics", () => {
  assert.equal(YUI_VERSION, "0.3.0");
  assert.deepEqual(yuiVersionIdentity(), {
    version: "0.3.0",
    controllerProtocolVersion: 3,
    storageLayoutVersion: 6,
    aggregateSchemaVersion: 14
  });

  const output = execFileSync(
    process.execPath,
    [new URL("../../dist/cli.js", import.meta.url).pathname, "--json", "version"],
    { encoding: "utf8" }
  );
  assert.deepEqual(JSON.parse(output), {
    ok: true,
    data: yuiVersionIdentity()
  });
});
