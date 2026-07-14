import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSchedulerTransaction } from "../dist/controller/controller.js";
import {
  createRoleRuntimeOperationLease,
  readGlobalRoleRuntimeOperationClaim,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim
} from "../dist/executor/roleRuntimeOperationClaim.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession,
  updateRoleAgentSessionStatus
} from "../dist/executor/agentExecutor.js";
import { createInputRequest } from "../dist/input/inputRequest.js";
import { createGlobalRole } from "../dist/role/role.js";
import {
  readOperatorPresence,
  scanOfflineInputResolutions
} from "../dist/scheduler/offlineInputResolution.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const start = new Date("2026-07-14T08:20:00.000Z");

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-offline-input-"));
  ensureStorageSchema(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function requester() {
  return {
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    sessionRoot: "/tmp",
    nativeSessionId: "leader-native-1",
    agentRunId: "leader-run-1"
  };
}

function seed(home) {
  const store = new FileTaskStore(home);
  store.saveTask(createTask("task-1", "Task one", start));
  store.saveInputRequest(createInputRequest(
    "offline-request",
    "task-1",
    requester(),
    {
      question: "Use safe path?",
      choices: [{ key: "safe", label: "Safe path" }],
      blockedRefs: [],
      resolutionPolicy: {
        mode: "offline-recommended",
        recommendation: { choiceKey: "safe", reason: "Safe and reversible." },
        offlineTimeoutMs: 30_000
      }
    },
    start
  ));
  store.saveInputRequest(createInputRequest(
    "user-request",
    "task-1",
    requester(),
    {
      question: "Need explicit approval?",
      choices: [{ key: "yes", label: "Yes" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    start
  ));
}

function scan(home, state, now) {
  return executeDomainTransaction(home, `offline-scan-${now.getTime()}`, (workingRoot) =>
    scanOfflineInputResolutions(
      new FileTaskStore(workingRoot),
      { state },
      now,
      (request) => `auto-${request.id}`
    )
  );
}

function operatorSessionSet(home, status = "running") {
  return recordRoleAgentSession(
    createRoleSessionSet({ scope: "global", roleName: "operator" }, "codex", start),
    {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "operator-native-1",
      policy: "fixed",
      status,
      sessionRoot: home,
      worktreeRoot: home,
      configFingerprint: {
        overall: "a".repeat(64),
        replayable: "a".repeat(64),
        permission: "a".repeat(64),
        sessionBound: "a".repeat(64)
      },
      permissionEnvelope: { adapterId: "codex" }
    },
    start
  );
}

function seedOperator(home, status = "running") {
  const role = createGlobalRole("operator", [{
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  }], "codex", home, start);
  const sessions = operatorSessionSet(home, status);
  const store = new FileTaskStore(home);
  store.saveGlobalRoleWithSessionSet(role, sessions);
  return { role, sessions };
}

function seedOperatorInputs(home) {
  const store = new FileTaskStore(home);
  store.saveTask(createTask("task-1", "Task one", start));
  store.saveInputRequest(createInputRequest(
    "offline-request",
    "task-1",
    requester(),
    {
      question: "Use safe path?",
      choices: [{ key: "safe", label: "Safe path" }],
      blockedRefs: [],
      resolutionPolicy: {
        mode: "offline-recommended",
        recommendation: { choiceKey: "safe", reason: "Safe and reversible." },
        offlineTimeoutMs: 30_000
      }
    },
    start
  ));
  store.saveInputRequest(createInputRequest(
    "user-request",
    "task-1",
    requester(),
    {
      question: "Need explicit approval?",
      choices: [{ key: "yes", label: "Yes" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    start
  ));
}

function writeActiveOperatorLaunchClaim(home, role, sessions) {
  const preparedState = { role, sessionSet: sessions, activeRun: null };
  const claim = {
    schemaVersion: 1,
    scope: "global-role",
    kind: "global-role-launch",
    token: randomUUID(),
    taskId: null,
    roleName: "operator",
    operation: "launch",
    ownerPid: process.pid,
    preparedSession: null,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(preparedState),
    recoveryToken: null,
    ...createRoleRuntimeOperationLease(start),
    phase: "effect-started",
    preparedState
  };
  writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
}

function seedPreparedOperatorLaunch(home, ownerPid) {
  const role = createGlobalRole("operator", [{
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  }], "codex", home, start);
  const preparedSession = operatorSessionSet(home).sessions.codex;
  const reserved = updateRoleAgentSessionStatus(
    operatorSessionSet(home),
    "codex",
    "reserved",
    start
  );
  const preparedState = { role, sessionSet: null, activeRun: null };
  const claim = {
    schemaVersion: 1,
    scope: "global-role",
    kind: "global-role-launch",
    token: randomUUID(),
    taskId: null,
    roleName: "operator",
    operation: "launch",
    ownerPid,
    preparedSession,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(preparedState),
    recoveryToken: null,
    ...createRoleRuntimeOperationLease(start),
    phase: "effect-started",
    preparedState
  };
  const store = new FileTaskStore(home);
  store.saveGlobalRoleWithSessionSet(role, reserved);
  writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
  return { claim, role, reserved };
}

function launchTmux(status, launchToken) {
  let externalEffects = 0;
  return {
    probeRoleStatus: () => status,
    roleLaunchToken: () => launchToken,
    ensureRoleWindow: () => {
      externalEffects += 1;
      throw new Error("scheduler must not create an Operator window");
    },
    externalEffects: () => externalEffects
  };
}

test("foreground Operator presence is proven by the active GlobalRoleSessionSet binding and live window", () => {
  const role = {
    activeAgentId: "codex",
    agentBindings: { codex: { adapterId: "codex" } }
  };
  const sessionSet = {
    activeAgentId: "codex",
    sessions: {
      codex: {
        agentId: "codex",
        adapterId: "codex",
        status: "running"
      }
    }
  };
  const store = {
    getGlobalRole: () => role,
    getGlobalRoleSessionSet: () => sessionSet,
    getActiveAgentRun: () => null
  };

  assert.deepEqual(readOperatorPresence(store, {
    probeRoleStatus: () => "running"
  }), { state: "online" });
  assert.deepEqual(readOperatorPresence(store, {
    probeRoleStatus: () => "exited"
  }), { state: "unknown" });
  assert.deepEqual(readOperatorPresence(store, {
    probeRoleStatus: () => {
      throw new Error("tmux unavailable");
    }
  }), { state: "unknown" });
  assert.deepEqual(readOperatorPresence({
    ...store,
    getGlobalRoleSessionSet: () => ({
      ...sessionSet,
      activeAgentId: "claude"
    })
  }, {
    probeRoleStatus: () => "running"
  }), { state: "unknown" });
  assert.deepEqual(readOperatorPresence({
    ...store,
    getGlobalRoleSessionSet: () => ({
      ...sessionSet,
      sessions: {
        codex: { ...sessionSet.sessions.codex, status: "reserved" }
      }
    })
  }, {
    probeRoleStatus: () => "running"
  }), { state: "unknown" });
  assert.deepEqual(readOperatorPresence({
    ...store,
    getGlobalRoleSessionSet: () => ({
      ...sessionSet,
      sessions: {
        codex: { ...sessionSet.sessions.codex, status: "stopped" }
      }
    })
  }, {
    probeRoleStatus: () => "exited"
  }), { state: "offline" });
  assert.deepEqual(readOperatorPresence({
    ...store,
    getGlobalRoleSessionSet: () => ({
      ...sessionSet,
      sessions: {}
    })
  }, {
    probeRoleStatus: () => "exited"
  }), { state: "offline" });
});

test("only confirmed offline starts and expires an offline-recommended clock; user-required never times out", (t) => {
  const home = createHome(t);
  seed(home);

  assert.deepEqual(scan(home, "online", start), { started: [], resolved: [], cleared: [] });
  assert.equal(new FileTaskStore(home).listOfflineResolutionClocks().length, 0);

  assert.deepEqual(scan(home, "offline", start), {
    started: ["task-1/offline-request"],
    resolved: [],
    cleared: []
  });
  assert.deepEqual(scan(home, "offline", new Date(start.getTime() + 29_999)), {
    started: [],
    resolved: [],
    cleared: []
  });
  assert.deepEqual(scan(home, "unknown", new Date(start.getTime() + 30_000)), {
    started: [],
    resolved: [],
    cleared: ["task-1/offline-request"]
  });

  const restartedAt = new Date(start.getTime() + 40_000);
  assert.deepEqual(scan(home, "offline", restartedAt), {
    started: ["task-1/offline-request"],
    resolved: [],
    cleared: []
  });
  assert.deepEqual(scan(home, "offline", new Date(restartedAt.getTime() + 30_000)), {
    started: [],
    resolved: ["task-1/offline-request"],
    cleared: []
  });

  const store = new FileTaskStore(home);
  assert.equal(store.getInputRequest("task-1", "offline-request").status, "auto-resolved");
  assert.equal(store.getInputResolution("task-1", "auto-offline-request").source, "offline-recommended");
  assert.equal(store.getInputRequest("task-1", "user-request").status, "open");
  assert.equal(store.getInputResolution("task-1", "auto-user-request"), null);
  assert.equal(store.getInputResolutionWakeup("task-1", "offline-request").agentRunId, "leader-run-1");
});

test("Controller scheduler settles a confirmed absent Operator session before advancing the offline clock", (t) => {
  const home = createHome(t);
  seedOperator(home);
  seedOperatorInputs(home);
  const tmux = { probeRoleStatus: () => "exited" };

  runSchedulerTransaction(home, tmux, start, 60_000, false);
  let store = new FileTaskStore(home);
  let sessions = store.getGlobalRoleSessionSet("operator");
  assert.equal(sessions.sessions.codex.status, "stopped");
  assert.equal(sessions.sessions.codex.updatedAt, start.toISOString());
  assert.equal(store.getOfflineResolutionClock("task-1", "offline-request").offlineSince, start.toISOString());
  assert.equal(store.getOfflineResolutionClock("task-1", "user-request"), null);

  runSchedulerTransaction(home, tmux, new Date(start.getTime() + 29_999), 60_000, false);
  store = new FileTaskStore(home);
  sessions = store.getGlobalRoleSessionSet("operator");
  assert.equal(sessions.sessions.codex.status, "stopped");
  assert.equal(sessions.sessions.codex.updatedAt, start.toISOString());
  assert.equal(store.getInputRequest("task-1", "offline-request").status, "open");

  runSchedulerTransaction(home, tmux, new Date(start.getTime() + 30_000), 60_000, false);
  store = new FileTaskStore(home);
  assert.equal(store.getInputRequest("task-1", "offline-request").status, "auto-resolved");
  assert.equal(store.getInputRequest("task-1", "user-request").status, "open");
  assert.equal(store.getOfflineResolutionClock("task-1", "offline-request"), null);
  assert.equal(store.getOfflineResolutionClock("task-1", "user-request"), null);
});

test("Controller scheduler keeps Operator presence unknown across probe failures, launch claims, and incomplete bindings", (t) => {
  const probeFailureHome = createHome(t);
  seedOperator(probeFailureHome);
  seedOperatorInputs(probeFailureHome);
  runSchedulerTransaction(probeFailureHome, {
    probeRoleStatus: () => {
      throw new Error("tmux unavailable");
    }
  }, start, 60_000, false);
  assert.equal(
    new FileTaskStore(probeFailureHome).getGlobalRoleSessionSet("operator").sessions.codex.status,
    "running"
  );
  assert.equal(
    new FileTaskStore(probeFailureHome).getOfflineResolutionClock("task-1", "offline-request"),
    null
  );

  const launchClaimHome = createHome(t);
  const launchClaimSeed = seedOperator(launchClaimHome, "stopped");
  seedOperatorInputs(launchClaimHome);
  writeActiveOperatorLaunchClaim(
    launchClaimHome,
    launchClaimSeed.role,
    launchClaimSeed.sessions
  );
  runSchedulerTransaction(launchClaimHome, { probeRoleStatus: () => "exited" }, start, 60_000, false);
  assert.equal(
    new FileTaskStore(launchClaimHome).getGlobalRoleSessionSet("operator").sessions.codex.status,
    "stopped"
  );
  assert.equal(
    new FileTaskStore(launchClaimHome).getOfflineResolutionClock("task-1", "offline-request"),
    null
  );

  const incompleteBindingHome = createHome(t);
  seedOperator(incompleteBindingHome, "reserved");
  seedOperatorInputs(incompleteBindingHome);
  runSchedulerTransaction(incompleteBindingHome, { probeRoleStatus: () => "exited" }, start, 60_000, false);
  assert.equal(
    new FileTaskStore(incompleteBindingHome).getGlobalRoleSessionSet("operator").sessions.codex.status,
    "reserved"
  );
  assert.equal(
    new FileTaskStore(incompleteBindingHome).getOfflineResolutionClock("task-1", "offline-request"),
    null
  );
});

test("Controller scheduler completes a dead effect-started launch reservation only for its exact live window", (t) => {
  const home = createHome(t);
  const { claim } = seedPreparedOperatorLaunch(home, 2_147_483_647);
  seedOperatorInputs(home);
  const tmux = launchTmux("running", claim.token);
  const recoveredAt = new Date(start.getTime() + 1_000);

  runSchedulerTransaction(home, tmux, recoveredAt, 60_000, false);
  let store = new FileTaskStore(home);
  let sessions = store.getGlobalRoleSessionSet("operator");
  assert.equal(readGlobalRoleRuntimeOperationClaim(home, "operator"), null);
  assert.equal(sessions.sessions.codex.status, "running");
  assert.equal(sessions.sessions.codex.updatedAt, recoveredAt.toISOString());
  assert.equal(store.getOfflineResolutionClock("task-1", "offline-request"), null);
  assert.equal(tmux.externalEffects(), 0);

  runSchedulerTransaction(home, tmux, new Date(recoveredAt.getTime() + 1), 60_000, false);
  store = new FileTaskStore(home);
  sessions = store.getGlobalRoleSessionSet("operator");
  assert.equal(readGlobalRoleRuntimeOperationClaim(home, "operator"), null);
  assert.equal(sessions.sessions.codex.updatedAt, recoveredAt.toISOString());
  assert.equal(tmux.externalEffects(), 0);
});

test("Controller scheduler terminalizes a dead absent launch claim before advancing its offline clock", (t) => {
  const home = createHome(t);
  const { claim } = seedPreparedOperatorLaunch(home, 2_147_483_647);
  seedOperatorInputs(home);
  const tmux = launchTmux("exited", claim.token);
  const recoveredAt = new Date(start.getTime() + 1_000);

  runSchedulerTransaction(home, tmux, recoveredAt, 60_000, false);
  let store = new FileTaskStore(home);
  let sessions = store.getGlobalRoleSessionSet("operator");
  assert.equal(readGlobalRoleRuntimeOperationClaim(home, "operator"), null);
  assert.equal(sessions.sessions.codex.status, "stopped");
  assert.equal(sessions.sessions.codex.updatedAt, recoveredAt.toISOString());
  assert.equal(store.getOfflineResolutionClock("task-1", "offline-request").offlineSince, recoveredAt.toISOString());
  assert.equal(store.getOfflineResolutionClock("task-1", "user-request"), null);
  assert.equal(tmux.externalEffects(), 0);

  runSchedulerTransaction(home, tmux, new Date(recoveredAt.getTime() + 29_999), 60_000, false);
  store = new FileTaskStore(home);
  sessions = store.getGlobalRoleSessionSet("operator");
  assert.equal(sessions.sessions.codex.updatedAt, recoveredAt.toISOString());
  assert.equal(store.getInputRequest("task-1", "offline-request").status, "open");

  runSchedulerTransaction(home, tmux, new Date(recoveredAt.getTime() + 30_000), 60_000, false);
  store = new FileTaskStore(home);
  assert.equal(store.getInputRequest("task-1", "offline-request").status, "auto-resolved");
  assert.equal(store.getInputRequest("task-1", "user-request").status, "open");
});

test("Controller scheduler leaves live launch leases and tmux probe failures unknown", (t) => {
  const liveHome = createHome(t);
  const live = seedPreparedOperatorLaunch(liveHome, process.pid);
  seedOperatorInputs(liveHome);
  runSchedulerTransaction(liveHome, launchTmux("running", live.claim.token), start, 60_000, false);
  assert.equal(readGlobalRoleRuntimeOperationClaim(liveHome, "operator").token, live.claim.token);
  assert.equal(new FileTaskStore(liveHome).getGlobalRoleSessionSet("operator").sessions.codex.status, "reserved");
  assert.equal(new FileTaskStore(liveHome).getOfflineResolutionClock("task-1", "offline-request"), null);

  const probeFailureHome = createHome(t);
  const probeFailure = seedPreparedOperatorLaunch(probeFailureHome, 2_147_483_647);
  seedOperatorInputs(probeFailureHome);
  runSchedulerTransaction(probeFailureHome, {
    probeRoleStatus: () => {
      throw new Error("tmux unavailable");
    },
    roleLaunchToken: () => probeFailure.claim.token
  }, start, 60_000, false);
  assert.equal(readGlobalRoleRuntimeOperationClaim(probeFailureHome, "operator").token, probeFailure.claim.token);
  assert.equal(
    new FileTaskStore(probeFailureHome).getGlobalRoleSessionSet("operator").sessions.codex.status,
    "reserved"
  );
  assert.equal(new FileTaskStore(probeFailureHome).getOfflineResolutionClock("task-1", "offline-request"), null);

  const tokenProbeFailureHome = createHome(t);
  const tokenProbeFailure = seedPreparedOperatorLaunch(tokenProbeFailureHome, 2_147_483_647);
  seedOperatorInputs(tokenProbeFailureHome);
  runSchedulerTransaction(tokenProbeFailureHome, {
    probeRoleStatus: () => "running",
    roleLaunchToken: () => {
      throw new Error("tmux launch token unavailable");
    }
  }, start, 60_000, false);
  assert.equal(
    readGlobalRoleRuntimeOperationClaim(tokenProbeFailureHome, "operator").token,
    tokenProbeFailure.claim.token
  );
  assert.equal(
    new FileTaskStore(tokenProbeFailureHome).getGlobalRoleSessionSet("operator").sessions.codex.status,
    "reserved"
  );
  assert.equal(
    new FileTaskStore(tokenProbeFailureHome).getOfflineResolutionClock("task-1", "offline-request"),
    null
  );
});
