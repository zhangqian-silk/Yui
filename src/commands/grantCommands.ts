import { dataError, taskNotFound, usageError } from "../errors/cliError.js";
import { createTaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import {
  createCapabilityGrant,
  revokeGrant,
  type CapabilityGrant,
  type CapabilityGrantIrreversibilityCeiling,
  type CapabilityGrantScope
} from "../grant/capabilityGrant.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatTimestamp } from "../output/timePresentation.js";
import type { Task } from "../task/task.js";
import { isCurrentGlobalOperator } from "./taskInputCommands.js";
import type {
  TaskCommandExecution,
  TaskCommandOptions,
  TaskWorkflowStore
} from "./taskCommands.js";

const CEILINGS: ReadonlySet<string> = new Set(["none", "reversible", "irreversible"]);

export function runGrantCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "issue": return issueGrant(rest, store, options);
    case "show": return showGrant(rest, store);
    case "list": return listGrants(rest, store);
    case "revoke": return revokeGrantCommand(rest, store, options);
    default:
      throw usageError(command === undefined
        ? "Task grant command is required."
        : `Unknown command: task grant ${command}`);
  }
}

function issueGrant(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task grant issue usage: yui task grant issue <task> --action <name> (repeatable) [--scope-project <id>...] [--scope-repo <owner/name>...] [--scope-package <name>...] [--scope-home <path>] [--param <name=v1,v2>...] [--expires-at <iso-8601>] [--max-uses <int>] [--irreversibility-ceiling <none|reversible|irreversible>].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--scope-home", "--expires-at", "--max-uses", "--irreversibility-ceiling"]),
    new Set(["--action", "--scope-project", "--scope-repo", "--scope-package", "--param"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const actions = parsed.multiOptions.get("--action") ?? [];
  if (actions.length === 0) throw usageError("--action is required.", usage);
  const scope = buildScope(parsed, usage);
  const parameterBounds = buildParameterBounds(parsed, usage);
  const expiresAt = optionalOption(parsed.options, "--expires-at");
  const maxUses = parseMaxUses(parsed, usage);
  const ceiling = parseCeiling(parsed, usage);
  // Grant issuance mints irreversible authority. The granter is bound to the
  // authenticated global Operator Session, not to a caller-supplied label.
  const env = options.environment ?? {};
  const granter = authorizeGrantOrigin(store, env, usage);
  const now = clock(options);
  // The grant record and its audit event commit in one transaction: a failed
  // event save cannot leave a persisted grant without its audit trail.
  const grant = store.transaction((tx) => {
    const issued = createCapabilityGrant(
      tx.nextCapabilityGrantId(taskId),
      taskId,
      {
        granter,
        ...(scope === undefined ? {} : { scope }),
        actions,
        ...(parameterBounds === undefined ? {} : { parameterBounds }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(maxUses === undefined ? {} : { maxUses }),
        ...(ceiling === undefined ? {} : { irreversibilityCeiling: ceiling })
      },
      now
    );
    tx.saveCapabilityGrant(taskId, issued);
    recordTaskEvent(tx, taskId, "capability-grant.issued", {
      grantId: issued.id,
      granter: issued.granter,
      actions: issued.actions.join(","),
      scope: scopeSummary(issued.scope)
    }, now);
    return issued;
  });
  return output(`Granted ${grant.id} to ${grant.taskId}.\n`, grant);
}

/**
 * Authorizes a grant mutation (issue or revoke) and returns the origin-bound
 * identity to record as the granter/revoker.
 *
 * Grant issue and revoke carry irreversible authority: they mint or revoke
 * the capability that lets a managed Agent perform irreversible site changes.
 * The only accepted origin is the authenticated global Operator Session,
 * whose env claims are verified against the durable live session binding by
 * isCurrentGlobalOperator.
 *
 * Absence of YUI identity vars is deliberately NOT treated as user authority:
 * a managed Agent can clear its child-process environment, so a "clean"
 * environment is indistinguishable from a scrubbed managed one. A Task-scoped
 * Session, a partial managed identity, and a stale/forged global binding are
 * all refused. Caller-supplied --granter/--by labels are not identity; the
 * recorded granter/revoker is bound to the Operator Session instead.
 */
function authorizeGrantOrigin(
  store: TaskWorkflowStore,
  env: NodeJS.ProcessEnv,
  usage: string
): string {
  if (!isCurrentGlobalOperator(store, env)) {
    throw usageError(
      "Grant issue and revoke require the authenticated global Operator " +
      "session. A managed Agent cannot self-issue or self-revoke a " +
      "capability grant, and a clean environment is not user authority.",
      usage
    );
  }
  // isCurrentGlobalOperator verified YUI_AGENT_ID against the durable binding.
  return `operator:${env.YUI_AGENT_ID ?? "unknown"}`;
}

function showGrant(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const usage = "Task grant show usage: yui task grant show <task> <grant-id>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const grant = store.getCapabilityGrant(taskId, parsed.positionals[1]!);
  if (grant === null) {
    throw dataError(`Capability grant not found: ${taskId}/${parsed.positionals[1]}.`);
  }
  return output(renderGrant(grant, store.getConfig().timeZone), grant);
}

function listGrants(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const usage = "Task grant list usage: yui task grant list <task>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const grants = store.listCapabilityGrants(taskId);
  if (grants.length === 0) {
    return output("No capability grants found.\n", []);
  }
  const timeZone = store.getConfig().timeZone;
  const rendered = `${renderTable(
    `Capability grants: ${taskId}`,
    [
      { header: "ID", minWidth: 6, maxWidth: 20 },
      { header: "Granter", minWidth: 6, maxWidth: 18 },
      { header: "Actions", minWidth: 8, maxWidth: 40 },
      { header: "Expires", minWidth: 10, maxWidth: 28 },
      { header: "Uses", minWidth: 5, maxWidth: 10 },
      { header: "Ceiling", minWidth: 8, maxWidth: 14 },
      { header: "Revoked", minWidth: 8, maxWidth: 28 }
    ],
    grants.map((grant) => [
      grant.id,
      grant.granter,
      grant.actions.join(","),
      grant.expiresAt === undefined ? "-" : formatTimestamp(grant.expiresAt, timeZone),
      grant.maxUses === undefined ? `${grant.usesUsed}` : `${grant.usesUsed}/${grant.maxUses}`,
      grant.irreversibilityCeiling,
      grant.revokedAt === undefined ? "no" : formatTimestamp(grant.revokedAt, timeZone)
    ]),
    defaultTableWidth()
  )}\n`;
  return output(rendered, grants);
}

function revokeGrantCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task grant revoke usage: yui task grant revoke <task> <grant-id>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const taskId = parsed.positionals[0]!;
  requireTask(store, taskId);
  const existing = store.getCapabilityGrant(taskId, parsed.positionals[1]!);
  if (existing === null) {
    throw dataError(`Capability grant not found: ${taskId}/${parsed.positionals[1]}.`);
  }
  // Revoke is the same irreversible-authority operation as issue: it requires
  // the authenticated Operator Session, and the revoker is bound to it.
  const env = options.environment ?? {};
  const by = authorizeGrantOrigin(store, env, usage);
  const wasRevoked = existing.revokedAt !== undefined;
  const now = clock(options);
  const grant = revokeGrant(existing, by, now);
  // The revoked grant and its audit event commit in one transaction: a failed
  // event save cannot leave a revoked grant without its audit trail.
  store.transaction((tx) => {
    tx.saveCapabilityGrant(taskId, grant);
    if (!wasRevoked) {
      recordTaskEvent(tx, taskId, "capability-grant.revoked", {
        grantId: grant.id,
        revokedBy: grant.revokedBy ?? by
      }, now);
    }
  });
  return output(`Revoked ${grant.id}.\n`, grant);
}

function buildScope(parsed: ParsedMultiTail, usage: string): CapabilityGrantScope | undefined {
  const projectIds = parsed.multiOptions.get("--scope-project") ?? [];
  const repositories = (parsed.multiOptions.get("--scope-repo") ?? []).map((value) => {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
      throw usageError("--scope-repo must use owner/name.", usage);
    }
    return {
      owner: value.slice(0, separator).trim(),
      name: value.slice(separator + 1).trim()
    };
  });
  const packages = parsed.multiOptions.get("--scope-package") ?? [];
  const homePath = optionalOption(parsed.options, "--scope-home");
  if (projectIds.length === 0
    && repositories.length === 0
    && packages.length === 0
    && homePath === undefined) {
    return undefined;
  }
  return {
    ...(projectIds.length > 0 ? { projectIds } : {}),
    ...(repositories.length > 0 ? { repositories } : {}),
    ...(packages.length > 0 ? { packages } : {}),
    ...(homePath === undefined ? {} : { homePath })
  };
}

function buildParameterBounds(
  parsed: ParsedMultiTail,
  usage: string
): Record<string, readonly string[]> | undefined {
  const paramValues = parsed.multiOptions.get("--param") ?? [];
  if (paramValues.length === 0) return undefined;
  const bounds: Record<string, readonly string[]> = {};
  for (const value of paramValues) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw usageError("--param must use name=value1,value2.", usage);
    }
    const name = value.slice(0, separator).trim();
    const allowed = value.slice(separator + 1)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (allowed.length === 0) {
      throw usageError(`--param must list at least one value: ${name}.`, usage);
    }
    if (Object.hasOwn(bounds, name)) {
      throw usageError(`--param may only be specified once per name: ${name}.`, usage);
    }
    bounds[name] = allowed;
  }
  return bounds;
}

function parseMaxUses(parsed: ParsedMultiTail, usage: string): number | undefined {
  const value = optionalOption(parsed.options, "--max-uses");
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw usageError("--max-uses must be a positive integer.", usage);
  }
  return Number(value);
}

function parseCeiling(
  parsed: ParsedMultiTail,
  usage: string
): CapabilityGrantIrreversibilityCeiling | undefined {
  const value = optionalOption(parsed.options, "--irreversibility-ceiling");
  if (value === undefined) return undefined;
  if (!CEILINGS.has(value)) {
    throw usageError("--irreversibility-ceiling must be one of: none, reversible, irreversible.", usage);
  }
  return value as CapabilityGrantIrreversibilityCeiling;
}

function scopeSummary(scope: CapabilityGrantScope): string {
  const parts: string[] = [];
  if (scope.taskId !== undefined) parts.push(`task:${scope.taskId}`);
  if (scope.projectIds !== undefined && scope.projectIds.length > 0) {
    parts.push(`project:${scope.projectIds.join(",")}`);
  }
  if (scope.repositories !== undefined && scope.repositories.length > 0) {
    parts.push(`repo:${scope.repositories.map((repo) => `${repo.owner}/${repo.name}`).join(",")}`);
  }
  if (scope.packages !== undefined && scope.packages.length > 0) {
    parts.push(`package:${scope.packages.join(",")}`);
  }
  if (scope.homePath !== undefined) parts.push(`home:${scope.homePath}`);
  return parts.join(";");
}

function renderGrant(grant: CapabilityGrant, timeZone: string | undefined): string {
  return [
    `Grant: ${grant.id}`,
    `Task: ${grant.taskId}`,
    `Granter: ${grant.granter}`,
    `Scope: ${scopeSummary(grant.scope)}`,
    `Actions: ${grant.actions.join(", ")}`,
    ...(Object.keys(grant.parameterBounds).length === 0
      ? []
      : [
          "Parameters:",
          ...Object.entries(grant.parameterBounds)
            .map(([name, values]) => `  ${name}: ${values.join(", ")}`)
        ]),
    ...(grant.expiresAt === undefined
      ? []
      : [`Expires: ${formatTimestamp(grant.expiresAt, timeZone)}`]),
    ...(grant.maxUses === undefined ? [] : [`Max uses: ${grant.maxUses}`]),
    `Uses used: ${grant.usesUsed}`,
    `Ceiling: ${grant.irreversibilityCeiling}`,
    ...(grant.revokedAt === undefined
      ? ["Revoked: no"]
      : [
          "Revoked: yes",
          `Revoked by: ${grant.revokedBy}`,
          `Revoked at: ${formatTimestamp(grant.revokedAt, timeZone)}`
        ]),
    `Created: ${formatTimestamp(grant.createdAt, timeZone)}`,
    `Updated: ${formatTimestamp(grant.updatedAt, timeZone)}`
  ].join("\n").concat("\n");
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
