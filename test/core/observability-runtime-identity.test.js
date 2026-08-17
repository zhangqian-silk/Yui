import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

test("storage identity flags the pseudo-layout-7 contradiction (layout 7 without yui.db)", () => {
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
    assert.ok(codes.includes("layout7-missing-database"), codes.join(","));
    const health = evaluateStorageHealth(identity);
    assert.equal(health.healthy, false);
    assert.equal(health.contradictions.length, 1);
    assert.match(health.contradictions[0].remediation, /migration|backup/u);
  } finally {
    cleanup();
  }
});

test("storage identity is healthy for a layout-7 Home with yui.db and sqlite backend", () => {
  const { home, cleanup } = temporaryHome();
  try {
    writeManifest(home, 7, 18);
    writeFileSync(join(home, "state.json"), "{}");
    writeFileSync(join(home, "yui.db"), "db");
    writeFileSync(join(home, "yui.db-wal"), "wal");
    const identity = collectStorageIdentity(
      home,
      createProductionStorageIdentityPorts({
        YUI_STORE_BACKEND: "sqlite",
        YUI_STORE_WORKER: "1"
      })
    );
    assert.equal(identity.configuredBackend, "sqlite");
    assert.equal(identity.workerEnabled, true);
    assert.equal(identity.physicalDatabase.present, true);
    assert.equal(identity.physicalDatabase.wal, true);
    assert.deepEqual(identity.findings, []);
    assert.equal(evaluateStorageHealth(identity).healthy, true);
  } finally {
    cleanup();
  }
});

test("storage identity warns when yui.db exists but the file backend is selected", () => {
  const { home, cleanup } = temporaryHome();
  try {
    writeManifest(home, 7, 18);
    writeFileSync(join(home, "state.json"), "{}");
    writeFileSync(join(home, "yui.db"), "db");
    const identity = collectStorageIdentity(home);
    const codes = identity.findings.map(({ code }) => code);
    assert.ok(codes.includes("database-present-but-file-backend"), codes.join(","));
    // A warning alone stays healthy; contradictions fail closed.
    assert.equal(evaluateStorageHealth(identity).healthy, true);
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
