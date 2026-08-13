#!/usr/bin/env node
// Verifies the per-SHA Deterministic CI gate record persisted by ci.yml
// (scripts/gate-hermetic.mjs writes it; the "Upload gate record" step publishes
// it as the `gate-record` artifact). The publish workflow downloads the record
// for the exact tagged commit and calls this script: git ancestry only proves
// the commit is on master, not that the gate passed for that exact SHA.
//
// Usage: node scripts/verify-gate-record.mjs <record-path> --expected-sha <sha>
// Exits 0 only when the record's top-level `sha` equals --expected-sha and its
// `result` is "pass". A missing file, malformed JSON, sha mismatch, or any
// other result exits 1 with the reason on stderr.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure verdict for a parsed gate record against the expected commit SHA.
 * Only the record contract's two top-level fields are read: `sha` (the gated
 * exact commit) and `result` ("pass" | "fail"); combined --base records keep
 * the same two fields.
 * @param {unknown} record
 * @param {string} expectedSha
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyGateRecord(record, expectedSha) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "gate record must be a JSON object" };
  }
  const gate = /** @type {Record<string, unknown>} */ (record);
  if (typeof gate.sha !== "string") {
    return {
      ok: false,
      reason: `gate record sha ${JSON.stringify(gate.sha)} is not a string`
    };
  }
  if (gate.sha !== expectedSha) {
    return {
      ok: false,
      reason: `gate record sha ${gate.sha} does not match expected ${expectedSha}`
    };
  }
  if (gate.result !== "pass") {
    return {
      ok: false,
      reason: `gate record result is ${JSON.stringify(gate.result)}, expected "pass"`
    };
  }
  return { ok: true };
}

function parseArgs(argv) {
  const options = { recordPath: undefined, expectedSha: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--expected-sha") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail("--expected-sha requires a value");
      }
      options.expectedSha = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      fail(`unknown argument: ${arg}`);
    } else if (options.recordPath === undefined) {
      options.recordPath = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.recordPath === undefined || options.expectedSha === undefined) {
    fail("usage: verify-gate-record.mjs <record-path> --expected-sha <sha>");
  }

  let recordText;
  try {
    recordText = readFileSync(options.recordPath, "utf8");
  } catch (error) {
    fail(`cannot read gate record ${options.recordPath}: ${error.message}`);
  }

  let record;
  try {
    record = JSON.parse(recordText);
  } catch (error) {
    fail(`gate record ${options.recordPath} is not valid JSON: ${error.message}`);
  }

  const verdict = verifyGateRecord(record, options.expectedSha);
  if (!verdict.ok) {
    fail(verdict.reason);
  }
  console.log(`Gate record verified for ${options.expectedSha}: result=pass.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
