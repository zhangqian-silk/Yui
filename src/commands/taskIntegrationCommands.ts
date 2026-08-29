import { NodeGitWorkspace } from "../repository/gitWorkspace.js";
import { assertProjectActive, resolveProject } from "../repository/project.js";
import { workspaceProjectEntry } from "../worktree/managedWorkspace.js";
import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  createIntegrationAttempt,
  recordResolutionDecision,
  supersedeIntegration,
  updateIntegrationAttempt,
  type IntegrationAttempt
} from "../integration/integrationAttempt.js";
import { GitIntegrationService, type IntegrationJobPort } from "../integration/gitIntegrationService.js";
import { runTaskIntegrationQueueCommand } from "./taskIntegrationQueueCommands.js";
import { taskLocalActor } from "./taskActor.js";
import { resolveTaskRecordReference } from "../task/taskRecordReference.js";
import {
  runDeliveryGuardPreflight,
  withGuardWarnings
} from "./deliveryGuardPreflight.js";

export type TaskIntegrationCommandOptions = Readonly<{
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  jobPort?: IntegrationJobPort;
}>;

export async function runTaskIntegrationCommand(
  args: readonly string[],
  store: TaskStore,
  home: string,
  options: TaskIntegrationCommandOptions = {}
): Promise<Readonly<{ output: string; data?: unknown }>> {
  const now = options.now ?? (() => new Date());
  const [command, ...rest] = args;
  if (command === "start") return start(rest, store, home, now, options);
  if (command === "continue") {
    return continueIntegration(rest, store, home, now, options);
  }
  if (command === "resolve") {
    return resolveDecision(rest, store, now, options.environment, home);
  }
  if (command === "abort") return abortIntegration(rest, store, now(), options, home);
  if (command === "supersede") {
    return supersedeIntegrationCommand(rest, store, now(), options.environment, home);
  }
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
  taskLocalActor(store, environment, integration.taskId, home);
  if (integration.status !== "committed"
    && integration.status !== "superseded"
    && integration.status !== "failed") {
    throw usageError(
      `Integration is not terminal: ${integration.id}/${integration.status}.`
    );
  }
  // rr4/finding-5: An Integration Attempt with an active DurableJob cannot be
  // cleaned up — the runner may still be using its worktree. Block on queued,
  // running, and unacknowledged unknown-needs-attention jobs owned by it.
  const activeIntegrationJob = store.listDurableJobs(integration.taskId).find((job) => (
    job.owner.kind === "integration-attempt"
    && job.owner.integrationAttemptId === integration.id
    && (
      job.status === "queued"
      || job.status === "running"
      || (job.status === "unknown-needs-attention" && job.acknowledgedAt === undefined)
    )
  ));
  if (activeIntegrationJob !== undefined) {
    throw usageError(
      `Integration ${integration.id} has an active DurableJob: `
      + `${activeIntegrationJob.id}/${activeIntegrationJob.status}. `
      + "Cancel or acknowledge it before cleanup."
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
  options: TaskIntegrationCommandOptions
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
  taskLocalActor(store, options.environment, task.id, home);
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
  assertProjectActive(project, "start an Integration");
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
  // The duplicate/budget preflight runs inside the same transaction as the
  // attempt insert: on the single-writer SQLite backend the check and the
  // record creation are atomic, so a concurrent Leader cannot sneak a
  // duplicate Integration between the guard and the write.
  const integration = store.transaction((tx) => {
    taskLocalActor(tx, options.environment, task.id, home);
    const guard = runDeliveryGuardPreflight(tx, task.id, {
      kind: "integration-start",
      projectId: project.id,
      changeSetIds
    }, { environment: options.environment, budget: true });
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
    return { attempt: created, guard };
  });
  const result = await runIntegration(store, home, integration.attempt, now, options);
  return {
    ...result,
    output: withGuardWarnings(integration.guard, result.output)
  };
}

async function continueIntegration(
  args: readonly string[],
  store: TaskStore,
  home: string,
  now: () => Date,
  options: TaskIntegrationCommandOptions
): Promise<Readonly<{ output: string; data: unknown }>> {
  const usage = "Task Integration continue usage: yui task integration continue <task>/<integration>.";
  const parsed = parseRepeatable(args, new Set(), new Set(), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0], options.environment);
  requireActiveIntegrationTask(store, integration);
  taskLocalActor(store, options.environment, integration.taskId, home);
  if (
    integration.status !== "validating"
    && integration.status !== "running"
    && (
      integration.status !== "blocked"
      || integration.resolution?.action !== "manual-resolution"
    )
  ) {
    throw usageError(`Integration is not ready to continue: ${integration.id}/${integration.status}.`);
  }
  return runIntegration(store, home, integration, now, options);
}

async function runIntegration(
  store: TaskStore,
  home: string,
  integration: IntegrationAttempt,
  now: () => Date,
  options: TaskIntegrationCommandOptions
): Promise<Readonly<{ output: string; data: unknown }>> {
  const result = await new GitIntegrationService(
    home,
    store,
    undefined,
    now,
    options.environment,
    undefined,
    options.jobPort
  ).integrate(integration.taskId, integration.id);
  const output = result.status === "committed"
    ? `Integrated ${result.attempt.changeSetIds.join(", ")} into ${result.attempt.targetRef} with CAS (${result.attempt.id})\n`
    : result.status === "blocked"
      ? `Integration ${result.attempt.id} requires a Task Agent resolution decision in ${result.workspace.path}\n`
      : result.status === "checks-running"
        ? `Integration ${result.attempt.id} checks are running as DurableJob ${result.job.id}; run 'yui task integration continue ${result.attempt.taskId}/${result.attempt.id}' when the job finishes\n`
        : `Integration ${result.attempt.id} failed; target ref was not advanced\n`;
  return { output, data: result };
}

function resolveDecision(
  args: readonly string[],
  store: TaskStore,
  now: () => Date,
  environment: NodeJS.ProcessEnv | undefined,
  home: string
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration resolve usage: yui task integration resolve <task>/<integration> --option <manual-resolution|reject> --rationale <text>.";
  const parsed = parseRepeatable(args, new Set(), new Set(["--option", "--rationale"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const selectedOption = parsed.one.get("--option");
  const rationale = parsed.one.get("--rationale");
  if (selectedOption === undefined || rationale === undefined) throw usageError(usage);
  const resolved = store.transaction((tx) => {
    const integration = requireIntegration(tx, parsed.positionals[0], environment);
    const task = requireActiveIntegrationTask(tx, integration);
    const actor = taskLocalActor(tx, environment, task.id, home);
    const updated = recordResolutionDecision(integration, {
      action: selectedOption as "manual-resolution" | "reject",
      rationale
    }, actor, now());
    tx.saveIntegrationAttempt(updated.taskId, updated);
    return updated;
  });
  return {
    output: selectedOption === "manual-resolution"
      ? `Selected manual resolution for ${resolved.id}; resolve its candidate worktree, then run integration continue\n`
      : `Rejected Integration ${resolved.id}\n`,
    data: { integration: resolved }
  };
}

async function abortIntegration(
  args: readonly string[],
  store: TaskStore,
  now: Date,
  options: TaskIntegrationCommandOptions,
  home: string
): Promise<Readonly<{ output: string; data: unknown }>> {
  const usage = "Task Integration abort usage: yui task integration abort <task>/<integration> --reason <text>.";
  const parsed = parseRepeatable(args, new Set(), new Set(["--reason"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0], options.environment);
  requireActiveIntegrationTask(store, integration);
  taskLocalActor(store, options.environment, integration.taskId, home);
  if (integration.status !== "running" && integration.status !== "blocked") {
    throw usageError(
      `Integration cannot be aborted from ${integration.status}: ${integration.id}.`
    );
  }
  const reason = parsed.one.get("--reason");
  if (reason === undefined) throw usageError(usage);
  if (integration.jobId !== undefined && options.jobPort !== undefined) {
    await options.jobPort.cancelJob(integration.taskId, integration.jobId);
  }
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
    taskLocalActor(tx, options.environment, current.taskId, home);
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
function supersedeIntegrationCommand(
  args: readonly string[],
  store: TaskStore,
  now: Date,
  environment: NodeJS.ProcessEnv | undefined,
  home: string
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration supersede usage: yui task integration supersede <task>/<integration> --reason <text>.";
  const parsed = parseRepeatable(args, new Set(), new Set(["--reason"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const integration = requireIntegration(store, parsed.positionals[0], environment);
  requireActiveIntegrationTask(store, integration);
  if (integration.status !== "committed") {
    throw usageError(
      `Integration cannot be superseded from ${integration.status}: ${integration.id}.`
    );
  }
  const reason = parsed.one.get("--reason");
  if (reason === undefined) throw usageError(usage);
  // Superseding a committed Integration rewrites delivery-baseline evidence
  // and audit history, so it remains an explicit Task-control decision.
  taskLocalActor(store, environment, integration.taskId, home);
  // A queue-backed committed Attempt cannot be superseded: the queue entry
  // would remain in its current status while its Attempt becomes "superseded",
  // leaving contradictory terminal records that never converge. This covers
  // the crash window where the entry is still "running" or "conflicted" after
  // the Attempt committed.
  const queueBacked = store.listIntegrationQueueEntries(integration.taskId)
    .some((entry) => entry.integrationAttemptId === integration.id);
  if (queueBacked) {
    throw usageError(
      `Integration ${integration.id} is backed by a queue entry; `
      + "reconcile the queue entry instead of superseding its Attempt."
    );
  }
  return store.transaction((tx) => {
    const current = tx.getIntegrationAttempt(integration.taskId, integration.id);
    if (current === null) {
      throw usageError(
        `Integration Attempt not found: ${integration.taskId}/${integration.id}.`
      );
    }
    if (current.status !== "committed") {
      throw usageError(
        `Integration cannot be superseded from ${current.status}: ${current.id}.`
      );
    }
    taskLocalActor(tx, environment, current.taskId, home);
    const superseded = supersedeIntegration(current, reason, now);
    tx.saveIntegrationAttempt(superseded.taskId, superseded);
    return {
      output: `Superseded Integration ${superseded.id}; the next valid committed Integration is now the delivery baseline\n`,
      data: { integration: superseded }
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
      `Job: ${integration.jobId ?? "-"}`,
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
