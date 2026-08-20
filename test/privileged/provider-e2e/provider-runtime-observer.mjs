import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createConfiguredAgent } from "../../../dist/agent/agent.js";
import { enqueueWork } from "../../../dist/coordination/workMailboxQueue.js";
import { startFileTaskControllerRuntime } from "../../../dist/controller/runtime.js";
import { resolveEffectiveLaunch } from "../../../dist/executor/effectiveLaunch.js";
import { createRole, createRoleAgentBinding } from "../../../dist/role/role.js";
import { createAgentRun } from "../../../dist/run/agentRun.js";
import {
  runtimeObservationFromTaskEvent
} from "../../../dist/runtime/runtimeObservation.js";
import { projectRuntimeTaskEvents } from "../../../dist/runtime/runtimeProjection.js";
import { FileTaskStore } from "../../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../../dist/task/task.js";
import { createIsolatedRuntime } from "../../helpers/isolatedRuntime.js";
import { createEvidenceRecorder } from "../../helpers/testEvidence.js";
import { taskOwnedWorkspace } from "../../helpers/taskWorkspace.js";

const states = new Map();
const WAIT_TIMEOUT_MS = 180_000;

export async function runProviderRuntimeObserver(provider, _testContext, context) {
  assert.ok(provider === "claude" || provider === "codex");
  const binary = resolveProviderBinary(provider);
  const providerHome = join(context.runRoot, "provider-home", provider);
  mkdirSync(providerHome, { recursive: true, mode: 0o700 });
  const providerEnvironment = prepareProviderEnvironment(provider, providerHome);
  const runtime = createIsolatedRuntime(undefined, {
    root: context.runtimeRoot,
    retainRoot: true,
    environment: {
      YUI_STORE_WORKER: "0",
      ...providerEnvironment
    }
  });
  mkdirSync(context.workspace, { recursive: true, mode: 0o700 });

  const evidence = createEvidenceRecorder({
    tier: "provider-e2e",
    name: `${provider} managed runtime observer`,
    binarySource: binary,
    yuiHome: runtime.home,
    workspace: context.workspace,
    namespaceOwnership: {
      kind: runtime.identity.domainKind,
      home: runtime.home,
      tmuxServer: runtime.identity.tmuxServer,
      token: runtime.identity.token
    }
  });
  evidence.recordPreflight(context.preflight);
  const state = { runtime, evidence, running: undefined };
  states.set(context.runRoot, state);

  const launcher = spawnSync(context.launcherPath, ["version"], {
    encoding: "utf8",
    env: runtime.environment,
    timeout: 10_000
  });
  assert.equal(launcher.error, undefined);
  assert.equal(launcher.status, 0, launcher.stderr);
  evidence.recordCheck(
    "checkout-local-launcher",
    "passed",
    `${context.launcherPath} ${launcher.stdout.trim()}`
  );

  const now = new Date();
  const taskId = `task-provider-${provider}`;
  const agentId = `real-${provider}`;
  const roleName = "worker";
  const secretBindings = provider === "claude"
    ? claudeCredentialBindings()
    : [];
  const agent = createConfiguredAgent(
    agentId,
    provider,
    binary,
    [],
    secretBindings,
    now
  );
  const permission = provider === "codex"
    ? {
        adapterId: "codex",
        permission: {
          strategy: "configured",
          sandbox: "read-only",
          approval: "never"
        }
      }
    : {
        adapterId: "claude",
        permission: { strategy: "configured", mode: "dontAsk" }
      };
  const task = activateTask(createTask(taskId, `${provider} Provider E2E`, now, {
    cwd: context.workspace
  }), now);
  const managedWorkspace = taskOwnedWorkspace(task, now);
  const role = createRole(
    task.id,
    roleName,
    [createRoleAgentBinding(agent, permission)],
    agent.id,
    context.workspace,
    now,
    {
      description: "A bounded Provider E2E role.",
      constraints: ["Do not call tools or mutate files."]
    },
    "read"
  );
  const run = createAgentRun(
    `run-provider-${provider}`,
    task.id,
    role.name,
    "new",
    "This is a bounded provider integration test. Do not call tools or Yui. Reply only with YUI_PROVIDER_OK.",
    now,
    {
      workspace: managedWorkspace,
      effective: resolveEffectiveLaunch({
        role,
        purpose: "execution",
        workspace: managedWorkspace
      })
    }
  );
  const store = new FileTaskStore(runtime.home);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveManagedWorkspace(managedWorkspace);
    tx.saveRole(task.id, role);
    tx.saveActiveAgentRun(run);
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: role.name },
      "provider-e2e-run-dispatched",
      now,
      [{ type: "run", taskId: task.id, id: run.id }]
    );
  });

  const controllerErrors = [];
  state.running = await startFileTaskControllerRuntime(runtime.home, {
    store,
    environment: runtime.environment,
    intervalMs: 60_000,
    signalWindowMs: 10,
    deliveryRetryMs: 100,
    runtimeObserverIntervalMs: 100,
    onError: (error) => controllerErrors.push(error)
  });
  state.running.runtime.signal(`role:${task.id}/${role.name}`);

  const observations = () => store.listEvents(task.id)
    .map(runtimeObservationFromTaskEvent)
    .filter((observation) => observation !== null);
  const waitFor = async (read, description) => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const result = read();
      if (result !== undefined && result !== null && result !== false) return result;
      if (Date.now() >= deadline) {
        const details = controllerErrors.map((error) => (
          error instanceof Error ? error.message : String(error)
        )).join("; ");
        throw new Error(
          `Timed out waiting for ${provider} ${description}`
          + (details.length === 0 ? "." : `; Controller errors: ${details}`)
        );
      }
      state.running.runtime.signal(`role:${task.id}/${role.name}`);
      await delay(100);
    }
  };

  const session = await waitFor(
    () => store.getTaskRoleSessionSet(task.id, role.name)?.sessions[agent.id],
    "native Session"
  );
  evidence.markSessionCreated(
    `launchId=${session.launchId}; nativeSessionId=${session.nativeSessionId}`
  );

  const accepted = await waitFor(
    () => observations().find((observation) => (
      observation.kind === "turn.accepted"
      && observation.fence.runId === run.id
      && observation.payload.observerSource !== undefined
    )),
    "provider-native prompt acceptance"
  );
  assert.equal(store.getAgentRun(task.id, run.id)?.deliveredAt !== undefined, true);
  assert.equal(
    resolve(accepted.payload.observerSource.locator).startsWith(`${resolve(providerHome)}/`),
    true,
    "Provider transcript escaped the disposable provider home."
  );
  evidence.markProviderAccepted(
    `driver=${accepted.fence.driverId}; launchId=${accepted.fence.launchId}`
  );

  const usageObservation = await waitFor(
    () => observations().find((observation) => (
      observation.kind === "activity.observed"
      && observation.fence.runId === run.id
      && observation.payload.usage !== undefined
      && usageTotal(observation.payload.usage) > 0
    )),
    "positive transcript token sample"
  );
  const confirmedActivity = await waitFor(
    () => observations().find((observation) => (
      observation.kind === "activity.observed"
      && observation.fence.runId === run.id
      && observation.authority === "controller"
      && observation.payload.usage === undefined
      && observation.receivedAt === usageObservation.receivedAt
    )),
    "token-growth activity confirmation"
  );
  assert.ok(confirmedActivity);
  const health = await waitFor(
    () => observations().find((observation) => (
      observation.kind === "observer.health"
      && observation.fence.runId === run.id
      && ["healthy", "degraded"].includes(observation.payload.observerStatus)
    )),
    "healthy transcript observer"
  );
  const projected = projectRuntimeTaskEvents(
    accepted.fence,
    run.createdAt,
    store.listEvents(task.id)
  );
  assert.ok(projected.usage);
  assert.ok(usageTotal(projected.usage) > 0);
  assert.ok(projected.lastRuntimeActivityAt);
  assert.ok(["healthy", "degraded"].includes(projected.observer.status));

  evidence
    .markModelCalled(
      `inputTokens=${usageObservation.payload.usage.inputTokens}; `
      + `outputTokens=${usageObservation.payload.usage.outputTokens}`
    )
    .recordCheck(
      "exact-run-fence",
      "passed",
      `runId=${run.id}; nativeTurnId=${accepted.fence.nativeTurnId ?? "provider-omitted"}`
    )
    .recordCheck(
      "independent-observer",
      "passed",
      `status=${health.payload.observerStatus}; source=${health.payload.sourceId}`
    )
    .recordCheck(
      "token-growth-runtime-activity",
      "passed",
      `total=${usageTotal(usageObservation.payload.usage)}; confirmedAt=${confirmedActivity.receivedAt}`
    )
    .noteVerificationGap("This bounded scenario does not exercise permission prompts, resume, or multi-turn use.");
}

export async function cleanupProviderRuntimeObserver(context) {
  const state = states.get(context.runRoot);
  if (state === undefined) return;
  let failure;
  try {
    await state.running?.close();
  } catch (error) {
    failure = error;
  }
  try {
    await state.runtime.teardown();
  } catch (error) {
    failure = failure === undefined
      ? error
      : new AggregateError([failure, error], "Provider E2E cleanup failed.");
  }
  if (failure === undefined) {
    state.evidence.recordCleanup(
      "success",
      "exact Controller, provider process, tmux namespace, and runtime resources were removed"
    );
  } else {
    state.evidence.recordCleanup(
      "error",
      failure instanceof Error ? failure.message : String(failure)
    );
  }
  process.stdout.write(`${state.evidence.render()}\n`);
  states.delete(context.runRoot);
  if (failure !== undefined) throw failure;
}

function resolveProviderBinary(provider) {
  const found = spawnSync("which", [provider], {
    encoding: "utf8",
    env: process.env,
    timeout: 10_000
  });
  if (found.error !== undefined) throw found.error;
  assert.equal(found.status, 0, `Provider binary is unavailable: ${provider}.`);
  const binary = realpathSync(found.stdout.trim());
  const version = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    env: process.env,
    timeout: 10_000
  });
  if (version.error !== undefined) throw version.error;
  assert.equal(version.status, 0, version.stderr);
  return binary;
}

function prepareProviderEnvironment(provider, providerHome) {
  if (provider === "claude") {
    assert.ok(
      claudeCredentialBindings().length > 0,
      "Claude Provider E2E requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN."
    );
    return { CLAUDE_CONFIG_DIR: providerHome };
  }
  const sourceHome = process.env.CODEX_HOME
    ?? join(process.env.HOME ?? "", ".codex");
  const sourceAuth = join(sourceHome, "auth.json");
  assert.equal(existsSync(sourceAuth), true, "Codex Provider E2E requires CODEX_HOME/auth.json.");
  copyFileSync(sourceAuth, join(providerHome, "auth.json"));
  return { CODEX_HOME: providerHome };
}

function claudeCredentialBindings() {
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (typeof process.env[name] === "string" && process.env[name].length > 0) {
      return [{ target: name, source: "process", sourceName: name, required: true }];
    }
  }
  return [];
}

function usageTotal(usage) {
  return usage.inputTokens + usage.outputTokens;
}
