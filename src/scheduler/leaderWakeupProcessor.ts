import { createTaskEvent } from "../event/taskEvent.js";
import { createCycle, type CycleCause } from "../cycle/cycle.js";
import { compileDispatchInput } from "../context/dispatchContext.js";
import {
  updateRoleAgentSessionStatus,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  claimRoleRuntimeOperation,
  clearRoleRuntimeOperationClaim,
  createRoleRuntimeOperationLease,
  executePostCommitRoleDispatch,
  readRoleRuntimeOperationClaim,
  readRoleRuntimeStateSnapshot,
  releaseRoleRuntimeOperationClaim,
  resolveAgentExecutor,
  roleRuntimeStateDigest,
  type RoleLaunchRuntimeOperationClaim
} from "../executor/executorRegistry.js";
import { activeRoleAgentBinding, updateRoleStatus, type Role } from "../role/role.js";
import { resolveAgent } from "../agent/agentRegistry.js";
import type { AgentDefinition } from "../agent/agent.js";
import { createAgentRun, type AgentRun } from "../run/agentRun.js";
import { recordLeaderFailure } from "./leaderFailure.js";
import { createLeaderRecoveryNotification, leaderRecoveryNotificationId } from "./operatorNotification.js";
import type { TaskReader, TaskStore } from "../storage/taskStore.js";
import { FileTaskStore } from "../storage/taskStore.js";
import { executeDomainTransaction } from "../storage/domainTransaction.js";
import { DomainTransactionRecoveryError } from "../storage/recoveryJournal.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";
import { randomUUID } from "node:crypto";
import type { DispatchMode } from "../executor/launchPlan.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import type { Task } from "../task/task.js";
import {
  persistTaskRoleDispatch,
  recoverTaskRoleRuntimeOperations,
  type PreparedTaskRoleDispatch
} from "../commands/taskCommands.js";

export type LeaderWakeupProcessingResult = {
  taskId: string;
  status: "dispatched" | "skipped" | "failed";
  error?: string;
};

type PreparedLeaderWakeup =
  | { kind: "skipped"; taskId: string }
  | {
      kind: "ready";
      wakeup: PendingWakeup;
      task: Task;
      role: Role;
      sessionSet: TaskRoleSessionSet | null;
      session: RoleAgentSession | null;
      mode: DispatchMode;
      input: string;
      run: AgentRun;
      agent: AgentDefinition;
    }
  | {
      kind: "failed";
      task: Task;
      role: Role;
      error: unknown;
    };

export function processLeaderWakeups(
  store: TaskStore,
  tmux: TmuxManager,
  now: Date,
  rootDir: string = store.rootDirectory()
): LeaderWakeupProcessingResult[] {
  recoverTaskRoleRuntimeOperations(rootDir, tmux, now);
  const preparations = store.runReadSnapshot((snapshot) =>
    snapshot.listPendingWakeups().map((wakeup) => prepareLeaderWakeup(snapshot, wakeup, now, rootDir)));

  return preparations.map((preparation) => {
    if (preparation.kind === "skipped") {
      return { taskId: preparation.taskId, status: "skipped" };
    }
    if (preparation.kind === "failed") {
      return recordLeaderWakeupFailure(preparation.task, preparation.role, preparation.error, tmux, now, rootDir);
    }
    return dispatchLeaderWakeup(preparation, tmux, now, rootDir);
  });
}

function prepareLeaderWakeup(
  store: TaskReader,
  wakeup: PendingWakeup,
  now: Date,
  rootDir: string
): PreparedLeaderWakeup {
  const task = store.getTask(wakeup.taskId);
  const role = store.getRole(wakeup.taskId, "leader");
  const sessionSet = store.getRoleSessionSet(wakeup.taskId, "leader");
  const session = role === null ? null : sessionSet?.sessions[role.activeAgentId] ?? null;

  if (
    task === null ||
    task.archived ||
    role === null ||
    readRoleRuntimeOperationClaim(rootDir, wakeup.taskId, "leader") !== null ||
    store.getLeaderFailure(wakeup.taskId) !== null ||
    store.getActiveAgentRun(wakeup.taskId, "leader") !== null
  ) {
    return { kind: "skipped", taskId: wakeup.taskId };
  }

  try {
    const mode: DispatchMode = session === null || session.status === "reserved" ? "new" : "resume";
    const input = [
      `TaskMux wakeup reasons: ${wakeup.reasons.join(", ")}.`,
      `Run taskmux task context ${task.id} --format json, then continue Leader stewardship.`
    ].join(" ");
    const compiledInput = compileDispatchInput(store, task.id, role, input);
    const run = createAgentRun(
      store.nextAgentRunId(task.id),
      task.id,
      role.name,
      mode,
      compiledInput,
      now
    );
    if (store.getAgentRun(task.id, run.id) !== null) {
      throw new Error(`Leader AgentRun id was allocated concurrently: ${task.id}/${run.id}.`);
    }
    const binding = activeRoleAgentBinding(role);
    if (
      mode === "new" &&
      session === null &&
      binding.adapterId === "codex" &&
      store.listAgentRuns(task.id).some((candidate) => candidate.roleName === role.name)
    ) {
      throw new Error("Codex Leader has an unregistered prior AgentRun; native session recovery is required.");
    }
    const agent = resolveAgent(binding.agentId, store.listConfiguredAgents());
    if (agent === null) throw new Error(`Leader Agent is not configured: ${binding.agentId}.`);
    return {
      kind: "ready",
      wakeup,
      task,
      role,
      sessionSet,
      session,
      mode,
      input: compiledInput,
      run,
      agent
    };
  } catch (error) {
    return { kind: "failed", task, role, error };
  }
}

function dispatchLeaderWakeup(
  preparation: Extract<PreparedLeaderWakeup, { kind: "ready" }>,
  tmux: TmuxManager,
  now: Date,
  rootDir: string
): LeaderWakeupProcessingResult {
  const { wakeup, task, role, sessionSet, session, mode, input, run, agent } = preparation;
  let effectiveSession: RoleAgentSession | null = session;
  try {
    const prepared = resolveAgentExecutor(activeRoleAgentBinding(role).adapterId).plan({
      taskmuxHome: rootDir,
      taskId: task.id,
      role,
      agent,
      run,
      session,
      input,
      now
    });
    effectiveSession = prepared.session;
    const atomicDispatch: PreparedTaskRoleDispatch = {
      taskId: task.id,
      role,
      expectedStateDigest: roleRuntimeStateDigest({
        role,
        sessionSet,
        activeRun: null,
        selectedWorkItem: null,
        pendingRun: { id: run.id, existing: null }
      }),
      run,
      workItem: null,
      expectedWorkItemUpdatedAt: null,
      sessionSet,
      session: effectiveSession,
      launch: prepared.launch,
      input,
      mode
    };
    const intent: RoleLaunchRuntimeOperationClaim = {
      schemaVersion: 1 as const,
      scope: "task-role" as const,
      kind: "launch",
      token: randomUUID(),
      taskId: task.id,
      roleName: role.name,
      operation: "leader-wakeup" as const,
      ownerPid: process.pid,
      preparedSession: effectiveSession,
      selectedWorkItem: null,
      pendingRun: { id: run.id, taskId: task.id, roleName: role.name },
      expectedStateDigest: atomicDispatch.expectedStateDigest,
      recoveryToken: null,
      ...createRoleRuntimeOperationLease(now)
    };
    executePostCommitRoleDispatch(tmux, {
      taskId: task.id,
      role,
      launch: prepared.launch,
      input,
      replaceExisting: mode === "new",
      launchToken: intent.token
    }, () => executeDomainTransaction(rootDir, `leader-wakeup-${randomUUID()}`, (workingRoot) => {
      const transactionStore = FileTaskStore.forDomainTransactionWorkspace(workingRoot, intent.token);
      persistTaskRoleDispatch(atomicDispatch, transactionStore, { recordAcceptedEvent: false });
      const schedule = transactionStore.getTaskSchedule(task.id);
      if (schedule !== null) {
        transactionStore.saveTaskSchedule(task.id, {
          ...schedule,
          lastLeaderWakeupAt: now.toISOString(),
          updatedAt: now.toISOString()
        });
      }
      transactionStore.saveEvent(task.id, createTaskEvent(
        transactionStore.nextEventId(task.id),
        "leader.wakeup_dispatched",
        { reasons: wakeup.reasons.join(",") },
        now
      ));
      const cycle = createCycle(
        transactionStore.nextCycleId(task.id),
        task.id,
        cycleCauseForWakeup(wakeup.reasons),
        `Leader wakeup: ${wakeup.reasons.join(", ")}`,
        now
      );
      transactionStore.saveCycle(task.id, cycle);
      transactionStore.saveEvent(task.id, createTaskEvent(
        transactionStore.nextEventId(task.id),
        "cycle.created",
        { cycle: cycle.id, cause: cycle.cause },
        now
      ));
      transactionStore.clearPendingWakeupIfUnchanged(wakeup);
      clearRoleRuntimeOperationClaim(
        workingRoot,
        intent.taskId,
        intent.roleName,
        intent.token
      );
    }), {
      claim: () => claimRoleRuntimeOperation(
        rootDir,
        `leader-wakeup-claim-${randomUUID()}`,
        intent,
        (workingRoot) => roleRuntimeStateDigest(readRoleRuntimeStateSnapshot(
          new FileTaskStore(workingRoot),
          intent.taskId,
          intent.roleName,
          { pendingRunId: intent.pendingRun?.id }
        ))
      ),
      release: () => releaseRoleRuntimeOperationClaim(
        rootDir,
        `leader-wakeup-release-${randomUUID()}`,
        intent
      )
    });
    return { taskId: task.id, status: "dispatched" };
  } catch (error) {
    if (error instanceof DomainTransactionRecoveryError) {
      throw error;
    }
    return recordLeaderWakeupFailure(task, role, error, tmux, now, rootDir);
  }
}

function recordLeaderWakeupFailure(
  task: Task,
  role: Role,
  error: unknown,
  tmux: TmuxManager,
  now: Date,
  rootDir: string
): LeaderWakeupProcessingResult {
  if (readRoleRuntimeOperationClaim(rootDir, task.id, role.name) !== null) {
    return { taskId: task.id, status: "skipped" };
  }
  const detail = error instanceof Error ? error.message : String(error);
  const message = `Leader dispatch failed: ${detail}`;
  const failureRecorded = executeDomainTransaction(rootDir, `leader-wakeup-failed-${randomUUID()}`, (workingRoot) => {
    const transactionStore = new FileTaskStore(workingRoot);
    const currentRole = transactionStore.getRole(task.id, role.name);
    if (
      currentRole === null ||
      currentRole.updatedAt !== role.updatedAt ||
      transactionStore.getActiveAgentRun(task.id, role.name) !== null
    ) {
      return false;
    }
    const currentSessionSet = transactionStore.getRoleSessionSet(task.id, role.name);
    const currentSession = currentSessionSet?.sessions[currentRole.activeAgentId] ?? null;
    transactionStore.saveLeaderFailure(recordLeaderFailure(
      task.id,
      currentSession?.nativeSessionId ?? "(unregistered)",
      message,
      now,
      transactionStore.getLeaderFailure(task.id)
    ));
    transactionStore.saveOperatorNotification(createLeaderRecoveryNotification(
      task.id,
      message,
      now,
      transactionStore.getOperatorNotification(task.id)
    ));
    if (currentSessionSet !== null && currentSession !== null && currentSession.status !== "reserved") {
      transactionStore.saveRoleSessionSet(updateRoleAgentSessionStatus(
        currentSessionSet,
        currentRole.activeAgentId,
        "broken",
        now
      ));
    }
    transactionStore.saveRole(task.id, updateRoleStatus(currentRole, "failed", now));
    return true;
  });
  if (!failureRecorded) {
    return { taskId: task.id, status: "skipped" };
  }
  try {
    tmux.sendRoleInput(
      "operator",
      "operator",
      `TaskMux alert: Leader recovery failed for ${task.id}. ${message}`
    );
  } catch {
    // The durable notification remains available when Operator is not running.
  }
  return {
    taskId: task.id,
    status: "failed",
    error: message
  };
}

function cycleCauseForWakeup(reasons: string[]): CycleCause {
  const supported = reasons.find((reason): reason is CycleCause => [
    "task-created",
    "user-comment",
    "schedule",
    "review-time",
    "operator-input",
    "role-result",
    "inactivity",
    "explicit-wake"
  ].includes(reason));

  if (supported !== undefined) {
    return supported;
  }
  if (reasons.some((reason) => reason.startsWith("role-") || reason.startsWith("leader-run-"))) {
    return "role-result";
  }
  return "explicit-wake";
}
