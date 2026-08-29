#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { renderCommandHelp } from "./cli/helpRenderer.js";
import { describeCommandTree, findCommandNode } from "./cli/commandCatalog.js";
import { routeInvocation } from "./cli/invocationRouter.js";
import { renderCompletion, type CliIdentity } from "./cli/completion.js";
import { resolveCompletionCandidates } from "./cli/dynamicCompletion.js";
import {
  allowsInteractiveSelection,
  resolveInteractiveArguments,
  type SelectionIo
} from "./cli/interactiveSelection.js";
import { runCompletionWizard } from "./cli/completionWizard.js";
import {
  renderAgentConfigurationResolutionNotice
} from "./cli/agentConfigurationPicker.js";
import {
  resolveGlobalRoleAgentConfigurationArguments,
  resolveRoleWizardArguments
} from "./cli/roleWizard.js";
import { resolveOperatorWizardArguments } from "./cli/operatorWizard.js";
import type { SelectionPorts } from "./cli/selectionPorts.js";
import { runUpdateCommand } from "./cli/updateCommand.js";
import { runUpgradeCommand } from "./cli/upgradeCommand.js";
import { formatTimestamp } from "./output/timePresentation.js";
import { resolveTmuxBin, resolveTmuxHistoryLimit } from "./config/yuiConfig.js";
import { renderAgentConfigurationCatalog } from "./output/agentConfigurationPresentation.js";
import type { ConfiguredAgent } from "./agent/agent.js";
import { nativeAgentEnvironmentNames } from "./agent/launchEnvironment.js";
import {
  runAgentCommand,
  type AgentCommandStore
} from "./commands/agentCommands.js";
import {
  runGlobalRoleCommand,
  type GlobalRoleCommandOptions
} from "./commands/globalRoleCommands.js";
import { runConfigCommand } from "./commands/configCommands.js";
import { CONFIG_DOMAINS, type ConfigDomain } from "./config/configCatalog.js";
import { runConfigOverview } from "./commands/configOverview.js";
import {
  parseControllerCleanupOptions,
  parseControllerStatusOptions,
  parseControllerRuntimeSnapshot,
  renderControllerResourceStatus,
  renderRuntimeIdentitySection,
  summarizeDurablePhysicalMismatch,
  type ControllerRuntimeSnapshot,
  runInteractiveControllerCleanup
} from "./commands/controllerCommands.js";
import {
  parseExecutionAuditOptions,
  runExecutionAuditCommand
} from "./commands/executionAuditCommands.js";
import {
  parseSessionReconcileOptions,
  parseSessionStopOptions,
  runSessionReconcileCommand,
  runSessionStopCommand
} from "./commands/sessionCommands.js";
import { SessionOwnerReconciliation } from "./controller/sessionOwnerReconciliation.js";
import { runJobCommand } from "./commands/jobCommands.js";
import { runDurableJobCommand } from "./commands/durableJobCommands.js";
import { runTelemetryCommand } from "./commands/telemetryCommands.js";
import { runResourcesCommand } from "./commands/resourcesCommands.js";
import {
  applyOperatorSessionControl,
  runOperatorCommand,
  type OperatorSessionControl
} from "./commands/operatorCommands.js";
import { runProjectCommand } from "./commands/projectCommands.js";
import { runProfileCommand } from "./commands/profileCommands.js";
import {
  dispatchPreparedReviewRound,
  failPendingReviewRound,
  preserveReviewRoundWorkspace,
  parseTaskCompletionRequest,
  parseTaskFinalReviewContractRebindRequest,
  preflightTaskCompletion,
  runTaskCommand,
  normalizedExecutionLanePlan,
  resolvedExecutionStageRetryGroup,
  validateTaskArchiveRequest
} from "./commands/taskCommands.js";
import { taskActor } from "./commands/taskActor.js";
import { isCurrentGlobalOperator } from "./commands/taskInputCommands.js";
import { runTaskIntegrationCommand } from "./commands/taskIntegrationCommands.js";
import { runTaskChangeSetCommand } from "./commands/taskChangeSetCommands.js";
import { runTaskOverlapCommand } from "./commands/taskOverlapCommands.js";
import { createControllerIntegrationJobPort } from "./controller/jobClient.js";
import { runTaskWorkspaceCommand } from "./commands/taskWorkspaceCommands.js";
import { runWorkflowCommandAsync } from "./commands/workflowCommands.js";
import { createUpdatePorts } from "./cli/updatePorts.js";
import { createReleaseWorkflowPorts } from "./release/releaseWorkflowPorts.js";
import {
  acquireHandoverLock,
  readRuntimeIdentity,
  type RuntimeIdentityReceipt
} from "./release/runtimeRelease.js";
import {
  assertCliHomeReleaseFence,
  describeCliHomeInvocation
} from "./release/cliHomeReleaseFence.js";
import {
  renderReleaseActivateResult,
  renderReleaseInstallResult,
  renderReleaseList,
  resolveReleaseActivationDriver,
  runReleaseActivate,
  runReleaseInstall,
  runReleaseList
} from "./commands/releaseCommands.js";
import {
  reconcileTaskRemoteBaselines,
  verifyTaskCompletionPublishedTree,
  type TaskCompletionPublishedTreeProof
} from "./commands/taskCompletionGate.js";
import { runTaskBaseStatusCommand } from "./commands/taskBaseCommands.js";
import { runTaskUpstreamCommand } from "./commands/taskUpstreamCommands.js";
import {
  assertTaskBaseFreshnessForCompletion,
  inspectTaskBaseFreshness
} from "./repository/taskBaseFreshness.js";
import { FileCompletionManager, resolveCliIdentity } from "./completion/fileCompletionManager.js";
import {
  assertFileTaskControllerStorageCompatible,
  ensureFileTaskController,
  FileTaskWorkflowRuntime,
  refreshRunningFileTaskControllerConfiguration,
  refreshRunningFileTaskControllerEnvironment,
  type RunningControllerRefreshResult,
  restartFileTaskController,
  stopFileTaskController
} from "./controller/clientRuntime.js";
import { callController, ControllerClientError } from "./core/controllerClient.js";
import { FileSchedulerStoreAdapter } from "./controller/fileSchedulerStoreAdapter.js";
import { cleanControllerResource } from "./controller/resourceCleanupLinux.js";
import { scanControllerResourceInventory } from "./controller/resourceInventoryLinux.js";
import { runSessionNotifyCommand } from "./controller/sessionNotify.js";
import { openSchedulerTelemetry } from "./telemetry/telemetryWiring.js";
import { runRuntimeObservationHookCommand } from "./controller/runtimeObservationHook.js";
import { buildDoctorReport, renderDoctor, runDoctorCommand } from "./doctor/doctor.js";
import { agentNotFound, CliError, runtimeError, usageError } from "./errors/cliError.js";
import { FileRoleLaunchPlanner } from "./executor/fileRoleLaunchPlanner.js";
import {
  AGENT_HOST_CONTROL_PROTOCOL,
  runAgentHost,
  sendAgentHostAuthorityControl,
  type AgentHostControlResult
} from "./runtime/agentHost.js";
import {
  TaskWorkspaceCoordinator,
  WorkspaceCleanupBlockedError
} from "./repository/taskWorkspaceCoordinator.js";
import {
  FileTaskWorkspacePreparer,
  type TaskWorkspaceActivation
} from "./repository/taskWorkspacePreparer.js";
import { inspectStorageSchema } from "./storage/storageSchema.js";
import {
  collectRuntimeBuildIdentity,
  collectStorageIdentity,
  countDroppedInboxEvents,
  createProductionRuntimeIdentityPorts,
  evaluateStorageHealth,
  resolveStatusIdentityEnabled
} from "./observability/runtimeIdentity.js";
import { type TaskStore, resolveYuiHome } from "./storage/taskStore.js";
import {
  openCompatibleFileTaskStore,
  validateCompatibleFileTaskStore
} from "./storage/compatibleTaskStore.js";
import { resolveTaskRecordReference } from "./task/taskRecordReference.js";
import { runSetupCommand, validateSetupInvocation } from "./setup/setupCommand.js";
import { NodeCommandExecutor } from "./tmux/commandExecutor.js";
import { TmuxManager } from "./tmux/tmuxManager.js";
import { WorkItemChangeSetManager } from "./workspace/workItemChangeSetManager.js";
import { parseWebCommandOptions, startYuiWebServer } from "./web/webServer.js";
import {
  AgentConfigurationCatalogService
} from "./executor/agentConfigurationCatalog.js";
import type { RoleAgentConfig } from "./executor/agentAdapter.js";
import { TmuxWebTerminalService } from "./web/tmuxWebTerminal.js";
import {
  listOperatorSessions,
  operatorSessionRef
} from "./operator/operatorSessionHistory.js";
import { YUI_VERSION, yuiVersionIdentity } from "./version.js";
import { SqliteSchemaMigrationError } from "./storage/sqliteSchema.js";
import {
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR,
  assertCompatibleControlPlanePreflight,
  assertExactControlPlanePreflight,
  assertExactTaskRuntimeEnvironment,
  assertExactTaskRuntimeState,
  exactControlPlaneDigest,
  extractExactControlArgument,
  createExactControlPlaneDescriptor,
  parseExactControlPlaneDescriptor,
  type ExactControlPlaneDescriptor
} from "./runtime/exactControlPlane.js";
import {
  readSessionBootstrapManifest,
  refreshManagedSessionCliWrappers
} from "./context/sessionBootstrapManifest.js";
import { builtinAgentDriverRegistry } from "./runtime/builtinAgentDrivers.js";
import {
  createTaskFinalReviewContract,
  extractTaskFinalReviewRequest,
  type TaskFinalReviewContract
} from "./review/taskFinalReviewContract.js";
import {
  prepareTaskFinalReviewContractRebindProof,
  resolveRecordedTaskFinalReviewContract,
  type TaskFinalReviewContractRebindProof
} from "./review/taskFinalReviewContractRebind.js";
import type { TaskReviewCandidate } from "./review/reviewRound.js";
import { assessDeltaRecheck, type DeltaRecheckPreflight } from "./review/deltaRecheck.js";
import { isAcceptedTaskReviewBaseline } from "./review/reviewAcceptance.js";
import { NodeGitWorkspace } from "./repository/gitWorkspace.js";
import {
  currentWorkItemExecutionGroup,
  workItemExecutionGroupById
} from "./workItem/workItem.js";

const VERSION = YUI_VERSION;
const exactControlInvocation = extractExactControlArgument(process.argv.slice(2));
const taskFinalReviewInvocation = extractTaskFinalReviewRequest(exactControlInvocation.args);
const rawArgs = [...taskFinalReviewInvocation.args];
const jsonOutput = rawArgs.includes("--json");
const args = normalizeAliases(
  jsonOutput ? rawArgs.filter((argument) => argument !== "--json") : rawArgs
);

void main().catch((error: unknown) => {
  if (error instanceof CliError) {
    const rendered = jsonOutput
      ? JSON.stringify({ ok: false, code: error.code, message: error.message, details: error.details })
      : `${error.code}: ${error.message}${error.helpText === undefined ? "" : `\n\n${error.helpText.trimEnd()}`}`;
    process.stderr.write(`${rendered}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  const message = runtimeFailureMessage(error);
  process.stderr.write(`${jsonOutput
    ? JSON.stringify({ ok: false, code: "RUNTIME_ERROR", message, details: {} })
    : `RUNTIME_ERROR: ${message}`}\n`);
  process.exitCode = 5;
});

function runtimeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof SqliteSchemaMigrationError)) return message;
  try {
    return `${message}\n${describeCliHomeInvocation({
      home: resolveYuiHome(process.env),
      packageRoot: fileURLToPath(new URL("../", import.meta.url)),
      entryPath: fileURLToPath(import.meta.url)
    })}`;
  } catch {
    return message;
  }
}

export async function main(): Promise<void> {
  const home = resolveYuiHome(process.env);
  const routedForFence = args.length === 0 ? undefined : routeInvocation(args);
  const managedInvocation = process.env.YUI_SESSION_SCOPE === "task"
    || process.env.YUI_SESSION_SCOPE === "global"
    || process.env[YUI_CONTROL_PLANE_DESCRIPTOR] !== undefined
    || process.env[YUI_TASK_RUNTIME_DESCRIPTOR] !== undefined;
  const homeFreeInvocation = args.length === 0
    || (args[0] === "version" && args.length === 1)
    || routedForFence?.kind === "help"
    || routedForFence?.kind === "path-error"
    || routedForFence?.kind === "incomplete";
  if (managedInvocation || !homeFreeInvocation) {
    assertCliHomeReleaseFence({
      home,
      packageRoot: fileURLToPath(new URL("../", import.meta.url)),
      entryPath: fileURLToPath(import.meta.url),
      args
    });
  }
  const delegatedDriver = explicitReleaseActivationDriver();
  if (delegatedDriver !== null) {
    const delegated = spawnSync(
      process.execPath,
      [delegatedDriver, ...process.argv.slice(2)],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit"
      }
    );
    if (delegated.error !== undefined) {
      throw runtimeError(
        `Target release activation driver could not start: ${delegated.error.message}`
      );
    }
    if (delegated.signal !== null) {
      throw runtimeError(
        `Target release activation driver stopped by signal ${delegated.signal}.`
      );
    }
    process.exitCode = delegated.status ?? 5;
    return;
  }
  const {
    contract: taskFinalReviewContract,
    verifiedStore,
    controlPlane: exactCurrentControlPlane
  } = await preflightManagedTaskControlPlane();
  if (args.length === 0) {
    emit(renderCommandHelp((await import("./cli/commandCatalog.js")).ROOT_COMMAND, VERSION));
    return;
  }
  if (args[0] === "version" && args.length === 1) {
    emit(VERSION, true, yuiVersionIdentity());
    return;
  }

  const invocation = routeInvocation(args);
  if (invocation.kind === "help") {
    emit(renderCommandHelp(invocation.node, VERSION), true);
    return;
  }
  if (invocation.kind === "path-error") {
    throw usageError(
      `Unknown command: ${invocation.typedPath}`,
      renderCommandHelp(invocation.helpNode, VERSION)
    );
  }
  if (invocation.kind === "incomplete") {
    throw usageError(
      `Command required after: ${invocation.typedPath}`,
      renderCommandHelp(invocation.helpNode, VERSION)
    );
  }

  if (args[0] === "version") throw usageError("Version usage: yui version");
  if (args[0] === "update") {
    if (jsonOutput) throw usageError("Update does not support --json.");
    if (args.length !== 1) throw usageError("Update usage: yui update");
    process.exitCode = runUpdateCommand();
    return;
  }

  if (args[0] === "release") {
    const subcommand = args[1];
    if (subcommand === "install" && args.length === 3) {
      const result = runReleaseInstall(home, args[2]);
      emit(renderReleaseInstallResult(result), false, result);
      if (result.outcome === "aborted") process.exitCode = 5;
      return;
    }
    if (subcommand === "list" && args.length === 2) {
      const result = runReleaseList(home);
      emit(renderReleaseList(result), false, result);
      return;
    }
    if (subcommand === "activate" && (args.length === 2 || args.length === 3)) {
      const releaseId = args.length === 3
        ? args[2]
        : runReleaseList(home).active ?? undefined;
      if (releaseId === undefined) {
        throw usageError(
          "Release activate usage: yui release activate <release-id> "
            + "(or activate the active release when exactly one is installed)."
        );
      }
      const result = await runReleaseActivate(home, releaseId);
      emit(renderReleaseActivateResult(result), false, result);
      if (result.outcome === "aborted" || result.outcome === "dual-owner") {
        process.exitCode = 5;
      }
      return;
    }
    throw usageError(
      "Release usage: yui release install <source-dir> | list | activate [release-id]."
    );
  }
  if (args[0] === "config" && args[1] === "completion") {
    await completionCommand(home, invocation.node);
    return;
  }
  if (args[0] === "config" && args[1] === "describe") {
    const describeNode = findCommandNode(["config", "describe"]);
    if (describeNode === undefined) throw new Error("Config describe command is missing from the catalog.");
    const domain = args[2];
    const domains = describeNode.argumentValues[0] ?? [];
    if (args.length > 3 || (domain !== undefined && !domains.includes(domain))) {
      throw usageError(`Config describe usage: ${describeNode.usage.join(" | ")}.`);
    }
    const target = findCommandNode(domain === undefined ? ["config"] : ["config", domain]);
    if (target === undefined) throw new Error(`Config domain is missing from the catalog: ${domain}.`);
    emit(renderCommandHelp(target, VERSION), false, describeCommandTree(target));
    return;
  }

  if (args[0] === "setup") {
    if (jsonOutput) throw usageError("Setup does not support --json.");
    await assertFileTaskControllerStorageCompatible(home);
    const setupIo = {
      input: process.stdin,
      output: process.stdout,
      forceInteractive: process.env.YUI_SETUP_INTERACTIVE === "1"
    };
    validateSetupInvocation(args.slice(1), setupIo);
    const output = await runSetupCommand(
      args.slice(1),
      process.env,
      new NodeCommandExecutor(),
      setupIo
    );
    // A successful setup leaves the Home ready for normal Yui work. Start the
    // detached per-Home Controller even when setup began with no Controller;
    // read-only commands and failed setup still remain non-starting paths.
    await ensureFileTaskController(home, { environment: process.env });
    const refresh = await refreshRunningFileTaskControllerEnvironment(
      home,
      openCompatibleFileTaskStore(home),
      process.env
    );
    emit(withControllerRefreshWarning(output, refresh, "Agent environment"));
    return;
  }
  if (args[0] === "doctor") {
    const doctorArgs = args.slice(1);
    if (doctorArgs.length !== 0) {
      // Preserve the usage error for stray operands (parity with text mode).
      runDoctorCommand(doctorArgs, process.env, new NodeCommandExecutor());
      return;
    }
    const report = buildDoctorReport(process.env, new NodeCommandExecutor());
    if (jsonOutput) {
      // Machine-readable result: the full checks array + a storage-health verdict
      // the update post-verify parses (P1-3). Exit non-zero when storage is not
      // healthy so even a naive exit-code check fails closed. This exit-code
      // signal is scoped to the --json path; text-mode doctor keeps its existing
      // presentation and exit 0 (the WorkItem allows doctor's presentation to stay).
      if (!report.storage.healthy) process.exitCode = 5;
      emit("", false, report);
      return;
    }
    emit(renderDoctor(report.checks, report.review));
    return;
  }
  if (args[0] === "execution") {
    // Issue 11 read-only audit: opens the Home read-only, never writes state,
    // never wakes a Leader.
    if (args[1] !== "audit") {
      throw usageError(
        "Execution usage: yui execution audit [--task <id>] [--since <iso>] [--until <iso>]."
      );
    }
    const options = parseExecutionAuditOptions(args.slice(2));
    const result = runExecutionAuditCommand(home, options);
    emit(result.output, false, result.report);
    return;
  }
  if (args[0] === "upgrade") {
    // Mirror doctor/controller: needs a Home but self-manages the schema check,
    // because upgrade must run against a non-current Home.
    const externallyQuiesced = process.env.YUI_UPDATE_EXTERNALLY_QUIESCED === "1";
    const ownsHandover = args.length === 1 && !externallyQuiesced;
    const externalFenceOwner = externallyQuiesced
      ? process.env.YUI_UPDATE_HANDOVER_OWNER_PID
      : undefined;
    const externalUpgradeFenceOwnerPid = externalFenceOwner === undefined
      ? undefined
      : Number(externalFenceOwner);
    if (
      externalUpgradeFenceOwnerPid !== undefined
      && (!Number.isSafeInteger(externalUpgradeFenceOwnerPid)
        || externalUpgradeFenceOwnerPid < 1)
    ) {
      throw runtimeError("Update storage-fence owner PID is invalid.");
    }
    const handover = ownsHandover ? acquireHandoverLock(home) : undefined;
    try {
      const result = await runUpgradeCommand(
        args.slice(1),
        home,
        externallyQuiesced
          ? {
              controllerLifecycle: "externally-quiesced",
              ...(externalUpgradeFenceOwnerPid === undefined
                ? {}
                : { externalUpgradeFenceOwnerPid })
            }
          : {}
      );
      // Public execute upgrades leave the Home operational even when no
      // Controller existed before the command. Dry-run and the staged updater's
      // externally-quiesced preflight must remain read-only/lifecycle-neutral.
      if (ownsHandover && result.exitCode === 0) {
        await ensureFileTaskController(home, {
          environment: process.env,
          handoverOwnerPid: process.pid
        });
      }
      process.exitCode = result.exitCode;
      emit(result.output, false, result.data);
    } finally {
      handover?.release();
    }
    return;
  }
  if (args[0] === "internal") {
    if (args[1] === "session-cli-refresh" && args.length === 2) {
      if (process.env.YUI_SESSION_SCOPE === "task"
        || (process.env.YUI_SESSION_SCOPE === "global" && process.env.YUI_ROLE !== "operator")) {
        throw usageError(
          "Managed Session CLI refresh may be run only by the user or global Operator."
        );
      }
      const result = refreshManagedSessionCliWrappers(home);
      emit(
        `Refreshed ${result.refreshed} legacy Session CLI wrapper(s); `
          + `${result.current} already current, ${result.skipped} skipped.`,
        false,
        result
      );
      return;
    }
    if (args[1] === "agent-host" && args.length === 4) {
      process.exitCode = await runAgentHost({
        home,
        launchId: args[2]!,
        ticket: args[3]!
      });
      return;
    }
    if (args[1] === "session-notify" && args.length === 3) {
      await runSessionNotifyCommand(args[2], process.env);
      return;
    }
    if (args[1] === "runtime-hook" && args.length === 2) {
      await runRuntimeObservationHookCommand(readFileSync(0, "utf8"), process.env);
      return;
    }
    throw usageError("Internal lifecycle callback usage is invalid.");
  }

  if (args[0] === "session" && args[1] === "reconcile") {
    const options = parseSessionReconcileOptions(args.slice(2));
    const store = openCompatibleFileTaskStore(home);
    const tmux = new TmuxManager(
      resolveTmuxBin(store.getConfig().tmuxBin),
      new NodeCommandExecutor(),
      {
        yuiHome: home,
        historyLimit: resolveTmuxHistoryLimit(store.getConfig().tmuxHistoryLimit)
      }
    );
    const reconciliation = new SessionOwnerReconciliation({
      home,
      store,
      environment: process.env,
      tmux
    });
    const result = await runSessionReconcileCommand({
      reconciliation,
      options,
      environment: process.env
    });
    process.exitCode = result.exitCode;
    emit(result.output, false, result.data);
    return;
  }

  if (args[0] === "controller") {
    const method = args[1];
    if (method === "live-identity" && args.length === 2) {
      try {
        const identity = await callController(home, "controller.identity", {});
        emit("", false, identity);
      } catch (error) {
        if (!(error instanceof ControllerClientError)) throw error;
        if (jsonOutput) {
          process.stderr.write(`${JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
            details: {}
          })}\n`);
        } else {
          process.stderr.write(`RUNTIME_ERROR: ${error.message}\n`);
        }
        process.exitCode = 5;
      }
      return;
    }
    if (method === "identity" && args.length === 2) {
      // Issue 02: the stable, read-only runtime identity receipt. It survives
      // a Controller stop and answers build ID, package digest, backend, and
      // worker state without a socket round-trip. When no receipt exists yet
      // (a Controller that predates this feature), fall back to the
      // authenticated socket identity so the command stays useful during
      // rollout step 1.
      let receipt: RuntimeIdentityReceipt | null = null;
      try {
        receipt = readRuntimeIdentity(home);
      } catch {
        // A corrupt or stale receipt (for example one written by an older
        // Controller that predates the launch-identity fields) falls back to
        // the live socket identity, which always carries the exact argv.
      }
      if (receipt !== null) {
        emit("", false, receipt);
        return;
      }
      try {
        const identity = await callController(home, "controller.identity", {});
        emit("", false, identity);
      } catch (error) {
        // Preserve the Controller protocol code for the synchronous update
        // lifecycle owner. A generic RUNTIME_ERROR would erase the only
        // definitive CONTROLLER_NOT_RUNNING proof and force an unnecessary
        // unknown-active block.
        if (!(error instanceof ControllerClientError)) throw error;
        if (jsonOutput) {
          process.stderr.write(`${JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
            details: {}
          })}\n`);
        } else {
          process.stderr.write(`RUNTIME_ERROR: ${error.message}\n`);
        }
        process.exitCode = 5;
      }
      return;
    }
    if (method === "status") {
      const options = parseControllerStatusOptions(args.slice(2));
      const snapshot = await scanControllerResourceInventory({
        currentHome: home,
        scope: options.scope,
        environment: process.env
      });
      if (resolveStatusIdentityEnabled(process.env)) {
        // Issue 11 read-only identity/metrics section. Every fact is observed;
        // missing producers render `unsupported` and storage contradictions
        // fail closed with exit code 5.
        const cliEntry = fileURLToPath(import.meta.url);
        const packageRoot = resolve(cliEntry, "..", "..");
        const build = collectRuntimeBuildIdentity(
          createProductionRuntimeIdentityPorts(packageRoot, cliEntry, process.env)
        );
        const storage = collectStorageIdentity(home);
        const droppedEvents = countDroppedInboxEvents(home);
        let runtime: ControllerRuntimeSnapshot;
        try {
          const result = await callController(
            home,
            "controller.status",
            {},
            { timeoutMs: 2_000 }
          );
          runtime = parseControllerRuntimeSnapshot(result, droppedEvents);
        } catch {
          runtime = { source: "unsupported", droppedEvents };
        }
        const mismatch = summarizeDurablePhysicalMismatch(snapshot);
        const identitySection = renderRuntimeIdentitySection({
          build,
          storage,
          runtime,
          mismatch,
          inventoryRssBytes: snapshot.summary.rssBytes
        });
        emit(
          `${renderControllerResourceStatus(snapshot, options.verbose)}\n\n${identitySection}`,
          false,
          { ...snapshot, identity: { build, storage, runtime, mismatch } }
        );
        // Exit 5 only on hard contradictions (fail). A needs-repair state
        // (pseudo-layout-7) is degraded but still readable via the file store,
        // so it exits 0 with a DEGRADED health line and a precise repair action.
        if (evaluateStorageHealth(storage).status === "fail") process.exitCode = 5;
        return;
      }
      emit(
        renderControllerResourceStatus(snapshot, options.verbose),
        false,
        snapshot
      );
      return;
    }
    if (method === "cleanup") {
      if (jsonOutput) throw usageError("Controller cleanup does not support --json.");
      const options = parseControllerCleanupOptions(args.slice(2));
      const readline = createInterface({
        input: process.stdin,
        output: process.stdout
      });
      try {
        const result = await runInteractiveControllerCleanup({
          io: {
            interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
            write: (value) => process.stdout.write(value),
            question: async (prompt) => readline.question(prompt)
          },
          scan: () => scanControllerResourceInventory({
            currentHome: home,
            scope: options.scope,
            environment: process.env
          }),
          clean: (resource) => cleanControllerResource(resource, {
            environment: process.env
          })
        });
        if (result.data.failed.length > 0 || result.data.skipped.length > 0) {
          process.exitCode = 5;
        }
        emit(result.output, false, result.data);
      } finally {
        readline.close();
      }
      return;
    }
    if ((method !== "stop" && method !== "restart") || args.length !== 2) {
      throw usageError(
        "Controller usage: yui controller status [--all] [--verbose] | "
          + "cleanup [--all] | stop | restart."
      );
    }
    validateCompatibleFileTaskStore(home);
    const controllerMethod: "stop" | "restart" = method;
    const updateHandoverOwner = process.env.YUI_UPDATE_HANDOVER_OWNER_PID;
    const updateHandoverOwnerPid = updateHandoverOwner === undefined
      ? undefined
      : Number(updateHandoverOwner);
    if (
      updateHandoverOwnerPid !== undefined
      && (!Number.isSafeInteger(updateHandoverOwnerPid) || updateHandoverOwnerPid < 1)
    ) {
      throw runtimeError("Update Controller handover owner PID is invalid.");
    }
    const controllerOptions = {
      environment: process.env,
      ...(updateHandoverOwnerPid === undefined ? {} : { handoverOwnerPid: updateHandoverOwnerPid })
    };
    const result = controllerMethod === "restart"
      ? await restartFileTaskController(home, controllerOptions)
      : await stopFileTaskController(home, controllerOptions);
    // The update lifecycle needs the authenticated replacement PID returned by
    // restart/readiness.  Keep stop's long-standing text envelope, while
    // exposing restart's structured result alongside its human output.
    emit(
      renderControllerResult(controllerMethod, result),
      false,
      controllerMethod === "restart" ? result : undefined
    );
    return;
  }

  if (args[0] === "resources") {
    await assertFileTaskControllerStorageCompatible(home);
    const resourcesStore = openCompatibleFileTaskStore(home);
    const result = await runResourcesCommand(args.slice(1), resourcesStore);
    emit(result.output, false, result.data);
    return;
  }

  await assertFileTaskControllerStorageCompatible(home);
  // Reuse the store the exact runtime preflight already opened and read for
  // this same Home. Opening a second store would parse the unchanged large
  // state a second time; the per-instance fingerprint cache still invalidates
  // on an external writer, and the storage lock + revision CAS are unchanged.
  const store = verifiedStore !== undefined
    && resolve(verifiedStore.rootDirectory()) === resolve(home)
    ? verifiedStore
    : openCompatibleFileTaskStore(home);
  const catalogs = new AgentConfigurationCatalogService(home, {
    environment: process.env
  });
  const resolved = await resolveTerminalArguments(args, invocation.node, store, catalogs);
  if (resolved === null) {
    emit("Cancelled.");
    return;
  }
  await preflightAgentConfigurationMutation(resolved, store, catalogs);

  const executor = new NodeCommandExecutor();
  const tmux = new TmuxManager(
    resolveTmuxBin(store.getConfig().tmuxBin),
    executor,
    {
      yuiHome: home,
      historyLimit: resolveTmuxHistoryLimit(store.getConfig().tmuxHistoryLimit),
      terminalInput: process.stdin,
      onWarning: (message) => process.stderr.write(`Warning: ${message}\n`)
    }
  );
  const schedulerStore = new FileSchedulerStoreAdapter(
    store,
    openSchedulerTelemetry(home, store.getConfig())
  );
  const planner = new FileRoleLaunchPlanner(home, store, { environment: process.env });
  const workspacePreparer = new FileTaskWorkspacePreparer(home, store);
  const runtime = new FileTaskWorkflowRuntime(
    home,
    store,
    schedulerStore,
    planner,
    tmux,
    workspacePreparer,
    {
      environment: process.env,
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Controller runtime error: ${message}\n`);
      }
    }
  );
  const workspaceCoordinator = new TaskWorkspaceCoordinator(store, workspacePreparer, runtime);

  if (resolved[0] === "web") {
    if (jsonOutput) throw usageError("Web does not support --json.");
    const options = parseWebCommandOptions(resolved.slice(1));
    const terminal = new TmuxWebTerminalService({
      yuiHome: home,
      tmuxBin: resolveTmuxBin(store.getConfig().tmuxBin),
      tmux,
      prepareGlobalRole: (roleName) => runtime.prepareGlobalRoleEnter(roleName),
      environment: process.env,
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Web terminal cleanup error: ${message}\n`);
      }
    });
    await startYuiWebServer(store, options, {
      terminal,
      answerInput: async ({ taskId, inputId, answer }) => {
        const command = [
          "input", "answer", inputId, "--task", taskId,
          ...("choiceKey" in answer
            ? ["--choice", answer.choiceKey]
            : ["--text", answer.text])
        ];
        const result = runTaskCommand(command, store, {
          runtime,
          environment: {},
          yuiHome: home
        });
        if (result.kind !== "output") {
          throw new Error("Input answer returned an invalid control result.");
        }
        const data = result.data as Readonly<{ request?: unknown }> | undefined;
        if (data?.request === undefined) {
          throw new Error("Input answer did not return the updated request.");
        }
        return data.request;
      }
    });
    const displayHost = options.host === "::1" ? "[::1]" : options.host;
    process.stdout.write(`Yui web control room: http://${displayHost}:${options.port}\n`);
    return;
  }

  if (resolved[0] === "config") {
    const domain = resolved[1];
    const roleOptions: GlobalRoleCommandOptions = {
      yuiHome: home,
      env: process.env
    };
    if (domain === "show") {
      const result = runConfigOverview(
        resolved.slice(2),
        store,
        process.env,
        resolveCliIdentity(process.env),
        roleOptions
      );
      emit(result.output, false, result.data);
      return;
    }
    if ((CONFIG_DOMAINS as readonly string[]).includes(domain ?? "")) {
      const configDomain = domain as ConfigDomain;
      const domainArgs = resolved.slice(2);
      const result = runConfigCommand(configDomain, domainArgs, store);
      if (
        domainArgs[0] === "set"
        && domainArgs[1] === "reconciliation-interval-seconds"
      ) {
        const refresh = await refreshRunningFileTaskControllerConfiguration(
          home,
          { environment: process.env }
        );
        emit(withControllerRefreshWarning(result.output, refresh, "Controller configuration"));
        return;
      }
      emit(result.output, false, result.data);
      return;
    }
    if (domain === "agent") {
      const agentArgs = resolved.slice(2);
      if (agentArgs[0] === "capabilities") {
        if (agentArgs.length !== 2) {
          throw usageError("Agent capabilities usage: yui config agent capabilities <agent-id>");
        }
        const agent = store.getConfiguredAgent(agentArgs[1] ?? "");
        if (agent === null) throw agentNotFound(agentArgs[1] ?? "");
        const result = await catalogs.resolve({
          agent,
          cwd: store.getConfig().defaultWorkspace ?? process.cwd()
        });
        emit(renderAgentConfigurationCatalog(result), false, result);
        return;
      }
      const affectedAgentId = agentArgs[1];
      const previousAgent = typeof affectedAgentId === "string"
        ? store.getConfiguredAgent(affectedAgentId)
        : null;
      const output = runAgentCommand(
        agentArgs,
        store as unknown as AgentCommandStore
      );
      if (
        agentArgs[0] === "add"
        || agentArgs[0] === "update"
        || agentArgs[0] === "remove"
      ) {
        const currentAgent = typeof affectedAgentId === "string"
          ? store.getConfiguredAgent(affectedAgentId)
          : null;
        const capabilityNotice = currentAgent !== null
          && (agentArgs[0] === "add" || agentArgs[0] === "update")
          ? renderAgentConfigurationResolutionNotice(await catalogs.resolve({
              agent: currentAgent,
              cwd: store.getConfig().defaultWorkspace ?? process.cwd()
            }))
          : "";
        const scope = agentEnvironmentRefreshScope(
          previousAgent,
          currentAgent,
          store.listConfiguredAgents()
        );
        const refresh = await refreshRunningFileTaskControllerEnvironment(
          home,
          store,
          process.env,
          scope
        );
        emit(withControllerRefreshWarning(
          `${output.trimEnd()}${capabilityNotice.length === 0 ? "\n" : `\n${capabilityNotice}`}`,
          refresh,
          "Agent environment"
        ));
        return;
      }
      emit(output);
      return;
    }
    if (domain === "profile") {
      const result = runProfileCommand(resolved.slice(2), store);
      emit(result.output, false, result.data);
      return;
    }
    if (domain === "role") {
      const result = runGlobalRoleCommand(
        resolved.slice(2),
        store as unknown as Parameters<typeof runGlobalRoleCommand>[1],
        roleOptions
      );
      if (typeof result !== "string") {
        throw new Error("Config Role commands cannot enter a runtime Session.");
      }
      emit(result);
      return;
    }
    throw usageError(`Unknown configuration domain: ${domain ?? ""}.`);
  }
  if (resolved[0] === "project") {
    const result = await runProjectCommand(resolved.slice(1), store, { environment: process.env });
    emit(result.output, false, result.data);
    return;
  }
  if (resolved[0] === "session") {
    if (resolved[1] === "stop") {
      const options = parseSessionStopOptions(resolved.slice(2));
      const result = await runSessionStopCommand({
        options,
        runtime: {
          beginMaintenance: () => acquireHandoverLock(home),
          snapshot: () => ({
            candidates: schedulerStore.listRuntimeSessionCandidates(),
            dormant: schedulerStore.listDormantRuntimeOwners()
          }),
          drainController: () => runtime.drainController(),
          stopController: () => stopFileTaskController(home, {
            environment: process.env
          }),
          startController: async () => {
            await ensureFileTaskController(home, { environment: process.env });
          },
          stopDormantSession: (candidate) => runtime.stopDormantSession(candidate)
        },
        environment: process.env
      });
      process.exitCode = result.exitCode;
      emit(result.output, false, result.data);
      return;
    }
    const roleOptions: GlobalRoleCommandOptions = {
      yuiHome: home,
      env: process.env,
      jsonOutput
    };
    const sessionArgs = resolved[1] === "enter" || resolved[1] === "context"
      ? [resolved[1], ...resolved.slice(2)]
      : ["session", resolved[1] ?? "", ...resolved.slice(2)];
    const result = runGlobalRoleCommand(
      sessionArgs,
      store as unknown as Parameters<typeof runGlobalRoleCommand>[1],
      roleOptions
    );
    if (typeof result === "string") {
      emit(result);
      return;
    }
    await ensureFileTaskController(home, { environment: process.env });
    await runtime.prepareGlobalRoleEnter(result.role.name);
    tmux.attachRole("operator", result.role.name, "auto");
    return;
  }
  if (resolved[0] === "operator") {
    if (resolved[1] === "enter") {
      if (resolved.length !== 2) throw usageError("Operator enter usage: yui operator enter.");
      await ensureFileTaskController(home, { environment: process.env });
      await runtime.prepareGlobalRoleEnter("operator");
      tmux.attachRole("operator", "operator", "auto");
      return;
    }
    const result = runOperatorCommand(resolved.slice(1), store, { runtime, environment: process.env });
    if (result.kind === "output") {
      emit(result.output, false, result.data);
      return;
    }
    if (result.kind !== "session") {
      throw new Error("Operator command returned an invalid control result.");
    }
    await executeOperatorSessionControl(
      result,
      home,
      store,
      runtime,
      tmux,
      catalogs
    );
    return;
  }
  if (resolved[0] === "task") {
    if (resolved[1] === "integration") {
      const result = await runTaskIntegrationCommand(
        resolved.slice(2),
        store,
        home,
        {
          environment: process.env,
          jobPort: createControllerIntegrationJobPort(home, { environment: process.env })
        }
      );
      emit(result.output, false, result.data);
      return;
    }
    if (resolved[1] === "change-set") {
      const result = await runTaskChangeSetCommand(resolved.slice(2), store);
      emit(result.output, false, result.data);
      return;
    }
    if (resolved[1] === "overlap") {
      const result = await runTaskOverlapCommand(resolved.slice(2), store);
      emit(result.output, false, result.data);
      return;
    }
    if (resolved[1] === "workflow"
      && (resolved[2] === "run" || resolved[2] === "resume")) {
      const result = await runWorkflowCommandAsync(
        resolved.slice(2),
        store,
        {
          environment: process.env,
          yuiHome: home,
          ports: createReleaseWorkflowPorts({
            home,
            updatePorts: createUpdatePorts(process.env),
            projectStore: store
          })
        }
      );
      if (result.kind !== "output") {
        throw new Error(`Task workflow ${resolved[2]} returned an invalid control result.`);
      }
      emit(result.output, false, result.data);
      return;
    }
    if (resolved[1] === "rebuild"
      || resolved[1] === "history"
      || resolved[1] === "replace") {
      const result = await runTaskWorkspaceCommand(
        resolved.slice(1),
        store,
        workspacePreparer
      );
      emit(result.output, false, result.data);
      return;
    }
    if (resolved[1] === "work" && resolved[2] === "isolate") {
      const workItemId = resolved[3];
      if (workItemId === undefined || resolved.length !== 4) {
        throw usageError("Task work isolate usage: yui task work isolate <task>/<work>.");
      }
      const reference = cliWorkItemReference(workItemId, process.env);
      const workspace = await workspaceCoordinator.isolateWorkItem(
        reference.taskId,
        reference.localId
      );
      emit(
        `Created WorkItem workspace for ${reference.taskId}/${reference.localId}\nWorkspace: ${workspace.root}\n`,
        false,
        { workItemRef: reference, workspace }
      );
      return;
    }
    if (resolved[1] === "work" && resolved[2] === "review"
      && resolved[3] === "cleanup") {
      const reviewRoundId = resolved[4];
      if (reviewRoundId === undefined || resolved.length !== 5) {
        throw usageError(
          "Task work review cleanup usage: yui task work review cleanup <task>/<review-round>."
        );
      }
      const reference = cliTaskRecordReference(reviewRoundId, "reviewRound", process.env);
      const removal = await workspaceCoordinator.cleanupReviewRound(
        reference.taskId,
        reference.localId
      );
      if (removal === "dirty") {
        throw usageError(
          `ReviewRound workspace is dirty and was retained: ${reference.taskId}/${reference.localId}.`
        );
      }
      emit(
        `Cleaned ReviewRound workspace ${reference.taskId}/${reference.localId} (${removal})\n`,
        false,
        { reviewRoundRef: reference, workspace: { removal } }
      );
      return;
    }
    if (resolved[1] === "work" && resolved[2] === "capture") {
      const workItemId = resolved[3];
      if (workItemId === undefined || resolved.length !== 4) {
        throw usageError("Task work capture usage: yui task work capture <task>/<work>.");
      }
      const reference = cliWorkItemReference(workItemId, process.env);
      const changeSets = await new WorkItemChangeSetManager(store).capture(
        reference.taskId,
        reference.localId,
        taskFinalReviewContract === undefined
          ? {}
          : { taskFinalReviewContract }
      );
      const qualified = `${reference.taskId}/${reference.localId}`;
      emit(
        changeSets.length === 0
          ? `WorkItem workspace has no changes to capture: ${qualified}\n`
          : `Captured ChangeSets ${changeSets.map(({ id }) => id).join(", ")} from ${
              qualified
            }\n`,
        false,
        { workItemRef: reference, changeSets }
      );
      return;
    }
    if (resolved[1] === "work" && resolved[2] === "cleanup") {
      const workItemId = resolved[3];
      const disposition = resolved[4];
      if (workItemId === undefined
        || !["--runtime-only", "--integrated", "--abandon"].includes(disposition ?? "")
        || resolved.length !== 5) {
        throw usageError(
          "Task work cleanup usage: yui task work cleanup <task>/<work> "
          + "(--runtime-only|--integrated|--abandon)."
        );
      }
      const reference = cliWorkItemReference(workItemId, process.env);
      const qualified = `${reference.taskId}/${reference.localId}`;
      taskActor(process.env, reference.taskId);
      if (disposition === "--runtime-only") {
        let runtimeCleanup;
        try {
          runtimeCleanup = await workspaceCoordinator.cleanupWorkItemRuntime(
            reference.taskId,
            reference.localId
          );
        } catch (error) {
          throw cleanupCliError(error, `work-item:${qualified}`);
        }
        emit(
          `Released WorkItem runtime ${qualified}; retained its Session and worktree\n`,
          false,
          {
            workItem: store.getWorkItem(reference.taskId, reference.localId),
            runtime: { cleanup: runtimeCleanup },
            worktree: { retained: true }
          }
        );
        return;
      }
      const cleanedAs = disposition === "--integrated" ? "integrated" : "abandoned";
      if (cleanedAs === "integrated") {
        try {
          await new WorkItemChangeSetManager(store).assertIntegrated(
            reference.taskId,
            reference.localId
          );
        } catch (error) {
          throw usageError(error instanceof Error ? error.message : String(error));
        }
      }
      let removal;
      try {
        removal = await workspaceCoordinator.cleanupWorkItem(
          reference.taskId,
          reference.localId,
          cleanedAs
        );
      } catch (error) {
        throw cleanupCliError(error, `work-item:${qualified}`);
      }
      if (removal === "dirty") {
        throw usageError(
          `WorkItem worktree is dirty and was retained: ${qualified}.`,
          undefined,
          cleanupBlockedDetails("dirty-worktree", `work-item:${qualified}`, true)
        );
      }
      emit(
        `Cleaned WorkItem worktree ${qualified} (${cleanedAs})\n`,
        false,
        {
          workItem: store.getWorkItem(reference.taskId, reference.localId),
          worktree: { removal, disposition: cleanedAs }
        }
      );
      return;
    }
    if (resolved[1] === "work" && resolved[2] === "review"
      && resolved[3] === "cleanup") {
      const reviewRef = resolved[4];
      if (reviewRef === undefined || resolved.length !== 5) {
        throw usageError(
          "Task work review cleanup usage: yui task work review cleanup <task>/<review-round>."
        );
      }
      const reference = cliTaskRecordReference(reviewRef, "reviewRound", process.env);
      const removal = await workspaceCoordinator.cleanupReviewRound(
        reference.taskId,
        reference.localId
      );
      if (removal === "dirty") {
        throw usageError(
          `ReviewRound worktree is dirty and was retained: ${reference.taskId}/${reference.localId}.`
        );
      }
      emit(
        `Cleaned ReviewRound worktree ${reference.taskId}/${reference.localId}\n`,
        false,
        {
          reviewRound: store.getReviewRound(reference.taskId, reference.localId),
          worktree: { removal }
        }
      );
      return;
    }
    if (resolved[1] === "work" && resolved[2] === "review"
      && resolved[3] === "preserve") {
      const reviewRef = resolved[4];
      if (reviewRef === undefined || resolved.length !== 5) {
        throw usageError(
          "Task work review preserve usage: yui task work review preserve <task>/<review-round>."
        );
      }
      const reference = cliTaskRecordReference(reviewRef, "reviewRound", process.env);
      const round = preserveReviewRoundWorkspace(
        reference.taskId,
        reference.localId,
        store,
        { runtime, environment: process.env, yuiHome: home }
      );
      emit(`Preserved ReviewRound worktree ${reference.taskId}/${reference.localId}\n`, false, {
        reviewRound: round
      });
      return;
    }
    if (resolved[1] === "archive") {
      const { taskId, disposition } = validateTaskArchiveRequest(
        resolved.slice(2),
        store,
        { runtime, environment: process.env, yuiHome: home }
      );
      const task = store.getTask(taskId);
      if (task === null) throw new Error(`Task disappeared after archive validation: ${taskId}.`);
      if (task.status !== "archived") {
        const workItemIds = store.listManagedWorkspaces(task.id)
          .flatMap(({ owner }) => owner.type === "work-item" ? [owner.workItemId] : []);
        for (const workItemId of workItemIds) {
          const item = store.getWorkItem(task.id, workItemId);
          if (item?.status !== "completed" || disposition !== "integrated") continue;
          try {
            await new WorkItemChangeSetManager(store).assertIntegrated(task.id, item.id);
          } catch (error) {
            throw usageError(error instanceof Error ? error.message : String(error));
          }
        }
        const cleanup = await workspaceCoordinator.cleanupTaskForArchive(task.id, disposition);
        if (cleanup.status === "retained-dirty") {
          throw usageError(
            cleanup.error ?? `Task ${task.id} has dirty managed worktrees and remains terminal.`,
            undefined,
            cleanupBlockedDetails(
              cleanup.reason ?? "dirty-worktree",
              cleanup.resource ?? `task:${task.id}`,
              cleanup.retryable ?? true
            )
          );
        }
        if (cleanup.status === "failed") {
          throw usageError(
            `Task ${task.id} worktree cleanup failed: ${cleanup.error ?? "unknown error"}.`,
            undefined,
            cleanupBlockedDetails(
              cleanup.reason ?? "cleanup-failed",
              cleanup.resource ?? `task:${task.id}`,
              cleanup.retryable ?? true
            )
          );
        }
      }
    }
    let taskRetirementProof;
    if (resolved[1] === "retire") {
      const taskId = resolved[2];
      if (taskId !== undefined && !taskId.startsWith("--")) {
        const task = store.getTask(taskId);
        if (task?.status === "active" || task?.status === "draft") {
          try {
            taskRetirementProof = await new WorkItemChangeSetManager(store)
              .assertRetirable(taskId);
          } catch (error) {
            throw usageError(error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
    if (resolved[1] === "work" && resolved[2] === "dispatch") {
      const workItemId = resolved[3];
      const reference = workItemId === undefined
        ? null
        : cliWorkItemReference(workItemId, process.env);
      const item = reference === null
        ? null
        : store.getWorkItem(reference.taskId, reference.localId);
      const task = item === null ? null : store.getTask(item.taskId);
      // A rejected Candidate starts a new execution iteration. Release every
      // terminal Lane Role runtime before preparing the new Lane workspaces;
      // durable Runs, Groups, Candidates, and workspace owners remain intact.
      if (item?.status === "failed"
        && currentWorkItemExecutionGroup(item)?.resolution !== undefined) {
        await workspaceCoordinator.cleanupWorkItemRuntime(item.taskId, item.id);
      }
      // Every Task needs an authoritative runtime owner before dispatch. A
      // Gitless Task uses an empty Task-owned view; Project-backed WorkItems
      // additionally receive their isolated Develop owner below.
      if (item !== null && task !== null) {
        await workspacePreparer.prepareTaskWorkspace(task.id);
      }
      // Every Project-backed WorkItem needs its own Develop owner before a
      // Lane can be prepared. The physical preparer creates the symlink view
      // and stores the exact WorkItem owner before dispatch creates the Run.
      if (item !== null
        && task !== null
        && task.projectBindings.length > 0
        && store.getWorkItemWorkspace(task.id, item.id) === null) {
        await workspaceCoordinator.isolateWorkItem(item.taskId, item.id);
      }
      if (item !== null && task !== null) {
        // For a new Group the preparer has already created deterministic
        // worktrees, but the owner record is adopted by dispatch's aggregate
        // transaction once its exact Lane ids exist.
      }
    }
    let executionLaneWorkspaces: ReadonlyMap<string, import("./worktree/managedWorkspace.js").ManagedWorkspace> | undefined;
    // Held only for a new Group's dispatch: the per-Project maintenance fence
    // spans Lane preparation and the adoption transaction, and projectPaths is
    // the under-fence snapshot the adoption CAS revalidates.
    let laneDispatchRelease: (() => void) | undefined;
    let laneDispatchProjectPaths: ReadonlyMap<string, string> | undefined;
    let workItemIntegrationProof;
    if (resolved[1] === "work" && resolved[2] === "accept") {
      const workItemId = resolved[3];
      if (workItemId !== undefined && !workItemId.startsWith("--")) {
        try {
          const reference = cliWorkItemReference(workItemId, process.env);
          workItemIntegrationProof = await new WorkItemChangeSetManager(store)
            .assertIntegrated(reference.taskId, reference.localId) ?? undefined;
        } catch (error) {
          throw usageError(error instanceof Error ? error.message : String(error));
        }
      }
    }
    let completionSummary: string | undefined;
    let completionPublishedTreeProof: TaskCompletionPublishedTreeProof | undefined;
    if (resolved[1] === "base" && resolved[2] === "status") {
      const result = await runTaskBaseStatusCommand(resolved.slice(3), store);
      emit(result.output, false, result.data);
      return;
    }
    if (resolved[1] === "upstream") {
      const result = await runTaskUpstreamCommand(resolved.slice(2), store);
      emit(result.output, false, result.data);
      return;
    }
    if (resolved[1] === "complete" && resolved[2] !== undefined) {
      const completionRequest = parseTaskCompletionRequest(resolved.slice(2));
      completionSummary = completionRequest.summary;
      const refreshRemote = resolved.includes("--refresh-remote");
      const completion = preflightTaskCompletion(resolved[2], store, {
        environment: process.env,
        ...(taskFinalReviewContract === undefined
          ? {}
          : { taskFinalReviewContract })
      }, completionRequest);
      if (!completion.completed && !completion.activeTaskReview) {
        // An explicit refresh must fetch the remote object graph before the
        // Publication proof resolves its exact commit. Without the flag the
        // command remains offline and preserves the existing proof-first path.
        const refreshedFreshness = refreshRemote
          ? await inspectTaskBaseFreshness(resolved[2], store, { refresh: true })
          : undefined;
        if (completionRequest.acceptedPublishedTreePublicationId !== undefined) {
          completionPublishedTreeProof = await verifyTaskCompletionPublishedTree(
            completionRequest.taskId,
            completionRequest.acceptedPublishedTreePublicationId,
            store
          );
        }
        const freshness = refreshedFreshness
          ?? await inspectTaskBaseFreshness(resolved[2], store);
        for (const warning of assertTaskBaseFreshnessForCompletion(freshness, {
          ...(completionPublishedTreeProof === undefined
            ? {}
            : {
                acceptedPublishedTreeProjectId: completionPublishedTreeProof.projectId
              })
        })) {
          process.stderr.write(`Warning: ${warning}\n`);
        }
        // Keep completion offline by default. An explicit refresh is the only
        // path that may fetch and reconcile a moved remote baseline.
        if (refreshRemote) {
          await reconcileTaskRemoteBaselines(
            resolved[2],
            store,
            home,
            { environment: process.env, jobPort: createControllerIntegrationJobPort(home, { environment: process.env }) }
          );
        }
      }
    }
    let taskFinalReviewRebindProof: TaskFinalReviewContractRebindProof | undefined;
    let taskFinalReviewRebindRequest:
      | ReturnType<typeof parseTaskFinalReviewContractRebindRequest>
      | undefined;
    let releaseTaskFinalReviewHandoverLock: (() => void) | undefined;
    if (resolved[1] === "review" && resolved[2] === "rebind") {
      if (!isCurrentGlobalOperator(store, process.env)) {
        throw usageError(
          "Task-final Review contract rebind requires the authenticated global Operator session."
        );
      }
      if (exactCurrentControlPlane === undefined) {
        throw usageError(
          "Task-final Review contract rebind requires the exact current global Session CLI."
        );
      }
      taskFinalReviewRebindRequest = parseTaskFinalReviewContractRebindRequest(
        resolved.slice(3)
      );
    }
    if ((resolved[1] === "review"
        && ["request", "force-fresh", "retry", "rebind"].includes(resolved[2] ?? ""))
      || resolved[1] === "complete") {
      const handoverLock = acquireHandoverLock(home);
      releaseTaskFinalReviewHandoverLock = handoverLock.release;
    }
    if (taskFinalReviewRebindRequest !== undefined) {
      const request = taskFinalReviewRebindRequest;
      try {
        taskFinalReviewRebindProof = prepareTaskFinalReviewContractRebindProof({
          home,
          taskId: request.taskId,
          fromControlPlaneDigest: request.fromControlPlaneDigest,
          toControlPlaneDigest: request.toControlPlaneDigest,
          fromReleaseId: request.fromReleaseId,
          toReleaseId: request.toReleaseId,
          currentControlPlane: exactCurrentControlPlane!.descriptor
        });
        const workItems = store.listWorkItems(request.taskId);
        const reviewRounds = store.listReviewRounds(request.taskId);
        const resolution = resolveRecordedTaskFinalReviewContract(
          request.taskId,
          workItems,
          reviewRounds,
          store.listEvents(request.taskId)
        );
        const activeRound = reviewRounds.find((round) => (
          (round.scope ?? "work-item") === "task"
          && (round.status === "pending" || round.status === "running")
        ));
        // An exact replay is a true no-op, even when the target Leader is live.
        // Invalid/stale source tuples also reach the command unchanged so its
        // transactional diagnosis cannot stop a healthy target runtime.
        if (resolution?.effective.controlPlaneDigest === request.fromControlPlaneDigest
          && activeRound === undefined) {
          // The contract event and wake must never target a Provider
          // Conversation launched by the source release. Active Runs fail
          // closed; otherwise stop and retire that runtime under the handover
          // lock before the transactional event+wake commit.
          await workspaceCoordinator.cleanupTaskRoleRuntime(request.taskId, "leader");
        }
      } catch (error) {
        releaseTaskFinalReviewHandoverLock!();
        releaseTaskFinalReviewHandoverLock = undefined;
        throw error;
      }
    }
    let candidateMaterialization: Awaited<ReturnType<typeof candidateMaterializationForTaskCommand>>;
    let candidateMaterializationCommitted = false;
    try {
      const preparedLanes = await prepareExecutionLaneWorkspacesForCommand(
        resolved,
        store,
        workspacePreparer,
        process.env
      );
      if (preparedLanes !== undefined) {
        executionLaneWorkspaces = preparedLanes.workspaces;
        laneDispatchRelease = preparedLanes.release;
        laneDispatchProjectPaths = preparedLanes.projectPaths;
      }
      candidateMaterialization = await candidateMaterializationForTaskCommand(
        resolved,
        store,
        workspacePreparer,
        process.env,
        taskFinalReviewContract
      );
      const candidateGitSnapshot = candidateMaterialization === undefined
        ? await candidateSnapshotForTaskCommand(
          resolved,
          store,
          workspacePreparer,
          process.env,
          taskFinalReviewContract
        )
        : candidateMaterialization.snapshot;
      const directTaskMainSnapshot = await directTaskMainSnapshotForTaskCommand(
        resolved,
        store,
        workspacePreparer,
        process.env,
        taskFinalReviewContract
      );
      const actualTaskReviewCandidate = await actualTaskReviewCandidateForTaskCommand(
        resolved,
        store,
        workspacePreparer,
        process.env
      );
      const deltaRecheckPreflight = await deltaRecheckPreflightForTaskCommand(
        resolved.slice(1),
        store,
        actualTaskReviewCandidate
      );
      const reviewWorkspaceResult = await reviewWorkspaceResultForTaskCommand(
        resolved,
        store,
        workspacePreparer,
        process.env
      );
      const executionLaneGitSnapshot = await executionLaneGitSnapshotForTaskCommand(
        resolved,
        store,
        workspacePreparer,
        process.env
      );
      const laneSnapshotPreflight = executionLaneGitSnapshot === undefined
        ? undefined
        : executionLaneGitSnapshot;
      // Physical preparation may precede the durable write, but Task status,
      // workspace identity/cwd, and ManagedWorkspace ownership are adopted by
      // one transaction. A failed attempt therefore leaves the Task Draft and
      // owning no writable workspace.
      let taskWorkspaceActivation: TaskWorkspaceActivation | undefined;
      if (resolved[1] === "activate" && resolved.length === 3) {
        const taskId = resolved[2];
        const task = taskId === undefined ? null : store.getTask(taskId);
        if (task !== null && task.status === "draft") {
          taskWorkspaceActivation = await workspacePreparer.activateTaskWorkspace(task.id);
        }
      }
      const result = runTaskCommand(
        resolved.slice(1),
        store,
        {
          runtime,
          environment: process.env,
          yuiHome: home,
          ...(taskFinalReviewContract === undefined
            ? {}
            : { taskFinalReviewContract }),
          ...(taskFinalReviewRebindProof === undefined
            ? {}
            : { taskFinalReviewRebindProof }),
          ...(completionSummary === undefined ? {} : { completionSummary }),
          ...(completionPublishedTreeProof === undefined
            ? {}
            : { completionPublishedTreeProof }),
          ...(workItemIntegrationProof === undefined ? {} : { workItemIntegrationProof }),
          ...(candidateGitSnapshot === undefined ? {} : { candidateGitSnapshot }),
          ...(candidateMaterialization === undefined
            ? {}
            : { candidateWorkspace: candidateMaterialization.workspace ?? null }),
          ...(executionLaneWorkspaces === undefined ? {} : { executionLaneWorkspaces }),
          ...(taskWorkspaceActivation === undefined ? {} : { taskWorkspaceActivation }),
          ...(laneDispatchProjectPaths === undefined ? {} : { laneDispatchProjectPaths }),
          ...(directTaskMainSnapshot === undefined ? {} : { directTaskMainSnapshot }),
          ...(actualTaskReviewCandidate === undefined
            ? {}
            : { actualTaskReviewCandidate }),
          ...(deltaRecheckPreflight === undefined
            ? {}
            : { deltaRecheckPreflight }),
          ...(reviewWorkspaceResult === undefined ? {} : { reviewWorkspaceResult }),
          ...(laneSnapshotPreflight === undefined ? {} : { executionLaneGitSnapshot: laneSnapshotPreflight }),
          ...(taskRetirementProof === undefined ? {} : { taskRetirementProof })
        }
      );
      // The dispatch transaction has now adopted (or rejected) the prepared
      // Lane workspaces. Release the held fence so later output/review
      // handling can take the per-Project fence itself.
      if (laneDispatchRelease !== undefined) {
        laneDispatchRelease();
        laneDispatchRelease = undefined;
      }
      // The command transaction has now durably submitted the Candidate. Any
      // later output/review handling must not roll back its Git snapshot.
      candidateMaterializationCommitted = candidateMaterialization !== undefined;
      if (result.kind === "output") {
        const requestedRound = reviewRoundFromCommandData(result.data);
        const persistedRequestedRound = requestedRound === undefined
          ? null
          : store.getReviewRound(requestedRound.taskId, requestedRound.id);
        let reviewOutput = "";
        let reviewData: unknown;
        const resumesReviewDispatch = (resolved[1] === "review" && resolved[2] === "request")
          || (resolved[1] === "work" && resolved[2] === "review")
          || (resolved[1] === "run" && resolved[2] === "retry");
        const reviewDispatchNeeded = requestedRound?.status === "pending"
          || (requestedRound?.status === "running"
            && resumesReviewDispatch
            && persistedRequestedRound?.executionGroup?.lanes.some((lane) => (
              lane.status === "pending" && lane.runId === undefined
            )) === true);
        if (reviewDispatchNeeded) {
          try {
            const workspace = requestedRound.status === "running"
              ? store.getReviewRoundWorkspace(requestedRound.taskId, requestedRound.id)
              : await workspacePreparer.prepareReviewRoundWorkspace(
                requestedRound.taskId,
                requestedRound.id
              );
            if (workspace === null) {
              throw new Error(`ReviewRound workspace is not ready: ${requestedRound.id}.`);
            }
            const reviewLaneWorkspaces = await prepareReviewLaneWorkspaces(
              requestedRound.taskId,
              requestedRound.id,
              store,
              workspacePreparer
            );
            if (reviewLaneWorkspaces !== undefined) {
              executionLaneWorkspaces = reviewLaneWorkspaces;
            }
            const storedRound = store.getReviewRound(
              requestedRound.taskId,
              requestedRound.id
            );
            const freshTaskCandidate = (storedRound?.scope ?? "work-item") === "task"
              ? await snapshotActualTaskReviewCandidate(
                requestedRound.taskId,
                store,
                workspacePreparer
              )
              : undefined;
            const run = dispatchPreparedReviewRound(
              requestedRound.taskId,
              requestedRound.id,
              store,
              {
                runtime,
                environment: process.env,
                yuiHome: home,
                ...(taskFinalReviewContract === undefined
                  ? {}
                  : { taskFinalReviewContract }),
                ...(freshTaskCandidate === undefined
                  ? {}
                  : { actualTaskReviewCandidate: freshTaskCandidate }),
                ...(executionLaneWorkspaces === undefined ? {} : { executionLaneWorkspaces }),
                ...(storedRound?.deltaRecheck === undefined
                  || deltaRecheckPreflight === undefined
                  ? {}
                  : {
                      deltaRecheckDiff: deltaRecheckPreflight.diffByProject
                    })
              }
            );
            reviewOutput = run === null
              ? `Review ${requestedRound.id} retained pending by Resource Broker\n`
              : `Review queued as ${requestedRound.id} (${run.id})\n`;
            reviewData = {
              reviewRequest: run === null
                ? {
                    kind: "busy",
                    reviewerRoleName: requestedRound.reviewerRoleName,
                    phase: "resource-broker",
                    activeReviewRoundId: requestedRound.id,
                    retryable: true,
                    retryAfterSeconds: 5
                  }
                : {
                    kind: "started",
                    reviewerRoleName: requestedRound.reviewerRoleName,
                    reviewRoundId: requestedRound.id,
                    runId: run.id
                  },
              reviewRound: store.getReviewRound(requestedRound.taskId, requestedRound.id),
              ...(run === null ? {} : { reviewRun: run }),
              workspace
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await workspacePreparer.discardUnadoptedExecutionLaneWorkspaces(
              executionLaneWorkspaces
            );
            const failed = failPendingReviewRound(
              requestedRound.taskId,
              requestedRound.id,
              message,
              store,
              {
                runtime,
                environment: process.env,
                yuiHome: home
              }
            );
            reviewOutput = `Review could not start: ${message}\n`
              + "The failed ReviewRound was retained for Leader routing.\n";
            reviewData = {
              reviewRequest: {
                kind: "unavailable",
                reviewerRoleName: requestedRound.reviewerRoleName,
                reviewRoundId: failed.id,
                reason: message,
                retryable: true
              },
              reviewRound: failed
            };
          }
        }
        if (resolved[1] === "project" && resolved[2] === "add") {
          const taskId = resolved[3];
          const task = taskId === undefined ? null : store.getTask(taskId);
          if (task?.status === "active") {
            await workspacePreparer.prepareTaskWorkspace(task.id);
          }
        }
        emit(`${result.output}${reviewOutput}`, false, reviewData === undefined
          ? result.data
          : { command: result.data, ...reviewData as object });
        return;
      }
      if (jsonOutput) {
        throw usageError("Task Role view/takeover requires an interactive terminal.");
      }
      if (result.kind === "view") {
        if (result.output !== undefined) emit(result.output);
        tmux.attachRole(result.taskId, result.roleName, "read-only");
        return;
      }
      const syncAuthority = async (
        authorityResult: Extract<typeof result, { kind: "authority" }>
      ): Promise<AgentHostControlResult> => {
        let control: AgentHostControlResult;
        try {
          control = await sendAgentHostAuthorityControl({
            home,
            scope: "task",
            taskId: authorityResult.taskId,
            roleName: authorityResult.roleName,
            control: {
              protocol: AGENT_HOST_CONTROL_PROTOCOL,
              type: "set-authority",
              nativeSessionId: authorityResult.nativeSessionId,
              authority: authorityResult.authority
            }
          });
        } catch (error) {
          throw runtimeError(
            `Agent Host authority synchronization failed at epoch ${authorityResult.authority.epoch}: `
            + `${error instanceof Error ? error.message : String(error)}. `
            + `Durable authority is ${authorityResult.authority.owner}-owned; retry `
            + `'yui task role release ${authorityResult.taskId} ${authorityResult.roleName}' `
            + "to reconcile the Host."
          );
        }
        if (control.outcome !== "accepted"
          || control.snapshot.nativeSessionId !== authorityResult.nativeSessionId
          || control.snapshot.authorityEpoch !== authorityResult.authority.epoch
          || control.snapshot.authorityOwner !== authorityResult.authority.owner
          || control.snapshot.authorityHolderId !== authorityResult.authority.holderId) {
          throw runtimeError(
            `Agent Host did not accept Provider authority epoch ${authorityResult.authority.epoch}: `
            + (control.snapshot.detail ?? control.outcome)
            + `. Durable authority is ${authorityResult.authority.owner}-owned; `
            + "retry 'yui task role release "
            + `${authorityResult.taskId} ${authorityResult.roleName}' to reconcile the Host.`
          );
        }
        return control;
      };
      await syncAuthority(result);
      emit(result.output);
      if (result.action === "release") {
        runtime.notifyMailboxChanged({
          kind: "role",
          taskId: result.taskId,
          roleName: result.roleName
        });
        return;
      }
      process.stdout.write(
        "Provider input is now routed through the Agent Host PTY gateway. "
        + "Use tmux detach (Ctrl-b d) to return authority to the Controller.\n"
      );
      try {
        tmux.attachRole(result.taskId, result.roleName, "read-write");
      } finally {
        const currentTask = store.getTask(result.taskId);
        // Completing or retiring the Task from inside the takeover Turn owns
        // Provider shutdown and clears the live binding. Do not turn that
        // successful terminal transition into a failing best-effort release.
        if (currentTask?.status === "active") {
          const released = runTaskCommand(
            ["role", "release", result.taskId, result.roleName],
            store,
            { runtime, environment: process.env, yuiHome: home }
          );
          if (released.kind !== "authority" || released.action !== "release") {
            throw runtimeError("Provider authority release returned an invalid result.");
          }
          await syncAuthority(released);
          emit(released.output);
          runtime.notifyMailboxChanged({
            kind: "role",
            taskId: released.taskId,
            roleName: released.roleName
          });
        }
      }
      return;
    } catch (error) {
      if (candidateMaterialization !== undefined && !candidateMaterializationCommitted) {
        await workspacePreparer.restoreExecutionGroupCandidateMaterialization(
          candidateMaterialization
        );
      }
      if (!candidateMaterializationCommitted) {
        await workspacePreparer.discardUnadoptedExecutionLaneWorkspaces(executionLaneWorkspaces);
      }
      if (laneDispatchRelease !== undefined) {
        laneDispatchRelease();
        laneDispatchRelease = undefined;
      }
      throw error;
    } finally {
      if (releaseTaskFinalReviewHandoverLock !== undefined) {
        releaseTaskFinalReviewHandoverLock();
        releaseTaskFinalReviewHandoverLock = undefined;
      }
    }
  }
  if (resolved[0] === "jobs") {
    emit(runJobCommand(resolved.slice(1), store, { runtime }));
    return;
  }
  if (resolved[0] === "job") {
    emit(await runDurableJobCommand(resolved.slice(1), {
      home,
      json: jsonOutput,
      environment: process.env,
      store
    }));
    return;
  }
  if (resolved[0] === "telemetry") {
    emit(await runTelemetryCommand(resolved.slice(1), {
      home,
      json: jsonOutput,
      environment: process.env,
      store
    }));
    return;
  }

  throw usageError(
    `Command is not connected to the restored FileTaskStore framework yet: ${resolved[0]}.`,
    renderCommandHelp(invocation.node, VERSION)
  );
}

function explicitReleaseActivationDriver(): string | null {
  if (args.length !== 3
    || args[0] !== "release"
    || args[1] !== "activate"
    || args[2]!.startsWith("-")) {
    return null;
  }
  return resolveReleaseActivationDriver(
    resolveYuiHome(process.env),
    args[2]!,
    fileURLToPath(import.meta.url)
  );
}

type ManagedTaskControlPlanePreflight = Readonly<{
  contract: TaskFinalReviewContract | undefined;
  controlPlane: Readonly<{
    digest: string;
    descriptor: ExactControlPlaneDescriptor;
  }> | undefined;
  /**
   * The FileTaskStore instance the exact runtime preflight already opened and
   * read. A same-Home command reuses it instead of opening a second store, so
   * the unchanged large state is not parsed twice. Its per-instance fingerprint
   * cache still invalidates on any external writer, and mutations keep their
   * unlocked re-read and revision CAS.
   */
  verifiedStore: TaskStore | undefined;
}>;

async function preflightManagedTaskControlPlane(): Promise<ManagedTaskControlPlanePreflight> {
  if (exactControlInvocation.error !== undefined) {
    throw new Error(exactControlInvocation.error);
  }
  if (taskFinalReviewInvocation.error !== undefined) {
    throw new Error(taskFinalReviewInvocation.error);
  }
  const serializedControl = process.env[YUI_CONTROL_PLANE_DESCRIPTOR];
  const serializedRuntime = process.env[YUI_TASK_RUNTIME_DESCRIPTOR];
  const exactRuntime = serializedControl !== undefined || serializedRuntime !== undefined;
  if (process.env.YUI_SESSION_SCOPE === "task" && !exactRuntime) {
    throw new Error(
      "Exact control-plane invocation requires both frozen descriptors in a managed Task runtime."
    );
  }
  if (!exactRuntime) {
    if (exactControlInvocation.digest !== undefined
      || process.env.YUI_SESSION_SCOPE === "global") {
      return await preflightManagedGlobalControlPlane(exactControlInvocation.digest);
    }
    if (taskFinalReviewInvocation.request !== undefined) {
      throw new Error(
        "Task final-review contract requires a verified exact Task control-plane invocation."
      );
    }
    return { contract: undefined, controlPlane: undefined, verifiedStore: undefined };
  }
  if (process.env.YUI_SESSION_SCOPE !== "task") {
    throw new Error("Exact Task control-plane invocation requires a managed Task runtime.");
  }
  if (serializedControl === undefined || serializedRuntime === undefined) {
    throw new Error("Exact control-plane invocation is required for this managed Task runtime.");
  }
  const control = parseExactControlPlaneDescriptor(serializedControl);
  const internalCallback = args[0] === "internal"
    && ["agent-host", "session-notify", "runtime-hook"].includes(args[1] ?? "");
  const home = resolveYuiHome(process.env);
  assertManagedSessionManifest(home, "task");
  if (resolve(control.yuiHome) !== resolve(home)) {
    throw new Error("Managed Task control-plane descriptor belongs to another YUI_HOME.");
  }
  const frozenDigest = exactControlPlaneDigest(control);
  const exactCommand = internalCallback || exactControlInvocation.digest !== undefined;
  let commandControl: ExactControlPlaneDescriptor;
  let digest: string;
  if (exactCommand) {
    digest = exactControlInvocation.digest ?? frozenDigest;
    await assertExactControlPlanePreflight({
      serializedDescriptor: serializedControl,
      digest,
      actualExecutable: process.execPath,
      actualCliEntry: fileURLToPath(import.meta.url),
      actualHome: home
    }, {
      // Provider callbacks must remain able to append their immutable inbox fact
      // while the Controller is offline. They still validate executable, CLI,
      // Home, schema, and the exact Task runtime envelope first.
      checkController: !internalCallback
    });
    commandControl = control;
  } else {
    await assertCompatibleControlPlanePreflight({ actualHome: home });
    // Package/build identity is deliberately not part of ordinary Session
    // continuity. Keep contracts on the Session's frozen digest while the
    // current CLI is proven protocol/storage compatible.
    commandControl = control;
    digest = frozenDigest;
  }
  const runtime = assertExactTaskRuntimeEnvironment(
    serializedRuntime,
    process.env,
    frozenDigest,
    control.yuiHome
  );
  const runtimeDriverCallback = args[0] === "internal"
    && args[1] === "runtime-hook"
    && process.env.YUI_DRIVER_ID !== undefined
    ? builtinAgentDriverRegistry().require(process.env.YUI_DRIVER_ID)
    : undefined;
  const preallocatedDriverCallback = runtimeDriverCallback
    ?.capabilities.observation.sessionBootstrap === "preallocated";
  const verifiedStore = openCompatibleFileTaskStore(control.yuiHome);
  assertExactTaskRuntimeState(
    runtime,
    verifiedStore,
    preallocatedDriverCallback
      ? {
          preallocatedDriverSessionReservation: {
            yuiHome: control.yuiHome,
            adapterId: runtimeDriverCallback.adapterId
          }
        }
      : {}
  );
  const request = taskFinalReviewInvocation.request;
  if (request === undefined) {
    return {
      contract: undefined,
      controlPlane: { digest, descriptor: commandControl },
      verifiedStore
    };
  }
  if (runtime.roleName !== "leader") {
    throw new Error("Only the exact Task Leader invocation may establish a final-review contract.");
  }
  if (request.taskId !== runtime.taskId) {
    throw new Error(
      `Task final-review contract Task id mismatch: expected ${runtime.taskId}, found ${request.taskId}.`
    );
  }
  const recordedContract = resolveRecordedTaskFinalReviewContract(
    runtime.taskId,
    verifiedStore.listWorkItems(runtime.taskId),
    verifiedStore.listReviewRounds(runtime.taskId),
    verifiedStore.listEvents(runtime.taskId)
  )?.effective;
  if (recordedContract !== undefined
    && recordedContract.reviewerRoleName !== request.reviewerRoleName) {
    throw new Error(
      `Task final-review Reviewer mismatch: expected ${recordedContract.reviewerRoleName}, `
        + `found ${request.reviewerRoleName}.`
    );
  }
  return {
    contract: createTaskFinalReviewContract({
      taskId: runtime.taskId,
      reviewerRoleName: request.reviewerRoleName,
      // Once Task evidence establishes a contract, a compatible Session or
      // CLI replacement presents that same capability. Package/build identity
      // must not force a release rebind or invalidate delivery evidence.
      controlPlaneDigest: recordedContract?.controlPlaneDigest ?? digest
    }),
    controlPlane: { digest, descriptor: commandControl },
    verifiedStore
  };
}

async function preflightManagedGlobalControlPlane(
  digest?: string
): Promise<ManagedTaskControlPlanePreflight> {
  if (process.env.YUI_SESSION_SCOPE !== "global") {
    throw new Error("Exact Task control-plane invocation requires its frozen runtime descriptors.");
  }
  if (taskFinalReviewInvocation.request !== undefined) {
    throw new Error(
      "Task final-review contract establishment requires a verified exact Task control-plane invocation."
    );
  }
  const manifestPath = process.env.YUI_SESSION_MANIFEST;
  if (manifestPath === undefined) {
    throw new Error("Managed global control-plane invocation requires its Session Manifest.");
  }
  const home = resolveYuiHome(process.env);
  const manifest = assertManagedSessionManifest(home, "global");
  const expectedRoleKind = process.env.YUI_ROLE === "operator" ? "operator" : "global";
  if (manifest.owner.scope !== "global"
    || manifest.roleKind !== expectedRoleKind) {
    throw new Error("Managed global invocation does not match its Session Manifest.");
  }
  const serializedDescriptor = readFileSync(manifest.controlPlane.descriptorPath, "utf8");
  const descriptor = parseExactControlPlaneDescriptor(serializedDescriptor);
  if (resolve(descriptor.yuiHome) !== resolve(home)) {
    throw new Error("Managed global control-plane descriptor belongs to another YUI_HOME.");
  }
  const frozenDigest = exactControlPlaneDigest(descriptor);
  if (frozenDigest !== manifest.controlPlane.digest
    || resolve(manifest.controlPlane.descriptorPath) !== resolve(
      join(descriptor.yuiHome, "runtime", "control-plane", `${frozenDigest}.json`)
    )
    || resolve(manifestPath) !== resolve(
      join(descriptor.yuiHome, "runtime", "session-manifests", `${manifest.digest}.json`)
    )) {
    throw new Error("Exact global Session Manifest does not match its control-plane descriptor.");
  }
  let commandControl: ExactControlPlaneDescriptor;
  let commandDigest: string;
  if (digest !== undefined) {
    await assertExactControlPlanePreflight({
      serializedDescriptor,
      digest,
      actualExecutable: process.execPath,
      actualCliEntry: fileURLToPath(import.meta.url),
      actualHome: home
    });
    commandControl = descriptor;
    commandDigest = digest;
  } else {
    await assertCompatibleControlPlanePreflight({ actualHome: home });
    commandControl = currentInvocationControlPlane(home);
    commandDigest = exactControlPlaneDigest(commandControl);
  }
  return {
    contract: undefined,
    controlPlane: { digest: commandDigest, descriptor: commandControl },
    verifiedStore: openCompatibleFileTaskStore(home)
  };
}

function currentInvocationControlPlane(home: string): ExactControlPlaneDescriptor {
  return createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry: fileURLToPath(import.meta.url),
    yuiHome: home
  });
}

function assertManagedSessionManifest(
  home: string,
  scope: "global" | "task"
) {
  const manifestPath = process.env.YUI_SESSION_MANIFEST;
  if (manifestPath === undefined) {
    throw new Error("Managed control-plane invocation requires its Session Manifest.");
  }
  const manifest = readSessionBootstrapManifest(manifestPath);
  if (manifest.owner.scope !== scope) {
    throw new Error("Managed invocation scope does not match its Session Manifest.");
  }
  if (scope === "task" && (
    manifest.owner.scope !== "task"
    || manifest.owner.taskId !== process.env.YUI_TASK_ID
  )) {
    throw new Error("Managed Task invocation does not match its Session Manifest owner.");
  }
  const expectedPath = resolve(
    home,
    "runtime",
    "session-manifests",
    `${manifest.digest}.json`
  );
  if (resolve(manifestPath) !== expectedPath) {
    throw new Error("Managed Session Manifest path is outside this YUI_HOME.");
  }
  return manifest;
}

function cleanupCliError(error: unknown, fallbackResource: string): CliError {
  if (error instanceof WorkspaceCleanupBlockedError) {
    return usageError(
      error.message,
      undefined,
      cleanupBlockedDetails(error.reason, error.resource, error.retryable)
    );
  }
  return new CliError(
    "RUNTIME_ERROR",
    error instanceof Error ? error.message : String(error),
    undefined,
    cleanupBlockedDetails("cleanup-failed", fallbackResource, true)
  );
}

function cleanupBlockedDetails(
  reason: string,
  resource: string,
  retryable: boolean
): Readonly<Record<string, unknown>> {
  return {
    status: "blocked",
    blockedBy: [{ resource, reason, retryable }],
    remainingResources: [resource],
    retryable
  };
}

function cliWorkItemReference(
  value: string,
  environment: NodeJS.ProcessEnv
) {
  try {
    return resolveTaskRecordReference(value, {
      kind: "workItem",
      label: "Work Item reference",
      ...(environment.YUI_TASK_ID === undefined
        ? {}
        : { contextTaskId: environment.YUI_TASK_ID })
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

function cliTaskRecordReference(
  value: string,
  kind: "agentRun" | "reviewRound",
  environment: NodeJS.ProcessEnv
) {
  try {
    return resolveTaskRecordReference(value, {
      kind,
      label: kind === "agentRun" ? "Agent Run reference" : "ReviewRound reference",
      ...(environment.YUI_TASK_ID === undefined
        ? {}
        : { contextTaskId: environment.YUI_TASK_ID })
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

async function candidateSnapshotForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv,
  taskFinalReviewContract?: TaskFinalReviewContract
) {
  if (args[0] !== "task") return undefined;
  const reviewableCandidateCommand = (
    args[1] === "run" && args[2] === "yield" && args[3] !== undefined
  ) || (
    args[1] === "work" && args[2] === "update"
    && args[3] !== undefined && args[4] === "done"
  ) || (
    args[1] === "work" && args[2] === "group" && args[3] === "resolve"
    && args[4] !== undefined
  );
  // Explicit Task-final review requests must remain independent of the
  // mutable global review trigger. Candidate snapshots are a delivery
  // boundary for every writable WorkItem, not only review-configured Tasks.
  const groupResolve = args[1] === "work" && args[2] === "group" && args[3] === "resolve";
  if (!reviewableCandidateCommand
    || (groupResolve && args.includes("--decision") && args[args.indexOf("--decision") + 1] !== "accept")) {
    return undefined;
  }
  if (args[1] === "run" && args[2] === "yield" && args[3] !== undefined) {
    const reference = cliTaskRecordReference(args[3], "agentRun", environment);
    const run = store.getAgentRun(reference.taskId, reference.localId);
    if (run === null || run.purpose !== "execution" || run.workItemId === undefined) {
      return undefined;
    }
    if (run.workspace === undefined) {
      // Gitless execution has no workspace or Git snapshot to capture. The
      // command layer still records the yielded Lane/Candidate evidence.
      return undefined;
    }
    // Group-backed Runs yield Lane evidence first; the Leader's later group
    // resolution performs the one Candidate snapshot after selected Lane
    // outputs have been materialized into the WorkItem workspace.
    if (run.executionGroupId !== undefined || run.workspace.owner.type === "execution-lane") {
      const item = store.getWorkItem(run.taskId, run.workItemId);
      const group = item === null || run.executionGroupId === undefined
        ? undefined
        : workItemExecutionGroupById(item, run.executionGroupId);
      const fixedSingleLane = group?.strategy.mode === "fixed"
        && group.strategy.count === 1
        && group.lanes.length === 1
        && group.stage === undefined
        && run.workspace.owner.type === "work-item";
      if (fixedSingleLane) return preparer.snapshotCandidateWorkspace(run.workspace);
      return undefined;
    }
    return preparer.snapshotCandidateWorkspace(run.workspace);
  }
  if (args[1] === "work" && args[2] === "update"
    && args[3] !== undefined && args[4] === "done") {
    const reference = cliWorkItemReference(args[3], environment);
    const workspace = store.getWorkItemWorkspace(reference.taskId, reference.localId);
    if (workspace === null) {
      // The exact Task-final contract intentionally supports a Leader-direct,
      // metadata-only Project Candidate. The command layer performs the full
      // Task/WorkItem/source/contract validation before any aggregate write.
      if (taskFinalReviewContract !== undefined) return undefined;
      throw usageError(
        `Reviewable direct WorkItem has no managed Candidate workspace: ${reference.localId}.`
      );
    }
    return preparer.snapshotCandidateWorkspace(workspace);
  }
  if (args[1] === "work" && args[2] === "group" && args[3] === "resolve"
    && args[4] !== undefined) {
    // The grouped accept path snapshots only after all selected Lane outputs
    // have been merged by candidateMaterializationForTaskCommand.
    return undefined;
  }
  return undefined;
}

async function candidateMaterializationForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv,
  taskFinalReviewContract?: TaskFinalReviewContract
): Promise<Awaited<ReturnType<FileTaskWorkspacePreparer["materializeExecutionGroupCandidate"]>> | undefined> {
  if (args[0] !== "task" || args[1] !== "work" || args[2] !== "group"
    || args[3] !== "resolve" || args[4] === undefined
    || !args.includes("--decision")
    || args[args.indexOf("--decision") + 1] !== "accept") return undefined;
  const reference = cliWorkItemReference(args[4], environment);
  const item = store.getWorkItem(reference.taskId, reference.localId);
  const group = item === null || item === undefined
    ? undefined
    : currentWorkItemExecutionGroup(item);
  if (item === null || item === undefined || group === undefined) return undefined;
  if (group.stage !== undefined && group.stage.stage !== "resolve") return undefined;
  // Early termination first stops never-started spend. Active stragglers are
  // deliberately retained, so the command records that stop and leaves the
  // group unresolved. Do not merge Lane output into the WorkItem Candidate
  // until those active Lanes settle and the Leader resolves the group again.
  if (args.includes("--early-stop")
    && group.lanes.some(({ status }) => status === "running")) return undefined;
  const selected = args.flatMap((value, index) => value === "--lane" && args[index + 1] !== undefined ? [args[index + 1]!] : []);
  const materializedLaneIds = selected.length === 0
    ? group.lanes
      .filter((lane) => lane.status === "yielded" || lane.status === "completed")
      .map(({ id }) => id)
    : selected;
  if (group.stage?.convergence !== undefined
    && group.stage.stage === "resolve"
    && materializedLaneIds.length !== 1) {
    throw usageError("Candidate convergence Resolve must select exactly one Lane before materialization.");
  }
  try {
    return await preparer.materializeExecutionGroupCandidate(
      item.taskId,
      item.id,
      group.id,
      materializedLaneIds
    );
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

async function prepareExecutionLaneWorkspacesForCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv
): Promise<PreparedExecutionLaneWorkspaces | undefined> {
  const isDispatch = args[0] === "task" && args[1] === "work" && args[2] === "dispatch" && args[3] !== undefined;
  const isRetry = args[0] === "task" && args[1] === "run" && args[2] === "retry" && args[3] !== undefined;
  if (!isDispatch && !isRetry) return undefined;
  const itemRef = isDispatch
    ? cliWorkItemReference(args[3]!, environment)
    : null;
  const item = itemRef === null
    ? (() => {
        const runRef = cliTaskRecordReference(args[3]!, "agentRun", environment);
        const run = store.getAgentRun(runRef.taskId, runRef.localId);
        return run?.workItemId === undefined ? null : store.getWorkItem(run.taskId, run.workItemId);
      })()
    : store.getWorkItem(itemRef.taskId, itemRef.localId);
  if (item === null) return undefined;
  const retryRun = isRetry
    ? store.getAgentRun(item.taskId, cliTaskRecordReference(args[3]!, "agentRun", environment).localId)
    : null;
  const currentGroup = currentWorkItemExecutionGroup(item);
  const group = retryRun?.executionGroupId === undefined
    ? (isDispatch && currentGroup?.resolution !== undefined ? undefined : currentGroup)
    : workItemExecutionGroupById(item, retryRun.executionGroupId);
  const roles = args.flatMap((value, index) => (
    value === "--lane-role" && args[index + 1] !== undefined
      ? [args[index + 1]!]
      : []
  ));
  const requestedStrategy = (() => {
    const index = args.indexOf("--strategy");
    const value = index < 0 ? undefined : args[index + 1];
    if (value === undefined) return undefined;
    const fixed = /^fixed:([1-9]\d*)$/u.exec(value);
    if (fixed !== null) return { mode: "fixed" as const, count: Number(fixed[1]) };
    const adaptive = /^adaptive:([1-9]\d*)$/u.exec(value);
    if (adaptive !== null) return { mode: "adaptive" as const, max: Number(adaptive[1]) };
    throw usageError(`Invalid execution strategy: ${value}.`);
  })();
  const retryLaneId = isRetry
    ? store.getAgentRun(item.taskId, cliTaskRecordReference(args[3]!, "agentRun", environment).localId)?.executionLaneId
    : undefined;
  const plan = normalizedExecutionLanePlan({
    assignee: item.assignee ?? "",
    requestedRoles: roles,
    requestedStrategy,
    existingGroup: group === undefined ? undefined : group,
    resolvedRetryGroup: isDispatch
      ? resolvedExecutionStageRetryGroup(currentGroup)
      : undefined,
    status: item.status,
    nextGroupId: `execution-group-${store.peekNextAgentRunId(item.taskId)}`,
    retryLaneId,
    phase: isRetry ? "retry" : "dispatch"
  });
  const laneRoles = plan.roles;
  if (!isRetry && laneRoles.length === 0) {
    throw usageError("At least one --lane-role is required when expanding an ExecutionGroup.");
  }
  if (group !== undefined && requestedStrategy !== undefined) {
    const same = group.strategy.mode === requestedStrategy.mode
      && (group.strategy.mode === "fixed"
        ? requestedStrategy.mode === "fixed" && group.strategy.count === requestedStrategy.count
        : requestedStrategy.mode === "adaptive" && group.strategy.max === requestedStrategy.max);
    if (!same) throw usageError(`ExecutionGroup strategy is frozen: ${group.id}.`);
  }
  const laneCount = plan.requestedCount;
  const adaptive = plan.strategy.mode === "adaptive";
  const needsIsolation = adaptive || laneCount > 1 || (group?.lanes.length ?? 0) > 1;
  if (!needsIsolation) return undefined;
  const groupId = group?.id ?? `execution-group-${store.peekNextAgentRunId(item.taskId)}`;
  const laneIds = plan.laneIds;
  // A new Group's Lanes are not yet durable, so their worktrees would be
  // unadopted between preparation and the dispatch transaction. Hold ONE
  // per-Project maintenance fence across both, so a project migrate cannot
  // switch the catalog in that gap and strand a Lane on the external
  // checkout. An existing Group's Lanes are adopted inside their own fence,
  // so no outer fence is held.
  const held = group === undefined
    ? preparer.acquireTaskProjectMaintenanceLocks(item.taskId)
    : undefined;
  const map = new Map<string, import("./worktree/managedWorkspace.js").ManagedWorkspace>();
  try {
    let projectPaths: ReadonlyMap<string, string> | undefined;
    if (held !== undefined) {
      const paths = new Map<string, string>();
      for (const { projectId } of held.current.projectBindings) {
        const project = store.getProject(projectId);
        if (project === null) throw new Error(`Project not found: ${projectId}.`);
        paths.set(projectId, project.path);
      }
      projectPaths = paths;
    }
    for (const laneId of laneIds.filter((value) => value.length > 0)) {
      map.set(laneId, await preparer.prepareExecutionLaneWorkspace(item.taskId, groupId, laneId, {
        purpose: "execution",
        workItemId: item.id
      }, held === undefined ? undefined : { current: held.current }));
    }
    return { workspaces: map, release: held?.release, projectPaths };
  } catch (error) {
    // Compensate (discard unadopted Lane worktrees) BEFORE releasing the
    // fence: a concurrent project migrate must not switch the catalog while
    // external-backed worktrees are still identifiable for removal.
    await preparer.discardUnadoptedExecutionLaneWorkspaces(map);
    if (held !== undefined) held.release();
    throw error;
  }
}

/**
 * The result of preparing a command's Execution Lane worktrees. For a new
 * (not-yet-durable) Group, `release` is the held per-Project maintenance fence
 * — the caller must keep it until the dispatch transaction adopts the
 * worktrees, then release it — and `projectPaths` is the under-fence Project
 * path snapshot the adoption CAS revalidates. Both are undefined for an
 * existing Group, whose Lanes are adopted inside their own fence.
 */
type PreparedExecutionLaneWorkspaces = Readonly<{
  workspaces: ReadonlyMap<string, import("./worktree/managedWorkspace.js").ManagedWorkspace>;
  release: (() => void) | undefined;
  projectPaths: ReadonlyMap<string, string> | undefined;
}>;

async function prepareReviewLaneWorkspaces(
  taskId: string,
  reviewRoundId: string,
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer
): Promise<ReadonlyMap<string, import("./worktree/managedWorkspace.js").ManagedWorkspace> | undefined> {
  const round = store.getReviewRound(taskId, reviewRoundId);
  const group = round?.executionGroup;
  if (round === null || round === undefined || group === undefined) return undefined;
  if (group.lanes.length < 2 && group.strategy.mode !== "adaptive") return undefined;
  const map = new Map<string, import("./worktree/managedWorkspace.js").ManagedWorkspace>();
  try {
    for (const lane of group.lanes.filter((candidate) => candidate.status === "pending" || candidate.status === "running")) {
      map.set(lane.id, await preparer.prepareExecutionLaneWorkspace(taskId, group.id, lane.id, {
        purpose: "review",
        reviewRoundId
      }));
    }
  } catch (error) {
    await preparer.discardUnadoptedExecutionLaneWorkspaces(map);
    throw error;
  }
  return map;
}

async function directTaskMainSnapshotForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv,
  taskFinalReviewContract?: TaskFinalReviewContract
) {
  if (taskFinalReviewContract === undefined
    || args[0] !== "task"
    || args[1] !== "work"
    || args[2] !== "update"
    || args[3] === undefined
    || args[4] !== "done") {
    return undefined;
  }
  const reference = cliWorkItemReference(args[3], environment);
  const item = store.getWorkItem(reference.taskId, reference.localId);
  if (item === null || item.writeProjectIds.length === 0
    || store.getWorkItemWorkspace(reference.taskId, reference.localId) !== null) {
    return undefined;
  }
  const workspace = store.getTaskWorkspace(reference.taskId);
  // Exact Task-final Candidates may intentionally be metadata-only when no
  // Task main exists. They remain review anchors, but are not eligible for the
  // direct ChangeSet capture path.
  if (workspace === null) return undefined;
  if (workspace.owner.type !== "task") {
    throw usageError(`Task has no authoritative main workspace: ${reference.taskId}.`);
  }
  try {
    return await preparer.snapshotDirectTaskMain(workspace, item.writeProjectIds);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

async function actualTaskReviewCandidateForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv
): Promise<TaskReviewCandidate | undefined> {
  if (args[0] !== "task") return undefined;
  let taskId: string | undefined;
  let decisionSupportRead = false;
  if (args[1] === "complete" && args[2] !== undefined) {
    const task = store.getTask(args[2]);
    if (task === null || task.status !== "active" || task.projectBindings.length === 0) {
      return undefined;
    }
    // Every Project-backed completion must freeze
    // a clean committed Task-main snapshot. Review policy only decides whether
    // that head also needs an independent ReviewRound.
    taskId = task.id;
  } else if (args[1] === "review"
    && args[2] === "request"
    && args[3] !== undefined) {
    taskId = store.getTask(args[3])?.id;
  } else if (args[1] === "review"
    && args[2] === "retry"
    && args[3] !== undefined) {
    const reference = cliTaskRecordReference(args[3], "reviewRound", environment);
    const round = store.getReviewRound(reference.taskId, reference.localId);
    if (round !== null && (round.scope ?? "work-item") === "task") {
      taskId = reference.taskId;
    }
  } else if (args[1] === "review"
    && args[2] === "force-fresh"
    && args[3] !== undefined) {
    const reference = cliTaskRecordReference(args[3], "reviewRound", environment);
    const round = store.getReviewRound(reference.taskId, reference.localId);
    if (round !== null && (round.scope ?? "work-item") === "task") {
      taskId = reference.taskId;
    }
  } else if (args[1] === "work"
    && args[2] === "review"
    && args[3] === "retry"
    && args[4] !== undefined) {
    const reference = cliTaskRecordReference(args[4], "reviewRound", environment);
    const round = store.getReviewRound(reference.taskId, reference.localId);
    if (round !== null && (round.scope ?? "work-item") === "task") {
      taskId = reference.taskId;
    }
  } else if (args[1] === "run"
    && (args[2] === "retry" || args[2] === "settle")
    && args[3] !== undefined) {
    const reference = cliTaskRecordReference(args[3], "agentRun", environment);
    const run = store.getAgentRun(reference.taskId, reference.localId);
    const round = run?.reviewRoundId === undefined
      ? null
      : store.getReviewRound(reference.taskId, run.reviewRoundId);
    if (run?.purpose === "review"
      && round !== null
      && (round.scope ?? "work-item") === "task") {
      taskId = reference.taskId;
    }
  } else if ((args[1] === "context" || args[1] === "next-action")
    && args[2] !== undefined) {
    taskId = store.getTask(args[2])?.id;
    decisionSupportRead = true;
  }
  if (taskId === undefined || store.getTask(taskId)?.status !== "active") return undefined;
  try {
    return await snapshotActualTaskReviewCandidate(taskId, store, preparer);
  } catch (error) {
    if (decisionSupportRead && error instanceof CliError) return undefined;
    throw error;
  }
}

async function snapshotActualTaskReviewCandidate(
  taskId: string,
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer
): Promise<TaskReviewCandidate> {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.projectBindings.length === 0) {
    throw usageError(`Final Task Review requires a Project-backed Task: ${task.id}.`);
  }
  const workspace = store.getTaskWorkspace(task.id);
  if (workspace === null
    || workspace.owner.type !== "task"
    || workspace.owner.taskId !== task.id) {
    throw usageError(`Task has no authoritative main workspace: ${task.id}.`);
  }
  try {
    const snapshot = await preparer.snapshotDirectTaskMain(
      workspace,
      task.projectBindings.map(({ projectId }) => projectId)
    );
    const heads = new Map(snapshot.projects.map(({ projectId, headCommit }) => (
      [projectId, headCommit]
    )));
    return {
      schemaVersion: 1,
      projects: task.projectBindings.map(({ projectId }) => {
        const commit = heads.get(projectId);
        if (commit === undefined) {
          throw new Error(`Task main snapshot omitted Project ${projectId}.`);
        }
        return { projectId, commit };
      })
    };
  } catch (error) {
    throw usageError(
      `Actual Task Project head verification failed for ${task.id}: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Issue 07: computes the delta-recheck assessment for `task review request
 * --delta-recheck`.  Runs only for that exact command; every other command
 * returns undefined. Technical evidence boundaries fail closed here; semantic
 * risk remains a Leader and Project-policy decision.
 */
async function deltaRecheckPreflightForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  actualTaskReviewCandidate: TaskReviewCandidate | undefined
): Promise<DeltaRecheckPreflight | undefined> {
  if (args[0] !== "task" || args[1] !== "review" || args[2] !== "request") {
    return undefined;
  }
  if (!args.includes("--delta-recheck")) return undefined;
  const taskId = args[3];
  if (taskId === undefined) return undefined;
  const task = store.getTask(taskId);
  if (task === null || task.status !== "active") return undefined;
  if (actualTaskReviewCandidate === undefined) return undefined;
  // The previous Round is the latest completed Task-final Round that accepted
  // a head (a full Review or an equivalent-and-accepted delta).  A
  // non-accepted delta cannot be the base for a new delta.
  const previous = [...store.listReviewRounds(task.id)]
    .filter((round) => isAcceptedTaskReviewBaseline(store, round))
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
    .at(-1);
  if (previous === undefined) {
    throw usageError(
      "Delta-recheck requires a previous completed Task-final Review that accepted a head."
    );
  }
  const repositoryPaths: Record<string, string> = {};
  for (const candidateProject of actualTaskReviewCandidate.projects) {
    const project = store.getProject(candidateProject.projectId);
    if (project === null) {
      throw usageError(`Delta-recheck Project not found: ${candidateProject.projectId}.`);
    }
    repositoryPaths[candidateProject.projectId] = project.path;
  }
  const assessment = await assessDeltaRecheck({
    repositoryPaths,
    previousRound: previous,
    candidate: actualTaskReviewCandidate,
    git: new NodeGitWorkspace()
  });
  if (assessment.kind === "ineligible") {
    throw usageError(
      `Delta-recheck is technically unavailable: ${assessment.reason}`
    );
  }
  return assessment.preflight;
}

async function reviewWorkspaceResultForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv
) {
  if (args[0] !== "task" || args[1] !== "run" || args[2] !== "yield"
    || args[3] === undefined) return undefined;
  const reference = cliTaskRecordReference(args[3], "agentRun", environment);
  const run = store.getAgentRun(reference.taskId, reference.localId);
  if (run === null || run.purpose !== "review" || run.reviewRoundId === undefined) {
    return undefined;
  }
  return preparer.snapshotReviewRunResult(reference.taskId, run);
}

async function executionLaneGitSnapshotForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv
) {
  if (args[0] !== "task" || args[1] !== "run" || args[2] !== "yield"
    || args[3] === undefined) return undefined;
  const reference = cliTaskRecordReference(args[3], "agentRun", environment);
  const run = store.getAgentRun(reference.taskId, reference.localId);
  if (run === null || run.executionGroupId === undefined
    || run.executionLaneId === undefined
    // Review output has a distinct evidence contract: diagnostic work may
    // remain uncommitted, and snapshotReviewRunResult validates its exact
    // ReviewRound/Lane owner. It must not also pass the Develop Candidate
    // snapshot preflight, which requires a clean committed worktree.
    || run.purpose === "review") {
    return undefined;
  }
  if (run.workspace === undefined) return null;
  const stored = store.getManagedWorkspace(run.workspace.owner);
  if (stored === null || !isDeepStrictEqual(stored, run.workspace)) {
    throw usageError(`Execution Lane managed workspace changed before yield: ${run.id}.`);
  }
  // A Gitless fixed(1) Lane runs from the durable Task-owned empty view. It
  // has no writable Project boundary, so there is no Lane Git snapshot to
  // freeze; keep the normal Candidate path metadata-only.
  if (run.workspace.owner.type === "task" && run.workspace.entries.length === 0) {
    return null;
  }
  try {
    return (await preparer.snapshotExecutionLaneWorkspace(run.workspace)) ?? null;
  } catch (error) {
    throw usageError(
      `Execution Lane Git snapshot preflight failed for ${run.id}: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function reviewRoundFromCommandData(data: unknown): Readonly<{
  id: string;
  taskId: string;
  reviewerRoleName: string;
  status: string;
}> | undefined {
  if (typeof data !== "object" || data === null || !("reviewRound" in data)) return undefined;
  const round = (data as { reviewRound?: unknown }).reviewRound;
  if (typeof round !== "object" || round === null) return undefined;
  const value = round as {
    id?: unknown;
    taskId?: unknown;
    reviewerRoleName?: unknown;
    status?: unknown;
  };
  return typeof value.id === "string"
    && typeof value.taskId === "string"
    && typeof value.reviewerRoleName === "string"
    && typeof value.status === "string"
    ? {
        id: value.id,
        taskId: value.taskId,
        reviewerRoleName: value.reviewerRoleName,
        status: value.status
      }
    : undefined;
}

async function executeOperatorSessionControl(
  control: OperatorSessionControl,
  home: string,
  store: TaskStore,
  runtime: FileTaskWorkflowRuntime,
  tmux: TmuxManager,
  catalogs: AgentConfigurationCatalogService
): Promise<void> {
  if (jsonOutput) throw usageError("Operator new and resume do not support --json.");
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw usageError("Operator new and resume require an interactive terminal.");
  }
  const role = store.getGlobalRole("operator");
  if (role === null) throw usageError("Operator is not configured. Run yui setup first.");
  const sessionSet = store.getGlobalRoleSessionSet(role.name);
  const active = sessionSet?.sessions[sessionSet.activeAgentId];
  const paneRunning = tmux.detectRoleStatus("operator", "operator") === "running";
  if (paneRunning && active === undefined) {
    throw usageError(
      "Operator is running but its native session has not been recorded yet. "
      + "Wait for the first turn to settle before switching sessions."
    );
  }
  if (
    control.action === "resume"
    && paneRunning
    && control.targetAgentId === active?.agentId
    && active !== undefined
    && operatorSessionRef(active) === control.ref
  ) {
    tmux.attachRole("operator", "operator", "auto");
    return;
  }

  const handle = terminalIo();
  try {
    if (control.targetAgentId !== role.activeAgentId) {
      const binding = role.agentBindings[control.targetAgentId];
      if (binding === undefined) {
        throw usageError(`Operator Agent is not bound: ${control.targetAgentId}.`);
      }
      handle.io.write([
        `Switching to ${adapterLabel(binding.adapterId)} (${binding.agentId})`,
        "",
        "Saved configuration",
        `  Model   ${binding.config.model ?? "CLI default"}`,
        `  Effort  ${binding.config.effort ?? "CLI default"}`,
        ""
      ].join("\n"));
      const update = (await handle.io.question(
        "Update this configuration? [y/N]: "
      ))?.trim().toLowerCase();
      if (update === "y" || update === "yes") {
        const resolution = await resolveGlobalRoleAgentConfigurationArguments(
          role.name,
          binding.agentId,
          selectionPorts(store, catalogs),
          handle.io
        );
        if (resolution.kind !== "resolved") {
          process.stdout.write("Cancelled.\n");
          return;
        }
        const updated = runGlobalRoleCommand(
          resolution.args.slice(2),
          store as unknown as Parameters<typeof runGlobalRoleCommand>[1],
          { yuiHome: home, env: process.env }
        );
        if (typeof updated !== "string") {
          throw new Error("Operator Agent configuration returned an invalid control result.");
        }
        handle.io.write(`\nUpdated ${adapterLabel(binding.adapterId)} configuration.\n`);
      }
    }
    if (paneRunning) {
      const answer = (await handle.io.question(
        "Operator is running. Switch session? [y/N]: "
      ))?.trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write("Cancelled.\n");
        return;
      }
    }
  } finally {
    handle.close();
  }

  await ensureFileTaskController(home, { environment: process.env });
  if (
    paneRunning
    || (
      active !== undefined
      && active.status !== "stopped"
      && active.status !== "broken"
    )
  ) {
    await runtime.stopGlobalRoleSession(role.name);
  }
  applyOperatorSessionControl(control, store);
  await runtime.prepareGlobalRoleEnter(role.name);
  tmux.attachRole("operator", role.name, "auto");
}

function adapterLabel(adapterId: string): string {
  return adapterId === "codex"
    ? "Codex"
    : adapterId === "claude"
      ? "Claude"
      : adapterId;
}

function renderControllerResult(method: "stop" | "restart", value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const result = value as Record<string, unknown>;
  if (method === "restart") {
    const previousPid = Number.isSafeInteger(result.previousPid) ? String(result.previousPid) : undefined;
    const pid = Number.isSafeInteger(result.pid) ? String(result.pid) : undefined;
    if (previousPid !== undefined && pid !== undefined) {
      return `Controller restarted (PID ${previousPid} -> ${pid}). tmux sessions were not stopped.`;
    }
    return pid === undefined
      ? "Controller restarted. tmux sessions were not stopped."
      : `Controller started (PID ${pid}). tmux sessions were not stopped.`;
  }
  return result.stopped === true
    ? "Controller stopped."
    : "Controller was already stopped.";
}

async function completionCommand(
  home: string,
  node: import("./cli/commandCatalog.js").CommandNode
): Promise<void> {
  if (args[2] === "candidates") {
    const separator = args.indexOf("--", 4);
    const prefix = args[3];
    if (prefix === undefined || separator !== 4) {
      throw usageError(
        "Completion candidates usage: yui config completion candidates <prefix> -- <words...>"
      );
    }
    const candidates = await resolveCompletionCandidates({
      current: prefix,
      words: args.slice(separator + 1),
      ports: completionSelectionPorts(home)
    });
    process.stdout.write(candidates.length === 0 ? "" : `${candidates.join("\n")}\n`);
    return;
  }

  if (jsonOutput) throw usageError("Completion configuration does not support --json.");
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw usageError("Completion configuration requires an interactive terminal.");
  }
  const shell = completionShell(args[2]);
  if (args.length > (shell === undefined ? 2 : 3)) {
    throw usageError("Completion usage: yui config completion [bash|zsh|fish]");
  }
  const store = openCompatibleFileTaskStore(home);
  const ioHandle = terminalIo();
  try {
    const manager = new FileCompletionManager(store, process.env, resolveCliIdentity(process.env));
    emit(await runCompletionWizard(
      manager,
      ioHandle.io,
      shell === undefined ? {} : { shell }
    ));
  } finally {
    ioHandle.close();
  }
  void node;
}

function completionShell(value: string | undefined): "bash" | "zsh" | "fish" | undefined {
  if (value === undefined) return undefined;
  if (value === "bash" || value === "zsh" || value === "fish") return value;
  throw usageError("Completion shell must be one of bash, zsh, fish.");
}

async function resolveTerminalArguments(
  commandArgs: readonly string[],
  node: import("./cli/commandCatalog.js").CommandNode,
  store: TaskStore,
  catalogs: AgentConfigurationCatalogService
): Promise<string[] | null> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive || !allowsInteractiveSelection(commandArgs, jsonOutput)) {
    return [...commandArgs];
  }
  const handle = terminalIo();
  try {
    const ports = selectionPorts(store, catalogs);
    const operatorWizard = await resolveOperatorWizardArguments(
      commandArgs,
      store.getGlobalRole("operator"),
      listOperatorSessions(store.getGlobalRoleSessionSet("operator")),
      handle.io
    );
    if (operatorWizard.kind === "cancelled") return null;
    const operatorArgs = operatorWizard.args;
    // Global Role add owns its Agent choice so the configured default can be
    // shown explicitly. Other commands first resolve missing positional
    // targets through the generic selector, then enter the focused Role UI.
    if (
      (operatorArgs[0] === "config" && operatorArgs[1] === "role" && operatorArgs[2] === "add")
      || (operatorArgs[0] === "task" && operatorArgs[1] === "role" && operatorArgs[2] === "add")
    ) {
      const wizard = await resolveRoleWizardArguments(operatorArgs, ports, handle.io);
      if (wizard.kind === "cancelled") return null;
      const selected = await resolveInteractiveArguments(wizard.args, node, ports, handle.io);
      return selected.kind === "cancelled" ? null : selected.args;
    }
    const selected = await resolveInteractiveArguments(operatorArgs, node, ports, handle.io);
    if (selected.kind === "cancelled") return null;
    const roleWizard = await resolveRoleWizardArguments(selected.args, ports, handle.io);
    return roleWizard.kind === "cancelled" ? null : roleWizard.args;
  } finally {
    // The Agent process must be the only reader of stdin after Role enter.
    handle.close();
  }
}

function terminalIo(): Readonly<{ io: SelectionIo; close(): void }> {
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return {
    io: {
      interactive: true,
      json: jsonOutput,
      width: process.stdout.columns ?? 100,
      write: (value) => { process.stdout.write(value); },
      question: async (prompt) => {
        try {
          return await readline.question(prompt);
        } catch (error) {
          if (error instanceof Error && (
            error.name === "AbortError"
            || ("code" in error && error.code === "ERR_USE_AFTER_CLOSE")
          )) return undefined;
          throw error;
        }
      }
    },
    close: () => { readline.close(); }
  };
}

function selectionPorts(
  store: TaskStore,
  catalogs: AgentConfigurationCatalogService
): SelectionPorts {
  return {
    call: (method, params) => selectionCall(store, catalogs, method, params)
  };
}

async function preflightAgentConfigurationMutation(
  commandArgs: readonly string[],
  store: TaskStore,
  catalogs: AgentConfigurationCatalogService
): Promise<void> {
  if (!hasModelOrEffortMutation(commandArgs)) return;
  const agentId = configurationMutationAgentId(commandArgs, store);
  if (agentId === undefined) return;
  const agent = store.getConfiguredAgent(agentId);
  if (agent === null) return;
  await catalogs.resolve({
    agent,
    cwd: store.getConfig().defaultWorkspace ?? process.cwd()
  });
}

function hasModelOrEffortMutation(args: readonly string[]): boolean {
  const operation = (args[0] === "config" && args[1] === "role")
    || (args[0] === "task" && args[1] === "role");
  return operation && [
    "--model", "--effort", "--clear-model", "--clear-effort"
  ].some((option) => args.includes(option));
}

function configurationMutationAgentId(
  args: readonly string[],
  store: TaskStore
): string | undefined {
  const explicit = optionValue(args, "--agent");
  if (explicit !== undefined) return explicit;
  if (args[0] === "config" && args[1] === "role" && args[2] === "update") {
    return store.getGlobalRole(args[3] ?? "")?.activeAgentId;
  }
  if (args[0] === "task" && args[1] === "role") {
    if (args[2] === "add") return store.getConfig().defaultAgent;
    if (args[2] === "update") {
      return store.getRole(args[3] ?? "", args[4] ?? "")?.activeAgentId;
    }
  }
  return undefined;
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.lastIndexOf(option);
  const value = index < 0 ? undefined : args[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : undefined;
}

function selectionCall(
  store: TaskStore,
  catalogs: AgentConfigurationCatalogService,
  method: string,
  params: Readonly<Record<string, unknown>>
): unknown {
  const reader = store as unknown as Record<string, (...args: never[]) => unknown>;
  switch (method) {
    case "agent.list": return store.listConfiguredAgents();
    case "agent.capabilities": {
      const agent = store.getConfiguredAgent(String(params.agentId ?? ""));
      if (agent === null) return null;
      const configuredWorkspace = store.getConfig().defaultWorkspace;
      const cwd = typeof params.cwd === "string" && params.cwd.length > 0
        ? params.cwd
        : configuredWorkspace ?? process.cwd();
      const config = typeof params.config === "object" && params.config !== null
        ? params.config as RoleAgentConfig
        : undefined;
      return catalogs.resolve({
        agent,
        cwd,
        ...(config === undefined ? {} : { config })
      });
    }
    case "config.get": return store.getConfig();
    case "profile.list": return store.listAgentProfiles();
    case "profile.show": return store.getAgentProfile(String(params.id ?? ""));
    case "role.list": return store.listGlobalRoles();
    case "role.show": return store.getGlobalRole(String(params.name ?? ""));
    case "project.list": return callOptional(reader, "listProjects");
    case "task.list": return callOptional(reader, "listTasks");
    case "task.integration.list": return store.listIntegrationAttempts(String(params.taskId ?? ""));
    case "task.change-set.list": return store.listChangeSets(String(params.taskId ?? ""));
    case "task.role.list": return callOptional(reader, "listRoles", [params.taskId]);
    case "task.role.show": return callOptional(reader, "getRole", [params.taskId, params.roleName]);
    case "task.work.list": return callOptional(reader, "listWorkItems", [params.taskId]);
    case "task.input.list": {
      const taskId = typeof params.taskId === "string" ? params.taskId : undefined;
      const requests = taskId === undefined
        ? store.listAllInputRequests()
        : store.listInputRequests(taskId);
      return params.all === true ? requests : requests.filter((request) => request.status === "open");
    }
    case "task.run.list": return callOptional(reader, "listAgentRuns", [params.taskId]);
    case "task.decision.list": return callOptional(reader, "listDecisions", [params.taskId]);
    case "task.milestone.list": return presentSelectionTimes(
      callOptional(reader, "listMilestones", [params.taskId]),
      store
    );
    case "task.event.list": return presentSelectionTimes(
      callOptional(reader, "listEvents", [params.taskId]),
      store
    );
    case "jobs.list": return callOptional(reader, "listJobs");
    default: return [];
  }
}

function presentSelectionTimes(value: unknown, store: TaskStore): unknown {
  if (!Array.isArray(value)) return value;
  const timeZone = store.getConfig().timeZone;
  return value.map((record) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) return record;
    const candidate = record as Record<string, unknown>;
    return typeof candidate.createdAt === "string"
      ? {
          ...candidate,
          createdAt: formatTimestamp(candidate.createdAt, timeZone)
        }
      : candidate;
  });
}

function callOptional(
  reader: Record<string, (...args: never[]) => unknown>,
  method: string,
  args: unknown[] = []
): unknown {
  const operation = reader[method];
  return operation === undefined ? [] : Reflect.apply(operation, reader, args);
}

function readableStore(home: string): TaskStore {
  return openCompatibleFileTaskStore(home);
}

function completionSelectionPorts(home: string): SelectionPorts {
  if (inspectStorageSchema(home).status === "uninitialized") {
    return { call: () => [] };
  }
  const store = readableStore(home);
  return selectionPorts(
    store,
    new AgentConfigurationCatalogService(home, { environment: process.env })
  );
}

function emit(output: string, literal = false, data?: unknown): void {
  const normalized = literal ? output.trimEnd() : output.trimEnd();
  process.stdout.write(`${jsonOutput
    ? JSON.stringify(data === undefined
        ? { ok: true, output: normalized }
        : { ok: true, data })
    : normalized}\n`);
}

function withControllerRefreshWarning(
  output: string,
  refresh: RunningControllerRefreshResult,
  label: string
): string {
  if (refresh.status !== "failed") return output;
  if (label === "Agent environment") {
    return `${output.trimEnd()}\nWarning: Agent configuration was saved, but its current `
      + `environment values were not applied or persisted (${refresh.message}). Retry the `
      + "Agent command with those variables present, or restart the Controller from an "
      + "environment that provides them.\n";
  }
  return `${output.trimEnd()}\nWarning: ${label} was saved, but the running Controller `
    + `could not be refreshed (${refresh.message}). Restart the Controller to apply it.\n`;
}

function agentEnvironmentRefreshScope(
  previous: ConfiguredAgent | null,
  current: ConfiguredAgent | null,
  configured: readonly ConfiguredAgent[]
): Readonly<{ sourceNames: readonly string[]; nativeNames: readonly string[] }> {
  const retainedSources = new Set(configured.flatMap((agent) => (
    agent.environment.map((binding) => binding.sourceName)
  )));
  const retainedNative = new Set(configured.flatMap((agent) => (
    nativeAgentEnvironmentNames(agent.adapterId)
  )));
  const currentSources = current?.environment.map((binding) => binding.sourceName) ?? [];
  const previousOnlySources = previous?.environment
    .map((binding) => binding.sourceName)
    .filter((name) => !retainedSources.has(name)) ?? [];
  const currentNative = current === null ? [] : nativeAgentEnvironmentNames(current.adapterId);
  const previousOnlyNative = previous === null
    ? []
    : nativeAgentEnvironmentNames(previous.adapterId).filter((name) => !retainedNative.has(name));
  return {
    sourceNames: [...new Set([...currentSources, ...previousOnlySources])],
    nativeNames: [...new Set([...currentNative, ...previousOnlyNative])]
  };
}

export function cliIdentity(env: NodeJS.ProcessEnv): CliIdentity {
  return env.YUI_CLI_NAME === "yui-dev" ? "yui-dev" : "yui";
}

function normalizeAliases(input: readonly string[]): string[] {
  const normalized = [...input];
  if (normalized.length === 1 && (normalized[0] === "-v" || normalized[0] === "--version")) {
    return ["version"];
  }
  const help = normalized.findIndex((argument) => argument === "-h" || argument === "--help");
  return help === normalized.length - 1 ? ["help", ...normalized.slice(0, help)] : normalized;
}

export { renderCompletion };
