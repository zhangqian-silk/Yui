import { isDeepStrictEqual } from "node:util";

import type { WorkerAccess } from "../profile/agentProfile.js";
import type {
  GlobalRole,
  RoleAgentBinding,
  RoleProfile,
  TaskRole
} from "../role/role.js";
import type {
  ManagedWorkspace,
  WorkspaceProjectEntry
} from "../worktree/managedWorkspace.js";
import { validateManagedWorkspace } from "../worktree/managedWorkspace.js";
import {
  resolveAgentAdapter,
  type AdvancedAgentConfig,
  type ClaudeAgentConfig,
  type CodexAgentConfig,
  type RoleAgentConfig
} from "./agentAdapter.js";
import { roleSessionKind } from "../context/roleSessionContext.js";
import {
  SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  sessionManifestCompatibilityDigest
} from "../context/sessionProtocolIdentity.js";

export type EffectiveLaunchProfileAccess = WorkerAccess;

export type EffectiveLaunchWorkspace = Readonly<{
  root: string;
  entries: readonly WorkspaceProjectEntry[];
}>;

export type EffectiveLaunchContext = Readonly<RoleProfile>;

type EffectiveLaunchBase = Readonly<{
  schemaVersion: 2;
  sourceDesiredRevision: number;
  agentId: string;
  /** Profile behavior intent captured for this Session; not a provider sandbox. */
  profileAccess: EffectiveLaunchProfileAccess;
  model?: string;
  effort?: string;
  search: boolean;
  additionalDirectories?: readonly string[];
  advanced?: AdvancedAgentConfig;
  writeProjectIds: readonly string[];
  workspace: EffectiveLaunchWorkspace;
  context: EffectiveLaunchContext;
  reviewRoundId?: string;
  reviewBaseCommit?: string;
  /** Absent only on bounded legacy v0 Sessions. */
  contextProtocolVersion?: typeof SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION;
  /** Stable Role/Skill compatibility identity, not a per-launch resource path digest. */
  sessionManifestCompatibilityDigest?: string;
}>;

export type CodexEffectiveLaunchSnapshot = EffectiveLaunchBase & Readonly<{
  adapterId: "codex";
  permission: NonNullable<CodexAgentConfig["permission"]>;
  profile?: string;
}>;

export type ClaudeEffectiveLaunchSnapshot = EffectiveLaunchBase & Readonly<{
  adapterId: "claude";
  permission: NonNullable<ClaudeAgentConfig["permission"]>;
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
  workspace?: ManagedWorkspace;
  /** Undefined means a non-WorkItem run; [] is an explicit read-only WorkItem scope. */
  workItemWriteProjectIds?: readonly string[];
  reviewRoundId?: string;
  reviewBaseCommit?: string;
}>;

export function resolveEffectiveLaunch(
  input: ResolveEffectiveLaunchInput
): EffectiveLaunchSnapshot {
  validateDesiredRole(input.role);
  const binding = input.role.agentBindings[input.role.activeAgentId]!;
  const workspace = snapshotWorkspace(input.role.workspace, input.workspace);
  const writeProjectIds = effectiveWriteProjects(input, workspace);
  const config = resolveAgentAdapter(binding.adapterId).canonicalizeConfig(
    clone(binding.config) as never
  ) as RoleAgentConfig;
  return snapshotFromConfig({
    sourceDesiredRevision: input.role.launchRevision,
    agentId: binding.agentId,
    config,
    profileAccess: input.role.defaultAccess,
    writeProjectIds,
    workspace,
    context: snapshotContext(input.role),
    contextProtocolVersion: SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
    sessionManifestCompatibilityDigest: sessionManifestCompatibilityDigest(
      input.role.name,
      roleSessionKind(
        input.role,
        "taskId" in input.role
          ? { scope: "task", taskId: input.role.taskId }
          : { scope: "global" },
        input.purpose
      ),
      input.role
    ),
    ...(input.purpose === "review"
      ? {
          reviewRoundId: identity(input.reviewRoundId ?? "", "ReviewRound id"),
          reviewBaseCommit: commit(input.reviewBaseCommit ?? "", "Review base commit")
        }
      : {})
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
    permission: clone(snapshot.permission),
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
    permission: clone(snapshot.permission),
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
  const withoutDesiredRevision = (snapshot: EffectiveLaunchSnapshot) => {
    const {
      sourceDesiredRevision: _sourceDesiredRevision,
      ...actual
    } = snapshot;
    return actual;
  };
  return isDeepStrictEqual(
    withoutDesiredRevision(existing),
    withoutDesiredRevision(desired)
  );
}

/**
 * A Task-owned main workspace is a mutable checkout: Integration advances its
 * durable Git heads while an idle native Session keeps the immutable launch
 * configuration with which it started. A later Run may resume that exact
 * Session only when the current durable Task workspace proves that every
 * non-commit workspace identity and every other launch field is unchanged.
 * WorkItem, ReviewRound and ExecutionLane workspaces remain strict.
 */
export function effectiveLaunchSnapshotsCompatibleForTaskMain(
  existing: EffectiveLaunchSnapshot,
  desired: EffectiveLaunchSnapshot,
  workspace: ManagedWorkspace | null | undefined
): boolean {
  if (effectiveLaunchSnapshotsCompatible(existing, desired)) return true;
  validateEffectiveLaunchSnapshot(existing);
  validateEffectiveLaunchSnapshot(desired);
  if (workspace === null || workspace === undefined) return false;
  validateManagedWorkspace(workspace);
  if (workspace.owner.type !== "task") return false;
  const durableWorkspace: EffectiveLaunchWorkspace = {
    root: workspace.root,
    entries: workspace.entries.map((entry) => ({ ...entry }))
  };
  if (!isDeepStrictEqual(desired.workspace, durableWorkspace)) return false;
  return isDeepStrictEqual(
    taskMainCompatibleSnapshot(existing),
    taskMainCompatibleSnapshot(desired)
  );
}

/** Preserves a fixed Session's launch configuration while freezing fresh Task-main Git facts. */
export function effectiveLaunchWithTaskMainWorkspace(
  existing: EffectiveLaunchSnapshot,
  workspace: ManagedWorkspace
): EffectiveLaunchSnapshot {
  validateEffectiveLaunchSnapshot(existing);
  validateManagedWorkspace(workspace);
  if (workspace.owner.type !== "task") {
    throw new Error("Only a Task-owned main workspace may refresh fixed Session Run evidence.");
  }
  return validateEffectiveLaunchSnapshot({
    ...existing,
    workspace: {
      root: workspace.root,
      entries: workspace.entries.map((entry) => ({ ...entry }))
    }
  });
}

function taskMainCompatibleSnapshot(snapshot: EffectiveLaunchSnapshot): unknown {
  const {
    sourceDesiredRevision: _sourceDesiredRevision,
    workspace,
    ...launch
  } = snapshot;
  return {
    ...launch,
    workspace: {
      root: workspace.root,
      entries: workspace.entries.map(({ baseCommit: _baseCommit, ...entry }) => entry)
    }
  };
}

export function validateEffectiveLaunchSnapshot<T extends EffectiveLaunchSnapshot>(
  snapshot: T
): T {
  if (snapshot.schemaVersion !== 2) {
    throw new Error("Effective launch snapshot must use schemaVersion 2.");
  }
  positiveInteger(snapshot.sourceDesiredRevision, "Source desired revision");
  identity(snapshot.agentId, "Effective Agent id");
  if (snapshot.profileAccess !== "read" && snapshot.profileAccess !== "write") {
    throw new Error(
      `Effective launch Profile access is invalid: ${String(snapshot.profileAccess)}.`
    );
  }
  if (typeof snapshot.search !== "boolean") {
    throw new Error("Effective launch search flag must be boolean.");
  }
  if (snapshot.adapterId === "claude" && snapshot.search) {
    throw new Error("Claude effective launch cannot enable Codex search.");
  }
  const writeProjectIds = uniqueIdentities(snapshot.writeProjectIds, "Effective writable Project");
  if (!isDeepStrictEqual(writeProjectIds, snapshot.writeProjectIds)) {
    throw new Error("Effective writable Projects must be unique and sorted.");
  }
  if (snapshot.permission === undefined) {
    throw new Error("Effective launch requires an explicit permission strategy.");
  }
  if ((snapshot.reviewRoundId === undefined) !== (snapshot.reviewBaseCommit === undefined)) {
    throw new Error("Effective Review base is incomplete.");
  }
  if (snapshot.reviewRoundId !== undefined && snapshot.reviewBaseCommit !== undefined) {
    identity(snapshot.reviewRoundId, "Effective ReviewRound id");
    commit(snapshot.reviewBaseCommit, "Effective review base commit");
  }
  if (snapshot.contextProtocolVersion !== undefined
    && snapshot.contextProtocolVersion !== SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Effective launch context protocol version is unsupported.");
  }
  if (snapshot.sessionManifestCompatibilityDigest !== undefined
    && !/^[a-f0-9]{64}$/u.test(snapshot.sessionManifestCompatibilityDigest)) {
    throw new Error("Effective launch Session Manifest compatibility digest is invalid.");
  }
  if ((snapshot.contextProtocolVersion === undefined)
    !== (snapshot.sessionManifestCompatibilityDigest === undefined)) {
    throw new Error("Effective launch Context protocol compatibility identity is incomplete.");
  }
  validateWorkspace(snapshot.workspace);
  cloneContext(snapshot.context);
  const config = effectiveLaunchConfigUnchecked(snapshot);
  resolveAgentAdapter(snapshot.adapterId).canonicalizeConfig(config as never);
  return snapshot;
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
    defaultAccess: snapshot.profileAccess,
    workspace: snapshot.workspace.root
  } as T;
  clearMissingContext(result, snapshot.context);
  return result;
}

function snapshotFromConfig(input: Readonly<{
  sourceDesiredRevision: number;
  agentId: string;
  config: RoleAgentConfig;
  profileAccess: EffectiveLaunchProfileAccess;
  writeProjectIds: readonly string[];
  workspace: EffectiveLaunchWorkspace;
  context: EffectiveLaunchContext;
  reviewRoundId?: string;
  reviewBaseCommit?: string;
  contextProtocolVersion?: typeof SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION;
  sessionManifestCompatibilityDigest?: string;
}>): EffectiveLaunchSnapshot {
  const config = clone(input.config);
  if (config.permission === undefined) {
    throw new Error("Effective launch requires an explicit permission strategy.");
  }
  const review = input.reviewRoundId === undefined
    ? {}
    : {
        reviewRoundId: identity(input.reviewRoundId, "ReviewRound id"),
        reviewBaseCommit: commit(input.reviewBaseCommit ?? "", "Review base commit")
      };
  const common = {
    schemaVersion: 2 as const,
    sourceDesiredRevision: positiveInteger(
      input.sourceDesiredRevision,
      "Source desired revision"
    ),
    agentId: identity(input.agentId, "Effective Agent id"),
    profileAccess: input.profileAccess,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    search: config.adapterId === "codex" && config.search === true,
    ...(config.additionalDirectories === undefined
      ? {}
      : { additionalDirectories: [...config.additionalDirectories] }),
    ...(config.advanced === undefined ? {} : { advanced: clone(config.advanced) }),
    writeProjectIds: [...input.writeProjectIds],
    workspace: cloneWorkspace(input.workspace),
    context: cloneContext(input.context),
    ...(input.contextProtocolVersion === undefined
      ? {}
      : { contextProtocolVersion: input.contextProtocolVersion }),
    ...(input.sessionManifestCompatibilityDigest === undefined
      ? {}
      : { sessionManifestCompatibilityDigest: input.sessionManifestCompatibilityDigest }),
    ...review
  };
  const snapshot: EffectiveLaunchSnapshot = config.adapterId === "codex"
    ? {
        ...common,
        adapterId: "codex",
        permission: clone(config.permission),
        ...(config.profile === undefined ? {} : { profile: config.profile })
      }
    : {
        ...common,
        adapterId: "claude",
        permission: clone(config.permission),
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
    const reviewWorkspace = input.workspace;
    if (reviewWorkspace === undefined
      || (reviewWorkspace.owner.type !== "review-round"
        && (reviewWorkspace.owner.type !== "execution-lane"
          || reviewWorkspace.owner.purpose !== "review"))) {
      throw new Error("Review launch requires a ReviewRound-owned workspace.");
    }
    if (reviewWorkspace.owner.reviewRoundId !== input.reviewRoundId) {
      throw new Error(
        `ReviewRound workspace owner does not match ${input.reviewRoundId}.`
      );
    }
    if (reviewWorkspace.entries.length === 0
      || reviewWorkspace.entries.some(({ access }) => access !== "write")) {
      throw new Error("Every ReviewRound workspace Project must be an isolated writable entry.");
    }
    return uniqueIdentities(
      reviewWorkspace.entries.map(({ projectId }) => projectId),
      "Review workspace Project"
    );
  }
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
  workspace: ManagedWorkspace | undefined
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
