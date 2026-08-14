import { NodeGitWorkspace } from "../repository/gitWorkspace.js";
import { resolveProject } from "../repository/project.js";
import { workspaceProjectEntry } from "../worktree/managedWorkspace.js";
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
import { runTaskIntegrationQueueCommand } from "./taskIntegrationQueueCommands.js";
import { taskActor } from "./taskActor.js";
import { resolveTaskRecordReference } from "../task/taskRecordReference.js";

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
  if (command === "start") return start(rest, store, home, now, options.environment);
  if (command === "continue") {
    return continueIntegration(rest, store, home, now, options.environment);
  }
  if (command === "resolve") {
    return resolveDecision(rest, store, now, options.environment);
  }
  if (command === "abort") return abortIntegration(rest, store, now(), options.environment);
  if (command === "cleanup") {
    return cleanupIntegration(rest, store, home, options.environment);
  }
  if (command === "list") return list(rest, store);
  if (command === "show") return show(rest, store, options.environment);
  if (command === "queue") {
    return runTaskIntegrationQueueCommand(rest, store, home, options);
  }
  throw usageError(command === undefined
    ? "Task Integration command is required."
    : `Unknown command: task integration ${command}`);
}

async function cleanupIntegration(
  args: readonly string[],
  store: TaskStore,
  home: string,
  environment: NodeJS.ProcessEnv | undefined
): Promise<Readonly<{ output: string; data: unknown }>> {
  if (args.length !== 1) {
    throw usageError(
      "Task Integration cleanup usage: yui task integration cleanup <task>/<integration>."
    );
  }
  const integration = requireIntegration(store, args[0], environment);
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
  now: () => Date,
  environment: NodeJS.ProcessEnv | undefined
): Promise<Readonly<{ output: string; data: unknown }>> {
  const usage = "Task Integration start usage: yui task integration start <task> [--project <project>] --change-set <id> [--change-set <id> ...] [--target <ref>] [--check <command> ...].";
  const parsed = parseRepeatable(
    args,
    new Set(["--change-set", "--check"]),
    new Set(["--project", "--target"]),
    usage
  );
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const task = store.getTask(parsed.positionals[0]);
  if (task === null) throw usageError(`Task not found: ${parsed.positionals[0]}.`);
  if (task.status !== "active") {
    throw usageError(`Task is not active: ${task.id}/${task.status}.`);
  }
  const changeSetIds = parsed.many.get("--change-set") ?? [];
  if (changeSetIds.length === 0) throw usageError("--change-set is required.", usage);
  const changeSets = changeSetIds.map((id) => {
    const changeSet = store.getChangeSet(task.id, id);
    if (changeSet === null) throw usageError(`ChangeSet not found: ${id}.`);
    return changeSet;
  });
  // Only diagnostic evidence commits (a reviewer's own commit on top of the
  // frozen base) are barred from becoming an Integration source.  A clean
  // review attests the frozen base itself (evidenceCommit === reviewBaseCommit),
  // which is the candidate's own head and a legitimate source.
  const diagnosticEvidence = new Set(store.listReviewRounds(task.id)
    .flatMap(({ evidenceCommit, reviewBaseCommit }) =>
      evidenceCommit !== undefined && evidenceCommit !== reviewBaseCommit
        ? [evidenceCommit]
        : []));
  const reviewSource = changeSets.find(({ headCommit }) => diagnosticEvidence.has(headCommit));
  if (reviewSource !== undefined) {
    throw usageError(
      `ReviewRound evidence commit cannot become an Integration source: ${reviewSource.id}.`
    );
  }
  const projectIds = [...new Set(changeSets.map(({ projectId }) => projectId))];
  if (projectIds.length !== 1) {
    throw usageError("An Integration may only contain ChangeSets from one Project.");
  }
  const requestedProject = parsed.one.get("--project");
  const project = requestedProject === undefined
    ? store.getProject(projectIds[0])
    : resolveProject(store.listProjects(), requestedProject);
  if (project === null) throw usageError(`Project not found: ${requestedProject ?? projectIds[0]}.`);
  if (project.id !== projectIds[0]) {
    throw usageError(`ChangeSets belong to another Project: ${projectIds[0]}.`);
  }
  if (!task.projectBindings.some(({ projectId }) => projectId === project.id)) {
    throw usageError(`Project does not belong to Task: ${project.id}.`);
  }
  const mainWorkspace = store.getTaskWorkspace(task.id);
  const mainEntry = mainWorkspace === null
    ? undefined
    : workspaceProjectEntry(mainWorkspace, project.id);
  const targetRef = parsed.one.get("--target") ?? mainEntry?.branch;
  if (targetRef === undefined) {
    throw usageError(`Task main worktree is not ready; reconcile the Task first: ${task.id}.`);
  }
  const expectedHead = (await new NodeGitWorkspace().inspect(project.path, targetRef)).baseCommit;
  const integration = store.transaction((tx) => {
    const created = createIntegrationAttempt({
      id: tx.nextIntegrationAttemptId(task.id),
      taskId: task.id,
      projectId: project.id,
      targetRef,
      expectedHead,
      changeSetIds,
      checkCommands: parsed.many.get("--check") ?? []
    }, now());
    tx.saveIntegrationAttempt(task.id, created);
    return created;
  });
  return runIntegration(store, home, integration, now, environment);
}

async function continueIntegration(
  args: readonly string[],
  store: TaskStore,
  home: string,
  now: () => Date,
  environment: NodeJS.ProcessEnv | undefined
): Promise<Readonly<{ output: string; data: unknown }>> {
  const usage = "Task Integration continue usage: yui task integration continue <task>/<integration>.";
  const parsed = parseRepeatable(args, new Set(), new Set(), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0], environment);
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
  return runIntegration(store, home, integration, now, environment);
}

async function runIntegration(
  store: TaskStore,
  home: string,
  integration: IntegrationAttempt,
  now: () => Date,
  environment: NodeJS.ProcessEnv | undefined
): Promise<Readonly<{ output: string; data: unknown }>> {
  const result = await new GitIntegrationService(home, store, undefined, now, environment)
    .integrate(integration.taskId, integration.id);
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
  const usage = "Task Integration resolve usage: yui task integration resolve <task>/<integration> --option <manual-resolution|reject> --rationale <text>.";
  const parsed = parseRepeatable(args, new Set(), new Set(["--option", "--rationale"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0], environment);
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
  now: Date,
  environment: NodeJS.ProcessEnv | undefined
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration abort usage: yui task integration abort <task>/<integration> --reason <text>.";
  const parsed = parseRepeatable(args, new Set(), new Set(["--reason"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0], environment);
  requireActiveIntegrationTask(store, integration);
  if (integration.status !== "running" && integration.status !== "blocked") {
    throw usageError(
      `Integration cannot be aborted from ${integration.status}: ${integration.id}.`
    );
  }
  const reason = parsed.one.get("--reason");
  if (reason === undefined) throw usageError(usage);
  return store.transaction((tx) => {
    // Re-read inside the transaction: a concurrent `continue` can advance the
    // Attempt to validating (and then commit the target) after the initial
    // read.  Aborting a validating or committed Attempt would leave the
    // target advanced while the Attempt is failed.
    const current = tx.getIntegrationAttempt(integration.taskId, integration.id);
    if (current === null) {
      throw usageError(
        `Integration Attempt not found: ${integration.taskId}/${integration.id}.`
      );
    }
    if (current.status !== "running" && current.status !== "blocked") {
      throw usageError(
        `Integration cannot be aborted from ${current.status}: ${current.id}.`
      );
    }
    const aborted = updateIntegrationAttempt(current, {
      status: "failed",
      checks: [
        ...(current.checks ?? []),
        { name: "aborted", outcome: "failed", details: reason }
      ]
    }, now);
    tx.saveIntegrationAttempt(aborted.taskId, aborted);
    return {
      output: `Aborted Integration ${aborted.id}; start a new Integration Attempt to retry\n`,
      data: { integration: aborted }
    };
  });
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
          { header: "Project", minWidth: 8, maxWidth: 20 },
          { header: "Target", minWidth: 8, maxWidth: 30 },
          { header: "Changes", minWidth: 7, maxWidth: 10 },
          { header: "Status", minWidth: 7, maxWidth: 20 }
        ],
        integrations.map((entry) => [
          entry.id,
          entry.projectId,
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
  store: TaskStore,
  environment: NodeJS.ProcessEnv | undefined
): Readonly<{ output: string; data: unknown }> {
  if (args.length !== 1) throw usageError("Task Integration show usage: yui task integration show <task>/<integration>.");
  const integration = requireIntegration(store, args[0], environment);
  return {
    output: `${[
      `Integration Attempt: ${integration.id}`,
      `Task: ${integration.taskId}`,
      `Project: ${integration.projectId}`,
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

function requireIntegration(
  store: TaskStore,
  value: string,
  environment: NodeJS.ProcessEnv | undefined
): IntegrationAttempt {
  let reference;
  try {
    reference = resolveTaskRecordReference(value, {
      kind: "integrationAttempt",
      contextTaskId: environment?.YUI_TASK_ID,
      label: "Integration Attempt"
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const attempt = store.getIntegrationAttempt(reference.taskId, reference.localId);
  if (attempt === null) {
    throw usageError(
      `Integration Attempt not found: ${reference.taskId}/${reference.localId}.`
    );
  }
  return attempt;
}

export function parseRepeatable(
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
