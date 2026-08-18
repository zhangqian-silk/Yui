import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  collectRuntimeBuildIdentity,
  collectStorageIdentity,
  countDroppedInboxEvents,
  createProductionStorageIdentityPorts,
  evaluateStorageHealth,
  resolveStatusIdentityEnabled,
  UNSUPPORTED
} from "../../dist/observability/runtimeIdentity.js";

function temporaryHome() {
  const home = mkdtempSync(join(tmpdir(), "yui-observability-identity-"));
  return {
    home,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function writeManifest(home, storageVersion = 7, aggregateSchemaVersion = 18) {
  writeFileSync(join(home, "schema.json"), JSON.stringify({
    schemaVersion: 1,
    storageVersion,
    aggregateSchemaVersion,
    recordVersions: {},
    updatedAt: "2026-08-17T00:00:00.000Z"
  }));
}

function writeRealDatabase(home) {
  const db = new Database(join(home, "yui.db"));
  db.exec("CREATE TABLE IF NOT EXISTS _probe (id INTEGER PRIMARY KEY)");
  db.close();
}

function writeMigrationReceipt(home) {
  writeFileSync(join(home, "migration-receipt.json"), JSON.stringify({
    layout: 7,
    switchedAt: "2026-08-17T00:00:00.000Z"
  }));
}

test("status identity flag defaults on and disables on explicit opt-out", () => {
  assert.equal(resolveStatusIdentityEnabled({}), true);
  assert.equal(resolveStatusIdentityEnabled({ YUI_STATUS_IDENTITY: "1" }), true);
  assert.equal(resolveStatusIdentityEnabled({ YUI_STATUS_IDENTITY: "0" }), false);
  assert.equal(resolveStatusIdentityEnabled({ YUI_STATUS_IDENTITY: "false" }), false);
});

test("build identity reports package and entry facts with unsupported fallbacks", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-observability-build-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "@zq-silk/yui",
      version: "0.6.0"
    }));
    const entry = join(root, "dist", "cli.js");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(entry, "// entry");
    const identity = collectRuntimeBuildIdentity({
      env: {},
      packageRoot: root,
      entryPath: entry,
      readText: (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      },
      fileSize: () => null,
      exists: () => true,
      realpath: (path) => path,
      gitHead: () => null
    });
    assert.equal(identity.packageName, "@zq-silk/yui");
    assert.equal(identity.packageVersion, "0.6.0");
    assert.match(identity.packageDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(identity.entryPath, entry);
    assert.match(identity.entryDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(identity.sourceCommit, UNSUPPORTED);
    assert.match(identity.nodeVersion, /^v\d+/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("storage identity classifies pseudo-layout-7 as needs-repair (layout 7 without yui.db)", () => {
  const { home, cleanup } = temporaryHome();
  try {
    writeManifest(home, 7, 18);
    writeFileSync(join(home, "state.json"), "{}");
    const identity = collectStorageIdentity(
      home,
      createProductionStorageIdentityPorts({})
    );
    assert.equal(identity.manifestStatus, "current");
    assert.equal(identity.logicalLayout, 7);
    assert.equal(identity.configuredBackend, "file");
    assert.equal(identity.workerEnabled, false);
    assert.equal(identity.physicalStateJson.present, true);
    assert.equal(identity.physicalDatabase.present, false);
    const codes = identity.findings.map(({ code }) => code);
    assert.ok(codes.includes("pseudo-layout-7"), codes.join(","));
    const finding = identity.findings.find(({ code }) => code === "pseudo-layout-7");
    assert.equal(finding.severity, "needs-repair");
    assert.match(finding.remediation, /yui upgrade/u);
    const health = evaluateStorageHealth(identity);
    assert.equal(health.status, "degraded");
    assert.equal(health.healthy, false);
    assert.equal(health.needsRepair.length, 1);
    assert.equal(health.contradictions.length, 0);
  } finally {
    cleanup();
  }
});

test("storage identity is healthy for a db-only layout-7 Home (yui.db, no state.json)", () => {
  const { home, cleanup } = temporaryHome();
  try {
    writeManifest(home, 7, 18);
    writeRealDatabase(home);
    writeFileSync(join(home, "yui.db-wal"), "wal");
    const identity = collectStorageIdentity(
      home,
      createProductionStorageIdentityPorts({
        YUI_STORE_WORKER: "1"
      })
    );
    assert.equal(identity.configuredBackend, "sqlite");
    assert.equal(identity.workerEnabled, true);
    assert.equal(identity.physicalDatabase.present, true);
    assert.equal(identity.physicalDatabase.wal, true);
    assert.equal(identity.physicalDatabase.health, "ok");
    assert.equal(identity.hasMigrationReceipt, false);
    assert.deepEqual(identity.findings, []);
    assert.equal(evaluateStorageHealth(identity).status, "ok");
  } finally {
    cleanup();
  }
});

test("storage identity warns when yui.db exists but the file backend is explicitly forced", () => {
  const { home, cleanup } = temporaryHome();
  try {
    writeManifest(home, 7, 18);
    writeFileSync(join(home, "state.json"), "{}");
    writeRealDatabase(home);
    writeMigrationReceipt(home);
    const identity = collectStorageIdentity(
      home,
      createProductionStorageIdentityPorts({ YUI_STORE_BACKEND: "file" })
    );
    assert.equal(identity.configuredBackend, "file");
    const codes = identity.findings.map(({ code }) => code);
    assert.ok(codes.includes("database-present-but-file-backend"), codes.join(","));
    // A warning alone stays healthy; contradictions fail closed.
    assert.equal(evaluateStorageHealth(identity).status, "ok");
  } finally {
    cleanup();
  }
});

test("storage identity fails closed when layout 7 has neither yui.db nor readable state.json", () => {
  const { home, cleanup } = temporaryHome();
  try {
    writeManifest(home, 7, 18);
    const identity = collectStorageIdentity(home);
    const codes = identity.findings.map(({ code }) => code);
    assert.ok(codes.includes("no-authoritative-backend"), codes.join(","));
    const health = evaluateStorageHealth(identity);
    assert.equal(health.status, "fail");
    assert.equal(health.contradictions.length, 1);
  } finally {
    cleanup();
  }
});

test("storage identity flags dual-copy conflict when state.json and yui.db coexist without a receipt", () => {
  const { home, cleanup } = temporaryHome();
  try {
    writeManifest(home, 7, 18);
    writeFileSync(join(home, "state.json"), "{}");
    writeRealDatabase(home);
    const identity = collectStorageIdentity(home);
    const codes = identity.findings.map(({ code }) => code);
    assert.ok(codes.includes("dual-copy-conflict"), codes.join(","));
    assert.equal(evaluateStorageHealth(identity).status, "fail");
  } finally {
    cleanup();
  }
});

test("storage identity flags an unhealthy yui.db", () => {
  const { home, cleanup } = temporaryHome();
  try {
    writeManifest(home, 7, 18);
    writeFileSync(join(home, "yui.db"), "not a sqlite database");
    const identity = collectStorageIdentity(home);
    assert.equal(identity.physicalDatabase.health, "unopenable");
    const codes = identity.findings.map(({ code }) => code);
    assert.ok(codes.includes("database-unhealthy"), codes.join(","));
    assert.equal(evaluateStorageHealth(identity).status, "fail");
  } finally {
    cleanup();
  }
});

test("storage identity reports uninitialized when the manifest is absent", () => {
  const { home, cleanup } = temporaryHome();
  try {
    const identity = collectStorageIdentity(home);
    assert.equal(identity.manifestStatus, "uninitialized");
    assert.equal(identity.logicalLayout, UNSUPPORTED);
    assert.deepEqual(identity.findings, []);
  } finally {
    cleanup();
  }
});

test("dropped inbox events count is zero without the directory and unsupported when unreadable", () => {
  const { home, cleanup } = temporaryHome();
  try {
    assert.equal(countDroppedInboxEvents(home), 0);
    mkdirSync(join(home, "runtime", "inbox-invalid"), { recursive: true });
    writeFileSync(join(home, "runtime", "inbox-invalid", "event-1.bad"), "{}");
    writeFileSync(join(home, "runtime", "inbox-invalid", "event-2.bad"), "{}");
    assert.equal(countDroppedInboxEvents(home), 2);
    assert.equal(
      countDroppedInboxEvents(home, () => {
        throw new Error("permission denied");
      }),
      UNSUPPORTED
    );
  } finally {
    cleanup();
  }
});
