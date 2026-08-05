#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

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
  preserveReviewRoundWorkspace,
  runTaskCommand,
  validateTaskArchiveRequest
} from "./commands/taskCommands.js";
import { taskActor } from "./commands/taskActor.js";
import { runTaskIntegrationCommand } from "./commands/taskIntegrationCommands.js";
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
import { FileSchedulerStoreAdapter } from "./controller/fileSchedulerStoreAdapter.js";
import { cleanControllerResource } from "./controller/resourceCleanupLinux.js";
import { scanControllerResourceInventory } from "./controller/resourceInventoryLinux.js";
import { runSessionNotifyCommand } from "./controller/sessionNotify.js";
import { runClaudeLifecycleHookCommand } from "./controller/claudeLifecycleHook.js";
import { buildDoctorReport, renderDoctor, runDoctorCommand } from "./doctor/doctor.js";
import { agentNotFound, CliError, runtimeError, usageError } from "./errors/cliError.js";
import { FileRoleLaunchPlanner } from "./executor/fileRoleLaunchPlanner.js";
import {
  TaskWorkspaceCoordinator,
  WorkspaceCleanupBlockedError
} from "./repository/taskWorkspaceCoordinator.js";
import { FileTaskWorkspacePreparer } from "./repository/taskWorkspacePreparer.js";
import { inspectStorageSchema, requireStorageSchema } from "./storage/storageSchema.js";
import { FileTaskStore, resolveYuiHome } from "./storage/taskStore.js";
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

const VERSION = YUI_VERSION;
const rawArgs = process.argv.slice(2);
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
      new FileTaskStore(home),
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
    emit(renderDoctor(report.checks));
    return;
  }
  if (args[0] === "upgrade") {
    // Mirror doctor/controller: needs a Home but self-manages the schema check,
    // because upgrade must run against a non-current Home. Dispatched before the
    // unconditional requireStorageSchema gate below.
    const result = await runUpgradeCommand(args.slice(1), home);
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
    throw usageError("Internal lifecycle callback usage is invalid.");
  }

  if (args[0] === "controller") {
    const method = args[1];
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
    requireStorageSchema(home);
    const controllerMethod: "stop" | "restart" = method;
    const result = controllerMethod === "restart"
      ? await restartFileTaskController(home, { environment: process.env })
      : await stopFileTaskController(home, { environment: process.env });
    emit(renderControllerResult(controllerMethod, result));
    return;
  }

  requireStorageSchema(home);
  await assertFileTaskControllerStorageCompatible(home);
  const store = new FileTaskStore(home);
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
    const enteringTask =
      (resolved[1] === "enter")
      || (resolved[1] === "role" && resolved[2] === "enter");
    if (enteringTask) {
      await ensureFileTaskController(home, { environment: process.env });
      const taskId = resolved[1] === "enter" ? resolved[2] : resolved[3];
      const task = taskId === undefined ? null : store.getTask(taskId);
      if (task?.status === "active" && task.projectBindings.length > 0) {
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
    if (resolved[1] === "work" && resolved[2] === "capture") {
      const workItemId = resolved[3];
      if (workItemId === undefined || resolved.length !== 4) {
        throw usageError("Task work capture usage: yui task work capture <task>/<work>.");
      }
      const reference = cliWorkItemReference(workItemId, process.env);
      const changeSets = await new WorkItemChangeSetManager(store).capture(
        reference.taskId,
        reference.localId
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
        const workItemIds = store.listRoleWorkspaces(task.id)
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
    const candidateGitSnapshot = await candidateSnapshotForTaskCommand(
      resolved,
      store,
      workspacePreparer,
      process.env
    );
    const reviewWorkspaceResult = await reviewWorkspaceResultForTaskCommand(
      resolved,
      store,
      workspacePreparer,
      process.env
    );
    const result = runTaskCommand(
      resolved.slice(1),
      store,
      {
        runtime,
        environment: process.env,
        yuiHome: home,
        ...(workItemIntegrationProof === undefined ? {} : { workItemIntegrationProof }),
        ...(candidateGitSnapshot === undefined ? {} : { candidateGitSnapshot }),
        ...(reviewWorkspaceResult === undefined ? {} : { reviewWorkspaceResult }),
        ...(taskRetirementProof === undefined ? {} : { taskRetirementProof })
      }
    );
    if (result.kind === "output") {
      const requestedRound = reviewRoundFromCommandData(result.data);
      let reviewOutput = "";
      let reviewData: unknown;
      if (requestedRound?.status === "pending") {
        try {
          const workspace = await workspacePreparer.prepareReviewRoundWorkspace(
            requestedRound.taskId,
            requestedRound.id
          );
          const run = dispatchPreparedReviewRound(
            requestedRound.taskId,
            requestedRound.id,
            store,
            { runtime, environment: process.env, yuiHome: home }
          );
          reviewOutput = `Review queued as ${requestedRound.id} (${run.id})\n`;
          reviewData = {
            reviewRound: store.getReviewRound(requestedRound.taskId, requestedRound.id),
            reviewRun: run,
            workspace
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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
        if (created?.task?.id !== undefined
          && (created.task.projectBindings?.length ?? 0) > 0) {
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
  environment: NodeJS.ProcessEnv
) {
  if (args[0] !== "task" || store.getReviewConfig() === null) return undefined;
  if (args[1] === "run" && args[2] === "yield" && args[3] !== undefined) {
    const reference = cliTaskRecordReference(args[3], "agentRun", environment);
    const run = store.getAgentRun(reference.taskId, reference.localId);
    if (run === null || run.purpose !== "execution" || run.workItemId === undefined) {
      return undefined;
    }
    if (run.workspace === undefined) {
      throw usageError(`Reviewable Run has no managed Candidate workspace: ${run.id}.`);
    }
    return preparer.snapshotCandidateWorkspace(run.workspace);
  }
  if (args[1] === "work" && args[2] === "update"
    && args[3] !== undefined && args[4] === "done") {
    const reference = cliWorkItemReference(args[3], environment);
    const workspace = store.getRoleWorkspace(reference.taskId, "leader");
    if (workspace === null) {
      throw usageError(
        `Reviewable direct WorkItem has no managed Candidate workspace: ${reference.localId}.`
      );
    }
    return preparer.snapshotCandidateWorkspace(workspace);
  }
  return undefined;
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
  return preparer.snapshotReviewRoundResult(reference.taskId, run.reviewRoundId);
}

function reviewRoundFromCommandData(data: unknown): Readonly<{
  id: string;
  taskId: string;
  status: string;
}> | undefined {
  if (typeof data !== "object" || data === null || !("reviewRound" in data)) return undefined;
  const round = (data as { reviewRound?: unknown }).reviewRound;
  if (typeof round !== "object" || round === null) return undefined;
  const value = round as { id?: unknown; taskId?: unknown; status?: unknown };
  return typeof value.id === "string"
    && typeof value.taskId === "string"
    && typeof value.status === "string"
    ? { id: value.id, taskId: value.taskId, status: value.status }
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
  requireStorageSchema(home);
  const store = new FileTaskStore(home);
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
  requireStorageSchema(home);
  return new FileTaskStore(home);
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
