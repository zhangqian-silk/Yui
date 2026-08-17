/**
 * `yui resources gc` — Resource GC command (Issue 10).
 *
 * Dry-run by default. `--apply` quarantines releasable resources only when
 * `resources.gcMode=quarantine` is set; `--purge` permanently deletes
 * quarantined resources after the observation window.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { Project } from "../repository/project.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import {
  applyResourceGc,
  planResourceGc,
  purgeResourceQuarantine,
  type GcMode,
  type GcPlan,
  type GcResult
} from "../resources/resourceGc.js";
import { createResourceRegistryStore } from "../resources/resourceRegistryStore.js";
import {
  resourceKindLabel,
  resourceOwnerLabel
} from "../resources/resourceDiscovery.js";
import type { ResourceRecord } from "../resources/resourceTypes.js";

export type ResourcesCommandResult = Readonly<{
  output: string;
  data?: unknown;
}>;

type GcAction = "dry-run" | "apply" | "purge";

export type ResourcesCommandOptions = Readonly<{
  now?: () => Date;
}>;

export async function runResourcesCommand(
  args: readonly string[],
  store: TaskStore,
  options: ResourcesCommandOptions = {}
): Promise<ResourcesCommandResult> {
  const [command, ...rest] = args;
  if (command !== "gc") {
    throw usageError(
      "Unknown resources command. Available: yui resources gc "
        + "[--dry-run|--apply|--purge] [--quarantine-ttl-hours <hours>]."
    );
  }
  return runGcCommand(rest, store, options);
}

async function runGcCommand(
  args: readonly string[],
  store: TaskStore,
  options: ResourcesCommandOptions
): Promise<ResourcesCommandResult> {
  const action = parseGcAction(args);
  const ttlHours = parseTtlHours(args);
  const now = options.now?.() ?? new Date();
  const home = resolve(store.rootDirectory());
  const mode = resolveGcMode(store);

  const projects = store.listProjects();
  const managedWorkspaces = collectManagedWorkspaces(store);
  const taskStatusById = collectTaskStatuses(store);

  if (action === "purge") {
    if (mode !== "quarantine") {
      return {
        output: "resources.gcMode=report; purge skipped. "
          + "Set resources.gcMode=quarantine to enable purge.",
        data: { mode, action: "purge", skipped: true }
      };
    }
    const result = await purgeResourceQuarantine(home, { now, ttlHours });
    return {
      output: renderPurgeResult(result),
      data: result
    };
  }

  const plan = await planResourceGc({
    home,
    registryStore: createResourceRegistryStore(home),
    projects,
    managedWorkspaces,
    taskStatusById,
    mode,
    now,
    quarantineTtlHours: ttlHours
  });

  if (action === "apply" && mode === "quarantine") {
    const result = await applyResourceGc(plan);
    return {
      output: renderApplyResult(result),
      data: result
    };
  }

  return {
    output: renderPlan(plan, action),
    data: plan
  };
}

function parseGcAction(args: readonly string[]): GcAction {
  const flags = new Set(args);
  if (flags.has("--apply")) return "apply";
  if (flags.has("--purge")) return "purge";
  return "dry-run";
}

function parseTtlHours(args: readonly string[]): number {
  const index = args.indexOf("--quarantine-ttl-hours");
  if (index === -1) return 24;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 1 || value > 24 * 30) {
    throw usageError("Quarantine TTL hours must be between 1 and 720.");
  }
  return value;
}

function resolveGcMode(store: TaskStore): GcMode {
  const value = store.getConfig().resourcesGcMode;
  return value === "quarantine" ? "quarantine" : "report";
}

function collectManagedWorkspaces(store: TaskStore): ManagedWorkspace[] {
  const workspaces: ManagedWorkspace[] = [];
  for (const task of store.listTasks()) {
    workspaces.push(...store.listManagedWorkspaces(task.id));
  }
  return workspaces;
}

function collectTaskStatuses(store: TaskStore): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const task of store.listTasks()) {
    statuses.set(task.id, task.status);
  }
  return statuses;
}

function renderPlan(plan: GcPlan, action: GcAction): string {
  const lines: string[] = [];
  const modeNotice = plan.mode === "report" && action === "apply"
    ? "resources.gcMode=report; apply shadowed (no changes). "
      + "Set resources.gcMode=quarantine to enable.\n"
    : "";
  lines.push(`${modeNotice}Resource GC plan (${plan.mode}, ${action}) at ${plan.generatedAt}`);
  lines.push(`Home: ${plan.home}`);
  lines.push("");

  if (plan.records.length === 0) {
    lines.push("No resources discovered.");
    return lines.join("\n");
  }

  const rows = plan.records.map((record) => [
    record.id,
    resourceKindLabel(record.kind),
    truncate(record.path, 60),
    resourceOwnerLabel(record.owner),
    formatSize(record.sizeBytes),
    record.cleanliness,
    record.activeRefs.length === 0 ? "-" : `${record.activeRefs.length} ref(s)`,
    record.disposition,
    record.blocker ?? ""
  ]);
  lines.push(renderTable(
    "Resources",
    [
      { header: "ID", minWidth: 16, maxWidth: 16 },
      { header: "Kind", minWidth: 14, maxWidth: 14 },
      { header: "Path", minWidth: 20, maxWidth: 60 },
      { header: "Owner", minWidth: 16, maxWidth: 32 },
      { header: "Size", minWidth: 10, maxWidth: 12 },
      { header: "Clean", minWidth: 8, maxWidth: 8 },
      { header: "Refs", minWidth: 8, maxWidth: 10 },
      { header: "Disposition", minWidth: 14, maxWidth: 16 },
      { header: "Blocker", minWidth: 10, maxWidth: 40 }
    ],
    rows,
    defaultTableWidth()
  ));
  lines.push("");
  lines.push(
    `Summary: ${plan.releasable.length} releasable, `
      + `${plan.retained.length} retained, `
      + `${plan.quarantined.length} quarantined, `
      + `${plan.deleted.length} deleted.`
  );
  return lines.join("\n");
}

function renderApplyResult(result: GcResult): string {
  const lines: string[] = [];
  lines.push(`Resource GC apply at ${result.planned.generatedAt}`);
  lines.push(`Home: ${result.planned.home}`);
  lines.push("");
  if (result.applied.length > 0) {
    lines.push(`Quarantined ${result.applied.length} resource(s):`);
    for (const record of result.applied) {
      lines.push(`  ${record.id} ${resourceKindLabel(record.kind)} ${record.path}`);
    }
  }
  if (result.failed.length > 0) {
    lines.push(`Failed ${result.failed.length} resource(s):`);
    for (const record of result.failed) {
      lines.push(`  ${record.id} ${record.path}: ${record.blocker ?? "unknown"}`);
    }
  }
  if (result.restored.length > 0) {
    lines.push(`Restored ${result.restored.length} resource(s) from quarantine.`);
  }
  if (result.applied.length === 0 && result.failed.length === 0 && result.restored.length === 0) {
    lines.push("No releasable resources.");
  }
  return lines.join("\n");
}

function renderPurgeResult(result: GcResult): string {
  const lines: string[] = [];
  lines.push(`Resource GC purge at ${result.planned.generatedAt}`);
  lines.push(`Home: ${result.planned.home}`);
  lines.push("");
  if (result.purged.length > 0) {
    lines.push(`Purged ${result.purged.length} resource(s):`);
    for (const record of result.purged) {
      lines.push(`  ${record.id} ${resourceKindLabel(record.kind)}`);
    }
  }
  if (result.restored.length > 0) {
    lines.push(`Restored ${result.restored.length} resource(s) with new live references.`);
  }
  if (result.failed.length > 0) {
    lines.push(`Failed ${result.failed.length} resource(s):`);
    for (const record of result.failed) {
      lines.push(`  ${record.id}: ${record.blocker ?? "unknown"}`);
    }
  }
  if (result.purged.length === 0 && result.restored.length === 0 && result.failed.length === 0) {
    lines.push("No quarantined resources past the observation window.");
  }
  return lines.join("\n");
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `…${value.slice(-(max - 1))}`;
}

export { existsSync as resourceExistsSync };
