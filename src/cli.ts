#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { recordTaskInterruptResult } from "./message/taskInterrupt.js";
import { agentAdapterLabel as adapterLabel } from "./agent/adapterCatalog.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { renderCommandHelp } from "./cli/helpRenderer.js";
import { describeCommandTree, findCommandNode } from "./cli/commandCatalog.js";
import { routeInvocation } from "./cli/invocationRouter.js";
import { renderCompletion, type CliIdentity } from "./cli/completion.js";
import { resolveCompletionCandidates } from "./cli/dynamicCompletion.js";
import { recordGlobalInterruptResult, recordGlobalSteerResult } from "./message/globalInterrupt.js";
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
import { runCapabilityCommand } from "./commands/capabilityCommands.js";
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
import {
  previewProfileAgentConfigurationMutation,
  runProfileCommand
} from "./commands/profileCommands.js";
import {
  assertWorkItemDependenciesCompletedForCommand,
  requireWorkItemAssignee,
  dispatchPreparedReviewRound,
  failPendingReviewRound,
  preserveReviewRoundWorkspace,
  parseTaskCompletionRequest,
  previewTaskRoleAgentConfigurationMutation,
  preflightTaskCompletion,
  runTaskCommand,
  planReplicatedWorkItemLanes,
  validateTaskArchiveRequest,
  parseTaskArchiveArguments
} from "./commands/taskCommands.js";
import {
  assertTaskRemoteDeliveryIntegrated,
  createTaskRemoteDeliveryProof,
  type TaskRemoteDeliveryProof
} from "./commands/taskRemoteDeliveryCommand.js";
import { renderArchiveDiagnostics, taskArchiveDiagnostics } from "./task/archiveDiagnostics.js";
import { inspectTaskArchive, renderTaskArchivePreflight } from "./task/archivePreflight.js";
import { CleanupInspectionError } from "./workspace/cleanupInspection.js";
import { runTaskPublicationVerifyCommand } from "./commands/taskPublicationVerifyCommand.js";
import { createGitHubCliPublicationVerifier } from "./external/githubPublicationVerifier.js";
import { createGitLabCliPublicationVerifier } from "./external/gitlabPublicationVerifier.js";
import { taskLocalActor, assertTaskDeliveryAuthority } from "./commands/taskActor.js";
import {
  saveArtifactCapability, readArtifactCapability, listArtifactsCapability
} from "./artifacts/artifactCapability.js";
import {
  parseTaskExecutionStartRequest,
  parseTaskExecutionStopRequest,
  finalizeStoppedTaskExecution,
  startTaskExecutionCommand,
  stopTaskExecutionCommand
} from "./commands/taskExecutionCommands.js";
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
import {
  agentNotFound,
  CliError,
  runtimeError,
  usageError
} from "./errors/cliError.js";
import { FileRoleLaunchPlanner } from "./executor/fileRoleLaunchPlanner.js";
import {
  AGENT_HOST_CONTROL_PROTOCOL,
  inspectAgentHost,
  runAgentHost,
  sendAgentHostAuthorityControl,
  sendAgentHostSteerControl,
  sendAgentHostCancelControl,
  foldSteerLiveReceipt,
  foldInterruptLiveReceipt,
  type AgentHostControlResult,
  type SteerLiveReceipt,
  type InterruptLiveReceipt
} from "./runtime/agentHost.js";
import {
  unknownAgentRunConfiguration,
  type AgentRunConfigurationObservation
} from "./runtime/agentRunConfiguration.js";
import type { TaskRoleHostObservation } from "./commands/taskRoleRuntimeStatus.js";
import {
  TaskWorkspaceCoordinator,
  WorkspaceCleanupBlockedError
} from "./repository/taskWorkspaceCoordinator.js";
import {
  FileTaskWorkspacePreparer,
  type TaskWorkspaceActivation
} from "./repository/taskWorkspacePreparer.js";
import { snapshotWorkItemCandidate } from "./repository/workItemCandidateSnapshot.js";
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
  openCurrentTaskStore,
  validateCurrentTaskStore
} from "./storage/currentTaskStore.js";
import { resolveTaskRecordReference } from "./task/taskRecordReference.js";
import { runSetupCommand, validateSetupInvocation } from "./setup/setupCommand.js";
import { NodeCommandExecutor } from "./tmux/commandExecutor.js";
import { TmuxManager } from "./tmux/tmuxManager.js";
import { WorkItemChangeSetManager } from "./workspace/workItemChangeSetManager.js";
import { workspaceProjectEntry } from "./worktree/managedWorkspace.js";
import { parseWebCommandOptions } from "./web/webServer.js";
import {
  AgentConfigurationCatalogService,
  validateAgentLaunchConfiguration
} from "./executor/agentConfigurationCatalog.js";
import type { RoleAgentConfig } from "./executor/agentAdapter.js";
import {
  resolveAgentProfileView
} from "./profile/agentProfileRuntime.js";
import type { AgentProfile } from "./profile/agentProfile.js";
import {
  listOperatorSessions,
  operatorSessionRef
} from "./operator/operatorSessionHistory.js";
import { YUI_VERSION, yuiVersionIdentity } from "./version.js";
import { SqliteSchemaMigrationError } from "./storage/sqliteSchema.js";
import {
  assertRuntimeCoherence
} from "./runtime/runtimeCoherence.js";
import {
  requireManagedTaskCaller,
  resolveManagedTaskReader
} from "./runtime/managedCaller.js";
import { operatorOfflineCommand, taskDiagnosticTarget } from "./cli/managedDiagnostics.js";
import {
  readSessionBootstrapManifest,
  refreshManagedSessionCliWrappers,
  type SessionEntryPoint
} from "./context/sessionBootstrapManifest.js";
import {
  createTaskFinalReviewContract,
  extractTaskFinalReviewRequest,
  type TaskFinalReviewContract
} from "./review/taskFinalReviewContract.js";
import { resolveRecordedTaskFinalReviewContract } from "./review/taskFinalReviewContractResolution.js";
import type { TaskReviewCandidate } from "./review/reviewRound.js";
import { assessDeltaRecheck, type DeltaRecheckPreflight } from "./review/deltaRecheck.js";
import { isCompletedTaskReviewEvidence } from "./review/reviewAcceptance.js";
import { NodeGitWorkspace } from "./repository/gitWorkspace.js";
import {
  currentWorkItemExecutionGroup,
  type WorkItem
} from "./workItem/workItem.js";

const VERSION = YUI_VERSION;
const taskFinalReviewInvocation = extractTaskFinalReviewRequest(process.argv.slice(2));
const rawArgs = [...taskFinalReviewInvocation.args];
const jsonOutput = rawArgs.includes("--json");
const args = normalizeAliases(
  jsonOutput ? rawArgs.filter((argument) => argument !== "--json") : rawArgs
);

void main().catch((error: unknown) => {
  if (error instanceof CleanupInspectionError) {
    error = cleanupCliError(error, error.checks[0]?.resource ?? "workspace");
  }
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
    || process.env.YUI_SESSION_SCOPE === "global";
  const homeFreeInvocation = args.length === 0
    || (args[0] === "version" && args.length === 1)
    || routedForFence?.kind === "help"
    || routedForFence?.kind === "path-error"
    || routedForFence?.kind === "incomplete";
  if (!homeFreeInvocation) {
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
  const {
    contract: taskFinalReviewContract,
    verifiedStore
  } = await preflightManagedTaskControlPlane();
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

  if (args[0] === "capability") {
    const result = await runCapabilityCommand(args.slice(1), home, process.env);
    emit(JSON.stringify(result, null, 2), false, result);
    const kind = (result as Record<string, unknown> | null)?.kind;
    if (typeof result === "object" && result !== null && !Array.isArray(result)
      && typeof kind === "string" && !["value", "operation"].includes(kind)) process.exitCode = 5;
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
      openCurrentTaskStore(home),
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
    const result = await runUpgradeCommand(args.slice(1), home);
    process.exitCode = result.exitCode;
    emit(result.output, false, result.data);
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
      const result = refreshManagedSessionCliWrappers(
        home,
        currentInvocationEntryPoint()
      );
      emit(
        `Refreshed ${result.refreshed} managed Session CLI wrapper(s); `
          + `${result.current} already current, ${result.skipped} skipped.`,
        false,
        result
      );
      return;
    }
    if (args[1] === "agent-host" && args.length === 3) {
      process.exitCode = await runAgentHost({
        home,
        ticket: args[2]!
      });
      return;
    }
    if (args[1] === "session-notify" && args.length === 3) {
      await runSessionNotifyCommand(args[2], process.env);
      return;
    }
    if (args[1] === "runtime-hook" && args.length === 2) {
      // Provider lifecycle Hooks are observation channels, never execution
      // gates. A late/stale Hook must not make Claude reject an otherwise
      // valid Session or AgentRun; its exact fence is revalidated before any
      // inbox fact is written, so dropping an invalid observation is safe.
      try {
        await runRuntimeObservationHookCommand(readFileSync(0, "utf8"), process.env);
      } catch {
        return;
      }
      return;
    }
    throw usageError("Internal lifecycle callback usage is invalid.");
  }

  if (args[0] === "session" && args[1] === "reconcile") {
    const options = parseSessionReconcileOptions(args.slice(2));
    const store = openCurrentTaskStore(home);
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
      // The receipt survives a Controller stop. If it has never been written,
      // ask the authenticated live Controller for the same current identity.
      const receipt: RuntimeIdentityReceipt | null = readRuntimeIdentity(home);
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
        // The exact current storage contract fails closed on contradictions.
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
    validateCurrentTaskStore(home);
    const controllerMethod: "stop" | "restart" = method;
    const updateHandoverOwner = process.env.YUI_UPDATE_HANDOVER_OWNER_PID;
    // A pre-fix updater cannot pass the owner environment variable to the
    // activated restart child, but it remains that child's direct parent while
    // holding the exact handover lock. Inherit only that OS-backed relationship;
    // every unrelated live lock still compares foreign and fails closed.
    const updateHandoverOwnerPid = updateHandoverOwner === undefined
      ? (Number.isSafeInteger(process.ppid) && process.ppid > 0 ? process.ppid : undefined)
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
    const resourcesStore = openCurrentTaskStore(home);
    const result = await runResourcesCommand(args.slice(1), resourcesStore);
    emit(result.output, false, result.data);
    return;
  }

  if (!operatorOfflineCommand(args)) await assertFileTaskControllerStorageCompatible(home);
  // Reuse the store the exact runtime preflight already opened and read for
  // this same Home. Opening a second store would parse the unchanged large
  // state a second time; the per-instance fingerprint cache still invalidates
  // on an external writer, and the storage lock + revision CAS are unchanged.
  const store = verifiedStore !== undefined
    && resolve(verifiedStore.rootDirectory()) === resolve(home)
    ? verifiedStore
    : openCurrentTaskStore(home);
  const catalogs = new AgentConfigurationCatalogService(home, {
    environment: process.env
  });
  const resolved = await resolveTerminalArguments(args, invocation.node, store, catalogs);
  if (resolved === null) {
    emit("Cancelled.");
    return;
  }
  const validateAgentConfiguration = await preflightAgentConfigurationMutation(
    resolved,
    store,
    catalogs
  );

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
    if (managedInvocation || process.env.YUI_ROLE || process.env.YUI_NATIVE_SESSION_ID) {
      throw usageError("The Web user ingress must be started from a local user terminal, not a managed Session.");
    }
    if (resolved.length === 2 && (resolved[1] === "--status" || resolved[1] === "--stop")) {
      const status = await callController(home, "web.status", {}) as { id: string; url: string } | null;
      if (resolved[1] === "--status") emit(status ? `Yui web control room: ${status.url}\n` : "Web is not running.\n", false, status);
      else {
        if (status) await callController(home, "web.stop", { id: status.id });
        emit("Web listener stopped; Controller and Agents are unchanged.\n");
      }
      return;
    }
    if (jsonOutput) throw usageError("Web start does not support --json; use --status.");
    const options = parseWebCommandOptions(resolved.slice(1));
    const id = randomUUID();
    await callController(home, "web.start", { ...options, id });
    const displayHost = options.host === "::1" ? "[::1]" : options.host;
    process.stdout.write(`Yui web control room: http://${displayHost}:${options.port}\n`);
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await callController(home, "web.stop", { id });
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
      const result = runProfileCommand(
        resolved.slice(2),
        store,
        () => new Date(),
        validateAgentConfiguration === undefined ? {} : { validateAgentConfiguration }
      );
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
    // The session surface (record/replace/enter/context) only ever yields the
    // enter control; the live input actions live under the top-level `role`
    // command below, never here.
    if (result.kind !== "enter") {
      throw new Error("Session commands cannot perform a live input control.");
    }
    await ensureFileTaskController(home, { environment: process.env });
    await runtime.prepareGlobalRoleEnter(result.role.name);
    tmux.attachRole("operator", result.role.name, "auto");
    return;
  }
  if (resolved[0] === "role") {
    // decision-3 §7 CLI grammar: the durable Global input actions are top-level
    // `role message queue|steer <global-role> …` and `role interrupt
    // <global-role> …`, distinct from `config role …` (desired configuration)
    // and `session …` (native session lifecycle). Core persists the durable
    // Global-owned Message, proves owner/target/capability/writer-fence from
    // durable state, and returns either a string disposition (queued,
    // idempotent-replay, or an explicit not-steered/not-interrupted failure with
    // its exact code) or a resolved live intent. The CLI performs at most one
    // native edge with scope "global" and taskId omitted — the same shared
    // resolver and transport as a Task Role, never a fabricated Task.
    let globalInputFailure: Readonly<{ code: string; detail: string; data: unknown }> | undefined;
    const roleOptions: GlobalRoleCommandOptions = {
      yuiHome: home,
      env: process.env,
      jsonOutput,
      onInputFailure: failure => { globalInputFailure = failure; }
    };
    const result = runGlobalRoleCommand(
      resolved.slice(1),
      store as unknown as Parameters<typeof runGlobalRoleCommand>[1],
      roleOptions
    );
    if (resolved[1] === "message" && resolved[2] === "queue" && resolved[3] !== undefined) {
      await callController(home, "scheduler.signal", {
        key: `global-role:${encodeURIComponent(resolved[3])}`
      }).catch(() => {});
    }
    if (typeof result === "string") {
      if (globalInputFailure !== undefined) {
        emitControlFailure(globalInputFailure.detail, globalInputFailure.code, globalInputFailure.data);
        return;
      }
      emit(result);
      return;
    }
    if (result.kind === "input-steer") {
      // Core already persisted the durable Global Message and proved target +
      // capability + writer fence from the Global Role's own Session set. This
      // is the single live edge: one native steer of the exact current Turn,
      // scope "global", no retarget and no fallback to interrupt or queue.
      await ensureFileTaskController(home, { environment: process.env });
      let control: AgentHostControlResult;
      try {
        control = await sendAgentHostSteerControl({
          home,
          scope: "global",
          roleName: result.roleName,
          control: {
            protocol: AGENT_HOST_CONTROL_PROTOCOL,
            type: "steer-turn",
            nativeSessionId: result.target.nativeSessionId,
            nativeTurnId: result.target.nativeTurnId ?? result.target.attemptId,
            authority: result.target.authority,
            run: { attemptId: result.receiptId, boundedText: result.text }
          }
        });
      } catch (error) {
        recordGlobalSteerResult(store, result.roleName, result.messageId, {
          state: "steer-unknown", outcome: "pending",
          detail: error instanceof Error ? error.message : String(error)
        });
        throw runtimeError(
          `Steer message ${result.messageId} is saved but the native steer did not complete: `
          + `${error instanceof Error ? error.message : String(error)}. `
          + "The Message is retained and its outcome is recorded from the Host; whether the "
          + "Provider accepted it may be delivery-unknown. Re-read the Session before acting; "
          + "do not reissue the same input under a new requestId or a different action."
        );
      }
      const steer = foldSteerLiveReceipt(control);
      recordGlobalSteerResult(store, result.roleName, result.messageId, steer);
      if (steer.state !== "steered") {
        emitControlFailure(steerReceiptOutput(result.output, result.roleName, result.messageId, steer),
          steer.state === "steer-unknown" ? "DELIVERY_UNKNOWN" : "STEER_NOT_DELIVERED",
          { roleName: result.roleName, messageId: result.messageId, steer });
        return;
      }
      emit(
        steerReceiptOutput(result.output, result.roleName, result.messageId, steer),
        false, {
          roleName: result.roleName,
          messageId: result.messageId, steer
        });
      return;
    }
    if (result.kind === "input-interrupt") {
      // The single live edge for a Global interrupt: one native cancel of the
      // exact current Turn, scope "global". Never a kill/restart/detach. Any
      // then-handoff was already claimed durably by Core (an existing Global
      // Message owned by this Role) and is delivered once by the ordinary
      // continuation path after this Turn reaches a proven terminal.
      await ensureFileTaskController(home, { environment: process.env });
      let control: AgentHostControlResult;
      try {
        control = await sendAgentHostCancelControl({
          home,
          scope: "global",
          roleName: result.roleName,
          control: {
            protocol: AGENT_HOST_CONTROL_PROTOCOL,
            type: "cancel",
            nativeOnly: true,
            nativeSessionId: result.target.nativeSessionId,
            attemptId: result.target.attemptId,
            authority: result.target.authority
          }
        });
      } catch (error) {
        recordGlobalInterruptResult(store, result.roleName, result.receiptId, {
          state: "interrupt-unknown", outcome: "cancel-requested",
          detail: error instanceof Error ? error.message : String(error)
        });
        throw runtimeError(
          `Interrupt of global role ${result.roleName} did not complete: `
          + `${error instanceof Error ? error.message : String(error)}. `
          + "No process was killed; re-read the Session before retrying."
        );
      }
      const interrupt = foldInterruptLiveReceipt(control);
      recordGlobalInterruptResult(store, result.roleName, result.receiptId, interrupt);
      if (interrupt.state !== "interrupt-requested") {
        emitControlFailure(interruptReceiptOutput(result.output, result.roleName, interrupt),
          interrupt.state === "interrupt-unknown" ? "DELIVERY_UNKNOWN" : "INTERRUPT_NOT_DELIVERED",
          { roleName: result.roleName, interrupt });
        return;
      }
      emit(
        interruptReceiptOutput(result.output, result.roleName, interrupt),
        false, {
          roleName: result.roleName,
          ...(result.thenMessageId === undefined ? {} : { thenMessageId: result.thenMessageId }),
          interrupt
        });
      return;
    }
    if (result.kind !== "enter") {
      throw new Error("Role command returned an invalid control result.");
    }
    // A top-level `role` command never enters a runtime Session; that is
    // `session enter`.
    throw usageError("Use 'yui session enter <role>' to attach to a Global Role.");
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
    if (resolved[1] === "archive-preflight") {
      const request = parseTaskArchiveArguments(resolved.slice(2), "archive-preflight");
      if (process.env.YUI_SESSION_SCOPE === "task" && process.env.YUI_TASK_ID !== request.taskId) {
        throw usageError("Archive inspection must remain within this Session's Task.");
      }
      const data = await inspectTaskArchive(workspaceCoordinator, request);
      emit(renderTaskArchivePreflight(data), false, data);
      return;
    }
    if (resolved[1] === "artifact") {
      // File/directory artifacts live in the Task's local Git repository, so
      // their save/read/list are asynchronous and handled here rather than in
      // the synchronous runTaskCommand chain. Save commits exactly one path and
      // returns a self-certifying commit-pinned reference; read pins to a commit
      // for frozen evidence; list is an ordinary current read.
      const action = resolved[2];
      const taskId = resolved[3];
      const usage = "Usage: yui task artifact list <task> | read <task> <relative-path> [<commit>] | "
        + "save <task> <relative-path> <content> [--message <text>] [--expected-head <commit>]";
      if (taskId === undefined || action === undefined || !["list", "read", "save"].includes(action)) {
        throw usageError(usage);
      }
      if (process.env.YUI_SESSION_SCOPE === "task" && process.env.YUI_TASK_ID !== taskId) {
        throw usageError("Artifact is outside the managed Task scope.");
      }
      if (store.getTask(taskId) === null) throw usageError(`Task not found: ${taskId}.`);
      let data: unknown;
      if (action === "list") {
        if (resolved.length !== 4) throw usageError(usage);
        data = await listArtifactsCapability(home, taskId);
      } else if (action === "read") {
        const relativePath = resolved[4];
        const commit = resolved[5];
        if (relativePath === undefined || resolved.length > 6) throw usageError(usage);
        data = await readArtifactCapability(home, taskId, {
          relativePath, ...(commit === undefined ? {} : { commit })
        });
      } else {
        // save: a delivery-authoritative action; a managed Task caller must be the current Leader.
        taskLocalActor(store, process.env, taskId);
        const relativePath = resolved[4];
        const content = resolved[5];
        if (relativePath === undefined || content === undefined) throw usageError(usage);
        const rest = resolved.slice(6);
        let message: string | undefined;
        let expectedHead: string | undefined;
        for (let index = 0; index < rest.length; index += 1) {
          const value = rest[index + 1];
          if (rest[index] === "--message" && value !== undefined) { message = value; index += 1; continue; }
          if (rest[index] === "--expected-head" && value !== undefined) { expectedHead = value; index += 1; continue; }
          throw usageError(usage);
        }
        data = await saveArtifactCapability(home, taskId, {
          relativePath, content,
          ...(message === undefined ? {} : { message }),
          ...(expectedHead === undefined ? {} : { expectedHead })
        });
      }
      emit(JSON.stringify(data, null, 2), false, data);
      return;
    }
    if (resolved[1] === "execution") {
      if (resolved[2] === "stop") {
        const request = parseTaskExecutionStopRequest(resolved.slice(3));
        const result = stopTaskExecutionCommand(request, store, { environment: process.env });
        try {
          await ensureFileTaskController(home, { environment: process.env });
          await runtime.stopTaskDurableJobs(result.taskId);
          await runtime.stopTaskRoleSessions(result.taskId, result.roleNames);
          await runtime.assertTaskPhysicalResourcesReleased(result.taskId);
          finalizeStoppedTaskExecution(result.taskId, store);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw runtimeError(
            `Task execution is stopped and durable progress is preserved, but physical runtime cleanup failed: ${message}`
          );
        }
        emit(result.output, false, result);
        return;
      }
      if (resolved[2] === "start") {
        const taskId = parseTaskExecutionStartRequest(resolved.slice(3));
        const task = store.getTask(taskId);
        if (task === null) throw usageError(`Task not found: ${taskId}.`);
        // Reject managed Task callers before inspecting or starting runtime resources.
        if (taskLocalActor(store, process.env, taskId) === "leader") {
          throw usageError("Task execution stop/start requires the global Operator or a human user.");
        }
        if (task.executionGate.state === "stopped") {
          await runtime.assertTaskPhysicalResourcesReleased(taskId);
        }
        await ensureFileTaskController(home, { environment: process.env });
        const result = startTaskExecutionCommand(taskId, store, { environment: process.env });
        // Idempotent start is also a reliable kick: if an earlier caller
        // committed the gate but lost its Controller acknowledgement, retrying
        // start re-signals the same durable wake without creating another one.
        await runtime.notifyMailboxChanged?.({ kind: "role", taskId, roleName: "leader" });
        emit(result.output, false, result);
        return;
      }
      throw usageError("Task execution usage: yui task execution <stop|start> ...");
    }
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
    if (resolved[1] === "publication" && resolved[2] === "verify") {
      const result = await runTaskPublicationVerifyCommand(
        resolved.slice(3),
        store,
        {
          verifiers: {
            github: createGitHubCliPublicationVerifier({
              environmentPath: process.env.PATH
            }),
            gitlab: createGitLabCliPublicationVerifier({
              environmentPath: process.env.PATH
            })
          },
          candidateForTask: async (taskId) => {
            const status = store.getTask(taskId)?.status;
            return status === "active" || status === "cancelled"
              ? snapshotActualTaskReviewCandidate(taskId, store, workspacePreparer)
              : null;
          },
          environment: process.env
        }
      );
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
    if (resolved[1] === "replace") {
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
      assertTaskDeliveryAuthority(store, process.env, reference.taskId);
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
      assertTaskDeliveryAuthority(store, process.env, reference.taskId);
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
          throw cleanupCliError(error, `work-item:${qualified}`);
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
    let archiveRemoteDeliveryProof: TaskRemoteDeliveryProof | undefined;
    let archiveTaskReviewCandidate: TaskReviewCandidate | undefined;
    if (resolved[1] === "archive") {
      const { taskId, disposition, force } = validateTaskArchiveRequest(
        resolved.slice(2),
        store,
        {
          runtime,
          environment: process.env,
          yuiHome: home
        }
      );
      const task = store.getTask(taskId);
      if (task === null) throw new Error(`Task disappeared after archive validation: ${taskId}.`);
      if (force || task.status === "archived") {
        // Archive admission and mandatory audit commit before any fallible
        // filesystem/provider work. Repeats report facts, never replay cleanup.
        const admitted = runTaskCommand(resolved.slice(1), store, {
          runtime, environment: process.env, yuiHome: home
        });
        if (force && admitted.kind === "output"
          && (admitted.data as { changed: boolean }).changed) {
          await workspaceCoordinator.cleanupArchivedTask(taskId, disposition);
        }
        const current = store.getTask(taskId)!;
        const archive = taskArchiveDiagnostics(store, current);
        emit(`Archived task ${taskId}\n${renderArchiveDiagnostics(archive)}`, false,
          { task: current, ...archive });
        return;
      }
      {
        if (disposition === "integrated") {
          archiveTaskReviewCandidate = await actualTaskReviewCandidateForTaskCommand(
            resolved,
            store,
            workspacePreparer,
            process.env
          );
          archiveRemoteDeliveryProof = createTaskRemoteDeliveryProof(
            store,
            task,
            archiveTaskReviewCandidate ?? null
          );
          assertTaskRemoteDeliveryIntegrated(archiveRemoteDeliveryProof.delivery);
        }
        const workItemIds = store.listManagedWorkspaces(task.id)
          .flatMap(({ owner }) => owner.type === "work-item" ? [owner.workItemId] : []);
        for (const workItemId of workItemIds) {
          const item = store.getWorkItem(task.id, workItemId);
          if (item?.status !== "accepted" || disposition !== "integrated") continue;
          try {
            await new WorkItemChangeSetManager(store).assertIntegrated(task.id, item.id);
          } catch (error) {
            throw cleanupCliError(error, `work-item:${task.id}/${item.id}`);
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
              cleanup.retryable ?? true,
              cleanup.checks
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
              cleanup.retryable ?? true,
              cleanup.checks
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
    assertWorkItemExecutionDependenciesForCommand(resolved, store, process.env);
    if (resolved[1] === "work" && resolved[2] === "dispatch") {
      const workItemId = resolved[3];
      const reference = workItemId === undefined
        ? null
        : cliWorkItemReference(workItemId, process.env);
      const item = reference === null
        ? null
        : store.getWorkItem(reference.taskId, reference.localId);
      const task = item === null ? null : store.getTask(item.taskId);
      if (item !== null && task !== null) {
        // Authority and pure Lane-shape checks precede every physical or
        // durable workspace preparation performed for dispatch.
        assertTaskDeliveryAuthority(store, process.env, task.id);
        requireWorkItemAssignee(item);
        workItemDispatchLanePlan(resolved, store, item);
      }
      // A rejected Candidate starts a new execution iteration. Release every
      // terminal Lane Role runtime before preparing the new Lane workspaces;
      // durable AgentRuns, Groups, Candidates, and workspace owners remain intact.
      if (item?.status === "open"
        && currentWorkItemExecutionGroup(item)?.lanes.every(
          ({ disposition }) => disposition !== "open"
        )) {
        await workspaceCoordinator.cleanupWorkItemRuntime(item.taskId, item.id);
      }
      // Every Task needs an authoritative runtime owner before dispatch. A
      // Gitless Task uses an empty Task-owned view; Project-backed WorkItems
      // additionally receive their isolated Develop owner below.
      if (item !== null && task !== null) {
        await workspacePreparer.prepareTaskWorkspace(task.id);
      }
      // A Project-backed Worker WorkItem gets an isolated Develop owner before
      // its Lane is prepared. A Leader-owned WorkItem intentionally executes
      // in the Task main worktree and must not enter this isolation path.
      if (item !== null
        && task !== null
        && task.projectBindings.length > 0
        && item.assignee !== "leader"
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
            .assertIntegrated(reference.taskId, reference.localId,
              optionValue(resolved, "--candidate")) ?? undefined;
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
      const result = await runTaskUpstreamCommand(resolved.slice(2), store, home, {
        environment: process.env
      });
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
          const reconciled = await reconcileTaskRemoteBaselines(
            resolved[2],
            store,
            home,
            { environment: process.env, jobPort: createControllerIntegrationJobPort(home, { environment: process.env }) }
          );
          if (reconciled.length > 0) {
            const updates = reconciled.map((entry) => (
              `${entry.projectId}: ${entry.fromCommit} -> ${entry.toCommit} `
              + `(Integration ${entry.integrationId})`
            )).join("; ");
            throw usageError(
              `Remote baseline reconciliation advanced Task ${resolved[2]} (${updates}). `
              + "The Task remains active so the Leader can inspect the new authoritative head, "
              + "decide how prior Review evidence applies, and retry task complete."
            );
          }
        }
      }
    }
    let releaseReviewHandoverLock: (() => void) | undefined;
    if ((resolved[1] === "review"
        && ["request", "retry"].includes(resolved[2] ?? ""))
      || resolved[1] === "complete") {
      const handoverLock = acquireHandoverLock(home);
      releaseReviewHandoverLock = handoverLock.release;
    }
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
      const candidateSnapshots = await candidateSnapshotForTaskCommand(
        resolved,
        store,
        workspacePreparer,
        process.env,
        taskFinalReviewContract
      );
      const actualTaskReviewCandidate = archiveRemoteDeliveryProof === undefined
        ? await actualTaskReviewCandidateForTaskCommand(
          resolved,
          store,
          workspacePreparer,
          process.env
        )
        : archiveTaskReviewCandidate;
      const deltaRecheckPreflight = await deltaRecheckPreflightForTaskCommand(
        resolved.slice(1),
        store,
        actualTaskReviewCandidate
      );
      // Read-only Host evidence for Session inspect and Role status/list. The command stays
      // synchronous over persisted state; this is the live reading it prints
      // beside those facts, prepared here because the Host is reached over a
      // socket.
      const liveHostObservations = await liveHostObservationsForTaskCommand(
        resolved,
        store,
        home
      );
      const liveRunConfiguration = runConfigurationForHostObservation(liveHostObservations?.[resolved[5] ?? ""]);
      // Physical preparation may precede the durable write, but Task status,
      // workspace identity/cwd, and ManagedWorkspace ownership are adopted by
      // one transaction. A failed attempt therefore leaves the Task Draft and
      // owning no writable workspace.
      let taskWorkspaceActivation: TaskWorkspaceActivation | undefined;
      if (resolved[1] === "activate" && resolved.length === 3) {
        const taskId = resolved[2];
        const task = taskId === undefined ? null : store.getTask(taskId);
        if (task !== null && task.status === "draft") {
          taskLocalActor(store, process.env, task.id);
          taskWorkspaceActivation = await workspacePreparer.activateTaskWorkspace(task.id, process.env);
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
          ...(completionSummary === undefined ? {} : { completionSummary }),
          ...(completionPublishedTreeProof === undefined
            ? {}
            : { completionPublishedTreeProof }),
          ...(workItemIntegrationProof === undefined ? {} : { workItemIntegrationProof }),
          ...candidateSnapshots,
          ...(executionLaneWorkspaces === undefined ? {} : { executionLaneWorkspaces }),
          ...(taskWorkspaceActivation === undefined ? {} : { taskWorkspaceActivation }),
          ...(laneDispatchProjectPaths === undefined ? {} : { laneDispatchProjectPaths }),
          ...(actualTaskReviewCandidate === undefined
            ? {}
            : { actualTaskReviewCandidate }),
          ...(archiveRemoteDeliveryProof === undefined
            ? {}
            : { archiveRemoteDeliveryProof }),
          ...(deltaRecheckPreflight === undefined
            ? {}
            : { deltaRecheckPreflight }),
          ...(liveRunConfiguration === undefined
            ? {}
            : { liveRunConfiguration }),
          ...(liveHostObservations === undefined ? {} : { liveHostObservations }),
          ...(taskRetirementProof === undefined ? {} : { taskRetirementProof }),
          ...(validateAgentConfiguration === undefined
            ? {}
            : { validateAgentConfiguration })
        }
      );
      // The dispatch transaction has now adopted (or rejected) the prepared
      // Lane workspaces. Release the held fence so later output/review
      // handling can take the per-Project fence itself.
      if (laneDispatchRelease !== undefined) {
        laneDispatchRelease();
        laneDispatchRelease = undefined;
      }
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
              lane.disposition === "open"
              && (lane.currentRunId === undefined
                || store.getRun(requestedRound.taskId, lane.currentRunId)?.status === "failed")
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
              ? `Review ${requestedRound.id} remains running\n`
              : `Review queued as ${requestedRound.id} (${run.id})\n`;
            reviewData = {
              reviewRequest: run === null
                ? {
                    kind: "running",
                    reviewerRoleName: requestedRound.reviewerRoleName,
                    activeReviewRoundId: requestedRound.id,
                    retryable: false
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
        const controlData = result.data as { steer?: { code?: string }; interrupt?: { code?: string } } | undefined;
        const failureCode = controlData?.steer?.code ?? controlData?.interrupt?.code;
        if (failureCode !== undefined) {
          emitControlFailure(result.output, failureCode, result.data);
          return;
        }
        emit(`${result.output}${reviewOutput}`, false, reviewData === undefined
          ? result.data
          : { command: result.data, ...reviewData as object });
        return;
      }
      if (jsonOutput && result.kind !== "session-stop"
        && result.kind !== "input-steer" && result.kind !== "input-interrupt") {
        throw usageError("Task Role view/takeover requires an interactive terminal.");
      }
      if (result.kind === "session-stop") {
        await ensureFileTaskController(home, { environment: process.env });
        try {
          await runtime.stopExactTaskRoleSession({
            taskId: result.taskId,
            roleName: result.roleName,
            agentId: result.agentId,
            adapterId: result.adapterId,
            nativeSessionId: result.nativeSessionId,
            sessionUpdatedAt: result.sessionUpdatedAt
          });
        } catch (error) {
          throw runtimeError(
            `Session stop was requested but physical Host cleanup did not complete: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        emit(result.output, false, {
          taskId: result.taskId,
          roleName: result.roleName,
          stopped: true,
          reason: result.reason
        });
        return;
      }
      if (result.kind === "view") {
        if (result.output !== undefined) emit(result.output);
        tmux.attachRole(result.taskId, result.roleName, "read-only");
        return;
      }
      if (result.kind === "input-steer") {
        // Core already persisted the Message and proved target + capability +
        // writer fence. This is the single live edge: one native steer of the
        // exact current Turn, with no retarget and no fallback to interrupt or
        // queue. Its durable settlement flows through the steer receipt fold.
        await ensureFileTaskController(home, { environment: process.env });
        let control: AgentHostControlResult;
        try {
          control = await sendAgentHostSteerControl({
            home,
            scope: "task",
            taskId: result.taskId,
            roleName: result.roleName,
            control: {
              protocol: AGENT_HOST_CONTROL_PROTOCOL,
              type: "steer-turn",
              nativeSessionId: result.target.nativeSessionId,
              nativeTurnId: result.target.nativeTurnId ?? result.target.attemptId,
              authority: result.target.authority,
              run: { attemptId: result.receiptId, boundedText: result.text }
            }
          });
        } catch (error) {
          throw runtimeError(
            `Steer message ${result.messageId} is saved but the native steer did not complete: `
            + `${error instanceof Error ? error.message : String(error)}. `
            + "The Message is retained and its outcome is recorded from the Host; whether the "
            + "Provider accepted it may be delivery-unknown. Re-read the Session before acting; "
            + "do not reissue the same input under a new requestId or a different action."
          );
        }
        const steer = foldSteerLiveReceipt(control);
        if (steer.state !== "steered") {
          emitControlFailure(steerReceiptOutput(result.output, `${result.taskId}/${result.roleName}`, result.messageId, steer),
            steer.state === "steer-unknown" ? "DELIVERY_UNKNOWN" : "STEER_REJECTED",
            { taskId: result.taskId, roleName: result.roleName, messageId: result.messageId, steer });
          return;
        }
        emit(
          steerReceiptOutput(result.output, `${result.taskId}/${result.roleName}`,
            result.messageId, steer),
          false, {
            taskId: result.taskId, roleName: result.roleName,
            messageId: result.messageId, steer
          });
        return;
      }
      if (result.kind === "input-interrupt") {
        // The single live edge for interrupt: one native cancel of the exact
        // current Turn. Never a kill/restart/detach. Any then-handoff was
        // already claimed durably by Core and is delivered once by the ordinary
        // continuation path after this Turn reaches a proven terminal.
        await ensureFileTaskController(home, { environment: process.env });
        let control: AgentHostControlResult;
        try {
          control = await sendAgentHostCancelControl({
            home,
            scope: "task",
            taskId: result.taskId,
            roleName: result.roleName,
            control: {
              protocol: AGENT_HOST_CONTROL_PROTOCOL,
              type: "cancel",
              nativeOnly: true,
              nativeSessionId: result.target.nativeSessionId,
              // Native cancel names the exact original execution attempt it stops
              // (Host matches request.attemptId === activeRunAttemptId). That is
              // distinct from receiptId, the durable identity of this interrupt
              // control operation — never send the operation id as the turn id.
              attemptId: result.target.attemptId,
              authority: result.target.authority
            }
          });
        } catch (error) {
          recordTaskInterruptResult(store, result.taskId, result.receiptId,
            { state: "interrupt-unknown", outcome: "cancel-requested" });
          throw runtimeError(
            `Interrupt ${result.receiptId} of ${result.taskId}/${result.roleName} did not complete: `
            + `${error instanceof Error ? error.message : String(error)}. `
            + "No process was killed; re-read the Session before retrying."
          );
        }
        const interrupt = foldInterruptLiveReceipt(control);
        recordTaskInterruptResult(store, result.taskId, result.receiptId, interrupt);
        if (interrupt.state !== "interrupt-requested") {
          emitControlFailure(interruptReceiptOutput(result.output, `${result.taskId}/${result.roleName}`, interrupt),
            interrupt.state === "interrupt-unknown" ? "DELIVERY_UNKNOWN"
              : interrupt.state === "interrupt-not-active" ? "NO_ACTIVE_TURN" : "INTERRUPT_REJECTED",
            { taskId: result.taskId, roleName: result.roleName, receiptId: result.receiptId, interrupt });
          return;
        }
        emit(
          interruptReceiptOutput(result.output, `${result.taskId}/${result.roleName}`, interrupt),
          false, {
            taskId: result.taskId, roleName: result.roleName,
            ...(result.thenMessageId === undefined ? {} : { thenMessageId: result.thenMessageId }),
            interrupt
          });
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
        // Completing or retiring the Task from inside the takeover AgentRun owns
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
      await workspacePreparer.discardUnadoptedExecutionLaneWorkspaces(executionLaneWorkspaces);
      if (laneDispatchRelease !== undefined) {
        laneDispatchRelease();
        laneDispatchRelease = undefined;
      }
      throw error;
    } finally {
      if (releaseReviewHandoverLock !== undefined) {
        releaseReviewHandoverLock();
        releaseReviewHandoverLock = undefined;
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
    `Command is not connected to the current TaskStore command routing: ${resolved[0]}.`,
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
  /**
   * The TaskStore instance the exact runtime preflight already opened and
   * read. A same-Home command reuses it instead of opening a second store, so
   * the unchanged large state is not parsed twice. Its per-instance fingerprint
   * cache still invalidates on any external writer, and mutations keep their
   * unlocked re-read and revision CAS.
   */
  verifiedStore: TaskStore | undefined;
}>;

async function preflightManagedTaskControlPlane(): Promise<ManagedTaskControlPlanePreflight> {
  if (taskFinalReviewInvocation.error !== undefined) {
    throw new Error(taskFinalReviewInvocation.error);
  }
  if (process.env.YUI_SESSION_SCOPE !== "task") {
    if (process.env.YUI_SESSION_SCOPE === "global") {
      return await preflightManagedGlobalControlPlane();
    }
    if (taskFinalReviewInvocation.request !== undefined) {
      throw new Error(
        "Task final-review contract may only be established from the Task Leader's managed Session."
      );
    }
    return { contract: undefined, verifiedStore: undefined };
  }
  const internalCallback = args[0] === "internal"
    && ["agent-host", "session-notify", "runtime-hook"].includes(args[1] ?? "");
  const home = resolveYuiHome(process.env);
  const manifest = assertManagedSessionManifest(home, "task");
  const diagnosticTarget = taskDiagnosticTarget(args);
  const diagnostic = diagnosticTarget !== undefined
    && diagnosticTarget === process.env.YUI_TASK_ID;
  if (diagnosticTarget !== undefined && !diagnostic) {
    throw usageError("Diagnostics must remain within this Session's Task.");
  }
  // One gate for every managed command: the current CLI, Home, and Controller
  // must agree. Internal callbacks must still be able to append their immutable
  // fact while the Controller is offline.
  await assertRuntimeCoherence(
    { actualHome: home },
    { checkController: !internalCallback && !diagnostic }
  );
  const verifiedStore = openCurrentTaskStore(home);
  // One authority for "may this process act as this Task Role?". Yui's own
  // internal callbacks run inside the Host process Yui itself launched; an Agent
  // command proves it is the Role's current runtime with its per-Session caller
  // key. Nothing here
  // gates on the current AgentRun: which AgentRun is active is durable state that the
  // command needing it reads, never a fact frozen into a process environment.
  const runtime = internalCallback
    ? undefined
    : diagnostic
      ? resolveManagedTaskReader(verifiedStore, process.env)
      : requireManagedTaskCaller(verifiedStore, process.env);
  if (diagnostic && runtime?.roleName !== "leader"
    && !(args[1] === "show"
      || (args[1] === "role" && args[2] === "session" && args[3] === "inspect"
        && args[5] === runtime?.roleName))) {
    // Non-Leaders keep their Assignment-scoped read authorization.
    requireManagedTaskCaller(verifiedStore, process.env);
  }
  const request = taskFinalReviewInvocation.request;
  if (request !== undefined && diagnostic) requireManagedTaskCaller(verifiedStore, process.env);
  if (request === undefined) {
    return { contract: undefined, verifiedStore };
  }
  if (runtime === undefined || runtime.roleName !== "leader") {
    throw new Error("Only the Task Leader's managed Session may establish a final-review contract.");
  }
  if (request.taskId !== runtime.taskId) {
    throw new Error(
      `Task final-review contract Task id mismatch: expected ${runtime.taskId}, found ${request.taskId}.`
    );
  }
  const recordedContract = resolveRecordedTaskFinalReviewContract(
    runtime.taskId,
    verifiedStore.listWorkItems(runtime.taskId),
    verifiedStore.listReviewRounds(runtime.taskId)
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
      reviewerRoleName: request.reviewerRoleName
    }),
    verifiedStore
  };
}

async function preflightManagedGlobalControlPlane(): Promise<ManagedTaskControlPlanePreflight> {
  if (taskFinalReviewInvocation.request !== undefined) {
    throw new Error(
      "Task final-review contract may only be established from the Task Leader's managed Session."
    );
  }
  const home = resolveYuiHome(process.env);
  const manifest = assertManagedSessionManifest(home, "global");
  const expectedRoleKind = process.env.YUI_ROLE === "operator" ? "operator" : "global";
  if (manifest.owner.scope !== "global"
    || manifest.roleKind !== expectedRoleKind) {
    throw new Error("Managed global invocation does not match its Session Manifest.");
  }
  if (expectedRoleKind === "operator" && ["doctor", "upgrade", "update"].includes(args[0] ?? "")) {
    // These commands inspect/adopt the storage contract themselves. Requiring
    // current storage before reaching upgrade would make recovery impossible.
    return { contract: undefined, verifiedStore: undefined };
  }
  await assertRuntimeCoherence({ actualHome: home }, {
    checkController: !(expectedRoleKind === "operator" && operatorOfflineCommand(args))
  });
  return { contract: undefined, verifiedStore: openCurrentTaskStore(home) };
}

/**
 * The entry point the current invocation resolves to. Only its executable and
 * CLI path are used, to retarget managed Session wrappers at this installation.
 */
function currentInvocationEntryPoint(): SessionEntryPoint {
  return {
    executable: process.execPath,
    cliEntry: fileURLToPath(import.meta.url)
  };
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
  if (error instanceof CleanupInspectionError) {
    return usageError(error.message, undefined,
      cleanupBlockedDetails(error.checks[0]?.reason ?? "cleanup-failed", fallbackResource, true, error.checks));
  }
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
  retryable: boolean,
  checks?: readonly import("./workspace/cleanupInspection.js").CleanupCheck[]
): Readonly<Record<string, unknown>> {
  return {
    status: "blocked",
    blockedBy: [{ resource, reason, retryable }],
    remainingResources: [resource],
    retryable,
    ...(checks === undefined ? {} : { checks })
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
  kind: "run" | "reviewRound",
  environment: NodeJS.ProcessEnv
) {
  try {
    return resolveTaskRecordReference(value, {
      kind,
      label: kind === "run" ? "AgentRun reference" : "ReviewRound reference",
      ...(environment.YUI_TASK_ID === undefined
        ? {}
        : { contextTaskId: environment.YUI_TASK_ID })
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

function assertWorkItemExecutionDependenciesForCommand(
  args: readonly string[],
  store: TaskStore,
  environment: NodeJS.ProcessEnv
): void {
  let item: WorkItem | undefined;
  if (args[0] === "task" && args[1] === "work" && args[2] === "dispatch"
    && args[3] !== undefined) {
    const reference = cliWorkItemReference(args[3], environment);
    item = store.getWorkItem(reference.taskId, reference.localId) ?? undefined;
  } else if (args[0] === "task" && args[1] === "run" && args[2] === "retry"
    && args[3] !== undefined) {
    const reference = cliTaskRecordReference(args[3], "run", environment);
    const run = store.getRun(reference.taskId, reference.localId);
    item = run?.purpose === "execution" && run.workItemId !== undefined
      ? store.getWorkItem(run.taskId, run.workItemId) ?? undefined
      : undefined;
  }
  if (item === undefined) return;
  assertWorkItemDependenciesCompletedForCommand(store, item);
}

async function candidateSnapshotForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv,
  taskFinalReviewContract?: TaskFinalReviewContract
) {
  if (args[0] !== "task" || args[1] !== "work" || args[2] !== "update"
    || args[3] === undefined || args[4] !== "done") return {};
  const reference = cliWorkItemReference(args[3], environment);
  return snapshotWorkItemCandidate(
    store, preparer, reference.taskId, reference.localId, taskFinalReviewContract
  );
}

async function prepareExecutionLaneWorkspacesForCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv
): Promise<PreparedExecutionLaneWorkspaces | undefined> {
  const isDispatch = args[0] === "task"
    && args[1] === "work"
    && args[2] === "dispatch"
    && args[3] !== undefined;
  if (!isDispatch) return undefined;
  const itemRef = cliWorkItemReference(args[3]!, environment);
  const item = store.getWorkItem(itemRef.taskId, itemRef.localId);
  if (item === null || item.assignee === undefined) return undefined;
  const plan = workItemDispatchLanePlan(args, store, item);
  if (plan.roles.length === 0) return undefined;
  for (const roleName of plan.roles) {
    if (store.getRole(item.taskId, roleName) === null) {
      throw usageError(`Task Role not found: ${item.taskId}/${roleName}.`);
    }
    if (store.getActiveRun(item.taskId, roleName) !== null) {
      throw usageError(`${item.taskId}/${roleName} already has an active turn.`);
    }
  }
  const held = preparer.acquireTaskProjectMaintenanceLocks(item.taskId);
  const map = new Map<string, import("./worktree/managedWorkspace.js").ManagedWorkspace>();
  try {
    const projectPaths = new Map<string, string>();
    for (const { projectId } of held.current.projectBindings) {
      const project = store.getProject(projectId);
      if (project === null) throw new Error(`Project not found: ${projectId}.`);
      projectPaths.set(projectId, project.path);
    }
    const source = item.assignee === "leader"
      ? store.getTaskWorkspace(item.taskId)
      : store.getWorkItemWorkspace(item.taskId, item.id);
    if (source === null) {
      throw usageError(`Execution Lane source workspace is not ready: ${item.id}.`);
    }
    const inputHeads = await preparer.snapshotExecutionLaneInputHeads(
      source,
      item.writeProjectIds
    );
    for (const laneId of plan.laneIds) {
      map.set(laneId, await preparer.prepareExecutionLaneWorkspace(
        item.taskId,
        plan.groupId,
        laneId,
        { purpose: "execution", workItemId: item.id, inputHeads },
        { current: held.current }
      ));
    }
    return { workspaces: map, release: held.release, projectPaths };
  } catch (error) {
    await preparer.discardUnadoptedExecutionLaneWorkspaces(map);
    held.release();
    throw error;
  }
}

function workItemDispatchLanePlan(
  args: readonly string[],
  store: TaskStore,
  item: WorkItem
): Readonly<ReturnType<typeof planReplicatedWorkItemLanes> & { groupId: string }> {
  if (item.assignee === undefined) {
    throw usageError(`Work Item has no Task Role assignee: ${item.id}.`);
  }
  const roles = args.flatMap((value, index) => (
    value === "--lane-role" && args[index + 1] !== undefined
      ? [args[index + 1]!]
      : []
  ));
  const groupId = `execution-group-${store.peekNextRunId(item.taskId)}`;
  return {
    groupId,
    ...planReplicatedWorkItemLanes(
      item.assignee,
      roles,
      groupId
    )
  };
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
  const map = new Map<string, import("./worktree/managedWorkspace.js").ManagedWorkspace>();
  try {
    for (const lane of group.lanes.filter(({ disposition }) => disposition === "open")) {
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
    const reference = cliTaskRecordReference(args[3], "run", environment);
    const run = store.getRun(reference.taskId, reference.localId);
    const round = run?.reviewRoundId === undefined
      ? null
      : store.getReviewRound(reference.taskId, run.reviewRoundId);
    if (run?.purpose === "review"
      && round !== null
      && (round.scope ?? "work-item") === "task") {
      taskId = reference.taskId;
    }
  } else if (args[1] === "archive"
    && args[2] !== undefined
    && args.includes("--integrated")) {
    taskId = store.getTask(args[2])?.id;
  } else if ((
    args[1] === "show"
    || args[1] === "next-action"
    || args[1] === "remote-delivery"
  )
    && args[2] !== undefined) {
    taskId = store.getTask(args[2])?.id;
    decisionSupportRead = true;
  }
  const status = taskId === undefined ? undefined : store.getTask(taskId)?.status;
  if (taskId === undefined || (status !== "active" && status !== "cancelled")) return undefined;
  try {
    return await snapshotActualTaskReviewCandidate(taskId, store, preparer, !decisionSupportRead);
  } catch (error) {
    if (decisionSupportRead && error instanceof CliError) return undefined;
    throw error;
  }
}

async function snapshotActualTaskReviewCandidate(
  taskId: string,
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  prepareWorkspace = true
): Promise<TaskReviewCandidate> {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.projectBindings.length === 0) {
    throw usageError(`Final Task Review requires a Project-backed Task: ${task.id}.`);
  }
  // Mutation preflights reconcile before freezing a candidate. A decision-
  // support read only observes existing heads; it must not migrate Sessions,
  // create worktrees or acquire workspace ownership as a side effect.
  if (prepareWorkspace) await preparer.prepareTaskWorkspace(task.id);
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
    .filter((round) => isCompletedTaskReviewEvidence(store, round))
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
    .at(-1);
  if (previous === undefined) {
    throw usageError(
      "Delta-recheck requires a previous completed Task-final Review that accepted a head."
    );
  }
  const repositoryPaths: Record<string, string> = {};
  const taskWorkspace = store.getTaskWorkspace(task.id);
  if (taskWorkspace === null || taskWorkspace.owner.type !== "task") {
    throw usageError(`Task has no authoritative main workspace: ${task.id}.`);
  }
  for (const candidateProject of actualTaskReviewCandidate.projects) {
    const entry = workspaceProjectEntry(taskWorkspace, candidateProject.projectId);
    if (entry === undefined) {
      throw usageError(
        `Delta-recheck Task workspace Project not found: ${candidateProject.projectId}.`
      );
    }
    repositoryPaths[candidateProject.projectId] = entry.path;
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
  const paneRunning = tmux.probeRoleStatus("operator", "operator") === "running";
  if (paneRunning && active === undefined) {
    throw usageError(
      "Operator is running but its native session has not been recorded yet. "
      + "Record the exact native session before switching sessions."
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
      && active.status === "active"
    )
  ) {
    await runtime.stopGlobalRoleSession(role.name);
  }
  applyOperatorSessionControl(control, store);
  await runtime.prepareGlobalRoleEnter(role.name);
  tmux.attachRole("operator", role.name, "auto");
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
  const store = openCurrentTaskStore(home);
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

type AgentConfigurationMutation = Readonly<{
  agentId: string;
  config: RoleAgentConfig;
  cwd: string;
}>;

type AgentConfigurationMutationValidator = (
  input: AgentConfigurationMutation
) => void;

async function preflightAgentConfigurationMutation(
  commandArgs: readonly string[],
  store: TaskStore,
  catalogs: AgentConfigurationCatalogService
): Promise<AgentConfigurationMutationValidator | undefined> {
  const mutation = profileAgentConfigurationMutation(commandArgs, store)
    ?? taskRoleAgentConfigurationMutation(commandArgs, store);
  if (mutation === undefined) {
    await warmLegacyRoleConfigurationMutation(commandArgs, store, catalogs);
    return undefined;
  }
  const agent = store.getConfiguredAgent(mutation.agentId);
  if (agent === null) throw agentNotFound(mutation.agentId);
  const resolved = await catalogs.resolve({
    agent,
    cwd: mutation.cwd,
    config: mutation.config
  });
  try {
    validateAgentLaunchConfiguration(resolved.catalog, mutation.config);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  return (candidate) => {
    if (
      candidate.agentId !== mutation.agentId
      || resolve(candidate.cwd) !== resolve(mutation.cwd)
      || !isDeepStrictEqual(candidate.config, mutation.config)
    ) {
      throw usageError(
        "Agent configuration changed after capability preflight; retry the command."
      );
    }
    try {
      validateAgentLaunchConfiguration(resolved.catalog, candidate.config);
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
  };
}

function profileAgentConfigurationMutation(
  args: readonly string[],
  store: TaskStore
): AgentConfigurationMutation | undefined {
  return args[0] === "config" && args[1] === "profile"
    ? previewProfileAgentConfigurationMutation(args.slice(2), store)
    : undefined;
}

function taskRoleAgentConfigurationMutation(
  args: readonly string[],
  store: TaskStore
): AgentConfigurationMutation | undefined {
  return args[0] === "task"
    ? previewTaskRoleAgentConfigurationMutation(args.slice(1), store)
    : undefined;
}

async function warmLegacyRoleConfigurationMutation(
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

/**
 * Ask the live Agent Host what the Session is running under, for a Session
 * inspect.
 *
 * Only for `task role session inspect`. Every other command reads persisted
 * state and must keep doing so: a query that reached into a running Session
 * would make reading a Task's records depend on whether an Agent happened to be
 * up.
 *
 * The request is the Host's existing `status` control, which reads state the
 * Host already holds. It creates no Session, sends no prompt and changes nothing
 * — which is what lets a read-only inspect use it at all.
 *
 * Every failure resolves to `unknown` with the reason rather than propagating:
 * no Host is running for most Sessions ever inspected, and the persisted facts
 * the command prints are worth showing regardless of whether a live one answered.
 */
async function liveHostObservationsForTaskCommand(
  args: readonly string[],
  store: TaskStore,
  home: string
): Promise<Readonly<Record<string, TaskRoleHostObservation>> | undefined> {
  if (args[0] !== "task" || args[1] !== "role") return undefined;
  const inspect = args[2] === "session" && args[3] === "inspect" && args.length === 6;
  const status = args[2] === "status" && args.length === 5;
  const list = args[2] === "list" && args.length === 4;
  if (!inspect && !status && !list) return undefined;
  const taskId = args[inspect ? 4 : 3]!;
  const roles = list ? store.listRoles(taskId).map(role => role.name) : [args[inspect ? 5 : 4]!];
  const entries = await Promise.all(roles.map(async roleName => [
    roleName, await readLiveHostObservation(store, home, taskId, roleName)
  ] as const));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, TaskRoleHostObservation] => entry[1] !== undefined));
}

async function readLiveHostObservation(
  store: TaskStore, home: string, taskId: string, roleName: string
): Promise<TaskRoleHostObservation | undefined> {
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  const active = sessions === null
    ? undefined
    : sessions.sessions[sessions.activeAgentId];
  if (active === undefined) return undefined;
  if (active.status !== "active") {
    return { detail: `This Session is ${active.status}; no live Host reading was requested.` };
  }
  try {
    const snapshot = await inspectAgentHost({
      home,
      scope: "task",
      taskId,
      roleName
    });
    if (snapshot.nativeSessionId !== active.nativeSessionId
      || snapshot.adapterId !== active.adapterId) {
      return { detail: "The Agent Host does not match the recorded Session." };
    }
    return { snapshot };
  } catch (error) {
    return { detail: `The Agent Host could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function runConfigurationForHostObservation(host?: TaskRoleHostObservation): AgentRunConfigurationObservation | undefined {
  if (host === undefined) return undefined;
  return host.snapshot?.runConfiguration ?? unknownAgentRunConfiguration(
    host.detail ?? `Host=${host.snapshot?.state ?? "unknown"}; no live Agent configuration was reported.`
  );
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
    case "profile.list": return store.listAgentProfiles().map((profile) =>
      profileSelectionRecord(profile, store));
    case "profile.show": {
      const profile = store.getAgentProfile(String(params.id ?? ""));
      return profile === null ? null : profileSelectionRecord(profile, store);
    }
    case "role.list": return store.listGlobalRoles();
    case "role.show": return store.getGlobalRole(String(params.name ?? ""));
    case "project.list": return callOptional(reader, "listProjects");
    case "task.list": return callOptional(reader, "listTasks");
    case "task.integration.list": return store.listIntegrationAttempts(String(params.taskId ?? ""));
    case "task.change-set.list": return store.listChangeSets(String(params.taskId ?? ""));
    case "task.role.list": return callOptional(reader, "listRoles", [params.taskId]);
    case "task.role.show": return callOptional(reader, "getRole", [params.taskId, params.roleName]);
    case "task.work.list": return callOptional(reader, "listWorkItems", [params.taskId]);
    case "task.message.list": return callOptional(reader, "listMessages", [params.taskId]);
    case "task.input.list": {
      const taskId = typeof params.taskId === "string" ? params.taskId : undefined;
      const requests = taskId === undefined
        ? store.listAllInputRequests()
        : store.listInputRequests(taskId);
      return params.all === true ? requests : requests.filter((request) => request.status === "open");
    }
    case "task.turn.list": return callOptional(reader, "listRuns", [params.taskId]);
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

function profileSelectionRecord(
  profile: AgentProfile,
  store: TaskStore
): Readonly<Record<string, unknown>> {
  const view = resolveAgentProfileView(profile, store);
  return {
    ...view.profile,
    runtimeSource: view.runtime.source,
    ...(view.runtime.source === "global-worker"
      ? { workerRevision: view.runtime.workerRevision }
      : {}),
    effectiveRuntime: view.runtime,
    ...(view.runtime.status === "resolved"
      ? {
          agentId: view.runtime.binding.agentId,
          adapterId: view.runtime.binding.adapterId,
          model: view.runtime.binding.config.model,
          effort: view.runtime.binding.config.effort
        }
      : {})
  };
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
  return openCurrentTaskStore(home);
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

function emitControlFailure(message: string, code: string, details: unknown): void {
  process.exitCode = 2;
  process.stdout.write(`${jsonOutput
    ? JSON.stringify({ ok: false, code, message: message.trim(), details })
    : message.trim()}\n`);
}

/**
 * The human line for a live steer, corrected to the *actual* live acceptance
 * (decision-3 §7). The store command's `base` line is written optimistically
 * ("Steering …"); only a proven `steered` keeps it. `steer-unknown` (pending) is
 * delivery-unknown, and a rejected/unavailable steer did not deliver — in both
 * cases the Message is retained and the operator must not reissue. There is no
 * retarget, queue, or interrupt fallback here; this only reports.
 */
function steerReceiptOutput(
  base: string, target: string, messageId: string, receipt: SteerLiveReceipt
): string {
  if (receipt.state === "steered") return base;
  const detail = receipt.detail === undefined ? "" : ` ${receipt.detail}`;
  const head = receipt.state === "steer-unknown"
    ? `Steer message ${messageId} to ${target} is delivery-unknown (${receipt.outcome}): the Host `
      + "holds it but the Provider has not yet proven acceptance."
    : `Steer message ${messageId} to ${target} did not deliver (${receipt.outcome}).`;
  return `${head}${detail} The Message is retained; re-read the Session before acting, and do not `
    + "reissue the same input under a new requestId or a different action.\n";
}

/**
 * The human line for a live interrupt, corrected to `control.cancellation`
 * (decision-3 §7). Only a proven stop-request keeps the optimistic `base` line.
 * `not-active`/`unknown`/unavailable each report that nothing was proven stopped;
 * no process is ever killed. A then-handoff, if any, was already claimed durably
 * and is delivered once by the ordinary continuation path after a proven terminal.
 */
function interruptReceiptOutput(
  base: string, target: string, receipt: InterruptLiveReceipt
): string {
  if (receipt.state === "interrupt-requested") return `${base.trim()}\nNative cancel requested; Turn termination is not yet proven.\n`;
  const detail = receipt.detail === undefined ? "" : ` ${receipt.detail}`;
  const reason = receipt.state === "interrupt-not-active"
    ? "found no active Turn to stop (not-active)"
    : receipt.state === "interrupt-unknown"
      ? "could not prove a stop (unknown)"
      : `did not complete (${receipt.outcome})`;
  return `Interrupt of ${target} ${reason}.${detail} No process was killed; re-read the Session `
    + "before retrying.\n";
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
  // Existing immutable Session Manifests (through 0.15.8) name this entry.
  // Remove once those Sessions are retired; both names share one handler.
  if (normalized[0] === "task" && normalized[1] === "turn") normalized[1] = "run";
  if (normalized.length === 1 && (normalized[0] === "-v" || normalized[0] === "--version")) {
    return ["version"];
  }
  const help = normalized.findIndex((argument) => argument === "-h" || argument === "--help");
  return help === normalized.length - 1 ? ["help", ...normalized.slice(0, help)] : normalized;
}

export { renderCompletion };
