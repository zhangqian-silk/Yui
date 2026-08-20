import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  YUI_VERSION,
  yuiVersionIdentity
} from "../../dist/version.js";

test("Yui exposes one release identity for CLI, Controller and storage diagnostics", () => {
  assert.equal(typeof YUI_VERSION, "string");
  assert.deepEqual(yuiVersionIdentity(), {
    version: YUI_VERSION,
    controllerProtocolVersion: 3,
    storageLayoutVersion: 7,
    aggregateSchemaVersion: 19
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
