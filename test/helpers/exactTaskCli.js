import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  markTaskRoleRunPushed
} from "../../dist/executor/agentExecutor.js";
import {
  EXACT_CONTROL_ARGUMENT,
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR,
  assertExactTaskRuntimeState,
  createExactControlPlaneDescriptor,
  createExactTaskRuntimeDescriptor,
  exactControlPlaneDigest,
  exactTaskRuntimeDescriptorPath,
  serializeExactDescriptor
} from "../../dist/runtime/exactControlPlane.js";
import {
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../../dist/runtime/lifecycleReservation.js";
import { writeTextFileAtomically } from "../../dist/storage/durableFile.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { TASK_FINAL_REVIEW_ARGUMENT } from "../../dist/review/taskFinalReviewContract.js";

let nextLaunch = 0;

/** Builds a real exact managed-Task CLI envelope around an existing fixture Role. */
export function exactTaskCliInvocation({
  home,
  store,
  taskId,
  roleName,
  taskFinalReviewerRole,
  environment = process.env,
  cliEntry = join(process.cwd(), "dist", "cli.js")
}) {
  stopFixtureController(home, cliEntry, environment);
  const role = store.getRole(taskId, roleName);
  if (role === null) throw new Error(`Fixture Role not found: ${taskId}/${roleName}.`);
  const binding = role.agentBindings[role.activeAgentId];
  if (binding === undefined) {
    throw new Error(`Fixture Role Agent binding not found: ${taskId}/${roleName}.`);
  }
  const run = store.getActiveAgentRun(taskId, roleName);
  let sessions = store.getTaskRoleSessionSet(taskId, roleName);
  if (run !== null) {
    sessions ??= createRoleSessionSet({
      scope: "task",
      taskId,
      roleName
    }, role.activeAgentId, new Date(run.createdAt));
    const fence = {
      agentId: role.activeAgentId,
      runId: run.id,
      receiptId: formatAgentRunReceiptId(taskId, run.id)
    };
    sessions = bindTaskRoleRun(sessions, fence, new Date(run.createdAt));
    // Provider event time may precede a Controller-created Session projection.
    // The projection records when the fact became applicable to this fence.
    const projectAfterPrepared = (timestamp) => new Date(Math.max(
      Date.parse(timestamp),
      Date.parse(sessions.inFlight.preparedAt)
    ));
    if (run.pushedAt !== undefined) {
      sessions = markTaskRoleRunPushed(
        sessions,
        fence,
        projectAfterPrepared(run.pushedAt)
      );
    }
    if (run.deliveredAt !== undefined) {
      sessions = markTaskRoleRunDelivered(
        sessions,
        fence,
        projectAfterPrepared(run.deliveredAt)
      );
    }
    store.saveTaskRoleSessionSet(sessions);
  }

  const liveSession = sessions?.sessions[role.activeAgentId];
  let launchId;
  let nativeSessionId;
  if (liveSession !== undefined
    && liveSession.status !== "stopped"
    && liveSession.status !== "broken") {
    if (liveSession.launchId === undefined) {
      throw new Error(`Fixture live Session has no launch fence: ${taskId}/${roleName}.`);
    }
    launchId = liveSession.launchId;
    nativeSessionId = liveSession.nativeSessionId;
  } else {
    if (liveSession !== undefined) {
      throw new Error(`Fixture Session is terminal but not retired: ${taskId}/${roleName}.`);
    }
    const owner = { scope: "task", taskId, roleName };
    const scheduler = new FileSchedulerStoreAdapter(store);
    const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
    if (isRuntimeLaunchReservation(mailbox?.processing)) {
      const reservedRun = mailbox.processing.executionRef?.type === "run"
        ? mailbox.processing.executionRef.id
        : undefined;
      if (reservedRun !== run?.id) {
        if (reservedRun !== undefined
          && store.getAgentRun(taskId, reservedRun)?.status === "active") {
          throw new Error(`Fixture runtime reservation still owns an active Run: ${reservedRun}.`);
        }
        const completed = scheduler.completeRuntimeLaunchReservation(
          owner,
          mailbox.processing.batchId,
          reservedRun
        );
        if (!completed) throw new Error("Fixture runtime reservation could not be replaced.");
      }
    }
    const current = store.getWorkMailbox(runtimeLifecycleTarget(owner));
    if (isRuntimeLaunchReservation(current?.processing)) {
      launchId = current.processing.batchId;
    } else {
      const proposed = `fixture-exact-${++nextLaunch}`;
      launchId = scheduler.reserveRuntimeLaunch({
        owner,
        launchId: proposed,
        ...(run === null ? {} : { runId: run.id })
      }, () => {}, new Date()).launchId;
    }
  }

  const control = createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry,
    yuiHome: home
  });
  const digest = exactControlPlaneDigest(control);
  const runtime = createExactTaskRuntimeDescriptor({
    controlPlaneDigest: digest,
    taskId,
    roleName,
    agentId: role.activeAgentId,
    adapterId: binding.adapterId,
    workspace: run?.effective.workspace.root ?? role.workspace,
    ...(run === null ? {} : { runId: run.id }),
    launchId,
    ...(nativeSessionId === undefined ? {} : { nativeSessionId })
  });
  assertExactTaskRuntimeState(runtime, store);
  const runtimeSource = exactTaskRuntimeDescriptorPath(home, runtime);
  writeTextFileAtomically(runtimeSource, `${serializeExactDescriptor(runtime)}\n`);

  const managedEnvironment = {
    ...environment,
    YUI_HOME: resolve(home),
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: taskId,
    YUI_ROLE: roleName,
    YUI_AGENT_ID: role.activeAgentId,
    YUI_ADAPTER_ID: binding.adapterId,
    YUI_WORKSPACE: runtime.workspace,
    YUI_LAUNCH_ID: launchId,
    [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(control),
    [YUI_TASK_RUNTIME_DESCRIPTOR]: runtimeSource
  };
  if (run === null) delete managedEnvironment.YUI_RUN_ID;
  else managedEnvironment.YUI_RUN_ID = run.id;
  if (nativeSessionId === undefined) delete managedEnvironment.YUI_NATIVE_SESSION_ID;
  else managedEnvironment.YUI_NATIVE_SESSION_ID = nativeSessionId;
  return {
    cliEntry,
    controlDigest: digest,
    prefix: [
      EXACT_CONTROL_ARGUMENT,
      digest,
      ...(taskFinalReviewerRole === undefined
        ? []
        : [TASK_FINAL_REVIEW_ARGUMENT, taskId, taskFinalReviewerRole])
    ],
    environment: managedEnvironment,
    completeFixtureRuntimeReservation() {
      const owner = { scope: "task", taskId, roleName };
      const mailbox = store.getWorkMailbox(runtimeLifecycleTarget(owner));
      if (!isRuntimeLaunchReservation(mailbox?.processing, launchId)) return false;
      const reservedRunId = mailbox.processing.executionRef?.type === "run"
        ? mailbox.processing.executionRef.id
        : undefined;
      if (reservedRunId !== run?.id) {
        throw new Error(`Fixture runtime reservation changed: ${launchId}.`);
      }
      return new FileSchedulerStoreAdapter(store).completeRuntimeLaunchReservation(
        owner,
        launchId,
        reservedRunId
      );
    }
  };
}

function stopFixtureController(home, cliEntry, source) {
  const environment = { ...source, YUI_HOME: resolve(home) };
  for (const name of [
    "YUI_SESSION_SCOPE",
    "YUI_TASK_ID",
    "YUI_ROLE",
    "YUI_AGENT_ID",
    "YUI_ADAPTER_ID",
    "YUI_WORKSPACE",
    "YUI_RUN_ID",
    "YUI_LAUNCH_ID",
    "YUI_NATIVE_SESSION_ID",
    YUI_CONTROL_PLANE_DESCRIPTOR,
    YUI_TASK_RUNTIME_DESCRIPTOR
  ]) delete environment[name];
  const stopped = spawnSync(
    process.execPath,
    [cliEntry, "controller", "stop"],
    { encoding: "utf8", env: environment }
  );
  if (stopped.status !== 0) {
    throw new Error(
      `Fixture Controller could not be stopped: ${stopped.stderr || stopped.stdout}`
    );
  }
}
