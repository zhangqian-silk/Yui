import type { Role } from "../role/role.js";

export type DispatchContextStore = Readonly<Record<string, never>>;

export type BuildRoleContextInput = Readonly<{
  taskId: string;
  role: Role;
  input: string;
  workItem?: Readonly<{
    id: string;
    writeProjectIds: readonly string[];
  }>;
  workspace?: Readonly<{
    root: string;
    entries: readonly Readonly<{
      projectId: string;
      directory: string;
      access: "read" | "write";
    }>[];
  }>;
}>;

/** Compatibility entry point used by the restored Task workflow. */
export function compileDispatchInput(
  _store: DispatchContextStore,
  taskId: string,
  role: Role,
  input: string,
  workContext: Pick<BuildRoleContextInput, "workItem" | "workspace"> = {}
): string {
  return buildRoleContext({ taskId, role, input, ...workContext });
}

export function buildRoleContext(context: BuildRoleContextInput): string {
  return context.role.name === "leader"
    ? buildLeaderContext(context)
    : buildWorkerContext(context);
}

export function buildLeaderContext(context: BuildRoleContextInput): string {
  return renderDispatchContext("leader", context);
}

export function buildWorkerContext(context: BuildRoleContextInput): string {
  return renderDispatchContext("worker", context);
}

const WORKER_RUN_COMPLETION_MARKER = "Yui Role Run completion requirement:";
const WORKER_RUN_COMPLETION_REQUIREMENT = [
  WORKER_RUN_COMPLETION_MARKER,
  "Before ending, read the exact current Run ID from the managed first line and execute "
    + "`yui task run yield <current-run-id> --summary-file - <<'YUI_SUMMARY'` "
    + "followed by the outcome, evidence, and a closing `YUI_SUMMARY` line, "
    + "replacing the placeholder with that ID.",
  "If you cannot finally determine success, failure, completeness, or the correct "
    + "disposition, do not guess, silently stop, or hide uncertainty behind a success "
    + "summary. Use this exact yield path and label the handoff uncertain, incomplete, "
    + "blocked, or requiring Leader judgment.",
  "Report the most complete truthful evidence available and, when applicable: exact Run, "
    + "WorkItem, and native Session identity; actions actually performed; changed paths "
    + "and commit/worktree state; checks actually run and their outcomes; provider, runtime, "
    + "or permission errors; the last confirmed lifecycle boundary; work not performed; "
    + "unresolved assumptions or decisions; residual risks; confidence; and bounded next options.",
  "Yield submits immutable Run evidence and a Candidate, or Review evidence only. It never "
    + "implies Leader acceptance, WorkItem completion, ChangeSet capture, Integration, or "
    + "Task completion. Review Runs report findings, verification gaps, and limits; the "
    + "Leader decides disposition.",
  "This exact control-plane permission does not grant repository writes, broad Bash, "
    + "external effects, or cross-Run control.",
  "If the exact yield is denied, do not retry, broaden permissions, use a wrapper, mutate "
    + "Yui state, or invent delivery evidence. Truthfully surface the blocker through the "
    + "supported provider failure boundary; there is no fallback protocol.",
  "Yielding closes the Run and hands the WorkItem to the Leader for acceptance; "
    + "a final response alone does neither.",
  "The yield command must be your final tool action. After it succeeds, stop immediately: "
    + "do not inspect, poll, accept, or perform any further work in the same native turn."
].join("\n");

export function ensureWorkerRunCompletionRequirement(
  input: string
): string {
  return input.endsWith(`\n\n${WORKER_RUN_COMPLETION_REQUIREMENT}`)
    ? input
    : `${input}\n\n${WORKER_RUN_COMPLETION_REQUIREMENT}`;
}

function renderDispatchContext(
  kind: "leader" | "worker",
  context: BuildRoleContextInput
): string {
  const profile = context.role;
  const binding = profile.agentBindings[profile.activeAgentId];
  const profileLines = [
    `Task: ${context.taskId}`,
    `Role: ${profile.name}`,
    `Active Agent: ${profile.activeAgentId}`,
    `Runtime: ${binding.adapterId}; model: ${binding.config.model ?? "CLI default"}; effort: ${binding.config.effort ?? "CLI default"}; YOLO: ${binding.config.yolo === true ? "enabled" : "disabled"}`,
    profile.description === undefined ? null : `Description: ${profile.description}`,
    ...(profile.responsibilities ?? []).map((item) => `Responsibility: ${item}`),
    ...(profile.constraints ?? []).map((item) => `Constraint: ${item}`),
    profile.expectedOutput === undefined ? null : `Expected output: ${profile.expectedOutput}`
  ].filter((line): line is string => line !== null);
  const workLines = kind === "worker"
    ? renderWorkerScope(context)
    : [];
  const rendered = [
    `Follow the injected yui-${kind} Skill for this Yui dispatch.`,
    profileLines.join("\n"),
    workLines.length === 0 ? null : workLines.join("\n"),
    "Yui dispatch:",
    requireText(context.input, "dispatch input")
  ].filter((section): section is string => section !== null && section.length > 0)
    .join("\n\n");
  return kind === "worker"
    ? ensureWorkerRunCompletionRequirement(rendered)
    : rendered;
}

function renderWorkerScope(context: BuildRoleContextInput): string[] {
  if (context.workItem === undefined || context.workspace === undefined) return [];
  const writable = context.workspace.entries.filter(({ access }) => access === "write");
  const contextOnly = context.workspace.entries.filter(({ access }) => access === "read");
  const projectLines = (
    label: string,
    entries: typeof context.workspace.entries
  ): string[] => [
    `${label}:`,
    ...(entries.length === 0
      ? ["- none"]
      : entries.map(({ directory, projectId }) => `- ${directory} (${projectId})`))
  ];
  return [
    `WorkItem: ${context.workItem.id}`,
    `Workspace root: ${context.workspace.root}`,
    ...projectLines("Writable Projects", writable),
    ...projectLines("Context-only Projects", contextOnly),
    `Read the full Task state with \`yui task context ${context.taskId}\`.`,
    `Read the current WorkItem scope with \`yui task work list ${context.taskId}\`.`,
    "Modify only Writable Projects. If another Project must change, stop and ask "
      + "the Task Leader to expand this WorkItem scope before continuing."
  ];
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
