import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEphemeralDomainIdentity,
  defaultEphemeralTmuxServer,
  readEphemeralDomainIdentity,
  readLinuxProcessStartIdentity,
  recordEphemeralTmuxTarget,
  writeEphemeralDomainIdentity
} from "../../dist/controller/domainIdentity.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { reapExpiredEphemeralResources } from "../../dist/controller/ephemeralResourceReaper.js";
import { scanControllerResourceInventory } from "../../dist/controller/resourceInventoryLinux.js";
import {
  createRoleSessionSet,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { recordRoleAgentSession } from "../helpers/effectiveLaunch.js";

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

test("same-token Controller restart writes retain recorded tmux targets", (t) => {
  const { root, home } = temporaryHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = identity(home, { tmuxTargets: [] });
  writeEphemeralDomainIdentity(home, first);
  assert.equal(
    recordEphemeralTmuxTarget(home, first.token, "yui-test:operator"),
    true
  );
  writeEphemeralDomainIdentity(home, first);
  const current = readEphemeralDomainIdentity(home);
  assert.equal(current.status, "valid");
  assert.deepEqual(current.identity.tmuxTargets, ["yui-test:operator"]);
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

test("only a live Global Session protects an expired domain", async (t) => {
  for (const status of ["ready", "stopped", "broken"]) {
    const { root, home } = temporaryHome();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const now = new Date("2026-08-01T00:00:00.000Z");
    const agent = createConfiguredAgent(
      `codex-global-${status}`,
      "codex",
      "codex",
      [],
      [],
      now
    );
    const role = createGlobalRole(
      "operator",
      [createRoleAgentBinding(agent)],
      agent.id,
      home,
      now
    );
    const store = new FileTaskStore(home);
    let sessions = createRoleSessionSet(
      { scope: "global", roleName: role.name },
      agent.id,
      now
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId: agent.id,
      adapterId: agent.adapterId,
      nativeSessionId: `native-${status}`,
      policy: "fixed",
      status: "ready"
    }, now);
    sessions = updateRoleAgentSessionStatus(sessions, agent.id, status, now);
    store.transaction((tx) => {
      tx.saveConfiguredAgent(agent);
      tx.saveGlobalRole(role);
      tx.saveGlobalRoleSessionSet(sessions);
    });
    writeEphemeralDomainIdentity(home, identity(home, {
      createdAt: new Date("2026-07-31T23:59:00.000Z")
    }));

    const snapshot = await scanControllerResourceInventory({
      currentHome: home,
      scope: "current",
      now: () => new Date("2026-08-01T00:00:10.000Z")
    });
    assert.equal(
      snapshot.domains[0].disposition,
      status === "ready" ? "protected" : "safe"
    );
    assert.equal(
      snapshot.domains[0].reasonCode,
      status === "ready" ? "ephemeral-active-task-role" : "ephemeral-host-dead"
    );
  }
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

for (const scenario of [
  { name: "a reused target", target: "yui-test:operator", disposition: "safe" },
  { name: "a new pane", target: "yui-test:worker", disposition: "review" }
]) {
  test(`reaper defers identity cleanup when ${scenario.name} appears after revalidation`, async () => {
    const home = "/tmp/yui-ephemeral-race-home";
    const target = "yui-test:operator";
    const domain = {
      yuiHome: home,
      storageStatus: "current",
      resourceCount: 1,
      liveProcessCount: 0,
      rssBytes: 0,
      issueCount: 1,
      kind: "ephemeral-test",
      domainKind: "ephemeral-test",
      liveness: "expired",
      disposition: "safe",
      reasonCode: "ephemeral-host-dead",
      fingerprint: "domain-fence",
      token: "a".repeat(64),
      tmuxTargets: [target],
      ageMs: 10_000,
      graceMs: 1_000
    };
    const identity = {
      id: `artifact:${home}/runtime/domain.json`,
      fingerprint: "identity-fingerprint",
      kind: "artifact",
      state: "stale",
      disposition: "safe",
      reasonCode: "stale-domain-identity",
      yuiHome: home,
      owner: { kind: "controller-domain", yuiHome: home },
      processes: [],
      rssBytes: 0,
      cpuTimeMs: 0,
      ageMs: 0,
      domain,
      artifact: {
        artifactKind: "domain-identity",
        path: `${home}/runtime/domain.json`,
        active: false,
        fingerprint: "identity-fingerprint"
      }
    };
    const sibling = {
      id: `agent-session:${home}:${scenario.target}`,
      fingerprint: `pane-${scenario.target}`,
      kind: "agent-session",
      state: scenario.disposition === "safe" ? "running" : "orphaned",
      disposition: scenario.disposition,
      reasonCode: scenario.disposition === "safe" ? "owned-role-pane" : "orphan-pane",
      yuiHome: home,
      owner: { kind: "none" },
      processes: [],
      rssBytes: 0,
      cpuTimeMs: 0,
      ageMs: 0,
      target: scenario.target,
      paneDead: false,
      paneCommand: "sleep",
      domain
    };
    const snapshot = (resources) => ({
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      currentHome: home,
      scope: "current",
      summary: {
        domainCount: 1,
        resourceCount: resources.length,
        liveProcessCount: 0,
        rssBytes: 0,
        byDisposition: { safe: resources.filter(({ disposition }) => disposition === "safe").length,
          review: resources.filter(({ disposition }) => disposition === "review").length,
          protected: 0, "report-only": 0 }
      },
      domains: [domain],
      resources,
      warnings: []
    });
    const snapshots = [snapshot([identity]), snapshot([identity, sibling])];
    let scanCount = 0;
    let cleanCalls = 0;
    let expiredDomainCallbacks = 0;
    const result = await reapExpiredEphemeralResources({
      scan: async () => snapshots[Math.min(scanCount++, snapshots.length - 1)],
      clean: async () => { cleanCalls += 1; },
      onExpiredDomain: () => { expiredDomainCallbacks += 1; }
    });

    assert.equal(cleanCalls, 0);
    assert.equal(result.cleaned, 0);
    assert.deepEqual(result.expiredDomains, []);
    assert.equal(expiredDomainCallbacks, 0);
    assert.deepEqual(result.failed, [{
      id: identity.id,
      message: "domain-sibling-appeared"
    }]);
  });
}
