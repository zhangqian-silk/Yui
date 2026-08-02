import { isDeepStrictEqual } from "node:util";

import type { AgentAdapterId } from "../agent/adapterCatalog.js";
import type { WorkerAccess } from "../profile/agentProfile.js";
import type {
  GlobalRole,
  RoleAgentBinding,
  RoleProfile,
  TaskRole
} from "../role/role.js";
import type { RoleWorkspace, WorkspaceProjectEntry } from "../worktree/roleWorkspace.js";
import {
  resolveAgentAdapter,
  type AdvancedAgentConfig,
  type ClaudeAgentConfig,
  type CodexAgentConfig,
  type RoleAgentConfig
} from "./agentAdapter.js";

export type EffectiveLaunchAccess = WorkerAccess;
export type EffectiveLaunchProvenance = "resolved" | "legacy-cutover";
export type EffectiveReviewBaseProvenance = "frozen-candidate" | "legacy-unavailable";

export type EffectiveLaunchWorkspace = Readonly<{
  root: string;
  entries: readonly WorkspaceProjectEntry[];
}>;

export type EffectiveLaunchContext = Readonly<RoleProfile>;

type EffectiveLaunchBase = Readonly<{
  schemaVersion: 1;
  provenance: EffectiveLaunchProvenance;
  sourceDesiredRevision: number;
  agentId: string;
  access: EffectiveLaunchAccess;
  model?: string;
  effort?: string;
  yolo: boolean;
  search: boolean;
  additionalDirectories?: readonly string[];
  advanced?: AdvancedAgentConfig;
  writeProjectIds: readonly string[];
  workspace: EffectiveLaunchWorkspace;
  context: EffectiveLaunchContext;
  reviewRoundId?: string;
  reviewBaseProvenance?: EffectiveReviewBaseProvenance;
  reviewBaseCommit?: string;
}>;

export type CodexEffectiveLaunchSnapshot = EffectiveLaunchBase & Readonly<{
  adapterId: "codex";
  permission?: CodexAgentConfig["permission"];
  profile?: string;
}>;

export type ClaudeEffectiveLaunchSnapshot = EffectiveLaunchBase & Readonly<{
  adapterId: "claude";
  permission?: ClaudeAgentConfig["permission"];
  settingsFile?: string;
  settingsSources?: readonly string[];
}>;

export type EffectiveLaunchSnapshot =
  | CodexEffectiveLaunchSnapshot
  | ClaudeEffectiveLaunchSnapshot;

export type EffectiveLaunchRole = TaskRole | GlobalRole;

export type ResolveEffectiveLaunchInput = Readonly<{
  role: EffectiveLaunchRole;
  purpose: "execution" | "review";
  workspace?: RoleWorkspace;
  /** Undefined means a non-WorkItem run; [] is an explicit read-only WorkItem scope. */
  workItemWriteProjectIds?: readonly string[];
  reviewRoundId?: string;
  reviewBaseCommit?: string;
  nativeReadOnlySupported?: boolean;
}>;

const CLAUDE_READ_ONLY_ALLOWED_TOOLS = Object.freeze([
  "Read",
  "Grep",
  "Glob",
  "Bash(yui --json task context *)",
  "Bash(yui --json task work show *)",
  "Bash(yui --json task work list *)",
  "Bash(git diff *)",
  "Bash(git status *)",
  "Bash(git show *)",
  "Bash(git log *)",
  "Bash(yui task run yield *)"
]);

const CLAUDE_READ_ONLY_DISALLOWED_TOOLS = Object.freeze([
  "Edit",
  "Write",
  "NotebookEdit"
]);

export function resolveEffectiveLaunch(
  input: ResolveEffectiveLaunchInput
): EffectiveLaunchSnapshot {
  validateDesiredRole(input.role);
  const binding = input.role.agentBindings[input.role.activeAgentId]!;
  const workspace = snapshotWorkspace(input.role.workspace, input.workspace);
  const writeProjectIds = effectiveWriteProjects(input, workspace);
  const writeAuthorized = "taskId" in input.role
    && input.role.defaultAccess === "write"
    && writeProjectIds.length > 0;
  const access: EffectiveLaunchAccess = input.role.defaultAccess === "read"
    || !writeAuthorized
    ? "read"
    : "write";
  if (access === "read" && input.nativeReadOnlySupported === false) {
    throw new Error(
      `Agent adapter ${binding.adapterId} cannot express native read-only access; launch refused.`
    );
  }
  return snapshotFromConfig({
    sourceDesiredRevision: input.role.launchRevision,
    provenance: "resolved",
    agentId: binding.agentId,
    config: access === "read"
      ? readOnlyConfig(binding.config)
      : writeConfig(binding.config),
    access,
    writeProjectIds,
    workspace,
    context: snapshotContext(input.role),
    ...(input.purpose === "review"
      ? {
          reviewRoundId: identity(input.reviewRoundId ?? "", "ReviewRound id"),
          reviewBaseProvenance: "frozen-candidate" as const,
          reviewBaseCommit: commit(input.reviewBaseCommit ?? "", "Review base commit")
        }
      : {})
  });
}

/**
 * The offline cutover records only legacy facts that were actually persisted,
 * and closes every missing permission field to read-only. Legacy snapshots are
 * audit history and are deliberately never resumable.
 */
export function legacyEffectiveLaunchSnapshot(input: Readonly<{
  sourceDesiredRevision: number;
  agentId: string;
  adapterId: AgentAdapterId;
  model?: string;
  effort?: string;
  workspace: EffectiveLaunchWorkspace;
  context?: EffectiveLaunchContext;
  reviewRoundId?: string;
}>): EffectiveLaunchSnapshot {
  return snapshotFromConfig({
    sourceDesiredRevision: positiveInteger(
      input.sourceDesiredRevision,
      "Legacy source desired revision"
    ),
    provenance: "legacy-cutover",
    agentId: identity(input.agentId, "Legacy Agent id"),
    config: readOnlyConfig({
      adapterId: input.adapterId,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort })
    } as RoleAgentConfig),
    access: "read",
    writeProjectIds: [],
    workspace: cloneWorkspace(input.workspace),
    context: cloneContext(input.context ?? {}),
    ...(input.reviewRoundId === undefined
      ? {}
      : {
          reviewRoundId: identity(input.reviewRoundId, "Legacy ReviewRound id"),
          reviewBaseProvenance: "legacy-unavailable" as const
        })
  });
}

export function effectiveLaunchConfig(
  snapshot: EffectiveLaunchSnapshot
): RoleAgentConfig {
  validateEffectiveLaunchSnapshot(snapshot);
  return effectiveLaunchConfigUnchecked(snapshot);
}

function codexConfigFromSnapshot(
  snapshot: CodexEffectiveLaunchSnapshot
): CodexAgentConfig {
  return {
    adapterId: "codex",
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.effort === undefined ? {} : { effort: snapshot.effort }),
    ...(snapshot.yolo ? { yolo: true as const } : {}),
    ...(snapshot.permission === undefined
      ? {}
      : { permission: clone(snapshot.permission) }),
    ...(snapshot.additionalDirectories === undefined
      ? {}
      : { additionalDirectories: [...snapshot.additionalDirectories] }),
    ...(snapshot.advanced === undefined
      ? {}
      : { advanced: clone(snapshot.advanced) }),
    ...(snapshot.search ? { search: true } : {}),
    ...(snapshot.profile === undefined ? {} : { profile: snapshot.profile })
  };
}

function claudeConfigFromSnapshot(
  snapshot: ClaudeEffectiveLaunchSnapshot
): ClaudeAgentConfig {
  return {
    adapterId: "claude",
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.effort === undefined ? {} : { effort: snapshot.effort }),
    ...(snapshot.yolo ? { yolo: true as const } : {}),
    ...(snapshot.permission === undefined
      ? {}
      : { permission: clone(snapshot.permission) }),
    ...(snapshot.additionalDirectories === undefined
      ? {}
      : { additionalDirectories: [...snapshot.additionalDirectories] }),
    ...(snapshot.advanced === undefined
      ? {}
      : { advanced: clone(snapshot.advanced) }),
    ...(snapshot.settingsFile === undefined
      ? {}
      : { settingsFile: snapshot.settingsFile }),
    ...(snapshot.settingsSources === undefined
      ? {}
      : { settingsSources: [...snapshot.settingsSources] })
  };
}

export function effectiveLaunchSnapshotsCompatible(
  existing: EffectiveLaunchSnapshot,
  desired: EffectiveLaunchSnapshot
): boolean {
  validateEffectiveLaunchSnapshot(existing);
  validateEffectiveLaunchSnapshot(desired);
  if (existing.provenance !== "resolved" || desired.provenance !== "resolved") return false;
  const withoutProvenanceRevision = (snapshot: EffectiveLaunchSnapshot) => {
    const {
      sourceDesiredRevision: _sourceDesiredRevision,
      provenance: _provenance,
      ...actual
    } = snapshot;
    return actual;
  };
  return isDeepStrictEqual(
    withoutProvenanceRevision(existing),
    withoutProvenanceRevision(desired)
  );
}

export function validateEffectiveLaunchSnapshot<T extends EffectiveLaunchSnapshot>(
  snapshot: T
): T {
  if (snapshot.schemaVersion !== 1) {
    throw new Error("Effective launch snapshot must use schemaVersion 1.");
  }
  if (snapshot.provenance !== "resolved" && snapshot.provenance !== "legacy-cutover") {
    throw new Error("Effective launch provenance is invalid.");
  }
  positiveInteger(snapshot.sourceDesiredRevision, "Source desired revision");
  identity(snapshot.agentId, "Effective Agent id");
  if (snapshot.access !== "read" && snapshot.access !== "write") {
    throw new Error(`Effective launch access is invalid: ${String(snapshot.access)}.`);
  }
  if (typeof snapshot.yolo !== "boolean" || typeof snapshot.search !== "boolean") {
    throw new Error("Effective launch yolo/search flags must be boolean.");
  }
  if (snapshot.adapterId === "claude" && snapshot.search) {
    throw new Error("Claude effective launch cannot enable Codex search.");
  }
  const writeProjectIds = uniqueIdentities(snapshot.writeProjectIds, "Effective writable Project");
  if (!isDeepStrictEqual(writeProjectIds, snapshot.writeProjectIds)) {
    throw new Error("Effective writable Projects must be unique and sorted.");
  }
  if (snapshot.access === "read" && snapshot.writeProjectIds.length !== 0) {
    throw new Error("Read-only effective launch cannot carry writable Projects.");
  }
  if ((snapshot.reviewRoundId === undefined) !== (snapshot.reviewBaseProvenance === undefined)) {
    throw new Error("Effective Review provenance is incomplete.");
  }
  if (snapshot.reviewRoundId !== undefined) {
    identity(snapshot.reviewRoundId, "Effective ReviewRound id");
    if (snapshot.reviewBaseProvenance === "frozen-candidate") {
      commit(snapshot.reviewBaseCommit ?? "", "Effective review base commit");
      if (snapshot.provenance !== "resolved") {
        throw new Error("Legacy effective launch cannot claim a frozen Review base.");
      }
    } else if (snapshot.reviewBaseProvenance === "legacy-unavailable") {
      if (snapshot.reviewBaseCommit !== undefined || snapshot.provenance !== "legacy-cutover") {
        throw new Error("Effective legacy Review provenance is invalid.");
      }
    } else {
      throw new Error("Effective Review base provenance is invalid.");
    }
  } else if (snapshot.reviewBaseCommit !== undefined) {
    throw new Error("Effective Review provenance is incomplete.");
  }
  validateWorkspace(snapshot.workspace);
  cloneContext(snapshot.context);
  const config = effectiveLaunchConfigUnchecked(snapshot);
  resolveAgentAdapter(snapshot.adapterId).canonicalizeConfig(config as never);
  if (snapshot.access === "read") {
    assertNativeReadOnlyConfig(config);
  }
  return snapshot;
}

export function assertReadOnlyAgentArgv(
  snapshot: EffectiveLaunchSnapshot,
  argv: readonly string[]
): void {
  validateEffectiveLaunchSnapshot(snapshot);
  if (snapshot.access !== "read") {
    throw new Error("Read-only argv validation requires a read-only effective snapshot.");
  }
  if (snapshot.adapterId === "codex") {
    if (argv.includes("--dangerously-bypass-approvals-and-sandbox")) {
      throw new Error("Codex read-only launch contains the YOLO bypass flag.");
    }
    if (argumentValue(argv, "--sandbox") !== "read-only"
      || argumentValue(argv, "--ask-for-approval") !== "never") {
      throw new Error("Codex read-only launch did not compile the native read-only boundary.");
    }
    return;
  }
  if (argv.includes("--dangerously-skip-permissions")) {
    throw new Error("Claude read-only launch contains the permission bypass flag.");
  }
  if (argumentValue(argv, "--permission-mode") !== "dontAsk"
    || !argv.includes("--allowed-tools")
    || !argv.includes("Read")
    || !argv.includes("--disallowed-tools")
    || !argv.includes("Write")) {
    throw new Error("Claude read-only launch did not compile the native read-only boundary.");
  }
}

export function effectiveRoleForLaunch<T extends EffectiveLaunchRole>(
  role: T,
  snapshot: EffectiveLaunchSnapshot
): T {
  validateEffectiveLaunchSnapshot(snapshot);
  const config = effectiveLaunchConfig(snapshot);
  const binding: RoleAgentBinding = {
    agentId: snapshot.agentId,
    adapterId: snapshot.adapterId,
    config
  };
  const result = {
    ...role,
    ...cloneContext(snapshot.context),
    activeAgentId: snapshot.agentId,
    agentBindings: { ...role.agentBindings, [snapshot.agentId]: binding },
    launchRevision: snapshot.sourceDesiredRevision,
    workspace: snapshot.workspace.root
  } as T;
  clearMissingContext(result, snapshot.context);
  return result;
}

function snapshotFromConfig(input: Readonly<{
  sourceDesiredRevision: number;
  provenance: EffectiveLaunchProvenance;
  agentId: string;
  config: RoleAgentConfig;
  access: EffectiveLaunchAccess;
  writeProjectIds: readonly string[];
  workspace: EffectiveLaunchWorkspace;
  context: EffectiveLaunchContext;
  reviewRoundId?: string;
  reviewBaseProvenance?: EffectiveReviewBaseProvenance;
  reviewBaseCommit?: string;
}>): EffectiveLaunchSnapshot {
  const config = clone(input.config);
  const common = {
    schemaVersion: 1 as const,
    provenance: input.provenance,
    sourceDesiredRevision: positiveInteger(
      input.sourceDesiredRevision,
      "Source desired revision"
    ),
    agentId: identity(input.agentId, "Effective Agent id"),
    access: input.access,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    yolo: config.yolo === true,
    search: config.adapterId === "codex" && config.search === true,
    ...(config.additionalDirectories === undefined
      ? {}
      : { additionalDirectories: [...config.additionalDirectories] }),
    ...(config.advanced === undefined ? {} : { advanced: clone(config.advanced) }),
    writeProjectIds: [...input.writeProjectIds],
    workspace: cloneWorkspace(input.workspace),
    context: cloneContext(input.context),
    ...(input.reviewRoundId === undefined
      ? {}
      : {
          reviewRoundId: identity(input.reviewRoundId, "ReviewRound id"),
          reviewBaseProvenance: input.reviewBaseProvenance ?? "frozen-candidate",
          reviewBaseCommit: commit(input.reviewBaseCommit ?? "", "Review base commit")
        })
  };
  const snapshot: EffectiveLaunchSnapshot = config.adapterId === "codex"
    ? {
        ...common,
        adapterId: "codex",
        ...(config.permission === undefined ? {} : { permission: clone(config.permission) }),
        ...(config.profile === undefined ? {} : { profile: config.profile })
      }
    : {
        ...common,
        adapterId: "claude",
        ...(config.permission === undefined ? {} : { permission: clone(config.permission) }),
        ...(config.settingsFile === undefined ? {} : { settingsFile: config.settingsFile }),
        ...(config.settingsSources === undefined
          ? {}
          : { settingsSources: [...config.settingsSources] })
      };
  return validateEffectiveLaunchSnapshot(snapshot);
}

function effectiveLaunchConfigUnchecked(
  snapshot: EffectiveLaunchSnapshot
): RoleAgentConfig {
  return snapshot.adapterId === "codex"
    ? codexConfigFromSnapshot(snapshot)
    : claudeConfigFromSnapshot(snapshot);
}

function readOnlyConfig(config: RoleAgentConfig): RoleAgentConfig {
  const common = {
    adapterId: config.adapterId,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort })
  };
  return config.adapterId === "codex"
    ? {
        ...common,
        adapterId: "codex",
        permission: { sandbox: "read-only", approval: "never" }
      }
    : {
        ...common,
        adapterId: "claude",
        permission: {
          mode: "dontAsk",
          allowedTools: [...CLAUDE_READ_ONLY_ALLOWED_TOOLS],
          disallowedTools: [...CLAUDE_READ_ONLY_DISALLOWED_TOOLS]
        },
        settingsSources: []
      };
}

function writeConfig(config: RoleAgentConfig): RoleAgentConfig {
  const canonical = resolveAgentAdapter(config.adapterId).canonicalizeConfig(
    clone(config) as never
  ) as RoleAgentConfig;
  if (canonical.yolo !== true || canonical.permission === undefined) return canonical;
  const result = { ...canonical } as RoleAgentConfig & { permission?: unknown };
  delete result.permission;
  return result;
}

function assertNativeReadOnlyConfig(config: RoleAgentConfig): void {
  if (config.yolo === true || config.additionalDirectories !== undefined
    || config.advanced !== undefined) {
    throw new Error("Read-only effective launch contains an access-expanding setting.");
  }
  if (config.adapterId === "codex") {
    if (config.search === true
      || config.permission?.sandbox !== "read-only"
      || config.permission.approval !== "never") {
      throw new Error("Codex effective launch is not native read-only.");
    }
    return;
  }
  if (config.settingsFile !== undefined
    || config.permission?.mode !== "dontAsk"
    || !isDeepStrictEqual(config.permission.allowedTools, CLAUDE_READ_ONLY_ALLOWED_TOOLS)
    || !isDeepStrictEqual(config.permission.disallowedTools, CLAUDE_READ_ONLY_DISALLOWED_TOOLS)) {
    throw new Error("Claude effective launch is not native read-only.");
  }
}

function effectiveWriteProjects(
  input: ResolveEffectiveLaunchInput,
  workspace: EffectiveLaunchWorkspace
): string[] {
  if (input.purpose === "review") {
    if (!("taskId" in input.role)) {
      throw new Error("Review launch requires a Task Role.");
    }
    if (input.reviewRoundId === undefined || input.reviewBaseCommit === undefined) {
      throw new Error("Review launch requires exact ReviewRound provenance.");
    }
    commit(input.reviewBaseCommit, "Review base commit");
    if (input.workspace === undefined || input.workspace.owner.type !== "review-round") {
      throw new Error("Review launch requires a ReviewRound-owned workspace.");
    }
    if (input.workspace.owner.reviewRoundId !== input.reviewRoundId) {
      throw new Error(
        `ReviewRound workspace owner does not match ${input.reviewRoundId}.`
      );
    }
    if (input.workspace.entries.length === 0
      || input.workspace.entries.some(({ access }) => access !== "write")) {
      throw new Error("Every ReviewRound workspace Project must be an isolated writable entry.");
    }
    return uniqueIdentities(
      workspace.entries.map(({ projectId }) => projectId),
      "Review workspace Project"
    );
  }
  if (input.role.defaultAccess === "read") return [];
  const workspaceWrite = uniqueIdentities(
    workspace.entries
      .filter(({ access }) => access === "write")
      .map(({ projectId }) => projectId),
    "Workspace writable Project"
  );
  if (!("taskId" in input.role)) return [];
  // A managed workspace describes what exists, not who is authorized to
  // mutate it. Only an explicit WorkItem write scope can grant Task writes.
  if (input.workItemWriteProjectIds === undefined) return [];
  const requested = uniqueIdentities(
    input.workItemWriteProjectIds,
    "WorkItem writable Project"
  );
  if (requested.length === 0) return [];
  if (!isDeepStrictEqual(requested, workspaceWrite)) {
    throw new Error("WorkItem write scope does not match the managed workspace write scope.");
  }
  return requested;
}

function snapshotWorkspace(
  roleWorkspace: string,
  workspace: RoleWorkspace | undefined
): EffectiveLaunchWorkspace {
  if (workspace === undefined) return { root: text(roleWorkspace, "Role workspace"), entries: [] };
  return {
    root: text(workspace.root, "Effective workspace root"),
    entries: workspace.entries.map((entry) => ({ ...entry }))
  };
}

function snapshotContext(role: EffectiveLaunchRole): EffectiveLaunchContext {
  return cloneContext(role);
}

function cloneContext(context: RoleProfile): EffectiveLaunchContext {
  return {
    ...(context.description === undefined ? {} : { description: text(context.description, "Role description") }),
    ...(context.responsibilities === undefined
      ? {}
      : { responsibilities: context.responsibilities.map((value) => text(value, "Role responsibility")) }),
    ...(context.constraints === undefined
      ? {}
      : { constraints: context.constraints.map((value) => text(value, "Role constraint")) }),
    ...(context.expectedOutput === undefined
      ? {}
      : { expectedOutput: text(context.expectedOutput, "Role expected output") }),
    ...(context.systemPrompt === undefined
      ? {}
      : { systemPrompt: text(context.systemPrompt, "Role system prompt") }),
    ...(context.skills === undefined
      ? {}
      : { skills: context.skills.map((value) => identity(value, "Role Skill id")) })
  };
}

function clearMissingContext(role: RoleProfile, context: EffectiveLaunchContext): void {
  for (const key of [
    "description",
    "responsibilities",
    "constraints",
    "expectedOutput",
    "systemPrompt",
    "skills"
  ] as const) {
    if (!Object.hasOwn(context, key)) delete role[key];
  }
}

function cloneWorkspace(workspace: EffectiveLaunchWorkspace): EffectiveLaunchWorkspace {
  validateWorkspace(workspace);
  return {
    root: workspace.root,
    entries: workspace.entries.map((entry) => ({ ...entry }))
  };
}

function validateWorkspace(workspace: EffectiveLaunchWorkspace): void {
  text(workspace.root, "Effective workspace root");
  if (!Array.isArray(workspace.entries)) throw new Error("Effective workspace entries are invalid.");
  uniqueIdentities(workspace.entries.map(({ projectId }) => projectId), "Effective workspace Project");
  for (const entry of workspace.entries) {
    identity(entry.projectId, "Effective workspace Project id");
    identity(entry.directory, "Effective workspace Project directory");
    if (entry.access !== "read" && entry.access !== "write") {
      throw new Error("Effective workspace Project access is invalid.");
    }
    text(entry.path, "Effective workspace Project path");
    text(entry.branch, "Effective workspace Project branch");
    text(entry.baseRef, "Effective workspace Project base ref");
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(entry.baseCommit)) {
      throw new Error("Effective workspace base commit is invalid.");
    }
  }
}

function validateDesiredRole(role: EffectiveLaunchRole): void {
  positiveInteger(role.launchRevision, "Role desired revision");
  if (role.defaultAccess !== "read" && role.defaultAccess !== "write") {
    throw new Error("Role default access is invalid.");
  }
  const binding = role.agentBindings[role.activeAgentId];
  if (binding === undefined) throw new Error("Role active Agent binding is missing.");
  if (binding.adapterId !== "codex" && binding.adapterId !== "claude") {
    throw new Error(`Role Agent adapter is unsupported: ${binding.adapterId}.`);
  }
}

function uniqueIdentities(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} list is invalid.`);
  const result = [...new Set(values.map((value) => identity(value, label)))].sort();
  if (result.length !== values.length) throw new Error(`${label} list contains duplicates.`);
  return result;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive.`);
  return value;
}

function identity(value: string, label: string): string {
  const result = text(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(result)
    || /[/\\\0]/u.test(result)) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function commit(value: string, label: string): string {
  const result = text(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(result)) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function text(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.lastIndexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
