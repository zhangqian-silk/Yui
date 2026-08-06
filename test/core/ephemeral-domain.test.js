import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEphemeralDomainIdentity,
  defaultEphemeralTmuxServer,
  readLinuxProcessStartIdentity,
  writeEphemeralDomainIdentity
} from "../../dist/controller/domainIdentity.js";
import { reapExpiredEphemeralResources } from "../../dist/controller/ephemeralResourceReaper.js";
import { scanControllerResourceInventory } from "../../dist/controller/resourceInventoryLinux.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";

function temporaryHome() {
  const root = mkdtempSync(join(tmpdir(), "yui-ephemeral-domain-test-"));
  const home = join(root, "home");
  ensureStorageSchema(home, new Date("2026-08-01T00:00:00.000Z"));
  return { root, home };
}

function identity(home, overrides = {}) {
  return createEphemeralDomainIdentity({
    tmuxServer: defaultEphemeralTmuxServer(home),
    tmuxTargets: ["yui-test:worker"],
    hostPid: 99999999,
    hostProcessStartIdentity: "123",
    createdAt: new Date(Date.now() - 10_000),
    ...overrides
  });
}

test("expired marked domain carries host identity, token and tmux target fence", async (t) => {
  const { root, home } = temporaryHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeEphemeralDomainIdentity(home, identity(home));
  const snapshot = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current"
  });
  assert.equal(snapshot.domains[0].domainKind, "ephemeral-test");
  assert.equal(snapshot.domains[0].liveness, "expired");
  assert.equal(snapshot.domains[0].disposition, "safe");
  assert.equal(snapshot.domains[0].hostPid, 99999999);
  assert.equal(snapshot.domains[0].hostProcessStartIdentity, "123");
  assert.equal(snapshot.domains[0].tmuxTargets[0], "yui-test:worker");
  assert.match(snapshot.domains[0].reasonCode, /ephemeral-host-dead/);
  assert.equal(snapshot.resources[0].domain?.token, snapshot.domains[0].token);
});

test("active host identity protects an otherwise expired domain", async (t) => {
  const { root, home } = temporaryHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const startIdentity = readLinuxProcessStartIdentity(process.pid);
  assert.notEqual(startIdentity, undefined);
  writeEphemeralDomainIdentity(home, identity(home, {
    hostPid: process.pid,
    hostProcessStartIdentity: startIdentity
  }));
  const snapshot = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current"
  });
  assert.equal(snapshot.domains[0].liveness, "active");
  assert.equal(snapshot.domains[0].disposition, "protected");
});

test("an initialized real Home without the marker remains review-only", async (t) => {
  const { root, home } = temporaryHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current"
  });
  assert.equal(snapshot.domains[0].domainKind, "unmarked");
  assert.equal(snapshot.domains[0].liveness, "unknown");
  assert.equal(snapshot.domains[0].disposition, "review");
});

test("PID reuse is expired only after the recorded start identity mismatches", async (t) => {
  const { root, home } = temporaryHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actual = readLinuxProcessStartIdentity(process.pid);
  assert.notEqual(actual, undefined);
  writeEphemeralDomainIdentity(home, identity(home, {
    hostPid: process.pid,
    hostProcessStartIdentity: actual === "1" ? "2" : "1"
  }));
  const snapshot = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current",
    now: () => new Date(Date.now() + 10_000)
  });
  assert.equal(snapshot.domains[0].disposition, "safe");
  assert.match(snapshot.domains[0].reasonCode, /identity-mismatch/);
});

test("reaper revalidates exact fingerprint and retries a failed clean", async () => {
  const resource = {
    id: "artifact:/tmp/ephemeral-domain",
    fingerprint: "before",
    kind: "artifact",
    state: "stale",
    disposition: "safe",
    reasonCode: "stale-domain-identity",
    owner: { kind: "none" },
    processes: [],
    rssBytes: 0,
    cpuTimeMs: 0,
    ageMs: 0,
    domain: {
      kind: "ephemeral-test",
      liveness: "expired",
      disposition: "safe",
      reasonCode: "ephemeral-host-dead",
      fingerprint: "domain-fence",
      tmuxTargets: [],
      ageMs: 10_000,
      graceMs: 1_000
    },
    artifact: {
      artifactKind: "domain-identity",
      path: "/tmp/ephemeral-domain",
      active: false,
      fingerprint: "before"
    }
  };
  const snapshot = () => Promise.resolve({
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    currentHome: "/tmp",
    scope: "all",
    summary: {
      domainCount: 1,
      resourceCount: 1,
      liveProcessCount: 0,
      rssBytes: 0,
      byDisposition: { safe: 1, review: 0, protected: 0, "report-only": 0 }
    },
    domains: [],
    resources: [resource],
    warnings: []
  });
  let cleanCalls = 0;
  const first = await reapExpiredEphemeralResources({
    scan: snapshot,
    clean: async () => {
      cleanCalls += 1;
      throw new Error("temporary cleanup failure");
    }
  });
  assert.equal(first.cleaned, 0);
  assert.equal(first.failed.length, 1);
  assert.equal(cleanCalls, 1);
  const second = await reapExpiredEphemeralResources({
    scan: snapshot,
    clean: async () => { cleanCalls += 1; }
  });
  assert.equal(second.cleaned, 1);
  assert.equal(second.failed.length, 0);
  assert.equal(cleanCalls, 2);
});
