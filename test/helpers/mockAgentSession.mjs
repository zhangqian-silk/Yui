import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  bindExecution,
  claimPending,
  completeProcessing
} from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { ExecutorRegistry } from "../../dist/executor/executorRegistry.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import {
  bindTaskRoleRun,
  clearTaskRoleRun,
  createRoleSessionSet,
  recordRoleAgentSession,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createSessionLaunchRequest } from "../../dist/runtime/sessionLaunchRequest.js";
import { TmuxSessionHost } from "../../dist/runtime/tmuxAdapters.js";
import {
  createAgentRun,
  failAgentRun,
  markAgentRunDelivered
} from "../../dist/run/agentRun.js";
import { reconcileStalledRoleRuns } from "../../dist/scheduler/roleRunStall.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { CommandExecutionError } from "../../dist/tmux/commandExecutor.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { createOwnedRunRoot } from "./isolationPreflight.js";
import { createIsolatedRuntime } from "./isolatedRuntime.js";
import { createEvidenceRecorder } from "./testEvidence.js";
import { taskOwnedWorkspace } from "./taskWorkspace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_EXECUTABLE = join(HERE, "mockClaudeAgent.mjs");
const START = new Date("2026-08-09T00:00:00.000Z");
const PUSHED = new Date("2026-08-09T00:00:01.000Z");
const FOLDED = new Date("2026-08-09T00:00:02.000Z");
const SUCCESSOR = new Date("2026-08-09T00:00:03.000Z");
const WAITING_WORKER_START = new Date("2026-08-09T00:30:00.000Z");
const WAIT_TIMEOUT_MS = 4_000;
const EXPLICIT_TMUX_RESOURCE_ABSENCE =
  /can't find (?:session|window|pane)|no server running|no current target|session not found|error connecting to .+ \(No such file or directory\)/iu;

export function isExplicitTmuxResourceAbsenceError(error) {
  return error instanceof CommandExecutionError
    && error.code === "COMMAND_FAILED"
    && EXPLICIT_TMUX_RESOURCE_ABSENCE.test(error.stderr);
}

export async function createMockAgentSession(
  testContext,
  { scenario, delayMs, waitingLeader = false, teardownFault, stopFault }
) {
  if (waitingLeader && scenario !== "no-progress") {
    throw new Error("Waiting-Leader fixture requires the no-progress Mock Agent scenario.");
  }
  const owned = createOwnedRunRoot({ prefix: "yui-mock-agent-" });
  const runtimeRoot = join(owned.canonicalRunRoot, "runtime-domain");
  const runtime = createIsolatedRuntime(undefined, { root: runtimeRoot });
  const evidence = createEvidenceRecorder({
    tier: "mock-agent-session",
    name: `Mock Agent Session (${scenario})`,
    binarySource: process.execPath,
    yuiHome: runtime.home,
    workspace: runtime.root,
    namespaceOwnership: {
      kind: runtime.identity.domainKind,
      home: runtime.home,
      tmuxServer: runtime.identity.tmuxServer,
      token: runtime.identity.token
    }
  });
  evidence
    .recordCheck(
      "controller-runtime",
      "not-started",
      "The fixture exercises production launch/runtime seams directly; no detached Controller was started."
    )
    .recordCheck(
      "provider-e2e",
      "not-run",
      "No real provider, model, or network path was invoked."
    )
    .recordCheck(
      "release-e2e",
      "not-run",
      "No install, update, upgrade, or global npm-prefix flow was invoked."
    )
    .noteVerificationGap("Detached Controller scheduling was not exercised by this Mock fixture.")
    .noteVerificationGap("Provider E2E and Release E2E were not run.");
  let cleaned = false;
  const stopSessions = [];
  const teardown = async () => {
    if (cleaned) return;
    let runtimeCleaned = false;
    let failure;
    let eligibleStopAbsence;
    const remember = (error) => {
      if (failure === undefined) failure = error;
    };
    try {
      for (const stopSession of stopSessions) {
        try {
          await stopSession();
        } catch (error) {
          if (isExplicitTmuxResourceAbsenceError(error)) {
            if (eligibleStopAbsence === undefined) eligibleStopAbsence = error;
          } else {
            remember(error);
          }
        }
      }
      try {
        await runtime.teardown();
        runtimeCleaned = true;
        if (teardownFault !== undefined) remember(teardownFault);
      } catch (error) {
        remember(error);
      }
    } finally {
      if (runtimeCleaned) {
        try {
          rmSync(owned.canonicalRunRoot, { recursive: true, force: true });
          if (existsSync(owned.canonicalRunRoot)) {
            throw new Error("Mock Agent owned run root still exists after exact teardown.");
          }
          cleaned = true;
        } catch (error) {
          remember(error);
        }
      }
    }
    const absenceConverged = eligibleStopAbsence !== undefined
      && runtimeCleaned
      && cleaned
      && failure === undefined;
    if (eligibleStopAbsence !== undefined && !absenceConverged) {
      failure = failure === undefined
        ? eligibleStopAbsence
        : new AggregateError(
            [eligibleStopAbsence, failure],
            "Mock Agent cleanup could not prove explicit tmux absence converged."
          );
    }
    if (failure !== undefined) {
      evidence.recordCleanup(
        "error",
        failure instanceof Error ? failure.message : String(failure)
      );
      throw failure;
    }
    evidence.recordCleanup(
      "success",
      absenceConverged
        ? "exact runtime teardown completed; owned root removed; explicit tmux absence converged"
        : "exact runtime teardown completed; owned root removed"
    );
  };
  testContext.after(teardown);

  const readyPath = join(runtime.root, "mock-agent.ready");
  const observationPath = join(runtime.root, "mock-agent.ndjson");
  const store = new FileTaskStore(runtime.home);
  const agent = createConfiguredAgent(
    "mock-claude",
    "claude",
    process.execPath,
    [
      MOCK_EXECUTABLE,
      "--yui-mock-scenario", scenario,
      "--yui-mock-root", owned.canonicalRunRoot,
      "--yui-mock-observation", observationPath,
      "--yui-mock-ready", readyPath,
      ...(delayMs === undefined
        ? []
        : ["--yui-mock-delay-ms", String(delayMs)])
    ],
    [],
    START
  );
  const task = activateTask(createTask("task-mock", "Mock Agent Session", START, {
    cwd: runtime.root
  }), START);
  const role = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding(agent)],
    agent.id,
    runtime.root,
    START
  );
  const leader = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    runtime.root,
    START
  );
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Exercise Mock Agent Session", assignee: role.name },
    START
  ), "running", START);
  const workerRunStart = waitingLeader ? WAITING_WORKER_START : START;
  const run = createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "Return the deterministic result",
    workerRunStart,
    {
      workItemId: item.id,
      effective: resolveEffectiveLaunch({ role, purpose: "execution" })
    }
  );
  const leaderRun = waitingLeader
    ? markAgentRunDelivered(createAgentRun(
        "agent-run-2",
        task.id,
        leader.name,
        "new",
        "Steward the Task while the Worker remains healthy",
        START,
        { effective: resolveEffectiveLaunch({ role: leader, purpose: "execution" }) }
      ), START)
    : null;
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveManagedWorkspace(taskOwnedWorkspace(task, START));
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, role);
    tx.saveWorkItem(task.id, item);
    tx.saveActiveAgentRun(run);
    if (leaderRun !== null) tx.saveActiveAgentRun(leaderRun);
    const target = { kind: "role", taskId: task.id, roleName: role.name };
    enqueueWork(tx, target, "run-dispatched", workerRunStart, [{
      type: "run",
      taskId: task.id,
      id: run.id
    }]);
    const mailbox = tx.getWorkMailbox(target);
    tx.saveWorkMailbox(bindExecution(claimPending(mailbox, {
      batchId: "delivery-1",
      owner: "mock-agent-session",
      startedAt: workerRunStart.toISOString()
    }), "delivery-1", { type: "run", taskId: task.id, id: run.id }));
  });

  const planner = new FileRoleLaunchPlanner(runtime.home, store, {
    environment: runtime.environment
  });
  const scheduler = new FileSchedulerStoreAdapter(store);
  const tmux = runtime.tmux();
  let bindingSequence = 0;
  const host = new TmuxSessionHost(planner, tmux, {
    createBindingId: () => `binding-${scenario}-${++bindingSequence}`
  });
  const delivery = new ExecutorRegistry(planner, tmux);
  const launchId = `launch-${scenario}`;
  scheduler.reserveRuntimeLaunch({
    owner: { scope: "task", taskId: task.id, roleName: role.name },
    launchId,
    runId: run.id
  }, () => {}, workerRunStart);
  const binding = await host.start(createSessionLaunchRequest({
    mode: "new",
    launchId,
    owner: { scope: "task", taskId: task.id, roleName: role.name },
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective: run.effective,
    workspace: runtime.root,
    runId: run.id,
    environment: runtime.environment
  }));
  if (binding.nativeSessionId === undefined) {
    throw new Error("Mock Claude launch did not allocate a native session id.");
  }
  stopSessions.push(async () => {
    if (stopFault !== undefined) throw stopFault;
    await host.stop(binding);
  });
  const receiptId = `agent-run:${task.id}/${run.id}`;
  const schedulerSession = {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: binding.nativeSessionId,
    status: "ready",
    effective: run.effective
  };
  store.transaction((tx) => {
    let sessions = createRoleSessionSet(
      { scope: "task", taskId: task.id, roleName: role.name },
      agent.id,
      workerRunStart
    );
    sessions = recordRoleAgentSession(sessions, {
      ...schedulerSession,
      launchId,
      policy: "fixed",
      status: "reserved"
    }, workerRunStart);
    sessions = bindTaskRoleRun(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId
    }, workerRunStart);
    tx.saveTaskRoleSessionSet(sessions);
  });
  if (binding.initialPromptRunId !== run.id) {
    throw new Error("Mock Claude launch did not carry the exact managed Run input.");
  }
  scheduler.saveRoleRunDelivery({
    task,
    role,
    run,
    session: schedulerSession,
    launchId,
    now: waitingLeader
      ? new Date(workerRunStart.getTime() + 1_000)
      : PUSHED
  });
  writeFileSync(readyPath, "ready\n", "utf8");

  let leaderBinding;
  if (leaderRun !== null) {
    const leaderLaunchId = "launch-waiting-leader";
    scheduler.reserveRuntimeLaunch({
      owner: { scope: "task", taskId: task.id, roleName: leader.name },
      launchId: leaderLaunchId,
      runId: leaderRun.id
    }, () => {}, START);
    leaderBinding = await host.start(createSessionLaunchRequest({
      mode: "new",
      launchId: leaderLaunchId,
      owner: { scope: "task", taskId: task.id, roleName: leader.name },
      agentId: agent.id,
      adapterId: agent.adapterId,
      effective: leaderRun.effective,
      workspace: runtime.root,
      runId: leaderRun.id,
      environment: runtime.environment
    }));
    if (leaderBinding.nativeSessionId === undefined) {
      throw new Error("Mock Leader launch did not allocate a native session id.");
    }
    stopSessions.push(async () => {
      if (stopFault !== undefined) throw stopFault;
      await host.stop(leaderBinding);
    });
    store.transaction((tx) => {
      let sessions = createRoleSessionSet(
        { scope: "task", taskId: task.id, roleName: leader.name },
        agent.id,
        START
      );
      sessions = recordRoleAgentSession(sessions, {
        agentId: agent.id,
        adapterId: agent.adapterId,
        nativeSessionId: leaderBinding.nativeSessionId,
        launchId: leaderLaunchId,
        policy: "fixed",
        status: "reserved",
        effective: leaderRun.effective
      }, START);
      sessions = bindTaskRoleRun(sessions, {
        agentId: agent.id,
        runId: leaderRun.id,
        receiptId: `agent-run:${task.id}/${leaderRun.id}`
      }, START);
      tx.saveTaskRoleSessionSet(sessions);
    });
  }

  evidence
    .markSessionCreated(`nativeSessionId=${binding.nativeSessionId}`)
    .recordCheck(
      "runtime-launch",
      "passed",
      `node=${process.execPath}; mock=${MOCK_EXECUTABLE}; production=dist FileRoleLaunchPlanner/TmuxSessionHost`
    );

  const inbox = new FileRuntimeEventInbox(runtime.home);
  const processor = new FileRuntimeEventProcessor(inbox, scheduler);
  const readObservations = () => {
    try {
      return readFileSync(observationPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  const waitFor = async (read, description) => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const found = await read();
      if (found !== undefined) return found;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Mock Agent ${description}.`);
      }
      await delay(20);
    }
  };

  return {
    home: runtime.home,
    workspace: runtime.root,
    tmuxServer: runtime.identity.tmuxServer,
    ownershipToken: runtime.identity.token,
    ownedRoot: owned.canonicalRunRoot,
    nativeSessionId: binding.nativeSessionId,
    leaderNativeSessionId: leaderBinding?.nativeSessionId,
    processCommand: process.execPath,
    mockExecutable: MOCK_EXECUTABLE,
    modelCalled: false,
    currentRun: () => store.getAgentRun(task.id, run.id),
    leaderRun: () => leaderRun === null ? null : store.getAgentRun(task.id, leaderRun.id),
    activeRun: () => store.getActiveAgentRun(task.id, role.name),
    currentWorkItem: () => store.getWorkItem(task.id, item.id),
    inboxEvents: () => inbox.list(),
    drainEvents: () => processor.drain(FOLDED),
    waitForEvent: (event) => waitFor(
      () => inbox.list().find((candidate) => (
        event === "session-start"
          ? candidate.type === "native-session-lifecycle"
          : event === "prompt-accepted"
            ? candidate.type === "native-prompt-accepted"
            : candidate.type === "claude-stop-failure"
      )),
      `runtime event ${event}`
    ),
    taskEvents: () => store.listEvents(task.id),
    taskMessages: () => store.listMessages(task.id),
    waitForObservation: (event, expected = {}) => waitFor(
      () => readObservations().find((candidate) => (
        candidate.event === event
        && Object.entries(expected).every(([key, value]) => candidate[key] === value)
      )),
      `observation ${event}`
    ),
    waitForHook: (hook) => waitFor(
      () => readObservations().find((candidate) => (
        candidate.event === "hook" && candidate.hook === hook
      )),
      `hook ${hook}`
    ),
    inspect: async () => (await host.inspect(binding)).state,
    waitForState: (state) => waitFor(
      async () => (await host.inspect(binding)).state === state ? state : undefined,
      `runtime state ${state}`
    ),
    async expectNoRuntimeEvents(milliseconds) {
      const before = inbox.list().map(({ id }) => id);
      await delay(milliseconds);
      const after = inbox.list().map(({ id }) => id);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error("Mock Agent unexpectedly produced a runtime event.");
      }
    },
    teardown,
    ownedRootExists: () => existsSync(owned.canonicalRunRoot),
    evidenceSnapshot: () => evidence.snapshot(),
    evidenceReport: () => evidence.render(),
    async reconcileWaitingLeader(now, windowMs) {
      if (leaderRun === null || leaderBinding?.nativeSessionId === undefined) {
        throw new Error("Mock Agent Session was not configured with a waiting Leader.");
      }
      const inputs = [
        {
          taskId: task.id,
          roleName: leader.name,
          agentId: agent.id,
          adapterId: agent.adapterId,
          nativeSessionId: leaderBinding.nativeSessionId
        },
        {
          taskId: task.id,
          roleName: role.name,
          agentId: agent.id,
          adapterId: agent.adapterId,
          nativeSessionId: binding.nativeSessionId
        }
      ];
      const observed = await delivery.inspectRoles(inputs);
      const exactInspections = await Promise.all([
        host.inspect(leaderBinding),
        host.inspect(binding)
      ]);
      const liveness = inputs.map((input, index) => {
        const status = observed.find((candidate) => (
          candidate.taskId === input.taskId && candidate.roleName === input.roleName
        ))?.status;
        if (status === undefined) {
          throw new Error(`Missing exact liveness observation for ${input.taskId}/${input.roleName}.`);
        }
        const exact = exactInspections[index];
        if (
          exact.state !== "running"
          || exact.nativeSessionId !== input.nativeSessionId
        ) {
          throw new Error(
            `Native Session fence changed during liveness observation for ${input.taskId}/${input.roleName}.`
          );
        }
        return { ...input, status };
      }).map(({ agentId: _agentId, adapterId: _adapterId, ...observation }) => observation);
      const liveStatuses = new Map(liveness.map((observation) => [
        `${observation.taskId}\0${observation.roleName}`,
        observation.status
      ]));
      const raised = await reconcileStalledRoleRuns(
        scheduler,
        delivery,
        now,
        undefined,
        windowMs,
        liveStatuses
      );
      return { liveness, raised };
    },
    advanceGeneration() {
      const active = store.getActiveAgentRun(task.id, role.name);
      const sessions = store.getTaskRoleSessionSet(task.id, role.name);
      if (active === null || sessions === null || sessions.inFlight === null) {
        throw new Error("Mock Agent successor requires an exact active generation.");
      }
      const successor = createAgentRun(
        "agent-run-2",
        task.id,
        role.name,
        "new",
        "Return only the successor result",
        SUCCESSOR,
        { workItemId: item.id, effective: run.effective }
      );
      let nextSessions = clearTaskRoleRun(sessions, {
        agentId: agent.id,
        runId: active.id,
        receiptId
      }, SUCCESSOR);
      nextSessions = updateRoleAgentSessionStatus(
        nextSessions,
        agent.id,
        "stopped",
        SUCCESSOR
      );
      nextSessions = recordRoleAgentSession(nextSessions, {
        agentId: agent.id,
        adapterId: agent.adapterId,
        nativeSessionId: "native-successor",
        launchId: "launch-successor",
        policy: "fixed",
        status: "running",
        effective: run.effective
      }, SUCCESSOR);
      nextSessions = bindTaskRoleRun(nextSessions, {
        agentId: agent.id,
        runId: successor.id,
        receiptId: `agent-run:${task.id}/${successor.id}`
      }, SUCCESSOR);
      store.transaction((tx) => {
        tx.saveAgentRun(failAgentRun(active, "Superseded by fixture generation.", SUCCESSOR));
        tx.clearActiveAgentRun(task.id, role.name);
        tx.saveAgentRun(successor);
        tx.saveTaskRoleSessionSet(nextSessions);
        const target = { kind: "role", taskId: task.id, roleName: role.name };
        const currentMailbox = tx.getWorkMailbox(target);
        tx.saveWorkMailbox(completeProcessing(currentMailbox, "delivery-1"));
        enqueueWork(tx, target, "run-dispatched", SUCCESSOR, [{
          type: "run",
          taskId: task.id,
          id: successor.id
        }]);
        const queued = tx.getWorkMailbox(target);
        tx.saveWorkMailbox(bindExecution(claimPending(queued, {
          batchId: "delivery-2",
          owner: "mock-agent-session",
          startedAt: SUCCESSOR.toISOString()
        }), "delivery-2", {
          type: "run",
          taskId: task.id,
          id: successor.id
        }));
        tx.saveActiveAgentRun(successor);
      });
      return successor;
    },
    inputSubmittedAtLaunch: binding.initialPromptRunId === run.id
  };
}
