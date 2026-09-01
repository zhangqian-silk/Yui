import type { Role } from "../role/role.js";

/** Stable Project references that tell an Agent where Project Policy lives.
 *
 * Policy remains a Yui-maintained Project record (or a configured Project
 * Skill); the dispatch only carries pointers so a launch cannot silently turn
 * repository prose into a second source of truth.
 */
export type ProjectPolicyReference = Readonly<{
  projectId: string;
  directory?: string;
}>;

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
  projectPolicy?: readonly ProjectPolicyReference[];
}>;

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

const WORKER_TURN_COMPLETION_MARKER = "Yui Role Turn result requirement:";
const WORKER_TURN_COMPLETION_REQUIREMENT = [
  WORKER_TURN_COMPLETION_MARKER,
  "End the Provider turn with a truthful final report. Yui records that native turn result "
    + "for the current Turn automatically; no completion command is required.",
  "If you cannot finally determine success, failure, completeness, or the correct "
    + "disposition, do not guess, silently stop, or hide uncertainty behind a success "
    + "summary. Label the final report uncertain, incomplete, "
    + "blocked, or requiring Leader judgment.",
  "Report the most complete truthful evidence available and, when applicable: exact Turn, "
    + "WorkItem, and native Session identity; actions actually performed; changed paths "
    + "and commit/worktree state; checks actually run and their outcomes; provider, runtime, "
    + "or permission errors; the last confirmed lifecycle boundary; work not performed; "
    + "unresolved assumptions or decisions; residual risks; confidence; and bounded next options.",
  "The Provider turn ending closes only this Turn. It does not imply Leader acceptance, "
    + "WorkItem completion, ChangeSet capture, Integration, or Task completion. Review Turns "
    + "report findings, verification gaps, and limits; the Leader decides disposition."
].join("\n");

export function ensureWorkerTurnCompletionRequirement(
  input: string
): string {
  return input.endsWith(`\n\n${WORKER_TURN_COMPLETION_REQUIREMENT}`)
    ? input
    : `${input}\n\n${WORKER_TURN_COMPLETION_REQUIREMENT}`;
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
    `Runtime: ${binding.adapterId}; model: ${binding.config.model ?? "CLI default"}; effort: ${binding.config.effort ?? "CLI default"}; permission: ${binding.config.permission.strategy}`,
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
    renderContextLayers(context, kind),
    profileLines.join("\n"),
    workLines.length === 0 ? null : workLines.join("\n"),
    "Yui dispatch:",
    requireText(context.input, "dispatch input")
  ].filter((section): section is string => section !== null && section.length > 0)
    .join("\n\n");
  return kind === "worker"
    ? ensureWorkerTurnCompletionRequirement(rendered)
    : rendered;
}

function renderContextLayers(
  context: BuildRoleContextInput,
  kind: "leader" | "worker"
): string {
  const projects = context.projectPolicy ?? [];
  const policyLines = projects.length === 0
    ? ["- none (this Task is not Project-backed)"]
    : projects.map(({ projectId, directory }) => {
        const label = directory === undefined ? projectId : `${directory} (${projectId})`;
        return `- ${label}: \`yui project show ${projectId}\`; then \`yui project knowledge list ${projectId}\` and show the relevant entries`;
      });
  return [
    "Context layers:",
    "- Yui Core: durable identity, lifecycle, access, workspace, and exact handoff safety.",
    `- Generic ${kind} Skill: reusable role behavior and evidence discipline.`,
    "- Project Policy: project-owned build, test, migration, release, and review rules; it is not a Yui Core default.",
    ...["Project Policy references:", ...policyLines],
    "- Task Contract: the current Task brief, WorkItem objective, acceptance criteria, and dispatch input.",
    "Do not import rules from another Project or Task, and do not infer Project Policy from repository files alone."
  ].join("\n");
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
