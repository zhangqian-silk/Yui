import { dataError, taskNotFound, usageError } from "../errors/cliError.js";
import { createTaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatTimestamp } from "../output/timePresentation.js";
import {
  createReleaseWorkflow,
  workflowStatus,
  type ReleaseStepKind,
  type ReleaseWorkflow
} from "../release/releaseWorkflow.js";
import {
  runReleaseWorkflow,
  type ReleaseWorkflowRunResult
} from "../release/releaseWorkflowEngine.js";
import type { ReleaseWorkflowPorts } from "../release/releaseWorkflowPorts.js";
import { openConfiguredTaskStore } from "../storage/sqliteStore.js";
import type { Task } from "../task/task.js";
import type {
  TaskCommandExecution,
  TaskCommandOptions,
  TaskWorkflowStore
} from "./taskCommands.js";

const STEP_KINDS: ReadonlySet<string> = new Set([
  "pr-create-or-reuse", "ci-confirm", "merge", "version-tag",
  "npm-publish", "fresh-install-smoke", "cli-update",
  "controller-replace", "project-migrate", "post-verify"
]);

const IRREVERSIBILITY_LEVELS: ReadonlySet<string> = new Set([
  "none", "reversible", "irreversible"
]);

export function runWorkflowCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "create": return createWorkflow(rest, store, options);
    case "show": return showWorkflow(rest, store);
    case "list": return listWorkflows(rest, store);
    case "status": return workflowStatusCommand(rest, store);
    case "run":
    case "resume":
      throw usageError(
        `Task workflow ${command} is asynchronous; use the yui CLI or runWorkflowCommandAsync.`
      );
    default:
      throw usageError(command === undefined
        ? "Task workflow command is required."
        : `Unknown command: task workflow ${command}`);
  }
}

/**
 * Runs (or resumes) a workflow. The yui CLI pre-dispatches `task workflow
 * run|resume` to this async entry point before the sync command path; direct
 * callers MUST use this function for run/resume. `ports` is the test seam:
 * production wiring injects the real adapter, suites inject deterministic
 * fakes. Every run resumes from the first non-terminal step; a completed
 * workflow is a no-op.
 */
export type TaskWorkflowAsyncOptions = TaskCommandOptions & Readonly<{
  /** Deterministic ports. Production wiring builds the real adapter. */
  ports?: ReleaseWorkflowPorts;
  maxSteps?: number;
}>;

export async function runWorkflowCommandAsync(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskWorkflowAsyncOptions
): Promise<TaskCommandExecution> {
  const [command, ...rest] = args;
  if (command !== "run" && command !== "resume") {
    throw usageError(`Task workflow async command must be run or resume: ${String(command)}`);
  }
  const usage = `Task workflow ${command} usage: yui task workflow ${command} <task> <workflow-id> [--grant <grant-id>] [--max-steps <int>].`;
  const parsed = parseTail(rest, new Set(["--grant", "--max-steps"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const workflowId = parsed.positionals[1]!;
  const existing = store.getReleaseWorkflow(taskId, workflowId);
  if (existing === null) {
    throw dataError(`Release workflow not found: ${taskId}/${workflowId}.`);
  }
  const ports = options.ports;
  if (ports === undefined) {
    throw usageError(
      `Task workflow ${command} requires ports; the yui CLI wires the real adapter.`,
      usage
    );
  }
  const grantId = optionalOption(parsed.options, "--grant");
  let maxSteps = options.maxSteps;
  if (parsed.options.has("--max-steps")) {
    const value = Number.parseInt(parsed.options.get("--max-steps")!, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw usageError("--max-steps must be a positive integer.", usage);
    }
    maxSteps = value;
  }
  // The immutable run-intent event commits BEFORE the engine persists the
  // first transition or calls an external system. A run that is killed,
  // crashes, or whose engine rethrows after this point can never leave
  // mutation or effect evidence without an audit record saying the run was
  // attempted. FileTaskStore transactions are synchronous, so the async
  // engine run cannot join this transaction; committing the intent first is
  // what makes the trail crash-safe across the whole run.
  const intentNow = clock(options);
  store.transaction((tx) => {
    recordTaskEvent(tx, taskId, "release-workflow.run-started", {
      workflowId,
      command,
      grantId: grantId ?? existing.grantId
    }, intentNow);
  });
  const result = await runReleaseWorkflow(store, taskId, workflowId, ports, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(grantId === undefined ? {} : { grantId })
  });
  // The engine persisted every step transition for crash recovery. The
  // outcome event and the workflow's final state commit together so the
  // audit trail cannot lag the record on a normal engine return.
  const eventNow = clock(options);
  const eventPayload = {
    workflowId,
    grantId: result.workflow.grantId,
    outcome: result.outcome,
    ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    attempted: result.attempted.join(",")
  };
  try {
    store.transaction((tx) => {
      tx.saveReleaseWorkflow(taskId, result.workflow);
      recordTaskEvent(tx, taskId, "release-workflow.run", eventPayload, eventNow);
    });
  } catch (error) {
    // The instance-level event save failed after a normal engine return. The
    // engine already committed the final workflow state for crash recovery
    // and the run-intent event above is durable, so the trail cannot be
    // empty; fall back to a fresh store of the SAME backend so the outcome
    // record commits to the authoritative store, then surface the original
    // failure so the caller knows this path was compromised.
    if (typeof store.rootDirectory === "function") {
      const auditStore = openConfiguredTaskStore(store.rootDirectory());
      recordTaskEvent(auditStore, taskId, "release-workflow.run", eventPayload, eventNow);
    }
    throw error;
  }
  return output(renderRun(result), result);
}

function workflowStatusCommand(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const usage = "Task workflow status usage: yui task workflow status <task> <workflow-id>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const workflow = store.getReleaseWorkflow(taskId, parsed.positionals[1]!);
  if (workflow === null) {
    throw dataError(`Release workflow not found: ${taskId}/${parsed.positionals[1]}.`);
  }
  const lines = [`Workflow: ${workflow.id}`, `Status: ${workflowStatus(workflow)}`];
  for (const entry of workflow.plan) {
    const step = workflow.steps[entry.id]!;
    const external = step.externalId === undefined ? "-" : step.externalId;
    lines.push(`  [${step.status}] ${entry.id} (${entry.kind}) attempts=${step.attempts} ext=${external}`);
  }
  return output(lines.join("\n").concat("\n"), workflow);
}

function renderRun(result: ReleaseWorkflowRunResult): string {
  const lines = [
    `Workflow ${result.workflow.id}: ${result.outcome} (status ${result.status})`,
    ...(result.stopReason === undefined ? [] : [`Stop: ${result.stopReason}`]),
    `Attempted: ${result.attempted.length === 0 ? "-" : result.attempted.join(", ")}`
  ];
  return lines.join("\n").concat("\n");
}

function createWorkflow(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task workflow create usage: yui task workflow create <task> --grant <grant-id> --source-repo <owner/name> --source-commit <sha> [--source-artifact <name@integrity>] --step <id>:<kind> (repeatable) [--step-irreversibility <id>=<level> (repeatable)] [--step-param <id>:<key>=<value> (repeatable)].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--grant", "--source-repo", "--source-commit", "--source-artifact"]),
    new Set(["--step", "--step-irreversibility", "--step-param"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const grantId = requiredOption(parsed.options, "--grant");
  const grant = store.getCapabilityGrant(taskId, grantId);
  if (grant === null) {
    throw dataError(`Capability grant not found: ${taskId}/${grantId}.`);
  }
  const source = buildSource(parsed, usage);
  const plan = buildPlan(parsed, usage);
  const now = clock(options);
  // The workflow record and its audit event commit in one transaction: a
  // failed event save cannot leave a persisted workflow without its audit
  // trail.
  const workflow = store.transaction((tx) => {
    const created = createReleaseWorkflow(
      tx.nextReleaseWorkflowId(taskId),
      taskId,
      { grantId, source, plan },
      now
    );
    tx.saveReleaseWorkflow(taskId, created);
    recordTaskEvent(tx, taskId, "release-workflow.created", {
      workflowId: created.id,
      grantId: created.grantId,
      commit: created.source.commit,
      steps: created.plan.map((entry) => entry.id).join(",")
    }, now);
    return created;
  });
  return output(
    `Created release workflow ${workflow.id} with ${workflow.plan.length} steps.\n`,
    workflow
  );
}

function showWorkflow(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const usage = "Task workflow show usage: yui task workflow show <task> <workflow-id>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const workflow = store.getReleaseWorkflow(taskId, parsed.positionals[1]!);
  if (workflow === null) {
    throw dataError(`Release workflow not found: ${taskId}/${parsed.positionals[1]}.`);
  }
  return output(renderWorkflow(workflow, store.getConfig().timeZone), workflow);
}

function listWorkflows(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const usage = "Task workflow list usage: yui task workflow list <task>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const workflows = store.listReleaseWorkflows(taskId);
  if (workflows.length === 0) {
    return output("No release workflows found.\n", []);
  }
  const rendered = `${renderTable(
    `Release workflows: ${taskId}`,
    [
      { header: "ID", minWidth: 6, maxWidth: 22 },
      { header: "Grant", minWidth: 6, maxWidth: 22 },
      { header: "Source", minWidth: 10, maxWidth: 40 },
      { header: "Steps", minWidth: 5, maxWidth: 8 },
      { header: "Status", minWidth: 7, maxWidth: 12 }
    ],
    workflows.map((workflow) => [
      workflow.id,
      workflow.grantId,
      sourceSummary(workflow),
      `${workflow.plan.length}`,
      workflowStatus(workflow)
    ]),
    defaultTableWidth()
  )}\n`;
  return output(rendered, workflows);
}

function buildSource(parsed: ParsedMultiTail, usage: string): ReleaseWorkflow["source"] {
  const repo = requiredOption(parsed.options, "--source-repo");
  const separator = repo.indexOf("/");
  if (separator <= 0 || separator === repo.length - 1) {
    throw usageError("--source-repo must use owner/name.", usage);
  }
  const commit = requiredOption(parsed.options, "--source-commit");
  const artifactValue = optionalOption(parsed.options, "--source-artifact");
  if (artifactValue === undefined) {
    return {
      repository: {
        owner: repo.slice(0, separator).trim(),
        name: repo.slice(separator + 1).trim()
      },
      commit
    };
  }
  const at = artifactValue.indexOf("@");
  if (at <= 0 || at === artifactValue.length - 1) {
    throw usageError("--source-artifact must use name@integrity.", usage);
  }
  return {
    repository: {
      owner: repo.slice(0, separator).trim(),
      name: repo.slice(separator + 1).trim()
    },
    commit,
    artifact: {
      name: artifactValue.slice(0, at).trim(),
      integrity: artifactValue.slice(at + 1).trim()
    }
  };
}

function buildPlan(
  parsed: ParsedMultiTail,
  usage: string
): Array<{
  id: string;
  kind: ReleaseStepKind;
  irreversibility?: "none" | "reversible" | "irreversible";
  params?: Readonly<Record<string, string>>;
}> {
  const stepValues = parsed.multiOptions.get("--step") ?? [];
  if (stepValues.length === 0) {
    throw usageError("--step is required.", usage);
  }
  const plan: Array<{
    id: string;
    kind: ReleaseStepKind;
    irreversibility?: "none" | "reversible" | "irreversible";
    params?: Record<string, string>;
  }> = stepValues.map((value) => {
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1) {
      throw usageError("--step must use id:kind.", usage);
    }
    const id = value.slice(0, separator).trim();
    const kind = value.slice(separator + 1).trim();
    if (!STEP_KINDS.has(kind)) {
      throw usageError(`--step kind is invalid: ${kind}.`, usage);
    }
    return { id, kind: kind as ReleaseStepKind };
  });
  const irreversibility = parsed.multiOptions.get("--step-irreversibility") ?? [];
  for (const value of irreversibility) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw usageError("--step-irreversibility must use id=level.", usage);
    }
    const id = value.slice(0, separator).trim();
    const level = value.slice(separator + 1).trim();
    if (!IRREVERSIBILITY_LEVELS.has(level)) {
      throw usageError(
        "--step-irreversibility must be one of: none, reversible, irreversible.",
        usage
      );
    }
    const entry = plan.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      throw usageError(`--step-irreversibility names an unknown step: ${id}.`, usage);
    }
    entry.irreversibility = level as "none" | "reversible" | "irreversible";
  }
  const stepParams = parsed.multiOptions.get("--step-param") ?? [];
  for (const value of stepParams) {
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1) {
      throw usageError("--step-param must use id:key=value.", usage);
    }
    const id = value.slice(0, separator).trim();
    const assignment = value.slice(separator + 1);
    const equals = assignment.indexOf("=");
    if (equals <= 0 || equals === assignment.length - 1) {
      throw usageError("--step-param must use id:key=value.", usage);
    }
    const entry = plan.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      throw usageError(`--step-param names an unknown step: ${id}.`, usage);
    }
    const key = assignment.slice(0, equals).trim();
    const paramValue = assignment.slice(equals + 1).trim();
    if (key.length === 0 || paramValue.length === 0) {
      throw usageError("--step-param must use id:key=value.", usage);
    }
    entry.params = { ...(entry.params ?? {}), [key]: paramValue };
  }
  return plan;
}

function sourceSummary(workflow: ReleaseWorkflow): string {
  const { owner, name } = workflow.source.repository;
  const shortCommit = workflow.source.commit.slice(0, 7);
  return `${owner}/${name}@${shortCommit}`;
}

function renderWorkflow(workflow: ReleaseWorkflow, timeZone: string | undefined): string {
  const lines = [
    `Workflow: ${workflow.id}`,
    `Task: ${workflow.taskId}`,
    `Grant: ${workflow.grantId}`,
    `Source: ${sourceSummary(workflow)}`,
    `Status: ${workflowStatus(workflow)}`,
    "Steps:"
  ];
  for (const entry of workflow.plan) {
    const step = workflow.steps[entry.id]!;
    const external = step.externalId === undefined ? "-" : step.externalId;
    lines.push(`  [${step.status}] ${entry.id} (${entry.kind}) attempts=${step.attempts} ext=${external}`);
  }
  lines.push(`Created: ${formatTimestamp(workflow.createdAt, timeZone)}`);
  lines.push(`Updated: ${formatTimestamp(workflow.updatedAt, timeZone)}`);
  return lines.join("\n").concat("\n");
}

function requireTask(store: TaskWorkflowStore, taskId: string | undefined): Task {
  const id = requiredText(taskId, "Task id");
  const task = store.getTask(id);
  if (task === null) throw taskNotFound(id);
  return task;
}

function recordTaskEvent(
  store: TaskWorkflowStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): void {
  store.saveEvent(taskId, createTaskEvent(
    store.nextEventId(taskId), taskId, type, payload, now
  ));
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  return requiredText(options.get(name), name);
}

function optionalOption(options: ReadonlyMap<string, string>, name: string): string | undefined {
  if (!options.has(name)) return undefined;
  return requiredText(options.get(name), name);
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw usageError(`${label} is required.`);
  }
  return normalized;
}

function clock(options: TaskCommandOptions): Date {
  return options.now?.() ?? new Date();
}

function output(value: string, data?: unknown): TaskCommandExecution {
  return data === undefined
    ? { kind: "output", output: value }
    : { kind: "output", output: value, data };
}

function exactPositionals(values: readonly string[], count: number, usage: string): void {
  if (values.length !== count || values.some((value) => value.trim().length === 0)) {
    throw usageError(usage);
  }
}

type ParsedTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
}>;

function parseTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  usage: string
): ParsedTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (options.has(value)) {
      throw usageError(`Option may only be specified once: ${value}.`, usage);
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options };
}

type ParsedMultiTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
  multiOptions: ReadonlyMap<string, string[]>;
}>;

function parseMultiValueTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  repeatOptions: ReadonlySet<string>,
  usage: string
): ParsedMultiTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const multiOptions = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value) && !repeatOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (repeatOptions.has(value)) {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        throw usageError(`${value} is required.`, usage);
      }
      multiOptions.set(value, [...(multiOptions.get(value) ?? []), optionValue]);
      index += 1;
      continue;
    }
    if (options.has(value)) {
      throw usageError(`Option may only be specified once: ${value}.`, usage);
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options, multiOptions };
}
