import { isDeepStrictEqual } from "node:util";

import { taskActor } from "./taskActor.js";
import { dataError, taskNotFound, usageError } from "../errors/cliError.js";
import { createTaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatTimestamp } from "../output/timePresentation.js";
import { resolveProject } from "../repository/project.js";
import {
  createPublicationReference,
  type PublicationReference,
  type PublicationExternalKind,
  type PublicationProvider,
  type PublicationState,
  type PublicationVerification
} from "../task/publicationReference.js";
import { resolveTaskRecordReference } from "../task/taskRecordReference.js";
import type {
  TaskCommandExecution,
  TaskCommandOptions,
  TaskWorkflowStore
} from "./taskCommands.js";

const PROVIDERS = new Set(["github", "gitlab"]);
const EXTERNAL_KINDS = new Set(["pull-request", "merge-request"]);
const STATES = new Set(["open", "merged", "closed"]);

export function runPublicationCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "add": return addPublication(rest, store, options);
    case "list": return listPublications(rest, store);
    case "show": return showPublication(rest, store);
    default:
      throw usageError(command === undefined
        ? "Task publication command is required."
        : `Unknown command: task publication ${command}`);
  }
}

function addPublication(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task publication add usage: yui task publication add <task> --project <project> --provider <github|gitlab> --repository <owner/name> --kind <pull-request|merge-request> --id <external-id> [--url <url>] [--title <text>] [--source-branch <branch>] [--target-branch <branch>] [--local-commit <sha>] [--remote-commit <sha>] [--state <open|merged|closed>] [--reported|--verified] [--evidence <text>] [--supersede <publication-id>] [--merged-at <iso-timestamp>].";
  const parsed = parseAddArgs(args, usage);
  const task = requireTask(store, parsed.positionals[0]);
  const projectReference = requiredOption(parsed.options, "--project");
  const project = resolveProject(store.listProjects(), projectReference);
  if (project === null) throw usageError(`Project not found: ${projectReference}.`, usage);
  if (!task.projectBindings.some((binding) => binding.projectId === project.id)) {
    throw usageError(`Project is not bound to Task ${task.id}: ${projectReference}.`, usage);
  }
  const actor = taskActor(options.environment, task.id);
  if (actor === "leader") {
    throw usageError(
      "A managed Task Leader cannot record external publication evidence; "
      + "use a user or global Operator session.",
      usage
    );
  }
  const state = enumOption<PublicationState>(parsed.options, "--state", STATES, usage) ?? "open";
  const verification = parseVerification(parsed, usage);
  const input = {
    projectId: project.id,
    provider: enumOption<PublicationProvider>(parsed.options, "--provider", PROVIDERS, usage)!,
    repository: requiredOption(parsed.options, "--repository"),
    externalKind: enumOption<PublicationExternalKind>(parsed.options, "--kind", EXTERNAL_KINDS, usage)!,
    externalId: requiredOption(parsed.options, "--id"),
    ...(parsed.options.has("--url") ? { externalUrl: requiredOption(parsed.options, "--url") } : {}),
    ...(parsed.options.has("--title") ? { title: requiredOption(parsed.options, "--title") } : {}),
    ...(parsed.options.has("--source-branch")
      ? { sourceBranch: requiredOption(parsed.options, "--source-branch") }
      : {}),
    ...(parsed.options.has("--target-branch")
      ? { targetBranch: requiredOption(parsed.options, "--target-branch") }
      : {}),
    ...(parsed.options.has("--local-commit")
      ? { localCommit: requiredOption(parsed.options, "--local-commit") }
      : {}),
    ...(parsed.options.has("--remote-commit")
      ? { remoteCommit: requiredOption(parsed.options, "--remote-commit") }
      : {}),
    state,
    verification,
    ...(parsed.options.has("--evidence")
      ? { evidence: requiredOption(parsed.options, "--evidence") }
      : {}),
    ...(parsed.options.has("--supersede")
      ? { supersedes: requiredOption(parsed.options, "--supersede") }
      : {}),
    ...(parsed.options.has("--merged-at")
      ? { mergedAt: requiredOption(parsed.options, "--merged-at") }
      : {}),
    recordedBy: actor,
    source: "manual" as const
  };
  const externalKey = `${input.provider}/${input.repository}/${input.externalId}`;
  const now = clock(options);
  const result = store.transaction((tx) => {
    const existing = tx.findPublicationReferenceByExternalKey(externalKey);
    if (existing !== null) {
      if (existing.taskId !== task.id) {
        throw dataError(
          `Publication external identity already belongs to Task ${existing.taskId}: ${externalKey}.`
        );
      }
      const semantic = createPublicationReference(
        existing.id,
        task.id,
        input.supersedes === existing.id
          ? {
              projectId: input.projectId,
              provider: input.provider,
              repository: input.repository,
              externalKind: input.externalKind,
              externalId: input.externalId,
              ...(input.externalUrl === undefined ? {} : { externalUrl: input.externalUrl }),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.sourceBranch === undefined ? {} : { sourceBranch: input.sourceBranch }),
              ...(input.targetBranch === undefined ? {} : { targetBranch: input.targetBranch }),
              ...(input.localCommit === undefined ? {} : { localCommit: input.localCommit }),
              ...(input.remoteCommit === undefined ? {} : { remoteCommit: input.remoteCommit }),
              state: input.state,
              verification: input.verification,
              ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
              ...(input.mergedAt === undefined ? {} : { mergedAt: input.mergedAt }),
              recordedBy: input.recordedBy,
              source: input.source
            }
          : input,
        new Date(existing.createdAt)
      );
      if (isDeepStrictEqual(semantic, existing)) {
        return { reference: existing, idempotent: true };
      }
      if (input.supersedes === undefined || input.supersedes !== existing.id) {
        throw usageError(
          `Publication ${externalKey} conflicts with current record ${existing.id}; `
          + "use --supersede with that id to append corrected evidence.",
          usage
        );
      }
    } else if (input.supersedes !== undefined) {
      throw usageError(
        `Publication supersede target has a different external identity: ${input.supersedes}.`,
        usage
      );
    }
    const reference = createPublicationReference(
      tx.nextPublicationReferenceId(task.id),
      task.id,
      input,
      now
    );
    tx.savePublicationReference(task.id, reference);
    recordTaskEvent(tx, task.id, "publication.recorded", {
      publicationId: reference.id,
      provider: reference.provider,
      repository: reference.repository,
      externalKind: reference.externalKind,
      externalId: reference.externalId,
      state: reference.state,
      verification: reference.verification
    }, now);
    return { reference, idempotent: false };
  });
  return output(
    result.idempotent
      ? `Publication reference already recorded: ${result.reference.id}.\n`
      : `Recorded publication ${result.reference.id} (${
        result.reference.provider
      }/${result.reference.repository}/${result.reference.externalKind}/${
        result.reference.externalId
      }) for ${result.reference.taskId}.\n`,
    result.reference
  );
}

function listPublications(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const usage = "Task publication list usage: yui task publication list <task>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const task = requireTask(store, parsed.positionals[0]);
  const references = store.listPublicationReferences(task.id);
  if (references.length === 0) {
    return output("No publication references found.\n", []);
  }
  const rendered = `${renderTable(
    `Publication references: ${task.id}`,
    [
      { header: "ID", minWidth: 12, maxWidth: 22 },
      { header: "External", minWidth: 16, maxWidth: 40 },
      { header: "Title", minWidth: 16, maxWidth: 40 },
      { header: "State", minWidth: 7, maxWidth: 10 },
      { header: "Verification", minWidth: 11, maxWidth: 14 },
      { header: "Lineage", minWidth: 18, maxWidth: 58 },
      { header: "Supersedes", minWidth: 12, maxWidth: 22 }
    ],
    references.map((reference) => [
      reference.id,
      `${reference.provider}/${reference.repository}/${reference.externalId}`,
      reference.title ?? "-",
      reference.state,
      reference.verification,
      lineageSummary(reference),
      reference.supersedes ?? "-"
    ]),
    defaultTableWidth()
  )}\n`;
  return output(rendered, references);
}

function showPublication(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const usage = "Task publication show usage: yui task publication show (<task>/<publication-id> | <task> <publication-id>).";
  const parsed = parseTail(args, new Set(), usage);
  if (parsed.positionals.length !== 1 && parsed.positionals.length !== 2) {
    throw usageError(usage);
  }
  const referenceId = parsed.positionals.length === 1
    ? resolveTaskRecordReference(parsed.positionals[0]!, {
      kind: "publicationReference",
      label: "Publication reference"
    })
    : resolveTaskRecordReference(
      `${parsed.positionals[0]}/${parsed.positionals[1]}`,
      { kind: "publicationReference", label: "Publication reference" }
    );
  requireTask(store, referenceId.taskId);
  const reference = store.getPublicationReference(
    referenceId.taskId,
    referenceId.localId
  );
  if (reference === null) {
    throw dataError(
      `Publication reference not found: ${referenceId.taskId}/${referenceId.localId}.`
    );
  }
  return output(
    renderPublication(reference, store.getConfig().timeZone),
    reference
  );
}

function renderPublication(
  reference: PublicationReference,
  timeZone: string | undefined
): string {
  return [
    `Publication: ${reference.id}`,
    `Task: ${reference.taskId}`,
    `Project: ${reference.projectId}`,
    `External: ${reference.provider}/${reference.repository}/${reference.externalId} (${reference.externalKind})`,
    ...(reference.externalUrl === undefined ? [] : [`URL: ${reference.externalUrl}`]),
    ...(reference.title === undefined ? [] : [`Title: ${reference.title}`]),
    ...(reference.sourceBranch === undefined && reference.targetBranch === undefined
      ? []
      : [`Branches: ${reference.sourceBranch ?? "unknown"} -> ${reference.targetBranch ?? "unknown"}`]),
    `State: ${reference.state}`,
    `Verification: ${reference.verification}`,
    `Lineage: ${reference.localCommit ?? "unknown"} -> ${reference.externalId} -> ${reference.remoteCommit ?? "unknown"}`,
    ...(reference.mergedAt === undefined
      ? []
      : [`Merged: ${formatTimestamp(reference.mergedAt, timeZone)}`]),
    ...(reference.evidence === undefined ? [] : [`Evidence: ${reference.evidence}`]),
    ...(reference.supersedes === undefined ? [] : [`Supersedes: ${reference.supersedes}`]),
    `Recorded by: ${reference.recordedBy}`,
    `Source: ${reference.source}`,
    `Created: ${formatTimestamp(reference.createdAt, timeZone)}`
  ].join("\n").concat("\n");
}

function lineageSummary(reference: PublicationReference): string {
  const local = reference.localCommit ?? "unknown";
  const remote = reference.remoteCommit ?? "unknown";
  return `${local.slice(0, 12)} -> ${reference.externalId} -> ${remote.slice(0, 12)}`;
}

function parseVerification(
  parsed: ParsedAddTail,
  usage: string
): PublicationVerification {
  if (parsed.flags.has("--reported") && parsed.flags.has("--verified")) {
    throw usageError("--reported and --verified are mutually exclusive.", usage);
  }
  return parsed.flags.has("--verified") ? "verified" : "reported";
}

function enumOption<T extends string>(
  options: ReadonlyMap<string, string>,
  name: string,
  allowed: ReadonlySet<string>,
  usage: string
): T | undefined {
  if (!options.has(name)) return undefined;
  const value = requiredOption(options, name);
  if (!allowed.has(value)) {
    throw usageError(`${name} must be one of: ${[...allowed].join(", ")}.`, usage);
  }
  return value as T;
}

function requireTask(store: TaskWorkflowStore, taskId: string | undefined) {
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

type ParsedAddTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}>;

function parseAddArgs(args: string[], usage: string): ParsedAddTail {
  const valueOptions = new Set([
    "--project", "--provider", "--repository", "--kind", "--id", "--url",
    "--title", "--source-branch", "--target-branch", "--local-commit",
    "--remote-commit", "--state", "--evidence", "--supersede", "--merged-at"
  ]);
  const flags = new Set(["--reported", "--verified"]);
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const seenFlags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (flags.has(value)) {
      if (seenFlags.has(value)) {
        throw usageError(`Flag may only be specified once: ${value}.`, usage);
      }
      seenFlags.add(value);
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
  return { positionals, options, flags: seenFlags };
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
