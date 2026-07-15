import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ConfiguredAgent } from "../agent/agent.js";
import type { TaskComment } from "../comment/comment.js";
import type { Cycle } from "../cycle/cycle.js";
import type { Decision } from "../decision/decision.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { InputRequest, InputResolution } from "../input/inputRequest.js";
import type { Milestone } from "../milestone/milestone.js";
import type { GlobalRole, Role, RoleAgentBinding } from "../role/role.js";
import type { AgentRun } from "../run/agentRun.js";
import type { TaskSchedule } from "../scheduler/taskSchedule.js";
import {
  FileTaskStore,
  type TaskmuxConfig,
  type TaskReader
} from "./taskStore.js";
import {
  AUTHORITY_REGISTRY,
  getAuthorityDescriptor,
  type AgentRequirement,
  type PortableSemantic,
  type PortableSemanticReference,
  type WorkspaceBinding
} from "./portableSchema.js";
import type { SemanticSnapshotReader } from "./portableExport.js";
import {
  PortableImportError,
  type PortableWorkspaceBindingMapping,
  type PortableImportTransactionTarget,
  type PortableSemanticIdentity,
  type PortableTargetWorkspaceBindingState,
  type ResolvedPortableWorkspaceBindingMapping
} from "./portableImport.js";
import { hasActiveDomainTransactionAuthority } from "./domainTransaction.js";
import type { Task } from "../task/task.js";
import type { TaskTopics } from "../topic/topic.js";
import type { TaskInputDraft } from "../input/taskInput.js";
import type { WorkItem } from "../workItem/workItem.js";
import type { ChildRole } from "../role/childRole.js";

type PortableWorkspaceState = Readonly<{
  descriptor: WorkspaceBinding;
  workspace: string;
  witness: string;
}>;

type PortableState = Readonly<{
  recordsByAuthority: ReadonlyMap<string, readonly PortableSemantic[]>;
  semanticByIdentity: ReadonlyMap<string, PortableSemantic>;
  workspaceById: ReadonlyMap<string, PortableWorkspaceState>;
  workspaceByRoot: ReadonlyMap<string, PortableWorkspaceState>;
  agentRequirements: readonly AgentRequirement[];
}>;

type PortableTaskLifecycle = PortableSemantic["lifecycle"];

type TrashedTaskDescriptor = Readonly<{
  task: Task;
  roles: readonly Role[];
}>;

const PORTABLE_AUTHORITY_IDS = Object.freeze(
  AUTHORITY_REGISTRY
    .filter((descriptor) => descriptor.portableExport === "include")
    .map((descriptor) => descriptor.id)
);

const BUILTIN_TOPIC_IDS = new Set([
  "requirements",
  "architecture",
  "ui",
  "implementation",
  "testing",
  "deployment",
  "operations",
  "security"
]);

const IMPORT_AUTHORITY_ORDER = new Map<string, number>([
  ["configured-skill", 0],
  ["task", 1],
  ["task-topics", 2],
  ["global-role", 3],
  ["task-role", 4],
  ["child-role", 5],
  ["cycle", 6],
  ["work-item", 7],
  ["agent-run-history", 8],
  ["input-request-history", 9],
  ["input-resolution", 10],
  ["task-input-draft", 11],
  ["task-schedule", 12],
  ["task-brief", 13],
  ["task-topic-summary", 14],
  ["task-timeline", 15],
  ["milestone", 16],
  ["decision", 17],
  ["comment", 18],
  ["event", 19],
  ["transcript", 20],
  ["config", 21]
]);

/**
 * Builds a semantic, host-redacted read adapter over a callback-bounded FileTaskStore reader.
 * It deliberately never calls any session, worktree, runtime, controller, or derived-state API.
 */
export function createPortableFileStoreSnapshotReader(reader: TaskReader): SemanticSnapshotReader {
  return new PortableFileStoreSnapshotReader(reader);
}

/**
 * Builds the import target for one already-active FileTaskStore domain transaction.
 * Callers must own the surrounding transaction; this adapter never opens one.
 */
export function createPortableFileStoreImportTarget(
  store: FileTaskStore
): PortableImportTransactionTarget {
  return new PortableFileStoreImportTarget(store);
}

class PortableFileStoreSnapshotReader implements SemanticSnapshotReader {
  private state: PortableState | undefined;

  constructor(private readonly reader: TaskReader) {}

  listAuthorityIds(): readonly string[] {
    return PORTABLE_AUTHORITY_IDS;
  }

  readAuthorityRecords(authorityId: string): readonly unknown[] {
    return this.readState().recordsByAuthority.get(authorityId) ?? [];
  }

  readWorkspaceBindings(): readonly unknown[] {
    return [...this.readState().workspaceById.values()]
      .map((state) => state.descriptor)
      .sort((left, right) => compareStrings(left.bindingId, right.bindingId));
  }

  readAgentRequirements(): readonly unknown[] {
    return this.readState().agentRequirements;
  }

  private readState(): PortableState {
    this.state ??= collectPortableState(this.reader);
    return this.state;
  }
}

class PortableFileStoreImportTarget implements PortableImportTransactionTarget {
  private state: PortableState | undefined;
  private readonly privateWorkspaceBindings = new Map<string, PortableWorkspaceState>();

  constructor(private readonly store: FileTaskStore) {}

  resolveWorkspaceMappings(
    sourceBindings: readonly WorkspaceBinding[],
    mappings: readonly PortableWorkspaceBindingMapping[]
  ): readonly ResolvedPortableWorkspaceBindingMapping[] {
    const sourceById = new Map(sourceBindings.map((binding) => [binding.bindingId, binding]));
    const currentWorkspaceById = collectPortableState(this.store).workspaceById;
    const targetIdentities = new Set<string>();
    const reservedBindingIds = new Set([
      ...currentWorkspaceById.keys(),
      ...this.privateWorkspaceBindings.keys()
    ]);
    const resolved: ResolvedPortableWorkspaceBindingMapping[] = [];

    for (const mapping of mappings) {
      const source = sourceById.get(mapping.sourceBindingId);
      if (source === undefined) throw new PortableImportError("INVALID_MAPPING");

      const targetWorkspace = hasTargetBindingId(mapping)
        ? existingWorkspaceTarget(currentWorkspaceById, mapping.targetBindingId, source.kind)
        : mapping.targetWorkspacePath;
      if (typeof targetWorkspace !== "string") throw new PortableImportError("INVALID_MAPPING");
      const inspected = inspectDirectWorkspaceTarget(source.kind, targetWorkspace, this.store.getConfig());
      claimWorkspaceTargetIdentity(targetIdentities, `workspace\u0000${inspected.workspace}`);
      const existingPrivate = this.findPrivateWorkspaceBinding(source.kind, inspected.workspace);
      const bindingId = existingPrivate?.descriptor.bindingId ?? (source.kind === "default"
        ? "default"
        : nextPrivateBindingId(reservedBindingIds));
      reservedBindingIds.add(bindingId);
      if (existingPrivate === undefined) {
        if (this.privateWorkspaceBindings.has(bindingId)) {
          throw new PortableImportError("INVALID_MAPPING");
        }
        const state: PortableWorkspaceState = Object.freeze({
          descriptor: Object.freeze({
            schemaVersion: 1,
            bindingId,
            kind: source.kind,
            relativeSubpath: "",
            label: `Imported ${source.kind} workspace`
          }),
          workspace: inspected.workspace,
          witness: inspected.witness
        });
        this.privateWorkspaceBindings.set(bindingId, state);
      }
      resolved.push(Object.freeze({
        schemaVersion: 1,
        sourceBindingId: mapping.sourceBindingId,
        targetBindingId: bindingId
      }));
    }

    return Object.freeze(resolved);
  }

  readWorkspaceBinding(bindingId: string): PortableTargetWorkspaceBindingState | null {
    const privateBinding = this.privateWorkspaceBindings.get(bindingId);
    if (privateBinding !== undefined) {
      const inspected = inspectDirectWorkspaceTarget(
        privateBinding.descriptor.kind,
        privateBinding.workspace,
        this.store.getConfig()
      );
      return {
        descriptor: privateBinding.descriptor,
        witness: inspected.witness
      };
    }
    const state = collectPortableState(this.store).workspaceById.get(bindingId);
    if (state === undefined) return null;
    return {
      descriptor: state.descriptor,
      witness: state.witness
    };
  }

  readAgentRequirement(agentId: string): AgentRequirement | null {
    const agent = this.store.getConfiguredAgent(agentId);
    return agent === null ? null : agentRequirement(agent);
  }

  readSemantic(identity: PortableSemanticIdentity): PortableSemantic | null {
    if (identity.lifecycle === "live" && identity.authority === "configured-skill") {
      const skill = this.store.getConfiguredSkill(identity.key);
      return skill === null ? null : configuredSkillSemanticRecord(skill);
    }
    const state = this.readState();
    const record = state.semanticByIdentity.get(semanticIdentity(
      identity.lifecycle,
      identity.authority,
      identity.key
    ));
    return record === undefined
      ? null
      : remapPrivateWorkspaceBindingIds(
        record,
        state.workspaceById,
        this.privateWorkspaceBindings
      );
  }

  applySemanticBatch(
    records: readonly PortableSemantic[],
    creates: readonly PortableSemantic[]
  ): void {
    if (!hasActiveDomainTransactionAuthority(this.store.rootDirectory())) {
      throw new Error("Portable import requires an active FileTaskStore transaction.");
    }
    const initial = collectPortableState(this.store);
    const workspaceById = new Map(initial.workspaceById);
    for (const [bindingId, state] of this.privateWorkspaceBindings) {
      workspaceById.set(bindingId, state);
    }
    const ordered = [...records].sort((left, right) => {
      const order = (IMPORT_AUTHORITY_ORDER.get(left.authority) ?? Number.MAX_SAFE_INTEGER) -
        (IMPORT_AUTHORITY_ORDER.get(right.authority) ?? Number.MAX_SAFE_INTEGER);
      return order !== 0 ? order : compareSemantic(left, right);
    });
    const orderedCreates = [...creates].sort((left, right) => {
      const order = (IMPORT_AUTHORITY_ORDER.get(left.authority) ?? Number.MAX_SAFE_INTEGER) -
        (IMPORT_AUTHORITY_ORDER.get(right.authority) ?? Number.MAX_SAFE_INTEGER);
      return order !== 0 ? order : compareSemantic(left, right);
    });
    const { newTrashTaskIds, replacedTrashTaskIds, runtimeResetTaskIds } = assertPortableImportTaskLifecycles(
      initial,
      ordered
    );
    const existingTrashTaskIds = new Set(
      [...initial.semanticByIdentity.values()]
        .filter((record) => record.lifecycle === "trash" && record.authority === "task")
        .map((record) => record.key)
    );
    const existingIncomingTrashTaskIds = [...new Set(ordered.flatMap((record) => {
      if (record.lifecycle !== "trash") return [];
      const taskId = portableTaskId(record);
      return taskId !== null &&
          initial.semanticByIdentity.has(semanticIdentity("trash", "task", taskId))
        ? [taskId]
        : [];
    }))].sort(compareStrings);
    const trashStore = new FileTaskStore(join(this.store.rootDirectory(), "trash"));

    this.store.pruneTrashedTasks(replacedTrashTaskIds);
    this.store.clearNonportableTaskRuntimeForPortableImport(runtimeResetTaskIds);
    this.store.clearTrashedRoleSessionsForPortableImport(existingIncomingTrashTaskIds);
    for (const record of orderedCreates.filter((record) => record.lifecycle === "live")) {
      persistSemanticRecord(this.store, workspaceById, record);
    }
    for (const record of orderedCreates.filter((record) => record.lifecycle === "trash")) {
      const taskId = portableTaskId(record);
      if (taskId === null) {
        throw new Error("Portable trash records must be task-scoped.");
      }
      persistSemanticRecord(
        existingTrashTaskIds.has(taskId) ? trashStore : this.store,
        workspaceById,
        record
      );
    }
    for (const taskId of newTrashTaskIds) {
      if (!this.store.deleteTask(taskId)) {
        throw new Error(`Portable trash task was not staged: ${taskId}`);
      }
    }
    this.state = undefined;
  }

  private readState(): PortableState {
    this.state ??= collectPortableState(this.store);
    return this.state;
  }

  private findPrivateWorkspaceBinding(
    kind: WorkspaceBinding["kind"],
    workspace: string
  ): PortableWorkspaceState | undefined {
    for (const state of this.privateWorkspaceBindings.values()) {
      if (state.workspace !== workspace) continue;
      if (state.descriptor.kind !== kind) {
        throw new PortableImportError("INVALID_MAPPING");
      }
      return state;
    }
    return undefined;
  }
}

type DirectWorkspaceInspection = Readonly<{
  workspace: string;
  witness: string;
}>;

function inspectDirectWorkspaceTarget(
  kind: WorkspaceBinding["kind"],
  value: string,
  config: TaskmuxConfig
): DirectWorkspaceInspection {
  if (kind === "default") {
    return inspectConfiguredDefaultWorkspace(value, config);
  }

  const directory = inspectCanonicalWorkspaceDirectory(value);
  // `repository` is the v3 compatibility label for a non-default Role
  // workspace. It never promised a Git-only target, so all non-default kinds
  // use the same canonical-directory authority check and stable inode witness.
  return Object.freeze({
    workspace: directory.workspace,
    witness: `${kind}\u0000${directory.workspace}\u0000${directory.device}\u0000${directory.inode}`
  });
}

function existingWorkspaceTarget(
  workspaceById: ReadonlyMap<string, PortableWorkspaceState>,
  bindingId: string,
  sourceKind: WorkspaceBinding["kind"]
): string {
  const existing = workspaceById.get(bindingId);
  if (existing === undefined) throw new PortableImportError("REQUIREMENT_MISMATCH");
  if (existing.descriptor.kind !== sourceKind) throw new PortableImportError("INVALID_MAPPING");
  return existing.workspace;
}

function inspectConfiguredDefaultWorkspace(
  value: string,
  config: TaskmuxConfig
): DirectWorkspaceInspection {
  if (config.defaultWorkspace !== value || !isAbsolute(value) || value !== resolve(value) ||
      value.length === 0 || value.length > 512 || value.includes("\u0000")) {
    throw new PortableImportError("INVALID_MAPPING");
  }
  if (!existsSync(value)) {
    return Object.freeze({
      workspace: value,
      witness: `default\u0000${value}\u0000missing`
    });
  }
  const directory = inspectCanonicalWorkspaceDirectory(value);
  return Object.freeze({
    workspace: directory.workspace,
    witness: `default\u0000${directory.workspace}\u0000${directory.device}\u0000${directory.inode}`
  });
}

function inspectCanonicalWorkspaceDirectory(value: string): Readonly<{
  workspace: string;
  device: string;
  inode: string;
}> {
  if (!isAbsolute(value) || value !== resolve(value) || value.length === 0 || value.length > 512 ||
      value.includes("\u0000")) {
    throw new PortableImportError("INVALID_MAPPING");
  }
  try {
    const initial = lstatSync(value);
    if (initial.isSymbolicLink() || !initial.isDirectory()) {
      throw new PortableImportError("INVALID_MAPPING");
    }
    const workspace = realpathSync(value);
    if (workspace !== value) throw new PortableImportError("INVALID_MAPPING");
    const finalEntry = lstatSync(workspace);
    const finalStats = statSync(workspace);
    if (finalEntry.isSymbolicLink() || !finalStats.isDirectory()) {
      throw new PortableImportError("INVALID_MAPPING");
    }
    return Object.freeze({
      workspace,
      device: String(finalStats.dev),
      inode: String(finalStats.ino)
    });
  } catch (error) {
    if (error instanceof PortableImportError) throw error;
    throw new PortableImportError("INVALID_MAPPING");
  }
}

function claimWorkspaceTargetIdentity(identities: Set<string>, identity: string): void {
  if (identities.has(identity)) throw new PortableImportError("INVALID_MAPPING");
  identities.add(identity);
}

function nextPrivateBindingId(reserved: ReadonlySet<string>): string {
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const candidate = `import-${randomUUID().toLowerCase()}`;
    if (!reserved.has(candidate)) return candidate;
  }
  throw new PortableImportError("INVALID_MAPPING");
}

function remapPrivateWorkspaceBindingIds(
  record: PortableSemantic,
  workspaceById: ReadonlyMap<string, PortableWorkspaceState>,
  privateBindings: ReadonlyMap<string, PortableWorkspaceState>
): PortableSemantic {
  if (record.workspaceBindingIds.length === 0 || privateBindings.size === 0) return record;
  const privateBindingByWorkspace = new Map<string, string>();
  for (const [bindingId, state] of privateBindings) {
    privateBindingByWorkspace.set(state.workspace, bindingId);
  }
  let changed = false;
  const workspaceBindingIds = record.workspaceBindingIds.map((bindingId) => {
    const workspace = workspaceById.get(bindingId)?.workspace;
    const privateBindingId = workspace === undefined
      ? undefined
      : privateBindingByWorkspace.get(workspace);
    if (privateBindingId === undefined || privateBindingId === bindingId) return bindingId;
    changed = true;
    return privateBindingId;
  });
  if (!changed) return record;
  workspaceBindingIds.sort(compareStrings);
  return {
    ...record,
    workspaceBindingIds
  };
}

function hasTargetBindingId(
  value: PortableWorkspaceBindingMapping
): value is Readonly<{
  schemaVersion: 1;
  sourceBindingId: string;
  targetBindingId: string;
  targetWorkspacePath?: never;
}> {
  return typeof value.targetBindingId === "string";
}

function collectPortableState(reader: TaskReader): PortableState {
  const config = reader.getConfig();
  const globalRoles = [...reader.listGlobalRoles()].sort((left, right) => compareStrings(left.name, right.name));
  const liveTasks = [...reader.listTasks()].sort((left, right) => compareStrings(left.id, right.id));
  const liveTaskRoles = liveTasks.flatMap((task) =>
    reader.listRoles(task.id).sort((left, right) => compareStrings(left.name, right.name))
  );
  const trashTasks = reader.listTrashedTaskIds().map((taskId) => {
    const descriptor = reader.readTrashedTask(taskId, (trashReader): TrashedTaskDescriptor => {
      const task = trashReader.getTask(taskId);
      if (task === null) throw new Error(`Portable trashed task is unavailable: ${taskId}`);
      return {
        task,
        roles: [...trashReader.listRoles(taskId)]
          .sort((left, right) => compareStrings(left.name, right.name))
      };
    });
    if (descriptor === null) throw new Error(`Portable trashed task is unavailable: ${taskId}`);
    return descriptor;
  });

  const taskLifecycles = new Map<string, PortableTaskLifecycle>();
  for (const task of liveTasks) {
    taskLifecycles.set(task.id, "live");
  }
  for (const descriptor of trashTasks) {
    if (taskLifecycles.has(descriptor.task.id)) {
      throw new Error(`Task id is present in both live and trash storage: ${descriptor.task.id}`);
    }
    taskLifecycles.set(descriptor.task.id, "trash");
  }

  const workspace = buildWorkspaceCatalog(
    config,
    globalRoles,
    [...liveTaskRoles, ...trashTasks.flatMap((descriptor) => descriptor.roles)]
  );
  const recordsByAuthority = new Map<string, PortableSemantic[]>(
    PORTABLE_AUTHORITY_IDS.map((authority) => [authority, []])
  );
  const add = (record: PortableSemantic): void => {
    const records = recordsByAuthority.get(record.authority);
    if (records === undefined) throw new Error(`Unsupported portable authority: ${record.authority}.`);
    records.push(record);
  };

  const configPayload = projectConfig(config);
  if (configPayload !== null) {
    const defaultAgentId = configPayload.defaultAgentId;
    add(semanticRecord(
      "config",
      "config",
      configPayload,
      [],
      typeof defaultAgentId === "string" ? [defaultAgentId] : [],
      [
        ...taskPointerReferences(configPayload.currentTaskId),
        ...taskPointerReferences(configPayload.lastTaskId)
      ]
    ));
  }

  const configuredSkills = reader.listConfiguredSkills();
  const configuredSkillIds = new Set(configuredSkills.map((skill) => skill.id));
  for (const skillId of referencedConfiguredSkillIds([
    ...globalRoles,
    ...liveTaskRoles,
    ...trashTasks.flatMap((descriptor) => descriptor.roles)
  ])) {
    if (!configuredSkillIds.has(skillId)) {
      throw new Error(`Referenced configured Skill is unavailable: ${skillId}.`);
    }
  }
  for (const skill of configuredSkills) {
    add(configuredSkillSemanticRecord(skill));
  }

  for (const role of globalRoles) {
    add(projectGlobalRole(role, workspace));
  }
  for (const task of liveTasks) {
    emitPortableTaskRecords(reader, task, "live", workspace, taskLifecycles, add);
  }
  for (const descriptor of trashTasks) {
    const result = reader.readTrashedTask(descriptor.task.id, (trashReader) => {
      const task = trashReader.getTask(descriptor.task.id);
      if (task === null) throw new Error(`Portable trashed task is unavailable: ${descriptor.task.id}`);
      emitPortableTaskRecords(trashReader, task, "trash", workspace, taskLifecycles, add);
    });
    if (result === null) throw new Error(`Portable trashed task is unavailable: ${descriptor.task.id}`);
  }

  const semanticByIdentity = new Map<string, PortableSemantic>();
  for (const records of recordsByAuthority.values()) {
    for (const record of records) {
      const identity = semanticIdentity(record.lifecycle, record.authority, record.key);
      if (semanticByIdentity.has(identity)) {
        throw new Error(`Duplicate portable semantic identity: ${identity}`);
      }
      semanticByIdentity.set(identity, record);
    }
  }
  return {
    recordsByAuthority,
    semanticByIdentity,
    workspaceById: workspace.byId,
    workspaceByRoot: workspace.byRoot,
    agentRequirements: [...reader.listConfiguredAgents()]
      .map(agentRequirement)
      .sort((left, right) => compareStrings(left.agentId, right.agentId))
  };
}

function emitPortableTaskRecords(
  reader: TaskReader,
  task: Task,
  lifecycle: PortableTaskLifecycle,
  workspace: { byRoot: Map<string, PortableWorkspaceState> },
  taskLifecycles: ReadonlyMap<string, PortableTaskLifecycle>,
  add: (record: PortableSemantic) => void
): void {
  add(semanticRecord("task", task.id, projectTask(task), [], [], [], lifecycle));
  add(semanticRecord(
    "task-topics",
    task.id,
    reader.getTaskTopics(task.id),
    [],
    [],
    taskScopedReferences(task.id, lifecycle),
    lifecycle
  ));

  const draft = reader.getTaskInputDraft(task.id);
  if (draft !== null) {
    add(semanticRecord(
      "task-input-draft",
      task.id,
      draft,
      [],
      [],
      taskScopedReferences(task.id, lifecycle),
      lifecycle
    ));
  }

  for (const role of reader.listRoles(task.id)) {
    add(projectTaskRole(role, workspace, lifecycle));
    const transcript = reader.readTranscript(task.id, role.name);
    if (transcript !== null) {
      add(semanticRecord(
        "transcript",
        `${task.id}/${role.name}`,
        transcript,
        [],
        [],
        taskScopedReferences(task.id, lifecycle),
        lifecycle
      ));
    }
  }

  for (const role of reader.listChildRoles(task.id)) {
    add(semanticRecord(
      "child-role",
      `${task.id}/${role.name}`,
      role,
      [],
      [],
      references(
        taskScopedReferences(task.id, lifecycle),
        taskRoleReference(task.id, role.parentRole, lifecycle)
      ),
      lifecycle
    ));
  }

  const schedule = reader.getTaskSchedule(task.id);
  if (schedule !== null) {
    add(semanticRecord(
      "task-schedule",
      task.id,
      projectTaskSchedule(schedule),
      [],
      [],
      taskScopedReferences(task.id, lifecycle),
      lifecycle
    ));
  }

  for (const cycle of reader.listCycles(task.id)) {
    add(semanticRecord(
      "cycle",
      `${task.id}/${cycle.id}`,
      cycle,
      [],
      [],
      references(
        taskScopedReferences(task.id, lifecycle),
        topicReferences(task.id, cycle.topics, lifecycle)
      ),
      lifecycle
    ));
  }

  for (const item of reader.listWorkItems(task.id)) {
    add(semanticRecord(
      "work-item",
      `${task.id}/${item.id}`,
      item,
      [],
      [],
      references(
        taskScopedReferences(task.id, lifecycle),
        taskRoleReference(task.id, item.assignee, lifecycle),
        item.cycleId === undefined ? [] : cycleReference(task.id, item.cycleId, lifecycle),
        topicReferences(task.id, item.topics, lifecycle)
      ),
      lifecycle
    ));
  }

  const portableRunsById = new Map<string, AgentRun>();
  for (const run of reader.listAgentRuns(task.id)) {
    if (!["yielded", "failed", "expired"].includes(run.status)) continue;
    portableRunsById.set(run.id, run);
    add(semanticRecord(
      "agent-run-history",
      `${task.id}/${run.id}`,
      run,
      [],
      [],
      references(
        taskScopedReferences(task.id, lifecycle),
        taskRoleReference(task.id, run.roleName, lifecycle),
        run.workItemId === undefined ? [] : workItemReference(task.id, run.workItemId, lifecycle),
        topicReferences(task.id, run.topics ?? [], lifecycle)
      ),
      lifecycle
    ));
  }

  for (const request of reader.listInputRequests(task.id)) {
    if (request.status === "open") continue;
    add(semanticRecord(
      "input-request-history",
      `${task.id}/${request.id}`,
      projectInputRequest(request),
      [],
      [request.requester.agentId],
      inputRequestReferences(request, lifecycle, taskLifecycles, portableRunsById),
      lifecycle
    ));
  }

  for (const resolution of reader.listInputResolutions(task.id)) {
    add(semanticRecord(
      "input-resolution",
      `${task.id}/${resolution.id}`,
      resolution,
      [],
      [],
      references(
        taskScopedReferences(task.id, lifecycle),
        inputRequestReference(task.id, resolution.requestId, lifecycle)
      ),
      lifecycle
    ));
  }

  const brief = reader.readTaskBrief(task.id);
  if (brief !== null) {
    add(semanticRecord(
      "task-brief",
      task.id,
      brief,
      [],
      [],
      taskScopedReferences(task.id, lifecycle),
      lifecycle
    ));
  }
  const topicSummary = reader.readTaskTopicSummaries(task.id);
  if (topicSummary !== null) {
    add(semanticRecord(
      "task-topic-summary",
      task.id,
      topicSummary,
      [],
      [],
      taskScopedReferences(task.id, lifecycle),
      lifecycle
    ));
  }
  const timeline = reader.readTaskTimeline(task.id);
  if (timeline !== null) {
    add(semanticRecord(
      "task-timeline",
      task.id,
      timeline,
      [],
      [],
      taskScopedReferences(task.id, lifecycle),
      lifecycle
    ));
  }

  for (const milestone of reader.listMilestones(task.id)) {
    add(semanticRecord(
      "milestone",
      `${task.id}/${milestone.id}`,
      milestone,
      [],
      [],
      references(
        taskScopedReferences(task.id, lifecycle),
        topicReferences(task.id, milestone.topics, lifecycle)
      ),
      lifecycle
    ));
  }
  for (const decision of reader.listDecisions(task.id)) {
    add(semanticRecord(
      "decision",
      `${task.id}/${decision.id}`,
      decision,
      [],
      [],
      references(
        taskScopedReferences(task.id, lifecycle),
        topicReferences(task.id, decision.topics, lifecycle)
      ),
      lifecycle
    ));
  }
  for (const comment of reader.listComments(task.id)) {
    add(semanticRecord(
      "comment",
      `${task.id}/${comment.id}`,
      comment,
      [],
      [],
      references(
        taskScopedReferences(task.id, lifecycle),
        topicReferences(task.id, comment.topics, lifecycle)
      ),
      lifecycle
    ));
  }
  for (const event of reader.listEvents(task.id)) {
    add(semanticRecord(
      "event",
      `${task.id}/${event.id}`,
      event,
      [],
      [],
      taskScopedReferences(task.id, lifecycle),
      lifecycle
    ));
  }
}

function buildWorkspaceCatalog(
  config: TaskmuxConfig,
  globalRoles: readonly GlobalRole[],
  taskRoles: readonly Role[]
): { byId: Map<string, PortableWorkspaceState>; byRoot: Map<string, PortableWorkspaceState> } {
  const byId = new Map<string, PortableWorkspaceState>();
  const byRoot = new Map<string, PortableWorkspaceState>();
  const add = (
    bindingId: string,
    kind: WorkspaceBinding["kind"],
    workspace: string,
    label: string
  ): void => {
    const state: PortableWorkspaceState = Object.freeze({
      descriptor: Object.freeze({
        schemaVersion: 1,
        bindingId,
        kind,
        relativeSubpath: "",
        label
      }),
      workspace,
      // Never serialized. The raw target root is only a private plan/apply witness.
      witness: `${kind}\u0000${workspace}`
    });
    byId.set(bindingId, state);
    byRoot.set(workspace, state);
  };

  if (config.defaultWorkspace !== undefined) {
    add("default", "default", config.defaultWorkspace, "Default workspace");
  }
  const roots = [...new Set([
    ...globalRoles.map((role) => role.workspace),
    ...taskRoles.map((role) => role.workspace)
  ])]
    .filter((root) => !byRoot.has(root))
    .sort(compareStrings);
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index] as string;
    add(`repository-${index + 1}`, "repository", root, `Repository workspace ${index + 1}`);
  }
  return { byId, byRoot };
}

function projectConfig(config: TaskmuxConfig): Record<string, unknown> | null {
  if (
    config.defaultAgent === undefined &&
    config.currentTaskId === undefined &&
    config.lastTaskId === undefined
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    ...(config.defaultAgent === undefined ? {} : { defaultAgentId: config.defaultAgent }),
    ...(config.currentTaskId === undefined ? {} : { currentTaskId: config.currentTaskId }),
    ...(config.lastTaskId === undefined ? {} : { lastTaskId: config.lastTaskId })
  };
}

function projectTask(task: Task): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: task.id,
    title: task.title,
    archived: task.archived,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.tags === undefined ? {} : { tags: task.tags }),
    ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
    ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
    ...(task.archivedBy === undefined ? {} : { archivedBy: task.archivedBy }),
    ...(task.archiveReason === undefined ? {} : { archiveReason: task.archiveReason }),
    ...(task.archiveSummary === undefined ? {} : { archiveSummary: task.archiveSummary })
  };
}

function projectGlobalRole(
  role: GlobalRole,
  workspace: { byRoot: Map<string, PortableWorkspaceState> }
): PortableSemantic {
  const workspaceState = requireWorkspaceState(workspace.byRoot, role.workspace);
  return semanticRecord(
    "global-role",
    role.name,
    projectRole(role),
    [workspaceState.descriptor.bindingId],
    roleAgentIds(role),
    configuredSkillReferences(role)
  );
}

function projectTaskRole(
  role: Role,
  workspace: { byRoot: Map<string, PortableWorkspaceState> },
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemantic {
  const workspaceState = requireWorkspaceState(workspace.byRoot, role.workspace);
  return semanticRecord(
    "task-role",
    `${role.taskId}/${role.name}`,
    projectRole(role),
    [workspaceState.descriptor.bindingId],
    roleAgentIds(role),
    references(
      taskScopedReferences(role.taskId, lifecycle),
      configuredSkillReferences(role)
    ),
    lifecycle
  );
}

function projectRole(role: GlobalRole | Role): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    ...("taskId" in role ? { taskId: role.taskId } : {}),
    name: role.name,
    activeAgentId: role.activeAgentId,
    agentBindings: Object.fromEntries(
      Object.entries(role.agentBindings)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([agentId, binding]) => [agentId, projectRoleAgentBinding(binding)])
    ),
    ...(role.description === undefined ? {} : { description: role.description }),
    ...(role.responsibilities === undefined ? {} : { responsibilities: role.responsibilities }),
    ...(role.constraints === undefined ? {} : { constraints: role.constraints }),
    ...(role.expectedOutput === undefined ? {} : { expectedOutput: role.expectedOutput }),
    ...(role.systemPrompt === undefined ? {} : { systemPrompt: role.systemPrompt }),
    ...(role.skills === undefined ? {} : { skills: [...role.skills] }),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt
  };
  return payload;
}

function projectRoleAgentBinding(binding: RoleAgentBinding): Record<string, unknown> {
  const config = binding.config.adapterId === "codex"
    ? {
        adapterId: "codex",
        ...(binding.config.model === undefined ? {} : { model: binding.config.model }),
        ...(binding.config.effort === undefined ? {} : { effort: binding.config.effort }),
        ...(binding.config.permission === undefined ? {} : { permission: binding.config.permission }),
        ...(binding.config.search === undefined ? {} : { search: binding.config.search })
      }
    : {
        adapterId: "claude",
        ...(binding.config.model === undefined ? {} : { model: binding.config.model }),
        ...(binding.config.effort === undefined ? {} : { effort: binding.config.effort }),
        ...(binding.config.permission === undefined ? {} : { permission: binding.config.permission })
      };
  return {
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    config
  };
}

function projectTaskSchedule(schedule: TaskSchedule): Record<string, unknown> {
  const { lastLeaderWakeupAt: _hostRuntimeWakeup, ...portable } = schedule;
  return portable;
}

function projectInputRequest(request: InputRequest): Record<string, unknown> {
  const {
    sessionRoot: _sessionRoot,
    nativeSessionId: _nativeSessionId,
    ...requester
  } = request.requester;
  return { ...request, requester };
}

function inputRequestReferences(
  request: InputRequest,
  lifecycle: PortableTaskLifecycle = "live",
  taskLifecycles?: ReadonlyMap<string, PortableTaskLifecycle>,
  portableRunsById?: ReadonlyMap<string, AgentRun>
): PortableSemanticReference[] {
  const taskId = request.taskId;
  const result: PortableSemanticReference[] = [
    ...taskScopedReferences(taskId, lifecycle),
    taskRoleReference(taskId, request.requester.roleName, lifecycle)
  ];
  const requesterRun = portableRunsById?.get(request.requester.agentRunId);
  if (requesterRun?.roleName === request.requester.roleName) {
    result.push(agentRunReference(taskId, requesterRun.id, lifecycle));
  }
  for (const blocked of request.blockedRefs) {
    if (blocked.type === "task") {
      const targetLifecycle = taskLifecycles?.get(blocked.id) ?? "live";
      result.push(taskReference(blocked.id, targetLifecycle));
    } else if (blocked.type === "work-item") {
      result.push(workItemReference(taskId, blocked.id, lifecycle));
    } else {
      result.push(decisionReference(taskId, blocked.id, lifecycle));
    }
  }
  if (request.status === "answered" || request.status === "auto-resolved") {
    result.push(inputResolutionReference(taskId, request.resolutionId as string, lifecycle));
  }
  return sortReferences(result);
}

function taskPointerReferences(taskId: unknown): PortableSemanticReference[] {
  return typeof taskId === "string" ? [taskReference(taskId)] : [];
}

function taskScopedReferences(
  taskId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference[] {
  return [taskReference(taskId, lifecycle)];
}

function topicReferences(
  taskId: string,
  topics: readonly string[],
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference[] {
  return topics.some((topic) => !BUILTIN_TOPIC_IDS.has(topic))
    ? [taskTopicsReference(taskId, lifecycle)]
    : [];
}

function taskReference(
  taskId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "task", key: taskId };
}

function taskTopicsReference(
  taskId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "task-topics", key: taskId };
}

function taskRoleReference(
  taskId: string,
  roleName: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "task-role", key: `${taskId}/${roleName}` };
}

function cycleReference(
  taskId: string,
  cycleId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "cycle", key: `${taskId}/${cycleId}` };
}

function workItemReference(
  taskId: string,
  workItemId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "work-item", key: `${taskId}/${workItemId}` };
}

function agentRunReference(
  taskId: string,
  runId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "agent-run-history", key: `${taskId}/${runId}` };
}

function inputRequestReference(
  taskId: string,
  requestId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "input-request-history", key: `${taskId}/${requestId}` };
}

function inputResolutionReference(
  taskId: string,
  resolutionId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "input-resolution", key: `${taskId}/${resolutionId}` };
}

function decisionReference(
  taskId: string,
  decisionId: string,
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemanticReference {
  return { lifecycle, authority: "decision", key: `${taskId}/${decisionId}` };
}

function semanticRecord(
  authority: string,
  key: string,
  payload: unknown,
  workspaceBindingIds: readonly string[],
  agentRequirementIds: readonly string[],
  refs: readonly PortableSemanticReference[],
  lifecycle: PortableTaskLifecycle = "live"
): PortableSemantic {
  return {
    schemaVersion: 1,
    lifecycle,
    authority,
    key,
    payload: payload as PortableSemantic["payload"],
    workspaceBindingIds: [...workspaceBindingIds].sort(compareStrings),
    agentRequirementIds: [...agentRequirementIds].sort(compareStrings),
    references: sortReferences(refs)
  };
}

function references(...values: ReadonlyArray<PortableSemanticReference | readonly PortableSemanticReference[]>): PortableSemanticReference[] {
  return sortReferences(values.flatMap((value) => Array.isArray(value) ? value : [value]));
}

function sortReferences(values: readonly PortableSemanticReference[]): PortableSemanticReference[] {
  return [...values].sort((left, right) => compareStrings(
    semanticIdentity(left.lifecycle, left.authority, left.key),
    semanticIdentity(right.lifecycle, right.authority, right.key)
  ));
}

function roleAgentIds(role: GlobalRole | Role): string[] {
  return Object.keys(role.agentBindings).sort(compareStrings);
}

function referencedConfiguredSkillIds(roles: readonly (GlobalRole | Role)[]): string[] {
  return [...new Set(roles.flatMap((role) => role.skills ?? []))].sort(compareStrings);
}

function configuredSkillReferences(role: GlobalRole | Role): PortableSemanticReference[] {
  return [...(role.skills ?? [])]
    .sort(compareStrings)
    .map((skillId) => ({
      lifecycle: "live" as const,
      authority: "configured-skill",
      key: skillId
    }));
}

function configuredSkillSemanticRecord(skill: {
  schemaVersion: 1;
  id: string;
  content: string;
  sha256: string;
}): PortableSemantic {
  return semanticRecord("configured-skill", skill.id, skill, [], [], []);
}

function agentRequirement(agent: ConfiguredAgent): AgentRequirement {
  return {
    schemaVersion: 1,
    agentId: agent.id,
    adapterId: agent.adapterId
  };
}

function requireWorkspaceState(
  workspaceByRoot: ReadonlyMap<string, PortableWorkspaceState>,
  root: string
): PortableWorkspaceState {
  const state = workspaceByRoot.get(root);
  if (state === undefined) throw new Error("Portable workspace binding is unavailable.");
  return state;
}

function assertPortableImportTaskLifecycles(
  initial: PortableState,
  records: readonly PortableSemantic[]
): Readonly<{
  newTrashTaskIds: readonly string[];
  replacedTrashTaskIds: readonly string[];
  runtimeResetTaskIds: readonly string[];
}> {
  const incoming = new Map<string, PortableTaskLifecycle>();
  const newTrashTaskIds = new Set<string>();
  const replacedTrashTaskIds = new Set<string>();
  const runtimeResetTaskIds = new Set<string>();
  for (const record of records) {
    const taskId = portableTaskId(record);
    if (taskId === null) {
      if (record.lifecycle === "trash") {
        throw new Error("Portable trash records must be task-scoped.");
      }
      continue;
    }
    const previous = incoming.get(taskId);
    if (previous !== undefined && previous !== record.lifecycle) {
      throw new Error(`Portable task lifecycle collision: ${taskId}`);
    }
    incoming.set(taskId, record.lifecycle);
    const hasExistingLiveTask = initial.semanticByIdentity.has(
      semanticIdentity("live", "task", taskId)
    );
    const opposite = record.lifecycle === "live" ? "trash" : "live";
    if (initial.semanticByIdentity.has(semanticIdentity(opposite, "task", taskId))) {
      if (record.lifecycle === "live") {
        replacedTrashTaskIds.add(taskId);
      } else {
        throw new Error(`Portable task lifecycle collision: ${taskId}`);
      }
    }
    if (!hasExistingLiveTask) {
      runtimeResetTaskIds.add(taskId);
    }
    if (
      record.lifecycle === "trash" &&
      !initial.semanticByIdentity.has(semanticIdentity("trash", "task", taskId))
    ) {
      newTrashTaskIds.add(taskId);
    }
  }
  return Object.freeze({
    newTrashTaskIds: Object.freeze([...newTrashTaskIds].sort(compareStrings)),
    replacedTrashTaskIds: Object.freeze([...replacedTrashTaskIds].sort(compareStrings)),
    runtimeResetTaskIds: Object.freeze([...runtimeResetTaskIds].sort(compareStrings))
  });
}

function portableTaskId(record: PortableSemantic): string | null {
  const descriptor = getAuthorityDescriptor(record.authority);
  if (descriptor === null || descriptor.lifecycle !== "task-lifecycle") {
    return null;
  }
  return descriptor.keyShape === "task"
    ? record.key
    : splitTaskEntityKey(record.key)[0];
}

function persistSemanticRecord(
  store: FileTaskStore,
  workspaceById: ReadonlyMap<string, PortableWorkspaceState>,
  record: PortableSemantic
): void {
  const payload = materializePortablePayload(record.payload);
  switch (record.authority) {
    case "config":
      persistConfig(store, payload as Record<string, unknown>);
      return;
    case "configured-skill":
      store.saveConfiguredSkill(payload as {
        schemaVersion: 1;
        id: string;
        content: string;
        sha256: string;
      });
      return;
    case "global-role":
      store.saveGlobalRole(importGlobalRole(record, workspaceById, payload as Record<string, unknown>));
      return;
    case "task":
      store.saveTask(payload as Task);
      return;
    case "task-topics":
      store.saveTaskTopics(record.key, payload as TaskTopics);
      return;
    case "task-input-draft":
      store.saveTaskInputDraft(record.key, payload as TaskInputDraft);
      return;
    case "input-request-history": {
      const request = payload as InputRequest;
      store.saveInputRequest(request);
      return;
    }
    case "input-resolution":
      store.saveInputResolution(payload as InputResolution);
      return;
    case "task-schedule":
      store.saveTaskSchedule(record.key, payload as TaskSchedule);
      return;
    case "cycle": {
      const [taskId] = splitTaskEntityKey(record.key);
      store.saveCycle(taskId, payload as Cycle);
      return;
    }
    case "work-item": {
      const [taskId] = splitTaskEntityKey(record.key);
      store.saveWorkItem(taskId, payload as WorkItem);
      return;
    }
    case "task-role": {
      const role = importTaskRole(record, workspaceById, payload as Record<string, unknown>);
      store.saveRole(role.taskId, role);
      return;
    }
    case "child-role": {
      const [taskId] = splitTaskEntityKey(record.key);
      store.saveChildRole(taskId, payload as ChildRole);
      return;
    }
    case "agent-run-history": {
      const [taskId] = splitTaskEntityKey(record.key);
      if (taskId.length === 0) throw new Error("Invalid portable agent run.");
      store.saveAgentRun(payload as AgentRun);
      return;
    }
    case "task-brief":
      store.saveTaskBrief(record.key, payload as string);
      return;
    case "task-topic-summary":
      store.appendTaskTopicSummary(record.key, payload as string);
      return;
    case "task-timeline":
      store.appendTaskTimeline(record.key, payload as string);
      return;
    case "milestone": {
      const [taskId] = splitTaskEntityKey(record.key);
      store.saveMilestone(taskId, payload as Milestone);
      return;
    }
    case "decision": {
      const [taskId] = splitTaskEntityKey(record.key);
      store.saveDecision(taskId, payload as Decision);
      return;
    }
    case "comment": {
      const [taskId] = splitTaskEntityKey(record.key);
      store.saveComment(taskId, payload as TaskComment);
      return;
    }
    case "event": {
      const [taskId] = splitTaskEntityKey(record.key);
      store.saveEvent(taskId, payload as TaskEvent);
      return;
    }
    case "transcript": {
      const [taskId, roleName] = splitTaskEntityKey(record.key);
      store.saveTranscript(taskId, roleName, payload as string);
      return;
    }
    default:
      throw new Error(`Unsupported portable import authority: ${record.authority}.`);
  }
}

function persistConfig(store: FileTaskStore, payload: Record<string, unknown>): void {
  const current = store.getConfig();
  store.saveConfig({
    ...current,
    schemaVersion: 1,
    ...(payload.defaultAgentId === undefined ? {} : { defaultAgent: payload.defaultAgentId as string }),
    ...(payload.currentTaskId === undefined ? {} : { currentTaskId: payload.currentTaskId as string }),
    ...(payload.lastTaskId === undefined ? {} : { lastTaskId: payload.lastTaskId as string })
  });
}

function importGlobalRole(
  record: PortableSemantic,
  workspaceById: ReadonlyMap<string, PortableWorkspaceState>,
  payload: Record<string, unknown>
): GlobalRole {
  const { schemaVersion: _schemaVersion, ...rest } = payload;
  return {
    ...rest,
    schemaVersion: 2,
    workspace: importWorkspace(record, workspaceById)
  } as unknown as GlobalRole;
}

function importTaskRole(
  record: PortableSemantic,
  workspaceById: ReadonlyMap<string, PortableWorkspaceState>,
  payload: Record<string, unknown>
): Role {
  const [taskId] = splitTaskEntityKey(record.key);
  const { schemaVersion: _schemaVersion, taskId: _payloadTaskId, ...rest } = payload;
  return {
    ...rest,
    schemaVersion: 2,
    taskId,
    workspace: importWorkspace(record, workspaceById),
    status: "idle"
  } as unknown as Role;
}

function materializePortablePayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function importWorkspace(
  record: PortableSemantic,
  workspaceById: ReadonlyMap<string, PortableWorkspaceState>
): string {
  if (record.workspaceBindingIds.length !== 1) {
    throw new Error("Portable role workspace binding is invalid.");
  }
  const bindingId = record.workspaceBindingIds[0] as string;
  const state = workspaceById.get(bindingId);
  if (state === undefined) throw new Error("Portable role workspace target is unavailable.");
  return state.workspace;
}

function splitTaskEntityKey(key: string): [string, string] {
  const separator = key.indexOf("/");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error("Portable task entity key is invalid.");
  }
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function semanticIdentity(lifecycle: string, authority: string, key: string): string {
  return `${lifecycle}\u0000${authority}\u0000${key}`;
}

function compareSemantic(left: PortableSemantic, right: PortableSemantic): number {
  return compareStrings(
    semanticIdentity(left.lifecycle, left.authority, left.key),
    semanticIdentity(right.lifecycle, right.authority, right.key)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
