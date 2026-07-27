import { NodeGitWorkspace } from "../repository/gitWorkspace.js";
import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  createIntegrationAttempt,
  recordResolutionDecision,
  updateIntegrationAttempt,
  type IntegrationAttempt
} from "../integration/integrationAttempt.js";
import { GitIntegrationService } from "../integration/gitIntegrationService.js";
import { taskActor } from "./taskActor.js";

export type TaskIntegrationCommandOptions = Readonly<{
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
}>;

export async function runTaskIntegrationCommand(
  args: readonly string[],
  store: TaskStore,
  home: string,
  options: TaskIntegrationCommandOptions = {}
): Promise<Readonly<{ output: string; data?: unknown }>> {
  const now = options.now ?? (() => new Date());
  const [command, ...rest] = args;
  if (command === "start") return start(rest, store, home, now);
  if (command === "continue") return continueIntegration(rest, store, home, now);
  if (command === "resolve") {
    return resolveDecision(rest, store, now, options.environment);
  }
  if (command === "abort") return abortIntegration(rest, store, now());
  if (command === "cleanup") return cleanupIntegration(rest, store, home);
  if (command === "list") return list(rest, store);
  if (command === "show") return show(rest, store);
  throw usageError(command === undefined
    ? "Task Integration command is required."
    : `Unknown command: task integration ${command}`);
}

async function cleanupIntegration(
  args: readonly string[],
  store: TaskStore,
  home: string
): Promise<Readonly<{ output: string; data: unknown }>> {
  if (args.length !== 1) {
    throw usageError(
      "Task Integration cleanup usage: yui task integration cleanup <integration>."
    );
  }
  const integration = requireIntegration(store, args[0]);
  if (integration.status !== "committed" && integration.status !== "failed") {
    throw usageError(
      `Integration is not terminal: ${integration.id}/${integration.status}.`
    );
  }
  const result = await new GitIntegrationService(home, store).cleanup(integration);
  if (result === "dirty") {
    throw usageError(
      `Integration worktree contains unresolved or uncommitted changes: ${
        integration.id
      }. Inspect it before cleanup.`
    );
  }
  return {
    output: result === "removed"
      ? `Cleaned Integration worktree and check logs ${integration.id}\n`
      : `Integration worktree and check logs already clean: ${integration.id}\n`,
    data: { integrationId: integration.id, cleanup: result }
  };
}

async function start(
  args: readonly string[],
  store: TaskStore,
  home: string,
  now: () => Date
): Promise<Readonly<{ output: string; data: unknown }>> {
  const usage = "Task Integration start usage: yui task integration start <task> --change-set <id> [--change-set <id> ...] [--target <ref>] [--check <command> ...].";
  const parsed = parseRepeatable(args, new Set(["--change-set", "--check"]), new Set(["--target"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const task = store.getTask(parsed.positionals[0]);
  if (task === null) throw usageError(`Task not found: ${parsed.positionals[0]}.`);
  if (task.status !== "active") {
    throw usageError(`Task is not active: ${task.id}/${task.status}.`);
  }
  if (task.projectId === undefined) throw usageError(`Task has no Project: ${task.id}.`);
  const project = store.getProject(task.projectId);
  if (project === null) throw usageError(`Project not found: ${task.projectId}.`);
  const changeSetIds = parsed.many.get("--change-set") ?? [];
  if (changeSetIds.length === 0) throw usageError("--change-set is required.", usage);
  for (const id of changeSetIds) {
    const changeSet = store.getChangeSet(task.id, id);
    if (changeSet === null) throw usageError(`ChangeSet not found: ${id}.`);
    if (changeSet.projectId !== project.id) {
      throw usageError(`ChangeSet belongs to another Project: ${id}.`);
    }
  }
  const mainWorkspace = store.getRoleWorkspace(task.id, "leader");
  const targetRef = parsed.one.get("--target") ?? mainWorkspace?.branch;
  if (targetRef === undefined) {
    throw usageError(`Task main worktree is not ready; reconcile the Task first: ${task.id}.`);
  }
  const expectedHead = (await new NodeGitWorkspace().inspect(project.path, targetRef)).baseCommit;
  const integration = createIntegrationAttempt({
    id: store.nextIntegrationAttemptId(task.id),
    taskId: task.id,
    targetRef,
    expectedHead,
    changeSetIds,
    checkCommands: parsed.many.get("--check") ?? []
  }, now());
  store.saveIntegrationAttempt(task.id, integration);
  return runIntegration(store, home, integration, now);
}

async function continueIntegration(
  args: readonly string[],
  store: TaskStore,
  home: string,
  now: () => Date
): Promise<Readonly<{ output: string; data: unknown }>> {
  const usage = "Task Integration continue usage: yui task integration continue <integration>.";
  const parsed = parseRepeatable(args, new Set(), new Set(), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0]);
  requireActiveIntegrationTask(store, integration);
  if (
    integration.status !== "validating"
    && (
      integration.status !== "blocked"
      || integration.resolution?.action !== "manual-resolution"
    )
  ) {
    throw usageError(`Integration is not ready to continue: ${integration.id}/${integration.status}.`);
  }
  return runIntegration(store, home, integration, now);
}

async function runIntegration(
  store: TaskStore,
  home: string,
  integration: IntegrationAttempt,
  now: () => Date
): Promise<Readonly<{ output: string; data: unknown }>> {
  const result = await new GitIntegrationService(home, store, undefined, now)
    .integrate(integration.id);
  const output = result.status === "committed"
    ? `Integrated ${result.attempt.changeSetIds.join(", ")} into ${result.attempt.targetRef} with CAS (${result.attempt.id})\n`
    : result.status === "blocked"
      ? `Integration ${result.attempt.id} requires a Leader resolution decision in ${result.workspace.path}\n`
      : `Integration ${result.attempt.id} failed; target ref was not advanced\n`;
  return { output, data: result };
}

function resolveDecision(
  args: readonly string[],
  store: TaskStore,
  now: () => Date,
  environment: NodeJS.ProcessEnv | undefined
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration resolve usage: yui task integration resolve <integration> --option <manual-resolution|reject> --rationale <text>.";
  const parsed = parseRepeatable(args, new Set(), new Set(["--option", "--rationale"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0]);
  const task = requireActiveIntegrationTask(store, integration);
  if (taskActor(environment, task.id) !== "leader") {
    throw usageError("Only the Task Leader can resolve an Integration conflict.");
  }
  const selectedOption = parsed.one.get("--option");
  const rationale = parsed.one.get("--rationale");
  if (selectedOption === undefined || rationale === undefined) throw usageError(usage);
  const resolved = recordResolutionDecision(integration, {
    action: selectedOption as "manual-resolution" | "reject",
    rationale
  }, now());
  store.saveIntegrationAttempt(resolved.taskId, resolved);
  return {
    output: selectedOption === "manual-resolution"
      ? `Leader selected manual resolution for ${resolved.id}; resolve its candidate worktree, then run integration continue\n`
      : `Leader rejected Integration ${resolved.id}\n`,
    data: { integration: resolved }
  };
}

function abortIntegration(
  args: readonly string[],
  store: TaskStore,
  now: Date
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration abort usage: yui task integration abort <integration> --reason <text>.";
  const parsed = parseRepeatable(args, new Set(), new Set(["--reason"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0]);
  requireActiveIntegrationTask(store, integration);
  if (integration.status !== "running" && integration.status !== "blocked") {
    throw usageError(
      `Integration cannot be aborted from ${integration.status}: ${integration.id}.`
    );
  }
  const reason = parsed.one.get("--reason");
  if (reason === undefined) throw usageError(usage);
  const aborted = updateIntegrationAttempt(integration, {
    status: "failed",
    checks: [
      ...(integration.checks ?? []),
      { name: "aborted", outcome: "failed", details: reason }
    ]
  }, now);
  store.saveIntegrationAttempt(aborted.taskId, aborted);
  return {
    output: `Aborted Integration ${aborted.id}; start a new Integration Attempt to retry\n`,
    data: { integration: aborted }
  };
}

function requireActiveIntegrationTask(
  store: TaskStore,
  integration: IntegrationAttempt
) {
  const task = store.getTask(integration.taskId);
  if (task === null) throw usageError(`Task not found: ${integration.taskId}.`);
  if (task.status !== "active") {
    throw usageError(`Task is not active: ${task.id}/${task.status}.`);
  }
  return task;
}

function list(
  args: readonly string[],
  store: TaskStore
): Readonly<{ output: string; data: unknown }> {
  if (args.length !== 1) throw usageError("Task Integration list usage: yui task integration list <task>.");
  const task = store.getTask(args[0]);
  if (task === null) throw usageError(`Task not found: ${args[0]}.`);
  const integrations = store.listIntegrationAttempts(task.id);
  const output = integrations.length === 0
    ? "No Integration Attempts found.\n"
    : `${renderTable(
        `Integration Attempts: ${task.id}`,
        [
          { header: "Integration", minWidth: 11, maxWidth: 24 },
          { header: "Target", minWidth: 8, maxWidth: 30 },
          { header: "Changes", minWidth: 7, maxWidth: 10 },
          { header: "Status", minWidth: 7, maxWidth: 20 }
        ],
        integrations.map((entry) => [
          entry.id,
          entry.targetRef,
          String(entry.changeSetIds.length),
          entry.status
        ]),
        defaultTableWidth()
      )}\n`;
  return { output, data: { integrations } };
}

function show(
  args: readonly string[],
  store: TaskStore
): Readonly<{ output: string; data: unknown }> {
  if (args.length !== 1) throw usageError("Task Integration show usage: yui task integration show <integration>.");
  const integration = requireIntegration(store, args[0]);
  return {
    output: `${[
      `Integration Attempt: ${integration.id}`,
      `Task: ${integration.taskId}`,
      `Target: ${integration.targetRef}`,
      `Expected head: ${integration.expectedHead}`,
      `Candidate: ${integration.candidateCommit ?? "-"}`,
      `ChangeSets: ${integration.changeSetIds.join(", ")}`,
      `Status: ${integration.status}`,
      `Conflict: ${integration.conflict?.summary ?? "-"}`,
      `Resolution: ${integration.resolution?.action ?? "-"}`,
      ...(integration.checks === undefined
        ? ["Checks: -"]
        : [
            "Checks:",
            ...integration.checks.flatMap((check) => [
              `- ${check.outcome}: ${check.name}`,
              ...(check.details === undefined ? [] : [`  ${check.details}`]),
              ...(check.logPath === undefined ? [] : [`  Log: ${check.logPath}`])
            ])
          ])
    ].join("\n")}\n`,
    data: { integration }
  };
}

function requireIntegration(store: TaskStore, id: string): IntegrationAttempt {
  const matches = store.listTasks().flatMap((task) => {
    const attempt = store.getIntegrationAttempt(task.id, id);
    return attempt === null ? [] : [attempt];
  });
  if (matches.length !== 1) throw usageError(`Integration Attempt not found: ${id}.`);
  return matches[0];
}

function parseRepeatable(
  args: readonly string[],
  repeatable: ReadonlySet<string>,
  singular: ReadonlySet<string>,
  usage: string
): Readonly<{
  positionals: string[];
  many: Map<string, string[]>;
  one: Map<string, string>;
}> {
  const positionals: string[] = [];
  const many = new Map<string, string[]>();
  const one = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!repeatable.has(value) && !singular.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (singular.has(value) && one.has(value)) {
      throw usageError(`Option may only be specified once: ${value}.`, usage);
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    if (repeatable.has(value)) many.set(value, [...(many.get(value) ?? []), optionValue]);
    else one.set(value, optionValue);
    index += 1;
  }
  return { positionals, many, one };
}
