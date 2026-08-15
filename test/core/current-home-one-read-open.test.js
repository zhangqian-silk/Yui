import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  openCompatibleFileTaskStore,
  readFingerprintFencedState
} from "../../dist/storage/compatibleTaskStore.js";
import { StorageCompatibilityError } from "../../dist/storage/migration/index.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore, STORAGE_STATE_FILE } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-08-14T00:00:00.000Z");
const PRELOAD = join(process.cwd(), "test", "helpers", "countStateReads.cjs");

function currentHomeFixture() {
  const home = mkdtempSync(join(tmpdir(), "yui-one-read-open-"));
  ensureStorageSchema(home, NOW);
  const writer = new FileTaskStore(home);
  writer.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: "codex", defaultWorkspace: home });
  });
  return { home, writer };
}

function readReport(reportPath) {
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return undefined;
  }
}

// ESM named imports from the CJS node:fs module bind at link time, so an
// in-process readFileSync patch would never observe the dist modules' reads.
// Spawn under the preload, which patches before any module links, and count
// full reads of the fixture's state.json.
function spawnCountedProbe(home, probeSource) {
  const reportPath = join(tmpdir(), `yui-one-read-report-${process.pid}-${Date.now()}.json`);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeSource], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${PRELOAD}`,
      YUI_TEST_HOME: home,
      YUI_TEST_STATE_READ_PATH: resolve(join(home, STORAGE_STATE_FILE)),
      YUI_TEST_STATE_READ_REPORT: reportPath
    },
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  });
  return { result, report: readReport(reportPath) };
}

const DIST_IMPORT = `
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dist = (name) => pathToFileURL(join(process.cwd(), "dist", name)).href;
`;

test("a current-Home compatible open reads state.json once for open and first use", (t) => {
  const { home } = currentHomeFixture();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { result, report } = spawnCountedProbe(home, `
    ${DIST_IMPORT}
    const { openCompatibleFileTaskStore } = await import(dist("storage/compatibleTaskStore.js"));
    const store = openCompatibleFileTaskStore(process.env.YUI_TEST_HOME);
    store.getConfig();
    store.listTasks();
  `);
  assert.equal(result.status, 0, `one-read open probe failed: ${result.stderr}`);
  assert.equal(
    report?.reads,
    1,
    `state.json was read ${report?.reads ?? 0} times; expected 1 (one fingerprint-fenced `
    + `snapshot feeding version inspection, strict validation, and the store cache seed).`
  );
});

test("repeated current-Home inventory scans do not multiply the one-read open", (t) => {
  const { home } = currentHomeFixture();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { result, report } = spawnCountedProbe(home, `
    ${DIST_IMPORT}
    const { scanControllerResourceInventory } = await import(dist("controller/resourceInventoryLinux.js"));
    for (let scan = 0; scan < 2; scan += 1) {
      const snapshot = await scanControllerResourceInventory({
        currentHome: process.env.YUI_TEST_HOME,
        scope: "current",
        environment: { ...process.env, YUI_HOME: process.env.YUI_TEST_HOME }
      });
      if (snapshot.warnings.length > 0) console.error(snapshot.warnings.join("\\n"));
    }
  `);
  assert.equal(result.status, 0, `inventory scan probe failed: ${result.stderr}`);
  assert.equal(
    report?.reads,
    2,
    `two inventory scans read state.json ${report?.reads ?? 0} times; expected 2 `
    + `(one fingerprint-fenced open per scan, not the old three-read open per scan).`
  );
});

test("the opened store serves the seeded snapshot and invalidates on a later external writer", (t) => {
  const { home, writer } = currentHomeFixture();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const opened = openCompatibleFileTaskStore(home);
  assert.equal(opened.getConfig().defaultAgent, "codex");
  // An external writer commits through a different store instance after the
  // open, changing fingerprint and revision.
  writer.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: "claude", defaultWorkspace: home });
  });
  assert.equal(
    opened.getConfig().defaultAgent,
    "claude",
    "the seeded cache must invalidate when an external writer changes the fingerprint"
  );
});

test("the fingerprint fence retries one drifting read and keeps the stable bytes", () => {
  const fingerprints = ["a", "b", "b", "b"];
  const reads = [];
  const snapshot = readFingerprintFencedState("/ignored/state.json", {
    fingerprint: () => fingerprints.shift(),
    read: () => {
      reads.push(1);
      return `attempt-${reads.length}`;
    }
  });
  assert.equal(snapshot.fingerprint, "b");
  assert.equal(snapshot.raw, "attempt-2");
  assert.equal(reads.length, 2, "one bounded retry after the first drift");
});

test("the fingerprint fence fails closed after the bounded retry", () => {
  const fingerprints = ["a", "b", "c", "d"];
  let reads = 0;
  assert.throws(
    () => readFingerprintFencedState("/ignored/state.json", {
      fingerprint: () => fingerprints.shift(),
      read: () => {
        reads += 1;
        return `attempt-${reads}`;
      }
    }),
    (error) => error instanceof StorageCompatibilityError
      && /changed while opening/.test(error.message)
  );
  assert.equal(reads, 2, "the retry budget is one extra attempt, then fail closed");
});
