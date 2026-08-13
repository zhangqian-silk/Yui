import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  cleanControllerResource
} from "../../dist/controller/resourceCleanupLinux.js";
import {
  createEphemeralDomainIdentity,
  defaultEphemeralTmuxServer,
  ephemeralDomainFingerprint,
  readEphemeralDomainIdentity,
  recordEphemeralTmuxTarget,
  writeEphemeralDomainIdentity
} from "../../dist/controller/domainIdentity.js";
import {
  scanControllerResourceInventory
} from "../../dist/controller/resourceInventoryLinux.js";
import { controllerSocketPath } from "../../dist/core/controllerEndpoint.js";
import { tmuxSocketDirectory } from "../../dist/tmux/tmuxSocketEndpoint.js";

function processResource(overrides = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    id: "controller:/tmp/yui:100:1000",
    fingerprint: "controller:100:1000",
    kind: "controller",
    state: "superseded",
    disposition: "safe",
    reasonCode: "superseded-controller",
    yuiHome: "/tmp/yui",
    owner: { kind: "controller-domain", yuiHome: "/tmp/yui" },
    processes: [{
      pid: 100,
      ppid: 1,
      uid,
      startIdentity: "1000",
      command: "node",
      rssBytes: 64,
      cpuTimeMs: 1,
      ageMs: 1000
    }],
    rssBytes: 64,
    cpuTimeMs: 1,
    ageMs: 1000,
    ...overrides
  };
}

test("process cleanup refuses a reused PID before sending any signal", async () => {
  const signals = [];
  await assert.rejects(
    cleanControllerResource(processResource(), {
      ports: {
        processStartIdentity: () => "different",
        signal: (pid, signal) => signals.push([pid, signal]),
        sleep: async () => {},
        artifactFingerprint: () => undefined,
        socketActive: () => false,
        removeArtifact() {},
        killPane: async () => {}
      }
    }),
    /changed since scan/
  );
  assert.deepEqual(signals, []);
});

test("process cleanup escalates only a still-matching stubborn process", async () => {
  const identities = new Map([[100, "1000"]]);
  const signals = [];
  await cleanControllerResource(processResource(), {
    termGraceMs: 1,
    killGraceMs: 1,
    pollMs: 1,
    ports: {
      processStartIdentity: (pid) => identities.get(pid),
      signal(pid, signal) {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") identities.delete(pid);
      },
      sleep: async () => {},
      artifactFingerprint: () => undefined,
      socketActive: () => false,
      removeArtifact() {},
      killPane: async () => {}
    }
  });

  assert.deepEqual(signals, [
    [100, "SIGTERM"],
    [100, "SIGKILL"]
  ]);
});

test("tmux server cleanup refuses to signal while Role panes remain", async () => {
  const signals = [];
  const tmuxServer = processResource({
    id: "tmux-server:/tmp/yui:100:1000",
    kind: "tmux-server",
    state: "orphaned",
    disposition: "review",
    reasonCode: "orphan-tmux-server"
  });
  await assert.rejects(
    cleanControllerResource(tmuxServer, {
      ports: {
        processStartIdentity: () => "1000",
        signal: (pid, signal) => signals.push([pid, signal]),
        sleep: async () => {},
        artifactFingerprint: () => undefined,
        socketActive: () => false,
        removeArtifact() {},
        killPane: async () => {},
        inspectTmuxServerPanes: async () => ["task-1/leader", "task-2/worker"]
      }
    }),
    /task-1\/leader, task-2\/worker/
  );
  assert.deepEqual(signals, []);
});

test("ephemeral cleanup defers without signaling when a target writer wins the final epoch", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-domain-cleanup-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const initial = createEphemeralDomainIdentity({
    tmuxServer: defaultEphemeralTmuxServer(home),
    tmuxTargets: ["yui-test:server"],
    hostPid: 99999999,
    hostProcessStartIdentity: "123"
  });
  writeEphemeralDomainIdentity(home, initial);
  const before = readEphemeralDomainIdentity(home);
  assert.equal(before.status, "valid");
  const domain = {
    kind: "ephemeral-test",
    liveness: "expired",
    disposition: "safe",
    reasonCode: "ephemeral-host-dead",
    fingerprint: ephemeralDomainFingerprint(initial, before.fingerprint),
    token: initial.token,
    tmuxTargets: initial.tmuxTargets,
    ageMs: 10_000,
    graceMs: 1_000
  };
  const resource = processResource({
    id: `tmux-server:${home}:100:1000`,
    yuiHome: home,
    kind: "tmux-server",
    state: "orphaned",
    reasonCode: "orphan-tmux-server",
    domain
  });
  const signals = [];
  await assert.rejects(
    cleanControllerResource(resource, {
      ports: {
        processStartIdentity: () => "1000",
        signal: (pid, signal) => signals.push([pid, signal]),
        sleep: async () => {},
        artifactFingerprint: () => undefined,
        socketActive: () => false,
        removeArtifact() {},
        killPane: async () => {},
        inspectTmuxServerPanes: async () => {
          throw new Error("inspection should be deferred after the writer wins");
        },
        beforeDomainCleanupEpoch: () => {
          assert.equal(
            recordEphemeralTmuxTarget(home, initial.token, "yui-test:new"),
            true
          );
        }
      }
    }),
    /changed since scan/
  );
  assert.deepEqual(signals, []);
  const after = readEphemeralDomainIdentity(home);
  assert.equal(after.status, "valid");
  assert.deepEqual(after.identity.tmuxTargets, ["yui-test:new", "yui-test:server"]);
});

test("ephemeral cleanup holds the identity fence through final inspection and signaling", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-domain-cleanup-lock-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const initial = createEphemeralDomainIdentity({
    tmuxServer: defaultEphemeralTmuxServer(home),
    tmuxTargets: ["yui-test:server"],
    hostPid: 99999999,
    hostProcessStartIdentity: "123"
  });
  writeEphemeralDomainIdentity(home, initial);
  const before = readEphemeralDomainIdentity(home);
  assert.equal(before.status, "valid");
  const domain = {
    kind: "ephemeral-test",
    liveness: "expired",
    disposition: "safe",
    reasonCode: "ephemeral-host-dead",
    fingerprint: ephemeralDomainFingerprint(initial, before.fingerprint),
    token: initial.token,
    tmuxTargets: initial.tmuxTargets,
    ageMs: 10_000,
    graceMs: 1_000
  };
  const resource = processResource({
    id: `tmux-server:${home}:100:1000`,
    yuiHome: home,
    kind: "tmux-server",
    state: "orphaned",
    reasonCode: "orphan-tmux-server",
    domain
  });
  const identities = new Map([[100, "1000"]]);
  const signals = [];
  let inspectCalls = 0;
  let writerResult;
  await cleanControllerResource(resource, {
    termGraceMs: 1,
    killGraceMs: 1,
    pollMs: 1,
    ports: {
      processStartIdentity: (pid) => identities.get(pid),
      signal(pid, signal) {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") identities.delete(pid);
      },
      sleep: async () => {},
      artifactFingerprint: () => undefined,
      socketActive: () => false,
      removeArtifact() {},
      killPane: async () => {},
      inspectTmuxServerPanes: async () => {
        inspectCalls += 1;
        if (inspectCalls === 2) {
          writerResult = recordEphemeralTmuxTarget(
            home,
            initial.token,
            "yui-test:blocked"
          );
        }
        return [];
      }
    }
  });
  assert.equal(writerResult, false);
  assert.deepEqual(signals, [
    [100, "SIGTERM"],
    [100, "SIGKILL"]
  ]);
  assert.equal(readEphemeralDomainIdentity(home).status, "valid");
});

test("artifact cleanup revalidates fingerprint and socket liveness", async () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const path = join(tmpdir(), `tmux-${uid}`, "yui-0123456789abcdef01234567");
  const artifact = processResource({
    id: `artifact:${path}`,
    fingerprint: "before",
    kind: "artifact",
    state: "stale",
    disposition: "safe",
    reasonCode: "stale-tmux-socket",
    owner: { kind: "none" },
    processes: [],
    rssBytes: 0,
    cpuTimeMs: 0,
    ageMs: 0,
    artifact: {
      artifactKind: "tmux-socket",
      path,
      active: false,
      fingerprint: "before"
    }
  });
  let removed = false;
  const basePorts = {
    processStartIdentity: () => undefined,
    signal() {},
    sleep: async () => {},
    socketActive: () => false,
    removeArtifact() {
      removed = true;
    },
    killPane: async () => {}
  };

  await assert.rejects(
    cleanControllerResource(artifact, {
      ports: { ...basePorts, artifactFingerprint: () => "after" }
    }),
    /changed since scan/
  );
  assert.equal(removed, false);

  await assert.rejects(
    cleanControllerResource(artifact, {
      ports: {
        ...basePorts,
        artifactFingerprint: () => "before",
        socketActive: () => true
      }
    }),
    /active/
  );
  assert.equal(removed, false);

  await cleanControllerResource(artifact, {
    ports: { ...basePorts, artifactFingerprint: () => "before" }
  });
  assert.equal(removed, true);
});

test("explicit TMUX_TMPDIR exclusively owns its tmux cleanup namespace", async (t) => {
  const customRoot = mkdtempSync(join("/tmp", "yui-explicit-tmux-root-"));
  t.after(() => rmSync(customRoot, { recursive: true, force: true }));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const server = "yui-0123456789abcdef01234567";
  const defaultDirectory = join("/tmp", `tmux-${uid}`);
  const customDirectory = join(customRoot, `tmux-${uid}`);
  const environment = {
    TMUX_TMPDIR: customRoot,
    TMPDIR: join(customRoot, "ignored-node-tmpdir")
  };

  assert.equal(tmuxSocketDirectory({ TMPDIR: environment.TMPDIR }), defaultDirectory);
  assert.equal(tmuxSocketDirectory(environment), customDirectory);

  const defaultArtifact = processResource({
    id: `artifact:${join(defaultDirectory, server)}`,
    fingerprint: "before",
    kind: "artifact",
    state: "stale",
    disposition: "safe",
    reasonCode: "stale-tmux-socket",
    owner: { kind: "none" },
    processes: [],
    rssBytes: 0,
    cpuTimeMs: 0,
    ageMs: 0,
    artifact: {
      artifactKind: "tmux-socket",
      path: join(defaultDirectory, server),
      active: false,
      fingerprint: "before"
    }
  });
  let removed = false;

  await assert.rejects(
    cleanControllerResource(defaultArtifact, {
      environment,
      ports: {
        processStartIdentity: () => undefined,
        signal() {},
        sleep: async () => {},
        artifactFingerprint: () => "before",
        socketActive: () => false,
        removeArtifact() { removed = true; },
        killPane: async () => {},
        inspectTmuxServerPanes: async () => []
      }
    }),
    /outside the Yui tmux namespace/
  );
  assert.equal(removed, false);
});

test("pane cleanup delegates only after the command layer revalidated the exact resource", async () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const pane = processResource({
    id: "agent-session:/tmp/yui:task-1:worker",
    fingerprint: "agent-session:200:2000:task-1:worker",
    kind: "agent-session",
    state: "orphaned",
    disposition: "review",
    reasonCode: "orphan-pane",
    target: "yui-task-1:worker",
    processes: [{
      pid: 200,
      ppid: 150,
      uid,
      startIdentity: "2000",
      command: "codex",
      rssBytes: 64,
      cpuTimeMs: 1,
      ageMs: 1000
    }]
  });
  const killed = [];
  await cleanControllerResource(pane, {
    ports: {
      processStartIdentity: () => "2000",
      signal() {},
      sleep: async () => {},
      artifactFingerprint: () => undefined,
      socketActive: () => false,
      removeArtifact() {},
      killPane: async (resource) => killed.push(resource.target)
    }
  });
  assert.deepEqual(killed, ["yui-task-1:worker"]);
});

test("Linux scanner and cleanup remove an exact inactive Controller socket artifact", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-cleanup-"));
  const socket = controllerSocketPath(home);
  mkdirSync(join(home, "runtime"));
  mkdirSync(dirname(socket), { recursive: true });
  writeFileSync(socket, "");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const snapshot = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current"
  });
  const artifact = snapshot.resources.find((resource) => (
    resource.artifact?.path === socket
  ));
  assert.ok(artifact);
  assert.equal(artifact.disposition, "safe");

  await cleanControllerResource(artifact);
  assert.equal(existsSync(socket), false);
});

test("Controller socket identity survives deletion of YUI_HOME", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-deleted-home-"));
  const socket = controllerSocketPath(home);
  mkdirSync(dirname(socket), { recursive: true });
  writeFileSync(socket, "");
  rmSync(home, { recursive: true, force: true });
  t.after(() => rmSync(socket, { force: true }));

  assert.equal(controllerSocketPath(home), socket);
  const snapshot = await scanControllerResourceInventory({
    currentHome: home,
    scope: "current"
  });
  const artifact = snapshot.resources.find((resource) => resource.artifact?.path === socket);
  assert.ok(artifact);
  await cleanControllerResource(artifact);
  assert.equal(existsSync(socket), false);
});
