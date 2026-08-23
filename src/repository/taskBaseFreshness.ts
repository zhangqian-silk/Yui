import { usageError } from "../errors/cliError.js";
import { createTaskEvent, type TaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task, TaskProjectBinding } from "../task/task.js";
import { workspaceProjectEntry, type ManagedWorkspace } from "../worktree/managedWorkspace.js";
import { NodeGitWorkspace, type GitRemoteBaseline, type GitWorkspacePort } from "./gitWorkspace.js";
import type { Project } from "./project.js";

export type TaskBaseFreshnessStatus =
  | "up-to-date"
  | "behind"
  | "ahead"
  | "diverged"
  | "unknown"
  | "not-applicable";

export type TaskBaseFreshnessSource =
  | "local-tracking"
  | "remote-refresh"
  | "compatibility-projection"
  | "not-applicable";

export type TaskBaseProvenanceSource =
  | "local-tracking"
  | "remote-fetch"
  | "unknown"
  | "not-applicable";

export type TaskBaseProvenance = Readonly<{
  projectId: string;
  directory: string;
  baseRef: string;
  baseCommit: string;
  source: TaskBaseProvenanceSource;
  remoteUrl?: string;
  trackingRef?: string;
  trackingCommit?: string;
  remoteConfigured: boolean;
}>;

export type TaskBaseFreshness = Readonly<{
  projectId: string;
  directory: string;
  baseRef: string;
  baseCommit: string;
  status: TaskBaseFreshnessStatus;
  source: TaskBaseFreshnessSource;
  workspacePath: string;
  workspaceClean: boolean | null;
  trackedRef?: string;
  trackedCommit?: string;
  remoteOnlyChangedFiles: readonly string[];
  remoteOnlyChangedFileCount: number;
  risk?: string;
  error?: string;
  observedAt?: string;
  observedSource?: TaskBaseProvenanceSource;
  observedRemoteUrl?: string;
  observedTrackingRef?: string;
  observedTrackingCommit?: string;
}>;

export type TaskBaseFreshnessReport = Readonly<{
  taskId: string;
  refreshed: boolean;
  entries: readonly TaskBaseFreshness[];
}>;

export type TaskBaseCompletionOptions = Readonly<{
  /** One exact Project whose reviewed Task head was explicitly accepted as
   * tree-identical to its verified merged Publication commit. */
  acceptedPublishedTreeProjectId?: string;
}>;

type CaptureInput = Readonly<{
  git: GitWorkspacePort;
  project: Project;
  binding: TaskProjectBinding;
  baseRef: string;
  baseCommit: string;
  remoteBaseline?: GitRemoteBaseline;
}>;

const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const RISK_FILE_PREVIEW = 20;

export async function captureTaskBaseProvenance(
  input: CaptureInput
): Promise<TaskBaseProvenance> {
  const common = {
    projectId: input.project.id,
    directory: input.binding.directory,
    baseRef: input.baseRef,
    baseCommit: input.baseCommit,
    ...(input.project.remoteUrl === undefined
      ? {}
      : { remoteUrl: redactRemoteUrl(input.project.remoteUrl) }),
    remoteConfigured: input.project.remoteUrl !== undefined
  };
  if (input.project.remoteUrl === undefined) {
    return { ...common, source: "not-applicable" };
  }
  if (input.remoteBaseline !== undefined) {
    return {
      ...common,
      source: "remote-fetch",
      trackingRef: `refs/heads/${input.remoteBaseline.branch}`,
      trackingCommit: input.remoteBaseline.commit
    };
  }
  const tracking = await input.git.inspectRemoteTracking({
    repositoryPath: input.project.path,
    remoteUrl: input.project.remoteUrl,
    branch: input.project.developmentBranch
  });
  if (tracking === null) {
    return { ...common, source: "unknown" };
  }
  return {
    ...common,
    source: "local-tracking",
    trackingRef: tracking.ref,
    trackingCommit: tracking.commit
  };
}

export function recordTaskBaseProvenanceEvents(
  tx: TaskStore,
  taskId: string,
  provenance: readonly TaskBaseProvenance[],
  now: Date
): void {
  for (const entry of provenance) {
    const payload: TaskEventPayload = {
      projectId: entry.projectId,
      directory: entry.directory,
      baseRef: entry.baseRef,
      baseCommit: entry.baseCommit,
      source: entry.source,
      remoteConfigured: entry.remoteConfigured ? "true" : "false",
      ...(entry.remoteUrl === undefined ? {} : { remoteUrl: entry.remoteUrl }),
      ...(entry.trackingRef === undefined ? {} : { trackingRef: entry.trackingRef }),
      ...(entry.trackingCommit === undefined ? {} : { trackingCommit: entry.trackingCommit })
    };
    tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId, "task.base-provenance", payload, now));
  }
}

export async function inspectTaskBaseFreshness(
  taskId: string,
  store: TaskStore,
  options: Readonly<{ git?: GitWorkspacePort; refresh?: boolean }> = {}
): Promise<TaskBaseFreshnessReport> {
  const task = requireTask(store, taskId);
  const git = options.git ?? newGitWorkspace();
  const workspace = store.getTaskWorkspace(taskId);
  const entries = await Promise.all(task.projectBindings.map(async (binding) => {
    const project = requireProject(store, binding.projectId);
    const entry = workspace === null ? undefined : workspaceProjectEntry(workspace, project.id);
    const baseCommit = await resolveBaseCommit(git, project, binding, entry);
    const workspacePath = entry?.path ?? project.path;
    const provenance = latestBaseProvenance(store.listEvents(taskId), project.id);
    const tracked = await resolveTracked(git, project, workspacePath, options.refresh === true);
    const status = await classifyStatus(git, workspacePath, project, baseCommit, tracked);
    const remoteOnlyChangedFiles = await remoteOnlyChanges(
      git,
      workspacePath,
      status,
      baseCommit,
      tracked?.commit
    );
    const workspaceClean = await inspectWorkspaceClean(git, workspacePath);
    return {
      projectId: project.id,
      directory: binding.directory,
      baseRef: binding.baseRef,
      baseCommit,
      status,
      source: tracked?.source ?? (project.remoteUrl === undefined ? "not-applicable" : "compatibility-projection"),
      workspacePath,
      workspaceClean,
      ...(tracked === undefined ? {} : {
        trackedRef: tracked.ref,
        trackedCommit: tracked.commit,
        ...(tracked.error === undefined ? {} : { error: redactText(tracked.error) })
      }),
      remoteOnlyChangedFiles: remoteOnlyChangedFiles.files.slice(0, RISK_FILE_PREVIEW),
      remoteOnlyChangedFileCount: remoteOnlyChangedFiles.files.length,
      ...(risk(status, workspaceClean, remoteOnlyChangedFiles.files, tracked?.error) === undefined
        ? {}
        : { risk: risk(status, workspaceClean, remoteOnlyChangedFiles.files, tracked?.error) }),
      ...(provenance === undefined ? {} : {
        observedAt: provenance.event.createdAt,
        observedSource: provenance.provenance.source,
        ...(provenance.provenance.remoteUrl === undefined
          ? {}
          : { observedRemoteUrl: provenance.provenance.remoteUrl }),
        ...(provenance.provenance.trackingRef === undefined
          ? {}
          : { observedTrackingRef: provenance.provenance.trackingRef }),
        ...(provenance.provenance.trackingCommit === undefined
          ? {}
          : { observedTrackingCommit: provenance.provenance.trackingCommit })
      })
    } satisfies TaskBaseFreshness;
  }));
  return { taskId, refreshed: options.refresh === true, entries };
}

export function assertTaskBaseFreshnessForCompletion(
  report: TaskBaseFreshnessReport,
  options: TaskBaseCompletionOptions = {}
): readonly string[] {
  const warnings: string[] = [];
  for (const entry of report.entries) {
    const acceptedPublishedTree = options.acceptedPublishedTreeProjectId === entry.projectId;
    if ((entry.status === "behind" || entry.status === "diverged")
      && !acceptedPublishedTree) {
      throw usageError(
        `Task ${report.taskId} Project ${entry.projectId} base is ${entry.status}; `
        + `run 'yui task base status ${report.taskId} --refresh' and choose an explicit delivery base. `
        + "Safe resolutions are to rebase or merge the Task workspace onto the refreshed remote base, "
        + "create a clean delivery branch from that base and cherry-pick the Task changes, "
        + "or ask the Leader to resolve it. Continuing without rebasing is allowed only after explicitly "
        + "recording the unrelated-diff risk."
      );
    }
    if (entry.workspaceClean === false) {
      throw usageError(
        `Task ${report.taskId} Project ${entry.projectId} workspace is dirty; `
        + "commit, integrate, or clean it before completion."
      );
    }
    if (entry.status === "unknown") {
      if (report.refreshed) {
        throw usageError(
          `Task ${report.taskId} Project ${entry.projectId} remote base could not be refreshed: `
          + `${entry.error ?? "unknown error"}`
        );
      }
      warnings.push(
        `Project ${entry.projectId} remote base is unknown; local completion continues without a remote claim.`
      );
    }
  }
  return warnings;
}

export function renderTaskBaseFreshnessReport(report: TaskBaseFreshnessReport): string {
  if (report.entries.length === 0) {
    return `Task ${report.taskId} has no Projects.\n`;
  }
  const lines = [
    `Task base freshness: ${report.taskId} (source: ${report.refreshed ? "remote refresh" : "local tracking"})`
  ];
  for (const entry of report.entries) {
    lines.push(
      `- ${entry.directory}: ${entry.projectId} @ ${entry.baseCommit}`,
      `  status: ${entry.status}; workspace: ${entry.workspaceClean === null ? "unknown" : entry.workspaceClean ? "clean" : "dirty"}`,
      `  observed remote: ${entry.observedRemoteUrl ?? "-"}`,
      `  tracked: ${entry.trackedCommit ?? "-"}${entry.trackedRef === undefined ? "" : ` (${entry.trackedRef})`}`,
      `  observed: ${entry.observedTrackingCommit ?? "-"}${entry.observedAt === undefined ? "" : ` at ${entry.observedAt}`}`
    );
    if (entry.risk !== undefined) lines.push(`  risk: ${entry.risk}`);
    if (entry.error !== undefined) lines.push(`  error: ${entry.error}`);
  }
  return lines.join("\n").concat("\n");
}

function newGitWorkspace(): GitWorkspacePort {
  return new NodeGitWorkspace();
}

function requireTask(store: TaskStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  return task;
}

function requireProject(store: TaskStore, projectId: string): Project {
  const project = store.getProject(projectId);
  if (project === null) throw usageError(`Project not found: ${projectId}.`);
  return project;
}

async function resolveBaseCommit(
  git: GitWorkspacePort,
  project: Project,
  binding: TaskProjectBinding,
  entry: ReturnType<typeof workspaceProjectEntry>
): Promise<string> {
  if (entry?.baseCommit !== undefined) return entry.baseCommit;
  if (COMMIT_PATTERN.test(binding.baseRef)) return binding.baseRef.toLowerCase();
  return (await git.inspect(project.path, binding.baseRef)).baseCommit;
}

async function resolveTracked(
  git: GitWorkspacePort,
  project: Project,
  workspacePath: string,
  refresh: boolean
): Promise<Readonly<{ ref: string; commit: string; source: TaskBaseFreshnessSource; error?: string }> | undefined> {
  if (project.remoteUrl === undefined) return undefined;
  if (refresh) {
    if (git.fetchRemoteHeadIntoWorktree === undefined) {
      return {
        ref: `refs/heads/${project.developmentBranch}`,
        commit: "",
        source: "remote-refresh",
        error: "managed Git workspace does not support remote refresh"
      };
    }
    try {
      const remote = await git.fetchRemoteHeadIntoWorktree({
        repositoryPath: workspacePath,
        remoteUrl: project.remoteUrl,
        branch: project.developmentBranch
      });
      return {
        ref: `refs/heads/${remote.branch}`,
        commit: remote.commit,
        source: "remote-refresh"
      };
    } catch (error) {
      return {
        ref: `refs/heads/${project.developmentBranch}`,
        commit: "",
        source: "remote-refresh",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  const tracking = await git.inspectRemoteTracking({
    repositoryPath: project.path,
    remoteUrl: project.remoteUrl,
    branch: project.developmentBranch
  });
  if (tracking === null) return undefined;
  return { ref: tracking.ref, commit: tracking.commit, source: "local-tracking" };
}

async function classifyStatus(
  git: GitWorkspacePort,
  repositoryPath: string,
  project: Project,
  baseCommit: string,
  tracked: Readonly<{ commit: string }> | undefined
): Promise<TaskBaseFreshnessStatus> {
  if (project.remoteUrl === undefined) return "not-applicable";
  if (tracked === undefined || tracked.commit === "") return "unknown";
  if (tracked.commit === baseCommit) return "up-to-date";
  if (await git.isAncestor(repositoryPath, baseCommit, tracked.commit)) {
    return "behind";
  }
  if (await git.isAncestor(repositoryPath, tracked.commit, baseCommit)) {
    return "ahead";
  }
  return "diverged";
}

async function remoteOnlyChanges(
  git: GitWorkspacePort,
  repositoryPath: string,
  status: TaskBaseFreshnessStatus,
  baseCommit: string,
  trackedCommit: string | undefined
): Promise<Readonly<{ files: readonly string[] }>> {
  if (trackedCommit === undefined
    || trackedCommit === ""
    || (status !== "behind" && status !== "diverged")) {
    return { files: [] };
  }
  try {
    const fromCommit = status === "behind"
      ? baseCommit
      : await git.mergeBase({ repositoryPath, leftCommit: baseCommit, rightCommit: trackedCommit });
    return {
      files: await git.changedFilesBetween({ repositoryPath, fromCommit, toCommit: trackedCommit })
    };
  } catch {
    return { files: [] };
  }
}

async function inspectWorkspaceClean(
  git: GitWorkspacePort,
  workspacePath: string
): Promise<boolean | null> {
  try {
    return await git.isClean(workspacePath);
  } catch {
    return null;
  }
}

function risk(
  status: TaskBaseFreshnessStatus,
  workspaceClean: boolean | null,
  files: readonly string[],
  error: string | undefined
): string | undefined {
  if (status === "behind" || status === "diverged") {
    const suffix = files.length === 0
      ? "no remote-only file delta is locally provable"
      : `${files.length} remote-only file${files.length === 1 ? "" : "s"} (${files.slice(0, RISK_FILE_PREVIEW).join(", ")}${files.length > RISK_FILE_PREVIEW ? ", ..." : ""}) may appear as unrelated delivery diff`;
    return `base is ${status}; ${suffix}.`;
  }
  if (workspaceClean === false) return "worktree has uncommitted changes.";
  if (status === "unknown") return error === undefined ? "remote identity is not locally observable." : redactText(error);
  return undefined;
}

function latestBaseProvenance(
  events: readonly TaskEvent[],
  projectId: string
): Readonly<{ event: TaskEvent; provenance: TaskBaseProvenance }> | undefined {
  const event = [...events].reverse().find((candidate) => (
    candidate.type === "task.base-provenance" && candidate.payload.projectId === projectId
  ));
  if (event === undefined) return undefined;
  const source = event.payload.source;
  if (source !== "local-tracking"
    && source !== "remote-fetch"
    && source !== "unknown"
    && source !== "not-applicable") {
    return undefined;
  }
  return {
    event,
    provenance: {
      projectId,
      directory: event.payload.directory ?? "",
      baseRef: event.payload.baseRef ?? "",
      baseCommit: event.payload.baseCommit ?? "",
      source,
      remoteConfigured: event.payload.remoteConfigured === "true",
      ...(event.payload.remoteUrl === undefined ? {} : { remoteUrl: event.payload.remoteUrl }),
      ...(event.payload.trackingRef === undefined ? {} : { trackingRef: event.payload.trackingRef }),
      ...(event.payload.trackingCommit === undefined ? {} : { trackingCommit: event.payload.trackingCommit })
    }
  };
}

function redactText(value: string): string {
  return redactRemoteUrl(value);
}

export function redactRemoteUrl(value: string): string {
  return value
    .replace(ABSOLUTE_REMOTE_URL_PATTERN, redactAbsoluteRemoteUrl)
    .replace(
      SCP_REMOTE_URL_PATTERN,
      (_match, prefix: string, _user: string, host: string, path: string) =>
        `${prefix}redacted@${host}:${path}`
    );
}

const ABSOLUTE_REMOTE_URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gu;
const SCP_REMOTE_URL_PATTERN = /(^|[\s"'(])([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([^\s"'<>]+)/gu;

function redactAbsoluteRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") {
      url.username = "redacted";
      url.password = "";
      return url.toString();
    }
    return value;
  } catch {
    return value.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/u, "$1redacted@");
  }
}
