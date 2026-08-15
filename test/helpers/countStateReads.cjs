'use strict';

// Test-only preload for spawned exact managed CLI processes. It counts full
// reads of one Yui Home state.json so a test can prove how many times the
// large Task state was parsed by the preflight store and the command store.
// The report is rewritten after every counted read, so a process killed at
// the un-widened timeout boundary still leaves its counter behind.

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const target = process.env.YUI_TEST_STATE_READ_PATH;
const report = process.env.YUI_TEST_STATE_READ_REPORT;

if (target !== undefined && report !== undefined) {
  const statePath = path.resolve(target);
  const writeFileSync = fs.writeFileSync;
  let reads = 0;
  let bytes = 0;
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function countedReadFileSync(file, ...rest) {
    const resolved = file instanceof URL ? fileURLToPath(file) : path.resolve(String(file));
    const result = readFileSync.call(this, file, ...rest);
    if (resolved === statePath) {
      reads += 1;
      bytes += Buffer.isBuffer(result) ? result.length : Buffer.byteLength(String(result));
      try {
        writeFileSync.call(fs, report, JSON.stringify({ reads, bytes }));
      } catch {
        // Best-effort evidence; the parent still observes the exit status.
      }
    }
    return result;
  };
}
