import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { AttemptAccess } from "../profile/agentProfile.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  AttemptCoordinator,
  attemptControlSocketPath
} from "../execution/attemptCoordinator.js";
import {
  CodexAppServerAttemptExecutor
} from "../execution/codexAppServerExecutor.js";
import {
  interruptExecutionAttempt,
  type ExecutionAttempt,
  type ExecutorKind
} from "../execution/executionAttempt.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";
import { configuredAgentLaunchEnvironment } from "../agent/launchEnvironment.js";
import { AttemptWorkspaceManager } from "../workspace/attemptWorkspaceManager.js";

export async function runTaskAttemptCommand(
  args: readonly string[],
  store: TaskStore,
  home: string,
  now: () => Date = () => new Date()
): Promise<Readonly<{ output: string; data?: unknown }>> {
  const [command, ...rest] = args;
  switch (command) {
    case "dispatch": return dispatch(rest, store, home, now);
    case "list": return list(rest, store);
    case "show": return show(rest, store);
    case "retry": return retry(rest, store, home, now);
    case "interrupt": return interrupt(rest, store, home, now);
    case "cleanup": return cleanup(rest, store, home);
    default:
      throw usageError(command === undefined
        ? "Task Attempt command is required."
        : `Unknown command: task attempt ${command}`);
  }
}

async function cleanup(
  args: readonly string[],
  store: TaskStore,
  home: string
): Promise<Readonly<{ output: string; data: unknown }>> {
  if (args.length !== 1) {
    throw usageError("Task Attempt cleanup usage: yui task attempt cleanup <attempt>.");
  }
  const attempt = requireAttempt(store, args[0]);
  if (attempt.state === "running") {
    throw usageError(`Execution Attempt is still running: ${attempt.id}.`);
  }
  if (attempt.access !== "write") {
    throw usageError(`Execution Attempt has no managed write worktree: ${attempt.id}.`);
  }
  const changeSetId = attempt.result?.changeSetId;
  if (
    changeSetId !== undefined
    && !store.listIntegrationAttempts(attempt.taskId).some((integration) => (
      integration.status === "committed"
      && integration.changeSetIds.includes(changeSetId)
    ))
  ) {
    throw usageError(
      `Execution Attempt ChangeSet is not integrated: ${changeSetId}. Integrate it before cleanup.`
    );
  }
  const result = await new AttemptWorkspaceManager(home, store).cleanup(attempt);
  if (result === "dirty") {
    throw usageError(
      `Execution Attempt worktree contains unintegrated changes or commits: ${
        attempt.id
      }. Inspect it before cleanup.`
    );
  }
  return {
    output: result === "removed"
      ? `Cleaned Execution Attempt worktree ${attempt.id}\n`
      : `Execution Attempt worktree already clean: ${attempt.id}\n`,
    data: { attemptId: attempt.id, cleanup: result }
  };
}

async function dispatch(
  args: readonly string[],
  store: TaskStore,
  home: string,
  now: () => Date
): Promise<Readonly<{ output: string; data: unknown }>> {
  const usage = "Task Attempt dispatch usage: yui task attempt dispatch <work> [--profile <id>] [--mode <auto|fork|session>] [--access <read|write>] [--input <text>] [--session-reason <text>].";
  const parsed = parse(args, new Set([
    "--profile", "--mode", "--access", "--input", "--session-reason"
  ]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const coordinator = new AttemptCoordinator(home, store, undefined, now);
  const result = await coordinator.dispatch({
    workItemId: parsed.positionals[0],
    ...(parsed.options.get("--profile") === undefined
      ? {}
      : { profileId: parsed.options.get("--profile") }),
    executor: parseMode(parsed.options.get("--mode") ?? "auto"),
    ...(parsed.options.get("--access") === undefined
      ? {}
      : { access: parseAccess(parsed.options.get("--access")) }),
    ...(parsed.options.get("--input") === undefined
      ? {}
      : { input: parsed.options.get("--input") }),
    ...(parsed.options.get("--session-reason") === undefined
      ? {}
      : { sessionReason: parsed.options.get("--session-reason") })
  });
  return {
    output: `Execution Attempt ${result.attempt.id} ${result.attempt.state}; Work Item ${result.workItem.status}\n`,
    data: result
  };
}

function list(
  args: readonly string[],
  store: TaskStore
): Readonly<{ output: string; data: unknown }> {
  if (args.length !== 1) throw usageError("Task Attempt list usage: yui task attempt list <task>.");
  const task = store.getTask(args[0]);
  if (task === null) throw usageError(`Task not found: ${args[0]}.`);
  const attempts = store.listExecutionAttempts(task.id);
  const output = attempts.length === 0
    ? "No Execution Attempts found.\n"
    : `${renderTable(
        `Execution Attempts: ${task.id}`,
        [
          { header: "Attempt", minWidth: 8, maxWidth: 24 },
          { header: "Work", minWidth: 6, maxWidth: 22 },
          { header: "Profile", minWidth: 7, maxWidth: 18 },
          { header: "Executor", minWidth: 8, maxWidth: 10 },
          { header: "Access", minWidth: 6, maxWidth: 8 },
          { header: "State", minWidth: 7, maxWidth: 18 }
        ],
        attempts.map((attempt) => [
          attempt.id,
          attempt.workItemId,
          `${attempt.profileId}@${attempt.profileRevision}`,
          attempt.executor,
          attempt.access,
          attempt.state
        ]),
        defaultTableWidth()
      )}\n`;
  return { output, data: { attempts } };
}

function show(
  args: readonly string[],
  store: TaskStore
): Readonly<{ output: string; data: unknown }> {
  if (args.length !== 1) throw usageError("Task Attempt show usage: yui task attempt show <attempt>.");
  const attempt = requireAttempt(store, args[0]);
  return {
    output: `${[
      `Execution Attempt: ${attempt.id}`,
      `Task: ${attempt.taskId}`,
      `Work Item: ${attempt.workItemId}`,
      `Profile: ${attempt.profileId}@${attempt.profileRevision}`,
      `Executor: ${attempt.executor}`,
      `Access: ${attempt.access}`,
      `State: ${attempt.state}`,
      `Base commit: ${attempt.baseCommit ?? "-"}`,
      `Session reason: ${attempt.sessionReason ?? "-"}`,
      `Provider session: ${attempt.providerRef?.sessionId ?? "-"}`,
      `Provider thread: ${attempt.providerRef?.threadId ?? "-"}`,
      `Provider turn: ${attempt.providerRef?.turnId ?? "-"}`,
      `Summary: ${attempt.result?.summary ?? "-"}`
    ].join("\n")}\n`,
    data: { attempt }
  };
}

async function retry(
  args: readonly string[],
  store: TaskStore,
  home: string,
  now: () => Date
): Promise<Readonly<{ output: string; data: unknown }>> {
  if (args.length !== 1) throw usageError("Task Attempt retry usage: yui task attempt retry <attempt>.");
  const previous = requireAttempt(store, args[0]);
  if (previous.state !== "failed" && previous.state !== "interrupted") {
    throw usageError(`Execution Attempt is not retryable from ${previous.state}: ${previous.id}.`);
  }
  const coordinator = new AttemptCoordinator(home, store, undefined, now);
  const result = await coordinator.dispatch({
    workItemId: previous.workItemId,
    profileId: previous.profileId,
    profileRevision: previous.profileRevision,
    executor: previous.executor,
    access: previous.access,
    exactInput: previous.input,
    ...(previous.executor === "session"
      ? { sessionReason: `Retry of ${previous.id}: ${previous.sessionReason ?? "independent ownership"}` }
      : {})
  });
  return {
    output: `Retried ${previous.id} as ${result.attempt.id}: ${result.attempt.state}\n`,
    data: result
  };
}

async function interrupt(
  args: readonly string[],
  store: TaskStore,
  home: string,
  now: () => Date
): Promise<Readonly<{ output: string; data: unknown }>> {
  if (args.length !== 1) throw usageError("Task Attempt interrupt usage: yui task attempt interrupt <attempt>.");
  let attempt = requireAttempt(store, args[0]);
  if (attempt.state !== "running") {
    throw usageError(`Execution Attempt is not running: ${attempt.id}.`);
  }
  attempt = interruptExecutionAttempt(attempt, "Interrupted by user.", now());
  store.transaction((tx) => {
    tx.saveExecutionAttempt(attempt.taskId, attempt);
    const item = tx.getWorkItem(attempt.taskId, attempt.workItemId);
    if (item !== null) {
      tx.saveWorkItem(
        attempt.taskId,
        updateWorkItemStatus(item, "failed", now(), "Execution Attempt interrupted by user.")
      );
    }
  });
  let providerWarning: string | undefined;
  if (attempt.providerRef?.turnId !== undefined) {
    try {
      const profile = store.getAgentProfileRevision(attempt.profileId, attempt.profileRevision);
      if (profile === null) {
        throw new Error(
          `Execution Attempt Agent Profile revision is unavailable: ${
            attempt.profileId
          }/${attempt.profileRevision}.`
        );
      }
      const configuredAgent = store.getConfiguredAgent(profile.agentId);
      if (configuredAgent === null) {
        throw new Error(`Execution Attempt Configured Agent not found: ${profile.agentId}.`);
      }
      await new CodexAppServerAttemptExecutor(
        configuredAgent.command,
        configuredAgentLaunchEnvironment(configuredAgent, process.env),
        configuredAgent.baseArgs
      ).interrupt(
        attempt.providerRef.threadId,
        attempt.providerRef.turnId,
        attemptControlSocketPath(home, attempt.id)
      );
    } catch (error) {
      providerWarning = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    output: `Interrupted Execution Attempt ${attempt.id}${
      providerWarning === undefined ? "" : `; provider interrupt was best-effort: ${providerWarning}`
    }\n`,
    data: {
      attempt,
      ...(providerWarning === undefined ? {} : { providerWarning })
    }
  };
}

function requireAttempt(store: TaskStore, id: string): ExecutionAttempt {
  const attempt = store.findExecutionAttempt(id);
  if (attempt === null) throw usageError(`Execution Attempt not found: ${id}.`);
  return attempt;
}

function parseMode(value: string): "auto" | ExecutorKind {
  if (value === "auto" || value === "fork" || value === "session") {
    return value;
  }
  throw usageError(`Invalid Attempt mode: ${value}.`);
}

function parseAccess(value: string | undefined): AttemptAccess {
  if (value === "read" || value === "write") return value;
  throw usageError(`Invalid Attempt access: ${String(value)}.`);
}

function parse(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  usage: string
): Readonly<{ positionals: string[]; options: Map<string, string> }> {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!allowed.has(value)) throw usageError(`Unsupported option: ${value}.`, usage);
    if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options };
}
