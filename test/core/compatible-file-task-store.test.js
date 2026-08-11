import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  initializeCompatibleFileTaskStore,
  openCompatibleFileTaskStore
} from "../../dist/storage/compatibleTaskStore.js";
import { MigrationRegistry } from "../../dist/storage/migration/index.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");

function fixture(t, unknown = false) {
  const base = mkdtempSync(join(tmpdir(), "yui-compatible-store-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const current = new FileTaskStore(home);
  current.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "codex", [], [], NOW));
  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const agent = state.configuredAgents.codex;
  agent.schemaVersion = 1;
  delete agent.environment;
  if (unknown) agent.mystery = true;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.recordVersions.configuredAgent = 1;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { home, statePath, manifestPath };
}

function registry() {
  const result = new MigrationRegistry();
  result.registerCompatible({
    axis: "record",
    recordKind: "configuredAgent",
    fromVersion: 1,
    toVersion: 2,
    defaults: ["environment=[]"],
    validateSource: (snapshot) => {
      for (const agent of Object.values(snapshot.state.configuredAgents)) {
        const keys = Object.keys(agent).sort();
        assert.deepEqual(keys, [
          "adapterId", "baseArgs", "command", "createdAt", "id", "schemaVersion", "updatedAt"
        ]);
        assert.equal(agent.schemaVersion, 1);
      }
    },
    normalize: (snapshot) => ({
      ...snapshot,
      schemaManifest: {
        ...snapshot.schemaManifest,
        recordVersions: {
          ...snapshot.schemaManifest.recordVersions,
          configuredAgent: 2
        }
      },
      state: {
        ...snapshot.state,
        configuredAgents: Object.fromEntries(
          Object.entries(snapshot.state.configuredAgents).map(([id, agent]) => [
            id,
            { ...agent, schemaVersion: 2, environment: [] }
          ])
        )
      }
    })
  });
  return result;
}

test("ordinary store commands read compatible-old records as the current model and first write is current-only", (t) => {
  const { home, statePath } = fixture(t);
  const before = readFileSync(statePath);
  const store = openCompatibleFileTaskStore(home, {
    registry: registry(),
    latest: latestStorageVersionState()
  });
  assert.deepEqual(store.listConfiguredAgents()[0].environment, []);
  assert.equal(store.listConfiguredAgents()[0].schemaVersion, 2);
  assert.deepEqual(readFileSync(statePath), before, "compatible reads must not rewrite the Home");

  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  const persisted = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(persisted.configuredAgents.codex.schemaVersion, 2);
  assert.deepEqual(persisted.configuredAgents.codex.environment, []);
});

test("setup initialization preserves an existing compatible Home and initializes only a new Home", (t) => {
  const existing = fixture(t);
  const stateBefore = readFileSync(existing.statePath);
  const manifestBefore = readFileSync(existing.manifestPath);
  assert.throws(
    () => new FileTaskStore(existing.home).getConfig(),
    /older than required/i,
    "non-opt-in FileTaskStore callers must remain current-only"
  );
  const compatible = initializeCompatibleFileTaskStore(existing.home, {
    registry: registry(),
    latest: latestStorageVersionState()
  });
  assert.deepEqual(compatible.listConfiguredAgents()[0].environment, []);
  assert.deepEqual(readFileSync(existing.statePath), stateBefore);
  assert.deepEqual(readFileSync(existing.manifestPath), manifestBefore);

  const base = mkdtempSync(join(tmpdir(), "yui-compatible-setup-new-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const initialized = initializeCompatibleFileTaskStore(home);
  assert.equal(initialized.getConfig().schemaVersion, 1);
  assert.equal(
    JSON.parse(readFileSync(join(home, "schema.json"), "utf8")).storageVersion,
    latestStorageVersionState().layout
  );
});

test("compatible loading rejects undeclared old-shape fields instead of accepting unknown structure", (t) => {
  const { home } = fixture(t, true);
  const store = openCompatibleFileTaskStore(home, {
    registry: registry(),
    latest: latestStorageVersionState()
  });
  assert.throws(() => store.listConfiguredAgents(), /Expected values to be strictly deep-equal/);
});

test("a durable family omission drives compatible introduction without a Home copy", (t) => {
  const base = mkdtempSync(join(tmpdir(), "yui-compatible-introduction-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const current = new FileTaskStore(home);
  current.saveConfig({ ...current.getConfig(), timeZone: "UTC" });
  const manifestPath = join(home, "schema.json");
  const statePath = join(home, "state.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.recordVersions.operatorNotification;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const beforeManifest = readFileSync(manifestPath);
  const beforeState = readFileSync(statePath);
  const introduction = new MigrationRegistry();
  introduction.registerCompatible({
    axis: "record",
    recordKind: "operatorNotification",
    fromVersion: 0,
    toVersion: 1,
    introduction: true,
    defaults: ["operatorNotification=null"],
    validateSource: (snapshot) => {
      assert.equal(snapshot.schemaManifest.recordVersions.operatorNotification, undefined);
    },
    normalize: (snapshot) => ({
      ...snapshot,
      schemaManifest: {
        ...snapshot.schemaManifest,
        recordVersions: {
          ...snapshot.schemaManifest.recordVersions,
          operatorNotification: 1
        }
      },
      state: { ...snapshot.state }
    })
  });

  const store = openCompatibleFileTaskStore(home, {
    registry: introduction,
    latest: latestStorageVersionState()
  });
  assert.equal(store.getConfig().timeZone, "UTC");
  assert.deepEqual(readFileSync(manifestPath), beforeManifest);
  assert.deepEqual(readFileSync(statePath), beforeState);

  store.saveConfig({ ...store.getConfig(), timeZone: "Asia/Shanghai" });
  const persistedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(persistedManifest.recordVersions.operatorNotification, 1);
  assert.equal(new FileTaskStore(home).getConfig().timeZone, "Asia/Shanghai");
  assert.deepEqual(readdirSync(base).sort(), ["home"]);
  t.after(() => rmSync(base, { recursive: true, force: true }));
});
