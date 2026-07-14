import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import {
  enrollAgentCapabilityProbePin,
  inspectAgentCapabilitiesAsync
} from "../dist/executor/agentAdapter.js";

const now = new Date("2026-07-12T00:00:00.000Z");

function definition(id, adapterId, command, overrides = {}) {
  return {
    schemaVersion: 2,
    id,
    adapterId,
    command,
    baseArgs: [],
    environment: [],
    source: "custom",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function executable(directory, name, body) {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

function probeEnvironment(directory) {
  return {
    ...process.env,
    PATH: [directory, dirname(process.execPath), process.env.PATH]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join(delimiter)
  };
}

function pinnedDefinition(id, adapterId, directory, overrides = {}, command = adapterId) {
  const probePin = enrollAgentCapabilityProbePin(
    { adapterId, command },
    probeEnvironment(directory)
  );
  assert.ok(probePin, `Expected a probe pin for ${adapterId}.`);
  return definition(id, adapterId, command, { ...overrides, probePin });
}

test("async probes meet their total deadline when a descendant holds stdout and stderr pipes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taskmux-capability-descendant-pipe-holder-"));
  const holderStarted = join(directory, "holder-started");
  const parentSpawnedHolder = `${holderStarted}.parent`;
  const descendantMarker = join(directory, "descendant-survived");
  const holderScript = `
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(holderStarted)}, "started");
setTimeout(() => writeFileSync(${JSON.stringify(descendantMarker)}, "survived"), 1450);
setTimeout(() => {}, 1600);
`;
  try {
    executable(directory, "codex", `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(holderScript)}], {
    stdio: ["ignore", 1, 2]
  });
  writeFileSync(${JSON.stringify(parentSpawnedHolder)}, "spawned");
  process.stdout.write("codex-cli 0.144.1\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ models: [] }));
`);

    const start = Date.now();
    const snapshot = await inspectAgentCapabilitiesAsync(
      pinnedDefinition("descendant-pipe-holder", "codex", directory),
      now,
      { budgetMs: 700 }
    );
    const elapsed = Date.now() - start;

    assert.equal(snapshot.installation.status, "probe-failed");
    assert.match(snapshot.installation.reason, /timed out/i);
    assert.equal(existsSync(parentSpawnedHolder), true, "probe fixture did not spawn its pipe holder");
    assert.equal(existsSync(holderStarted), true, "descendant did not start");
    assert.ok(elapsed < 1_300, `async probe waited for a descendant-held pipe: ${elapsed}ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(existsSync(descendantMarker), false, "timeout left a probe descendant running");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
