#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { renderCommandHelp } from "./cli/helpRenderer.js";
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
import {
  parseControllerCleanupOptions,
  parseControllerStatusOptions,
  renderControllerResourceStatus,
  runInteractiveControllerCleanup
} from "./commands/controllerCommands.js";
import { runJobCommand } from "./commands/jobCommands.js";
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
  RESUMED_PENDING_FINAL_REVIEW,
  TERMINALIZED_LEADER_BEFORE_FINAL_REVIEW,
  TaskFinalReviewDispatchDriftError,
  preserveReviewRoundWorkspace,
  parseTaskCompletionRequest,
  preflightTaskCompletion,
  runTaskCommand,
  normalizedExecutionLanePlan,
  validateTaskArchiveRequest
} from "./commands/taskCommands.js";
import { taskActor } from "./commands/taskActor.js";
import { runTaskIntegrationCommand } from "./commands/taskIntegrationCommands.js";
import { runTaskChangeSetCommand } from "./commands/taskChangeSetCommands.js";
import { runTaskOverlapCommand } from "./commands/taskOverlapCommands.js";
import { runTaskWorkspaceCommand } from "./commands/taskWorkspaceCommands.js";
import { reconcileTaskRemoteBaselines } from "./commands/taskCompletionGate.js";
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
import { runClaudeLifecycleHookCommand } from "./controller/claudeLifecycleHook.js";
import { runCodexLifecycleHookCommand } from "./controller/codexLifecycleHook.js";
import { buildDoctorReport, renderDoctor, runDoctorCommand } from "./doctor/doctor.js";
import { agentNotFound, CliError, runtimeError, usageError } from "./errors/cliError.js";
import { FileRoleLaunchPlanner } from "./executor/fileRoleLaunchPlanner.js";
import {
  TaskWorkspaceCoordinator,
  WorkspaceCleanupBlockedError
} from "./repository/taskWorkspaceCoordinator.js";
import {
  FileTaskWorkspacePreparer,
  ReviewRoundWorkspaceEvidenceError
} from "./repository/taskWorkspacePreparer.js";
import { inspectStorageSchema } from "./storage/storageSchema.js";
import { type FileTaskStore, resolveYuiHome } from "./storage/taskStore.js";
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
import {
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR,
  assertExactControlPlanePreflight,
  assertExactTaskRuntimeEnvironment,
  assertExactTaskRuntimeState,
  exactControlPlaneDigest,
  extractExactControlArgument,
  parseExactControlPlaneDescriptor
} from "./runtime/exactControlPlane.js";
import {
  createTaskFinalReviewContract,
  extractTaskFinalReviewRequest,
  type TaskFinalReviewContract
} from "./review/taskFinalReviewContract.js";
import type { TaskReviewCandidate } from "./review/reviewRound.js";
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
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${jsonOutput
    ? JSON.stringify({ ok: false, code: "RUNTIME_ERROR", message, details: {} })
    : `RUNTIME_ERROR: ${message}`}\n`);
  process.exitCode = 5;
});

export async function main(): Promise<void> {
  const taskFinalReviewContract = await preflightManagedTaskControlPlane();
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

  const home = resolveYuiHome(process.env);
  if (args[0] === "completion") {
    await completionCommand(home, invocation.node);
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
  if (args[0] === "upgrade") {
    // Mirror doctor/controller: needs a Home but self-manages the schema check,
    // because upgrade must run against a non-current Home.
    const result = await runUpgradeCommand(
      args.slice(1),
      home,
      process.env.YUI_UPDATE_EXTERNALLY_QUIESCED === "1"
        ? { controllerLifecycle: "externally-quiesced" }
        : {}
    );
    process.exitCode = result.exitCode;
    emit(result.output, false, result.data);
    return;
  }
  if (args[0] === "internal") {
    if (args[1] === "session-notify" && args.length === 3) {
      await runSessionNotifyCommand(args[2], process.env);
      return;
    }
    if (args[1] === "claude-hook" && args.length === 2) {
      await runClaudeLifecycleHookCommand(readFileSync(0, "utf8"), process.env);
      return;
    }
    if (args[1] === "codex-hook" && args.length === 2) {
      await runCodexLifecycleHookCommand(readFileSync(0, "utf8"), process.env);
      return;
    }
    throw usageError("Internal lifecycle callback usage is invalid.");
  }

  if (args[0] === "controller") {
    const method = args[1];
    if (method === "identity" && args.length === 2) {
      // Internal lifecycle seam used by update/upgrade. The Controller socket
      // authenticates this exact launch identity; public `controller status`
      // intentionally redacts argv in its resource inventory.
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
    const result = controllerMethod === "restart"
      ? await restartFileTaskController(home, { environment: process.env })
      : await stopFileTaskController(home, { environment: process.env });
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

  await assertFileTaskControllerStorageCompatible(home);
  const store = openCompatibleFileTaskStore(home);
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
    process.env.YUI_TMUX_BIN ?? "tmux",
    executor,
    {
      yuiHome: home,
      terminalInput: process.stdin,
      onWarning: (message) => process.stderr.write(`Warning: ${message}\n`)
    }
  );
  const schedulerStore = new FileSchedulerStoreAdapter(store);
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
      tmuxBin: process.env.YUI_TMUX_BIN ?? "tmux",
      tmux,
      prepareTaskRole: (input) => runtime.prepareTaskRoleEnter(input),
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

  if (resolved[0] === "agent") {
    const agentArgs = resolved.slice(1);
    if (agentArgs[0] === "capabilities") {
      if (agentArgs.length !== 2) {
        throw usageError("Agent capabilities usage: yui agent capabilities <agent-id>");
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
  if (resolved[0] === "config") {
    const configArgs = resolved.slice(1);
    const output = runConfigCommand(configArgs, store);
    if (
      configArgs[0] === "set"
      && configArgs[1] === "--reconciliation-interval-seconds"
    ) {
      const refresh = await refreshRunningFileTaskControllerConfiguration(
        home,
        { environment: process.env }
      );
      emit(withControllerRefreshWarning(output, refresh, "Controller configuration"));
      return;
    }
    emit(output);
    return;
  }
  if (resolved[0] === "project") {
    const result = await runProjectCommand(resolved.slice(1), store);
    emit(result.output, false, result.data);
    return;
  }
  if (resolved[0] === "profile") {
    const result = runProfileCommand(resolved.slice(1), store);
    emit(result.output, false, result.data);
    return;
  }
  if (resolved[0] === "role") {
    const roleOptions: GlobalRoleCommandOptions = {
      yuiHome: home,
      env: process.env
    };
    const result = runGlobalRoleCommand(
      resolved.slice(1),
      store as unknown as Parameters<typeof runGlobalRoleCommand>[1],
      roleOptions
    );
    if (typeof result === "string") {
      emit(result);
      return;
    }
    await ensureFileTaskController(home, { environment: process.env });
    await runtime.prepareGlobalRoleEnter(result.role.name);
    tmux.attachRole("operator", result.role.name);
    return;
  }
  if (resolved[0] === "operator") {
    if (resolved[1] === "enter") {
      if (resolved.length !== 2) throw usageError("Operator enter usage: yui operator enter.");
      await ensureFileTaskController(home, { environment: process.env });
      await runtime.prepareGlobalRoleEnter("operator");
      tmux.attachRole("operator", "operator");
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
        { environment: process.env }
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
    const enteringTask =
      (resolved[1] === "enter")
      || (resolved[1] === "role" && resolved[2] === "enter");
    if (enteringTask) {
      await ensureFileTaskController(home, { environment: process.env });
      const taskId = resolved[1] === "enter" ? resolved[2] : resolved[3];
      const task = taskId === undefined ? null : store.getTask(taskId);
      if (task?.status === "active") {
        await workspacePreparer.prepareTaskWorkspace(task.id);
      }
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
      const actor = taskActor(process.env, reference.taskId);
      if (actor === "operator") {
        throw usageError(
          "Only the Task Leader may clean a WorkItem from a managed Session."
        );
      }
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
    let executionLaneWorkspaces = await prepareExecutionLaneWorkspacesForCommand(
      resolved,
      store,
      workspacePreparer,
      process.env
    );
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
    if (resolved[1] === "complete" && resolved[2] !== undefined) {
      const completionRequest = parseTaskCompletionRequest(resolved.slice(2));
      completionSummary = completionRequest.summary;
      const completion = preflightTaskCompletion(resolved[2], store, {
        environment: process.env,
        ...(taskFinalReviewContract === undefined
          ? {}
          : { taskFinalReviewContract })
      });
      if (!completion.completed && !completion.activeTaskReview) {
        await reconcileTaskRemoteBaselines(
          resolved[2],
          store,
          home,
          { environment: process.env }
        );
      }
    }
    let candidateMaterialization: Awaited<ReturnType<typeof candidateMaterializationForTaskCommand>>;
    let candidateMaterializationCommitted = false;
    try {
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
        process.env,
        taskFinalReviewContract
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
          ...(workItemIntegrationProof === undefined ? {} : { workItemIntegrationProof }),
          ...(candidateGitSnapshot === undefined ? {} : { candidateGitSnapshot }),
          ...(candidateMaterialization === undefined
            ? {}
            : { candidateWorkspace: candidateMaterialization.workspace ?? null }),
          ...(executionLaneWorkspaces === undefined ? {} : { executionLaneWorkspaces }),
          ...(directTaskMainSnapshot === undefined ? {} : { directTaskMainSnapshot }),
          ...(actualTaskReviewCandidate === undefined
            ? {}
            : { actualTaskReviewCandidate }),
          ...(reviewWorkspaceResult === undefined ? {} : { reviewWorkspaceResult }),
          ...(laneSnapshotPreflight === undefined ? {} : { executionLaneGitSnapshot: laneSnapshotPreflight }),
          ...(taskRetirementProof === undefined ? {} : { taskRetirementProof })
        }
      );
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
        const reviewDispatchNeeded = requestedRound?.status === "pending"
          || (requestedRound?.status === "running"
            && resolved[1] === "review"
            && resolved[2] === "request"
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
                ...(executionLaneWorkspaces === undefined ? {} : { executionLaneWorkspaces })
              }
            );
            reviewOutput = `Review queued as ${requestedRound.id} (${run.id})\n`;
            reviewData = {
              reviewRound: store.getReviewRound(requestedRound.taskId, requestedRound.id),
              reviewRun: run,
              workspace
            };
          } catch (error) {
            const currentRound = store.getReviewRound(
              requestedRound.taskId,
              requestedRound.id
            );
            if (requestedRound.resumedPendingFinalReview
              && !requestedRound.terminalizedLeaderRun
              && (error instanceof ReviewRoundWorkspaceEvidenceError
                || error instanceof TaskFinalReviewDispatchDriftError)
              && (currentRound?.scope ?? "work-item") === "task") {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            await workspacePreparer.discardUnadoptedExecutionLaneWorkspaces(
              executionLaneWorkspaces
            );
            const failed = failPendingReviewRound(
              requestedRound.taskId,
              requestedRound.id,
              message,
              store,
              { runtime, environment: process.env, yuiHome: home }
            );
            reviewOutput = `Review could not start: ${message}\n`;
            reviewData = { reviewRound: failed };
          }
        }
        if (resolved[1] === "create") {
          const created = result.data as {
            task?: { id?: string; projectBindings?: readonly unknown[] }
          } | undefined;
          if (created?.task?.id !== undefined) {
            let workspace;
            try {
              workspace = await workspacePreparer.prepareTaskWorkspace(created.task.id);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              workspace = {
                taskId: created.task.id,
                status: "failed" as const,
                error: message
              };
            }
            const latest = store.getTask(created.task.id);
            const leader = store.getRole(created.task.id, "leader");
            if (latest !== null && leader !== null) {
              const warning = workspace.status === "failed"
                ? `Main worktree is not ready: ${workspace.error ?? "unknown error"}.\n`
                  + `After correcting the Git problem, run yui task reconcile ${created.task.id}.\n`
                : "";
              emit(`${result.output}${warning}`, false, {
                ...created,
                task: latest,
                leader,
                workspace
              });
              return;
            }
          }
        }
        if (resolved[1] === "activate") {
          const taskId = resolved[2];
          const task = taskId === undefined ? null : store.getTask(taskId);
          if (task?.status === "active") {
            await workspacePreparer.prepareTaskWorkspace(task.id);
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
      await runtime.prepareTaskRoleEnter({
        taskId: result.taskId,
        roleName: result.roleName
      });
      if (result.output !== undefined) emit(result.output);
      tmux.attachRole(result.taskId, result.roleName);
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
      throw error;
    }
  }
  if (resolved[0] === "jobs") {
    emit(runJobCommand(resolved.slice(1), store, { runtime }));
    return;
  }

  throw usageError(
    `Command is not connected to the restored FileTaskStore framework yet: ${resolved[0]}.`,
    renderCommandHelp(invocation.node, VERSION)
  );
}

async function preflightManagedTaskControlPlane(): Promise<
  TaskFinalReviewContract | undefined
> {
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
    if (exactControlInvocation.digest !== undefined) {
      throw new Error("Exact Task control-plane invocation requires its frozen runtime descriptors.");
    }
    if (taskFinalReviewInvocation.request !== undefined) {
      throw new Error(
        "Task final-review contract requires a verified exact Task control-plane invocation."
      );
    }
    return undefined;
  }
  if (process.env.YUI_SESSION_SCOPE !== "task") {
    throw new Error("Exact Task control-plane invocation requires a managed Task runtime.");
  }
  if (serializedControl === undefined || serializedRuntime === undefined) {
    throw new Error("Exact control-plane invocation is required for this managed Task runtime.");
  }
  const control = parseExactControlPlaneDescriptor(serializedControl);
  const internalCallback = args[0] === "internal";
  if (!internalCallback && exactControlInvocation.digest === undefined) {
    throw new Error(
      "Exact control-plane invocation is required; bare `yui` and PATH launchers are not valid in a managed Task runtime."
    );
  }
  const digest = exactControlInvocation.digest ?? exactControlPlaneDigest(control);
  await assertExactControlPlanePreflight({
    serializedDescriptor: serializedControl,
    digest,
    actualExecutable: process.execPath,
    actualCliEntry: fileURLToPath(import.meta.url),
    actualHome: resolveYuiHome(process.env)
  }, {
    // Provider callbacks must remain able to append their immutable inbox fact
    // while the Controller is offline. They still validate executable, CLI,
    // Home, build, schema, and the exact Task runtime envelope first.
    checkController: !internalCallback
  });
  const runtime = assertExactTaskRuntimeEnvironment(
    serializedRuntime,
    process.env,
    digest,
    control.yuiHome
  );
  const preallocatedClaudeCallback = args.length === 2
    && args[0] === "internal"
    && args[1] === "claude-hook";
  assertExactTaskRuntimeState(
    runtime,
    openCompatibleFileTaskStore(control.yuiHome),
    preallocatedClaudeCallback
      ? { preallocatedNativeSessionReservation: { yuiHome: control.yuiHome } }
      : {}
  );
  const request = taskFinalReviewInvocation.request;
  if (request === undefined) return undefined;
  if (runtime.roleName !== "leader") {
    throw new Error("Only the exact Task Leader invocation may establish a final-review contract.");
  }
  if (request.taskId !== runtime.taskId) {
    throw new Error(
      `Task final-review contract Task id mismatch: expected ${runtime.taskId}, found ${request.taskId}.`
    );
  }
  return createTaskFinalReviewContract({
    taskId: runtime.taskId,
    reviewerRoleName: request.reviewerRoleName,
    controlPlaneDigest: digest
  });
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
  store: FileTaskStore,
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
  store: FileTaskStore,
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
  const selected = args.flatMap((value, index) => value === "--lane" && args[index + 1] !== undefined ? [args[index + 1]!] : []);
  try {
    return await preparer.materializeExecutionGroupCandidate(
      item.taskId,
      item.id,
      group.id,
      selected
    );
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

async function prepareExecutionLaneWorkspacesForCommand(
  args: readonly string[],
  store: FileTaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv
): Promise<ReadonlyMap<string, import("./worktree/managedWorkspace.js").ManagedWorkspace> | undefined> {
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
  const strategyArg = args.find((value) => value.startsWith("adaptive:") || value.startsWith("fixed:"));
  const adaptive = strategyArg?.startsWith("adaptive:") === true || group?.strategy.mode === "adaptive";
  const needsIsolation = adaptive || laneCount > 1 || (group?.lanes.length ?? 0) > 1;
  if (!needsIsolation) return undefined;
  const groupId = group?.id ?? `execution-group-${store.peekNextAgentRunId(item.taskId)}`;
  const laneIds = plan.laneIds;
  const map = new Map<string, import("./worktree/managedWorkspace.js").ManagedWorkspace>();
  try {
    for (const laneId of laneIds.filter((value) => value.length > 0)) {
      map.set(laneId, await preparer.prepareExecutionLaneWorkspace(item.taskId, groupId, laneId, {
        purpose: "execution",
        workItemId: item.id
      }));
    }
  } catch (error) {
    await preparer.discardUnadoptedExecutionLaneWorkspaces(map);
    throw error;
  }
  return map;
}

async function prepareReviewLaneWorkspaces(
  taskId: string,
  reviewRoundId: string,
  store: FileTaskStore,
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
  store: FileTaskStore,
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
  store: FileTaskStore,
  preparer: FileTaskWorkspacePreparer,
  environment: NodeJS.ProcessEnv,
  taskFinalReviewContract?: TaskFinalReviewContract
): Promise<TaskReviewCandidate | undefined> {
  if (args[0] !== "task") return undefined;
  let taskId: string | undefined;
  if (args[1] === "complete" && args[2] !== undefined) {
    const task = store.getTask(args[2]);
    if (task === null || task.status !== "active" || task.projectBindings.length === 0) {
      return undefined;
    }
    const establishedFinalRound = store.listReviewRounds(task.id).some((round) => (
      (round.scope ?? "work-item") === "task"
    ));
    if (taskFinalReviewContract === undefined
      && store.getReviewConfig()?.trigger !== "final"
      && !establishedFinalRound) {
      return undefined;
    }
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
  }
  if (taskId === undefined || store.getTask(taskId)?.status !== "active") return undefined;
  return snapshotActualTaskReviewCandidate(taskId, store, preparer);
}

async function snapshotActualTaskReviewCandidate(
  taskId: string,
  store: FileTaskStore,
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

async function reviewWorkspaceResultForTaskCommand(
  args: readonly string[],
  store: FileTaskStore,
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
  store: FileTaskStore,
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
  status: string;
  resumedPendingFinalReview: boolean;
  terminalizedLeaderRun: boolean;
}> | undefined {
  if (typeof data !== "object" || data === null || !("reviewRound" in data)) return undefined;
  const round = (data as { reviewRound?: unknown }).reviewRound;
  if (typeof round !== "object" || round === null) return undefined;
  const value = round as { id?: unknown; taskId?: unknown; status?: unknown };
  return typeof value.id === "string"
    && typeof value.taskId === "string"
    && typeof value.status === "string"
    ? {
        id: value.id,
        taskId: value.taskId,
        status: value.status,
        resumedPendingFinalReview: (
          data as { [RESUMED_PENDING_FINAL_REVIEW]?: unknown }
        )[RESUMED_PENDING_FINAL_REVIEW] === true,
        terminalizedLeaderRun: (
          data as { [TERMINALIZED_LEADER_BEFORE_FINAL_REVIEW]?: unknown }
        )[TERMINALIZED_LEADER_BEFORE_FINAL_REVIEW] === true
      }
    : undefined;
}

async function executeOperatorSessionControl(
  control: OperatorSessionControl,
  home: string,
  store: FileTaskStore,
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
    tmux.attachRole("operator", "operator");
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
          resolution.args.slice(1),
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
  tmux.attachRole("operator", role.name);
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
  if (args[1] === "candidates") {
    const separator = args.indexOf("--");
    const prefix = args[2];
    if (prefix === undefined || separator !== 3) {
      throw usageError("Completion candidates usage: yui completion candidates <prefix> -- <words...>");
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
  const shell = completionShell(args[1]);
  if (args.length > (shell === undefined ? 1 : 2)) {
    throw usageError("Completion usage: yui completion [bash|zsh|fish]");
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
  store: FileTaskStore,
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
      (operatorArgs[0] === "role" && operatorArgs[1] === "add")
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
  store: FileTaskStore,
  catalogs: AgentConfigurationCatalogService
): SelectionPorts {
  return {
    call: (method, params) => selectionCall(store, catalogs, method, params)
  };
}

async function preflightAgentConfigurationMutation(
  commandArgs: readonly string[],
  store: FileTaskStore,
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
  const operation = args[0] === "role"
    || (args[0] === "task" && args[1] === "role");
  return operation && [
    "--model", "--effort", "--clear-model", "--clear-effort"
  ].some((option) => args.includes(option));
}

function configurationMutationAgentId(
  args: readonly string[],
  store: FileTaskStore
): string | undefined {
  const explicit = optionValue(args, "--agent");
  if (explicit !== undefined) return explicit;
  if (args[0] === "role" && args[1] === "update") {
    return store.getGlobalRole(args[2] ?? "")?.activeAgentId;
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
  store: FileTaskStore,
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

function presentSelectionTimes(value: unknown, store: FileTaskStore): unknown {
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

function readableStore(home: string): FileTaskStore {
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
