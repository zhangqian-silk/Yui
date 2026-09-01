/**
 * Automatic Resource GC for terminal Tasks (Issue 10).
 *
 * The Controller may call this on a low-frequency timer to quarantine
 * resources owned by terminal Tasks. It is always opt-in: the
 * `resources.gcAutoQuarantine` config defaults to false, and permanent
 * deletion remains a manual, delayed step.
 *
 * The auto-GC pass reuses the same plan/apply engine as the manual command,
 * so every safety guarantee (live-ref re-scan, cleanliness proof, fail-closed
 * sources) applies identically.
 */

import type { TaskStore } from "../storage/taskStore.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import {
  applyResourceGc,
  planResourceGc,
  type GcResult
} from "./resourceGc.js";
import {
  resolveResourcesGcAutoQuarantine,
  resolveResourcesGcMode,
  resolveResourcesQuarantineTtlHours
} from "../config/yuiConfig.js";

export type ResourceAutoGcHook = () => Promise<Readonly<{
  skipped: boolean;
  applied: number;
  failed: number;
  restored: number;
}>>;

/**
 * Create the Controller's automatic Resource GC hook. The hook self-skips
 * unless `resourcesGcMode=quarantine` and `resourcesGcAutoQuarantine=true`.
 */
export function createResourceAutoGc(options: {
  home: string;
  store: TaskStore;
  environment?: NodeJS.ProcessEnv;
}): ResourceAutoGcHook {
  const { home, store, environment } = options;
  return async () => {
    const config = store.getConfig();
    const autoQuarantine = resolveResourcesGcAutoQuarantine(config.resourcesGcAutoQuarantine);
    if (!autoQuarantine || resolveResourcesGcMode(config.resourcesGcMode) !== "quarantine") {
      return { skipped: true, applied: 0, failed: 0, restored: 0 };
    }
    const now = new Date();
    const projects = store.listProjects();
    const managedWorkspaces = collectManagedWorkspaces(store);
    const taskStatusById = collectTaskStatuses(store);
    const input = {
      home,
      projects,
      managedWorkspaces,
      taskStatusById,
      mode: "quarantine" as const,
      now,
      quarantineTtlHours: resolveResourcesQuarantineTtlHours(
        config.resourcesQuarantineTtlHours
      ),
      environment,
      activeWorkspaceOwnerPaths: collectActiveWorkspaceOwnerPaths(store)
    };
    const plan = await planResourceGc(input);
    const result = await applyResourceGc(input, plan);
    return {
      skipped: false,
      applied: result.applied.length,
      failed: result.failed.length,
      restored: result.restored.length
    };
  };
}

export type AutoGcResult = Readonly<{
  ran: boolean;
  result?: GcResult;
  reason?: string;
}>;

/**
 * Run one automatic GC pass. Returns `ran: false` when auto-GC is disabled or
 * the GC mode is not `quarantine`. The pass never purges: permanent deletion
 * is always manual.
 */
export async function runAutoResourceGc(
  store: TaskStore,
  options: { now?: Date } = {}
): Promise<AutoGcResult> {
  const config = store.getConfig();
  const autoQuarantine = resolveResourcesGcAutoQuarantine(config.resourcesGcAutoQuarantine);
  if (!autoQuarantine) {
    return { ran: false, reason: "auto-quarantine is disabled" };
  }
  const gcMode = resolveResourcesGcMode(config.resourcesGcMode);
  if (gcMode !== "quarantine") {
    return { ran: false, reason: "resources.gcMode is not quarantine" };
  }

  const now = options.now ?? new Date();
  const home = store.rootDirectory();
  const projects = store.listProjects();
  const managedWorkspaces = collectManagedWorkspaces(store);
  const taskStatusById = collectTaskStatuses(store);

  const input = {
    home,
    projects,
    managedWorkspaces,
    taskStatusById,
    mode: "quarantine" as const,
    now,
    quarantineTtlHours: resolveResourcesQuarantineTtlHours(
      config.resourcesQuarantineTtlHours
    ),
    activeWorkspaceOwnerPaths: collectActiveWorkspaceOwnerPaths(store)
  };

  const plan = await planResourceGc(input);
  const result = await applyResourceGc(input, plan);
  return { ran: true, result };
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

/**
 * Workspace paths claimed by active durable Jobs. An active Turn still
 * holds its workspace even after the managed workspace record is gone, so
 * those paths stay protected until the Turn finishes.
 */
function collectActiveWorkspaceOwnerPaths(store: TaskStore): string[] {
  const paths: string[] = [];
  for (const task of store.listTasks()) {
    for (const run of store.listTurns(task.id)) {
      if (run.status !== "active") continue;
      const workspace = run.workspace;
      if (workspace === undefined) continue;
      paths.push(workspace.root, ...workspace.entries.map((entry) => entry.path));
    }
  }
  return paths;
}
