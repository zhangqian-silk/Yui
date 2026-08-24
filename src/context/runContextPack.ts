import type { AgentRun } from "../run/agentRun.js";
import type { TaskStore } from "../storage/taskStore.js";
import { TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT } from "../task/publicationReference.js";
import { RUN_BOOTSTRAP_MAX_DELTAS } from "./runContextContract.js";
import {
  contextContentDigest,
  contextSnapshotRef,
  createContextSnapshot,
  validateContextSnapshot,
  type ContextRef,
  type ContextSnapshot,
  type ContextSnapshotRef,
  type ContextSnapshotScope
} from "./contextSnapshot.js";

export const RUN_CONTEXT_PACK_SCHEMA_VERSION = 1 as const;
export const RUN_CONTEXT_PACK_MAX_REFS = 256;
export const RUN_CONTEXT_PACK_MAX_BYTES = 8 * 1024 * 1024;
export const RUN_CONTEXT_EXPAND_MAX_BYTES = 4 * 1024 * 1024;

export type RunContextView = "operator" | "leader" | "worker" | "reviewer" | "global";
export type RunContextSummary = Readonly<{
  refId: string;
  store: string;
  summary: string;
  digest: string;
}>;
export type RunContextBudgetResult = Readonly<{
  maxRefs: number;
  returnedRefs: number;
  maxBytes: number;
  returnedBytes: number;
  truncated: false;
}>;
export type RunContextPack = Readonly<{
  schemaVersion: typeof RUN_CONTEXT_PACK_SCHEMA_VERSION;
  identity: Readonly<{
    taskId: string;
    runId: string;
    roleName: string;
    purpose: AgentRun["purpose"];
    agentId: string;
    adapterId: string;
    workspace: string;
  }>;
  snapshot?: ContextSnapshotRef;
  assignment: AgentRun["assignment"];
  authority: Readonly<{
    view: RunContextView;
    readableRefs: readonly ContextRef[];
    writableProjectIds: readonly string[];
  }>;
  pointers: readonly ContextRef[];
  summaries: readonly RunContextSummary[];
  deltas: readonly ContextRef[];
  completion: Readonly<{
    allowedActions: readonly string[];
    exactRunRef: string;
  }>;
  budget: RunContextBudgetResult;
  digest: string;
}>;

type MaterializedRef = Readonly<{ ref: ContextRef; value: unknown }>;

export function freezeRunContextSnapshot(
  store: TaskStore,
  run: Readonly<Pick<
    AgentRun,
    "taskId" | "roleName" | "purpose" | "workItemId" | "reviewRoundId" | "workspace"
  >>,
  now: Date,
  frozenBy: "leader" | "controller" = "controller"
): ContextSnapshot {
  const scope: ContextSnapshotScope = run.reviewRoundId !== undefined
    ? "stage"
    : run.workItemId !== undefined
      ? "workitem"
      : "task";
  const scopeRef = run.reviewRoundId ?? run.workItemId;
  const materialized = collectAuthorizedContext(store, run);
  const previous = store.listContextSnapshots(run.taskId)
    .filter((candidate) => candidate.scope === scope && candidate.scopeRef === scopeRef)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  const snapshot = createContextSnapshot({
    id: store.nextContextSnapshotId(run.taskId),
    taskId: run.taskId,
    scope,
    ...(scopeRef === undefined ? {} : { scopeRef }),
    sequence: (previous?.sequence ?? 0) + 1,
    refs: materialized.map(({ ref }) => ref),
    resources: materialized,
    acceptRefs: run.workItemId === undefined ? [] : [`work-item:${run.workItemId}:acceptance`],
    ...(previous === undefined ? {} : { parentRef: contextSnapshotRef(previous) }),
    frozenAt: now,
    frozenBy
  });
  store.saveContextSnapshot(snapshot);
  return snapshot;
}

/** Bounded changed-ref hint between one frozen Snapshot and its exact parent. */
export function contextSnapshotDeltaRefIds(
  store: TaskStore,
  snapshot: ContextSnapshot
): readonly string[] {
  validateContextSnapshot(snapshot);
  if (snapshot.parentRef === undefined) return Object.freeze([]);
  const parent = store.getContextSnapshot(snapshot.taskId, snapshot.parentRef.id);
  if (parent === null
    || parent.digest !== snapshot.parentRef.digest
    || parent.sequence !== snapshot.parentRef.sequence) {
    throw new Error(`Context Snapshot parent is missing or drifted: ${snapshot.parentRef.id}.`);
  }
  validateContextSnapshot(parent);
  const previous = new Map(parent.refs.map((ref) => [ref.refId, ref]));
  const changed = snapshot.refs.filter((ref) => {
    const before = previous.get(ref.refId);
    return before === undefined
      || before.digest !== ref.digest
      || before.revision !== ref.revision
      || before.store !== ref.store
      || before.layer !== ref.layer;
  }).map(({ refId }) => refId);
  return Object.freeze([...new Set(changed)].sort().slice(0, RUN_BOOTSTRAP_MAX_DELTAS));
}

export function buildRunContextPack(store: TaskStore, taskId: string, runId: string): RunContextPack {
  const run = requireExactRun(store, taskId, runId);
  const current = collectAuthorizedContext(store, run);
  let pointers: readonly ContextRef[] = current.map(({ ref }) => ref);
  let snapshotRef: ContextSnapshotRef | undefined;
  if (run.assignment.contextSnapshotRef !== undefined) {
    const expected = run.assignment.contextSnapshotRef;
    const snapshot = store.getContextSnapshot(taskId, expected.id);
    if (snapshot === null) throw new Error(`Run Context Snapshot is missing: ${expected.id}.`);
    validateContextSnapshot(snapshot);
    if (snapshot.digest !== expected.digest || snapshot.taskId !== taskId) {
      throw new Error(`Run Context Snapshot identity drifted: ${expected.id}.`);
    }
    pointers = snapshot.refs;
    snapshotRef = contextSnapshotRef(snapshot);
  }
  if (pointers.length > RUN_CONTEXT_PACK_MAX_REFS) {
    throw new Error(`Run Context exceeds ${RUN_CONTEXT_PACK_MAX_REFS} authorized refs.`);
  }
  const view = contextView(run);
  const writableProjectIds = writableProjects(store, run, view);
  const summaries = pointers.map((ref) => Object.freeze({
    refId: ref.refId,
    store: ref.store,
    summary: ref.summary ?? `${ref.store} ${ref.refId}`,
    digest: ref.digest
  }));
  const body = {
    schemaVersion: RUN_CONTEXT_PACK_SCHEMA_VERSION,
    identity: Object.freeze({
      taskId,
      runId,
      roleName: run.roleName,
      purpose: run.purpose,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      workspace: run.effective.workspace.root
    }),
    ...(snapshotRef === undefined ? {} : { snapshot: snapshotRef }),
    assignment: run.assignment,
    authority: Object.freeze({ view, readableRefs: pointers, writableProjectIds }),
    pointers,
    summaries,
    deltas: pointers.filter((ref) => run.assignment.deltaRefIds.includes(ref.refId)),
    completion: Object.freeze({
      allowedActions: completionActions(view),
      exactRunRef: `${taskId}/${runId}`
    })
  };
  const digest = contextContentDigest(body);
  const preliminaryBytes = Buffer.byteLength(JSON.stringify({ ...body, digest }), "utf8");
  if (preliminaryBytes > RUN_CONTEXT_PACK_MAX_BYTES) {
    throw new Error(`Run Context Pack exceeds ${RUN_CONTEXT_PACK_MAX_BYTES} bytes.`);
  }
  const pack = Object.freeze({
    ...body,
    budget: Object.freeze({
      maxRefs: RUN_CONTEXT_PACK_MAX_REFS,
      returnedRefs: pointers.length,
      maxBytes: RUN_CONTEXT_PACK_MAX_BYTES,
      returnedBytes: preliminaryBytes,
      truncated: false as const
    }),
    digest
  });
  return pack;
}

export function expandRunContextRef(
  store: TaskStore,
  taskId: string,
  runId: string,
  refId: string,
  refStore?: string
): Readonly<{ ref: ContextRef; value: unknown; digest: string }> {
  const pack = buildRunContextPack(store, taskId, runId);
  const authorized = pack.pointers.filter((ref) => (
    ref.refId === refId && (refStore === undefined || ref.store === refStore)
  ));
  const selector = refStore === undefined ? refId : `${refStore}/${refId}`;
  if (authorized.length !== 1) {
    throw new Error(`Run Context ref is not uniquely authorized: ${selector}.`);
  }
  const run = requireExactRun(store, taskId, runId);
  const snapshotRef = run.assignment.contextSnapshotRef;
  const materialized = snapshotRef === undefined
    ? collectAuthorizedContext(store, run).find(({ ref }) => (
        contextRefIdentity(ref) === contextRefIdentity(authorized[0]!)
      ))
    : store.getContextSnapshot(taskId, snapshotRef.id)?.resources.find(({ ref }) => (
        contextRefIdentity(ref) === contextRefIdentity(authorized[0]!)
      ));
  if (materialized === undefined || materialized.ref.digest !== authorized[0]!.digest) {
    throw new Error(`Run Context ref is unavailable or drifted: ${selector}.`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(materialized.value), "utf8");
  if (bytes > RUN_CONTEXT_EXPAND_MAX_BYTES) {
    throw new Error(`Run Context expansion exceeds ${RUN_CONTEXT_EXPAND_MAX_BYTES} bytes.`);
  }
  return Object.freeze({
    ref: materialized.ref,
    value: materialized.value,
    digest: contextContentDigest({ ref: materialized.ref, value: materialized.value })
  });
}

/** Fail-closed delta cursor resolution for one immutable Run lineage. */
export function buildRunContextDelta(
  store: TaskStore,
  taskId: string,
  runId: string,
  after: string
): Readonly<{ schemaVersion: 1; after: string; cursor: string; refs: readonly ContextRef[] }> {
  const pack = buildRunContextPack(store, taskId, runId);
  if (after === pack.digest || after === pack.snapshot?.digest) {
    return Object.freeze({ schemaVersion: 1, after, cursor: pack.digest, refs: [] });
  }
  const run = requireExactRun(store, taskId, runId);
  const snapshotRef = run.assignment.contextSnapshotRef;
  const snapshot = snapshotRef === undefined
    ? null
    : store.getContextSnapshot(taskId, snapshotRef.id);
  const parentDigest = snapshot?.parentRef?.digest;
  if (!((parentDigest !== undefined && after === parentDigest)
    || (parentDigest === undefined && after === "none"))) {
    throw new Error("Run Context delta cursor is outside the frozen Snapshot lineage.");
  }
  return Object.freeze({
    schemaVersion: 1,
    after,
    cursor: pack.digest,
    refs: pack.deltas
  });
}

function requireExactRun(store: TaskStore, taskId: string, runId: string): AgentRun {
  const run = store.getAgentRun(taskId, runId);
  if (run === null || run.taskId !== taskId || run.id !== runId) {
    throw new Error(`Agent Run not found: ${taskId}/${runId}.`);
  }
  return run;
}

function collectAuthorizedContext(
  store: TaskStore,
  run: Readonly<Pick<
    AgentRun,
    "taskId" | "roleName" | "purpose" | "workItemId" | "reviewRoundId" | "workspace"
  >>
): MaterializedRef[] {
  const task = store.getTask(run.taskId);
  if (task === null) throw new Error(`Task not found: ${run.taskId}.`);
  const view = contextView(run);
  const result: MaterializedRef[] = [materialize("L2", "task", task.id, task)];
  const brief = store.getTaskBrief(task.id);
  if (brief !== null && view === "leader") {
    result.push(materialize("L2", "task-brief", task.id, brief));
  }
  const role = store.getRole(task.id, run.roleName);
  if (role === null) throw new Error(`Run Role not found: ${task.id}/${run.roleName}.`);
  result.push(materialize("L1", "role-profile", role.name, {
    name: role.name,
    defaultAccess: role.defaultAccess,
    description: role.description,
    responsibilities: role.responsibilities ?? [],
    constraints: role.constraints ?? [],
    expectedOutput: role.expectedOutput,
    skills: role.skills ?? [],
    launchRevision: role.launchRevision
  }));
  if ("workspace" in run && run.workspace !== undefined) {
    result.push(materialize("L3", "managed-workspace", `${run.taskId}/${run.roleName}`, run.workspace));
  }
  if (run.workItemId !== undefined) {
    const item = store.getWorkItem(task.id, run.workItemId);
    if (item === null) throw new Error(`Run WorkItem not found: ${run.workItemId}.`);
    result.push(materialize("L3", "work-item", item.id, item));
    if (view === "worker") {
      for (const dependencyId of item.dependsOn) {
        const dependency = store.getWorkItem(task.id, dependencyId);
        if (dependency === null || dependency.status !== "completed") {
          throw new Error(`Run WorkItem dependency is not accepted: ${dependencyId}.`);
        }
        result.push(materialize("L3", "accepted-work-item", dependency.id, dependency));
      }
    }
  }
  if (run.reviewRoundId !== undefined) {
    const round = store.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) throw new Error(`Run ReviewRound not found: ${run.reviewRoundId}.`);
    result.push(materialize("L3", "review-round", round.id, round));
    for (const finding of store.listReviewFindings(task.id).filter((candidate) => (
      candidate.firstReviewRoundId === round.id
      || candidate.lastReviewRoundId === round.id
      || candidate.repair?.workItemId === round.workItemId
    ))) {
      result.push(materialize("L3", "review-finding", finding.id, finding));
    }
  }
  for (const binding of task.projectBindings) {
    const project = store.getProject(binding.projectId);
    if (project === null) throw new Error(`Run Project not found: ${binding.projectId}.`);
    const { knowledge, ...projectPolicy } = project;
    result.push(materialize("L1", "project-policy", project.id, projectPolicy));
    for (const entry of knowledge.filter(({ status }) => status === "active")) {
      result.push(materialize(
        "L1",
        "project-knowledge",
        `${project.id}:${entry.id}`,
        { projectId: project.id, ...entry }
      ));
    }
  }
  if (view === "leader") {
    for (const item of store.listWorkItems(task.id)) {
      result.push(materialize("L3", "work-item", item.id, item));
    }
    for (const decision of store.listDecisions(task.id)) {
      result.push(materialize("L2", "task-decision", decision.id, decision));
    }
    for (const milestone of store.listMilestones(task.id).slice(-16)) {
      result.push(materialize("L2", "task-milestone", milestone.id, milestone));
    }
    for (const round of store.listReviewRounds(task.id).slice(-16)) {
      result.push(materialize("L3", "review-round", round.id, round));
    }
    for (const finding of store.listReviewFindings(task.id)) {
      result.push(materialize("L3", "review-finding", finding.id, finding));
    }
    for (const agentRun of store.listAgentRuns(task.id).slice(-24)) {
      result.push(materialize("L4", "agent-run", agentRun.id, agentRun));
    }
    for (const message of store.listMessages(task.id).slice(-16)) {
      result.push(materialize("L4", "task-message", message.id, message));
    }
    const publishedTreeAuthorizations = [];
    const events = store.listEvents(task.id);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.type === "task.completed" || event.type === "task.reopened") break;
      if (event.type === TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT) {
        publishedTreeAuthorizations.push(event);
      }
    }
    for (const event of publishedTreeAuthorizations.reverse().slice(-16)) {
      result.push(materialize("L4", "task-event", event.id, event));
    }
    for (const request of store.listOpenInputRequests([task.id])) {
      result.push(materialize("L4", "input-request", request.id, request));
    }
  }
  const unique = new Map(result.map((entry) => [contextRefIdentity(entry.ref), entry]));
  return [...unique.values()].sort((left, right) => (
    contextRefIdentity(left.ref).localeCompare(contextRefIdentity(right.ref))
  ));
}

function materialize(layer: ContextRef["layer"], store: string, refId: string, value: unknown): MaterializedRef {
  const digest = contextContentDigest(value);
  const record = value as Record<string, unknown>;
  const revision = String(record.revision ?? record.updatedAt ?? record.createdAt ?? digest);
  const title = typeof record.title === "string"
    ? record.title
    : typeof record.summary === "string"
      ? record.summary
      : `${store} ${refId}`;
  return Object.freeze({
    ref: Object.freeze({
      layer,
      store,
      refId,
      revision,
      digest,
      summary: title.slice(0, 400)
    }),
    value
  });
}

function contextRefIdentity(ref: ContextRef): string {
  return `${ref.store}\0${ref.refId}\0${ref.revision}`;
}

function contextView(run: Readonly<Pick<AgentRun, "roleName" | "purpose">>): RunContextView {
  if (run.purpose === "review") return "reviewer";
  if (run.roleName === "leader") return "leader";
  if (run.roleName === "operator") return "operator";
  return "worker";
}

function writableProjects(store: TaskStore, run: AgentRun, view: RunContextView): readonly string[] {
  if (view === "leader") return Object.freeze(store.getTask(run.taskId)?.projectBindings.map(({ projectId }) => projectId) ?? []);
  if (view === "reviewer") {
    return Object.freeze(run.workspace?.entries.filter(({ access }) => access === "write").map(({ projectId }) => projectId) ?? []);
  }
  if (run.workItemId === undefined) return Object.freeze([]);
  return Object.freeze(store.getWorkItem(run.taskId, run.workItemId)?.writeProjectIds ?? []);
}

function completionActions(view: RunContextView): readonly string[] {
  if (view === "leader") return Object.freeze(["yield", "complete-task", "request-input"]);
  if (view === "reviewer") return Object.freeze(["checkpoint", "yield-review"]);
  if (view === "operator") return Object.freeze(["answer-input", "recover"]);
  return Object.freeze(["checkpoint", "yield"]);
}
