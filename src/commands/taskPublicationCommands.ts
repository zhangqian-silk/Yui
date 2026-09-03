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
  type PublicationReferenceInput,
  type PublicationExternalKind,
  type PublicationProvider,
  type PublicationRecordedBy,
  type PublicationState,
  type PublicationVerification
} from "../task/publicationReference.js";
import type { Task } from "../task/task.js";
import { resolveTaskRecordReference } from "../task/taskRecordReference.js";
import type {
  TaskCommandExecution,
  TaskCommandOptions,
  TaskWorkflowStore
} from "./taskCommands.js";

const PROVIDERS = new Set(["github", "gitlab"]);
const EXTERNAL_KINDS = new Set(["pull-request", "merge-request"]);
const STATES = new Set(["open", "merged", "closed"]);
const INHERITED_METADATA_FIELDS = [
  "externalUrl",
  "title",
  "sourceBranch",
  "targetBranch"
] as const satisfies readonly (keyof PublicationReferenceInput)[];
const INHERITED_EVIDENCE_FIELDS = [
  "remoteCommit",
  "evidence",
  "mergedAt"
] as const satisfies readonly (keyof PublicationReferenceInput)[];

export function runPublicationCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "upsert": return upsertPublication(rest, store, options);
    case "list": return listPublications(rest, store);
    case "show": return showPublication(rest, store);
    default:
      throw usageError(command === undefined
        ? "Task publication command is required."
        : `Unknown command: task publication ${command}`);
  }
}

function upsertPublication(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task publication upsert usage: yui task publication upsert <task> --project <project> --provider <github|gitlab> --repository <owner/name> --kind <pull-request|merge-request> --id <external-id> [--url <url>] [--title <text>] [--source-branch <branch>] [--target-branch <branch>] [--local-commit <sha>] [--remote-commit <sha>] [--state <open|merged|closed>] [--reported|--verified] [--evidence <text>] [--merged-at <iso-timestamp>].";
  const parsed = parseUpsertArgs(args, usage);
  exactPositionals(parsed.positionals, 1, usage);
  const task = requireTask(store, parsed.positionals[0]);
  const projectReference = requiredOption(parsed.options, "--project", usage);
  const project = resolveProject(store.listProjects(), projectReference);
  if (project === null) throw usageError(`Project not found: ${projectReference}.`, usage);
  if (!task.projectBindings.some((binding) => binding.projectId === project.id)) {
    throw usageError(`Project is not bound to Task ${task.id}: ${projectReference}.`, usage);
  }
  const actor = taskActor(options.environment, task.id);
  const state = enumOption<PublicationState>(parsed.options, "--state", STATES, usage);
  const verification = parseVerification(parsed, usage);
  const input: PublicationReferenceInput = {
    projectId: project.id,
    provider: requiredEnumOption<PublicationProvider>(
      parsed.options, "--provider", PROVIDERS, usage
    ),
    repository: requiredOption(parsed.options, "--repository", usage),
    externalKind: requiredEnumOption<PublicationExternalKind>(
      parsed.options, "--kind", EXTERNAL_KINDS, usage
    ),
    externalId: requiredOption(parsed.options, "--id", usage),
    ...(parsed.options.has("--url")
      ? { externalUrl: requiredOption(parsed.options, "--url", usage) }
      : {}),
    ...(parsed.options.has("--title")
      ? { title: requiredOption(parsed.options, "--title", usage) }
      : {}),
    ...(parsed.options.has("--source-branch")
      ? { sourceBranch: requiredOption(parsed.options, "--source-branch", usage) }
      : {}),
    ...(parsed.options.has("--target-branch")
      ? { targetBranch: requiredOption(parsed.options, "--target-branch", usage) }
      : {}),
    ...(parsed.options.has("--local-commit")
      ? { localCommit: requiredOption(parsed.options, "--local-commit", usage) }
      : {}),
    ...(parsed.options.has("--remote-commit")
      ? { remoteCommit: requiredOption(parsed.options, "--remote-commit", usage) }
      : {}),
    ...(state === undefined ? {} : { state }),
    ...(verification === undefined ? {} : { verification }),
    ...(parsed.options.has("--evidence")
      ? { evidence: requiredOption(parsed.options, "--evidence", usage) }
      : {}),
    ...(parsed.options.has("--merged-at")
      ? { mergedAt: requiredOption(parsed.options, "--merged-at", usage) }
      : {})
  };
  const now = clock(options);
  const result = store.transaction((tx) => upsertTaskPublication(
    tx,
    task,
    input,
    actor,
    now
  ));
  return output(
    result.idempotent
      ? `Publication reference already current: ${result.reference.id}.\n`
      : `Upserted publication ${result.reference.id} (${
        result.reference.provider
      }/${result.reference.repository}/${result.reference.externalKind}/${
        result.reference.externalId
      }) for ${result.reference.taskId}.\n`,
    result.reference
  );
}

/**
 * One immutable Publication upsert against the caller's current transaction.
 * External verification uses the same lineage and idempotency path as manual
 * evidence instead of maintaining a second mutation protocol.
 */
export function upsertTaskPublication(
  store: TaskWorkflowStore,
  task: Task,
  input: PublicationReferenceInput,
  actor: PublicationRecordedBy,
  now: Date
): Readonly<{ reference: PublicationReference; idempotent: boolean }> {
  const externalKey = `${input.provider}/${input.repository}/${input.externalId}`;
  const existing = store.findPublicationReferenceByExternalKey(externalKey);
  if (existing !== null && existing.taskId !== task.id) {
    throw dataError(
      `Publication external identity already belongs to Task ${existing.taskId}: ${externalKey}.`
    );
  }
  const effective = existing === null
    ? input
    : inheritPublicationInput(existing, input);
  if (existing !== null) {
    const semantic = createPublicationReference(
      existing.id,
      task.id,
      {
        ...effective,
        recordedBy: existing.recordedBy,
        source: existing.source
      },
      new Date(existing.createdAt)
    );
    if (isDeepStrictEqual(
      publicationSemantics(semantic),
      publicationSemantics(existing)
    )) {
      return { reference: existing, idempotent: true };
    }
  }
  const reference = createPublicationReference(
    store.nextPublicationReferenceId(task.id),
    task.id,
    {
      ...effective,
      ...(existing === null ? {} : { supersedes: existing.id }),
      recordedBy: actor,
      source: "manual"
    },
    now
  );
  store.savePublicationReference(task.id, reference);
  recordPublicationEvent(store, reference, now);
  return { reference, idempotent: false };
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
  parsed: ParsedUpsertTail,
  usage: string
): PublicationVerification | undefined {
  if (parsed.flags.has("--reported") && parsed.flags.has("--verified")) {
    throw usageError("--reported and --verified are mutually exclusive.", usage);
  }
  if (parsed.flags.has("--verified")) return "verified";
  if (parsed.flags.has("--reported")) return "reported";
  return undefined;
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

function requiredEnumOption<T extends string>(
  options: ReadonlyMap<string, string>,
  name: string,
  allowed: ReadonlySet<string>,
  usage: string
): T {
  const value = enumOption<T>(options, name, allowed, usage);
  if (value === undefined) {
    throw usageError(`${name} is required.`, usage);
  }
  return value;
}

function inheritPublicationInput(
  existing: PublicationReference,
  input: PublicationReferenceInput
): PublicationReferenceInput {
  const localCommitChanged = input.localCommit !== undefined
    && normalizeCommitForComparison(input.localCommit) !== existing.localCommit;
  const stateChanged = input.state !== undefined && input.state !== existing.state;
  const remoteCommitChanged = input.remoteCommit !== undefined
    && normalizeCommitForComparison(input.remoteCommit) !== existing.remoteCommit;
  const evidenceChanged = input.evidence !== undefined
    && input.evidence.trim() !== existing.evidence;
  const mergedAtChanged = input.mergedAt !== undefined
    && input.mergedAt !== existing.mergedAt;
  const evidenceContextChanged = localCommitChanged
    || stateChanged
    || remoteCommitChanged
    || evidenceChanged
    || mergedAtChanged;
  const inherited: PublicationReferenceInput = {
    projectId: input.projectId,
    provider: input.provider,
    repository: input.repository,
    externalKind: input.externalKind,
    externalId: input.externalId,
    state: input.state ?? (localCommitChanged ? "open" : existing.state),
    verification: input.verification ?? (
      evidenceContextChanged ? "reported" : existing.verification
    ),
    ...(input.localCommit === undefined
      ? (existing.localCommit === undefined ? {} : { localCommit: existing.localCommit })
      : { localCommit: input.localCommit })
  };
  for (const field of INHERITED_METADATA_FIELDS) {
    const value = input[field] ?? existing[field];
    if (value !== undefined) Object.assign(inherited, { [field]: value });
  }
  for (const field of INHERITED_EVIDENCE_FIELDS) {
    const value = input[field] ?? (
      evidenceContextChanged ? undefined : existing[field]
    );
    if (value !== undefined) Object.assign(inherited, { [field]: value });
  }
  return inherited;
}

function normalizeCommitForComparison(value: string): string {
  return value.trim().toLowerCase();
}

function publicationSemantics(reference: PublicationReference) {
  const {
    schemaVersion: _schemaVersion,
    id: _id,
    taskId: _taskId,
    supersedes: _supersedes,
    recordedBy: _recordedBy,
    source: _source,
    createdAt: _createdAt,
    ...semantics
  } = reference;
  return semantics;
}

function requireTask(store: TaskWorkflowStore, taskId: string | undefined) {
  const id = requiredText(taskId, "Task id");
  const task = store.getTask(id);
  if (task === null) throw taskNotFound(id);
  return task;
}

function recordPublicationEvent(
  store: TaskWorkflowStore,
  reference: PublicationReference,
  now: Date
): void {
  recordTaskEvent(store, reference.taskId, "publication.recorded", {
    publicationId: reference.id,
    provider: reference.provider,
    repository: reference.repository,
    externalKind: reference.externalKind,
    externalId: reference.externalId,
    state: reference.state,
    verification: reference.verification
  }, now);
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

function requiredOption(
  options: ReadonlyMap<string, string>,
  name: string,
  usage?: string
): string {
  const value = options.get(name)?.trim();
  if (value === undefined || value.length === 0) {
    throw usageError(`${name} is required.`, usage);
  }
  return value;
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

type ParsedUpsertTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}>;

function parseUpsertArgs(args: string[], usage: string): ParsedUpsertTail {
  const valueOptions = new Set([
    "--project", "--provider", "--repository", "--kind", "--id", "--url",
    "--title", "--source-branch", "--target-branch", "--local-commit",
    "--remote-commit", "--state", "--evidence", "--merged-at"
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
