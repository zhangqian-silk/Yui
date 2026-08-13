import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { verifyGateRecord } from "../../scripts/verify-gate-record.mjs";

const root = resolve(import.meta.dirname, "../..");
const verifier = join(root, "scripts", "verify-gate-record.mjs");
const expectedSha = "0123456789abcdef0123456789abcdef01234567";

function freshSandbox(t) {
  const sandbox = mkdtempSync(join(root, ".verify-gate-record-test-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return sandbox;
}

function writeRecord(sandbox, record) {
  const path = join(sandbox, "gate-record.json");
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function runVerifier(args) {
  return execFileSync(process.execPath, [verifier, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
}

function assertRejected(args, reasonPattern) {
  assert.throws(
    () => runVerifier(args),
    (error) => error.status === 1 && reasonPattern.test(error.stderr ?? ""),
    `expected verifier to exit 1 with stderr matching ${reasonPattern}`
  );
}

test("verify-gate-record accepts a pass record for the exact SHA", (t) => {
  const sandbox = freshSandbox(t);
  const record = writeRecord(sandbox, { sha: expectedSha, result: "pass" });

  const output = runVerifier([record, "--expected-sha", expectedSha]);
  assert.match(output, /Gate record verified/u);
});

test("verify-gate-record rejects a record whose sha does not match", (t) => {
  const sandbox = freshSandbox(t);
  const record = writeRecord(sandbox, {
    sha: "ffffffffffffffffffffffffffffffffffffffff",
    result: "pass"
  });

  assertRejected([record, "--expected-sha", expectedSha], /does not match expected/u);
});

test("verify-gate-record rejects a record whose result is fail", (t) => {
  const sandbox = freshSandbox(t);
  const record = writeRecord(sandbox, { sha: expectedSha, result: "fail" });

  assertRejected([record, "--expected-sha", expectedSha], /result is "fail"/u);
});

test("verify-gate-record rejects a record without a result field", (t) => {
  const sandbox = freshSandbox(t);
  const record = writeRecord(sandbox, { sha: expectedSha });

  assertRejected([record, "--expected-sha", expectedSha], /result/u);
});

test("verify-gate-record rejects a missing record file", (t) => {
  const sandbox = freshSandbox(t);

  assertRejected(
    [join(sandbox, "missing.json"), "--expected-sha", expectedSha],
    /cannot read gate record/u
  );
});

test("verify-gate-record rejects malformed JSON", (t) => {
  const sandbox = freshSandbox(t);
  const record = join(sandbox, "gate-record.json");
  writeFileSync(record, "{ not json\n");

  assertRejected([record, "--expected-sha", expectedSha], /not valid JSON/u);
});

test("verify-gate-record requires a record path and an expected SHA", () => {
  assertRejected(["--expected-sha", expectedSha], /usage/u);
});

test("verifyGateRecord pure verdict only reads sha and result", () => {
  assert.deepEqual(
    verifyGateRecord({ sha: expectedSha, result: "pass" }, expectedSha),
    { ok: true }
  );
  // Extra fields (e.g. a combined --base record's classification evidence)
  // neither help nor hurt the verdict.
  assert.deepEqual(
    verifyGateRecord(
      { sha: expectedSha, result: "pass", checks: [], classification: {} },
      expectedSha
    ),
    { ok: true }
  );
  assert.equal(verifyGateRecord({ sha: "other", result: "pass" }, expectedSha).ok, false);
  assert.equal(verifyGateRecord({ sha: expectedSha, result: "fail" }, expectedSha).ok, false);
  assert.equal(verifyGateRecord(null, expectedSha).ok, false);
});
