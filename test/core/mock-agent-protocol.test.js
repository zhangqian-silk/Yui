import assert from "node:assert/strict";
import test from "node:test";

import { parseMockClaudeArguments } from "../helpers/mockClaudeAgent.mjs";

function args(overrides = {}) {
  return [
    "--yui-mock-scenario", overrides.scenario ?? "normal",
    "--yui-mock-root", "/tmp/owned",
    "--yui-mock-observation", "/tmp/owned/mock.ndjson",
    "--yui-mock-ready", "/tmp/owned/ready",
    "--yui-mock-delay-ms", overrides.delay ?? "25",
    "--plugin-dir", "/tmp/owned/plugin",
    "--session-id", "native-1"
  ];
}

test("Mock Claude parser accepts only a bounded deterministic scenario", () => {
  assert.deepEqual(parseMockClaudeArguments(args()), {
    scenario: "normal",
    delayMs: 25,
    ownedRoot: "/tmp/owned",
    observationPath: "/tmp/owned/mock.ndjson",
    readyPath: "/tmp/owned/ready",
    pluginRoot: "/tmp/owned/plugin",
    nativeSessionId: "native-1"
  });
  assert.throws(
    () => parseMockClaudeArguments(args({ scenario: "arbitrary-shell" })),
    /unsupported Mock Claude scenario/i
  );
  assert.throws(
    () => parseMockClaudeArguments(args().map((value) => (
      value === "/tmp/owned/mock.ndjson" ? "/tmp/escaped.ndjson" : value
    ))),
    /paths must stay inside/i
  );
});

test("Mock Claude parser rejects missing launch identity and unbounded delays", () => {
  assert.throws(
    () => parseMockClaudeArguments(args().filter((value) => value !== "--session-id")),
    /--session-id/
  );
  for (const delay of ["-1", "1.5", "2001"]) {
    assert.throws(
      () => parseMockClaudeArguments(args({ delay })),
      /integer from 0 to 2000/
    );
  }
});
