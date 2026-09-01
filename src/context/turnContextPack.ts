import type { Turn } from "../turn/turn.js";
import type { TaskStore } from "../storage/taskStore.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";
import { TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT } from "../task/publicationReference.js";
import { TURN_INPUT_MAX_DELTAS } from "./turnInputContract.js";
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

export const TURN_CONTEXT_PACK_SCHEMA_VERSION = 1 as const;
export const TURN_CONTEXT_PACK_MAX_REFS = 256;
export const TURN_CONTEXT_PACK_MAX_BYTES = 8 * 1024 * 1024;
export const TURN_CONTEXT_EXPAND_MAX_BYTES = 4 * 1024 * 1024;

export type TurnContextView = "operator" | "leader" | "worker" | "reviewer" | "global";
export type TurnContextSummary = Readonly<{
  refId: string;
  store: string;
  summary: string;
  digest: string;
}>;
export type TurnContextBudgetResult = Readonly<{
  maxRefs: number;
  returnedRefs: number;
  maxBytes: number;
  returnedBytes: number;
  truncated: false;
}>;
export type TurnContextPack = Readonly<{
  schemaVersion: typeof TURN_CONTEXT_PACK_SCHEMA_VERSION;
  identity: Readonly<{
    taskId: string;
    turnId: string;
    roleName: string;
    purpose: Turn["purpose"];
    agentId: string;
    adapterId: string;
    workspace: string;
  }>;
  snapshot?: ContextSnapshotRef;
  input: Turn["inputs"][number]["input"];
  authority: Readonly<{
    view: TurnContextView;
    readableRefs: readonly ContextRef[];
    writableProjectIds: readonly string[];
  }>;
  pointers: readonly ContextRef[];
  summaries: readonly TurnContextSummary[];
  deltas: readonly ContextRef[];
  completion: Readonly<{
    allowedActions: readonly string[];
    exactTurnRef: string;
  }>;
  budget: TurnContextBudgetResult;
  digest: string;
}>;

type MaterializedRef = Readonly<{ ref: ContextRef; value: unknown }>;

export function freezeTurnContextSnapshot(
  store: TaskStore,
  run: Readonly<Pick<
    Turn,
    "taskId" | "roleName" | "purpose" | "workItemId" | "reviewRoundId" | "workspace"
  >>,
  now: Date,
  frozenBy: "leader" | "controller" = "controller",
  baselineRef?: ContextSnapshotRef
): ContextSnapshot {
  if (baselineRef !== undefined) {
    const baseline = store.getContextSnapshot(run.taskId, baselineRef.id);
    if (baseline === null
      || baseline.taskId !== run.taskId
      || baselineRef.taskId !== run.taskId
      || baseline.digest !== baselineRef.digest
      || baseline.sequence !== baselineRef.sequence
      || baseline.scope !== "stage"
      || baselineRef.scope !== baseline.scope
      || baseline.scopeRef !== baselineRef.scopeRef) {
      throw new Error(`Turn Context baseline is missing or drifted: ${baselineRef.id}.`);
    }
    validateContextSnapshot(baseline);
    const overlays = collectTurnContextOverlays(store, run);
    const resources = [...new Map([...baseline.resources, ...overlays].map((entry) => [
      contextRefIdentity(entry.ref),
      entry
    ])).values()].sort((left, right) => (
      contextRefIdentity(left.ref).localeCompare(contextRefIdentity(right.ref))
    ));
    const previous = store.listContextSnapshots(run.taskId)
      .filter((candidate) => candidate.scope === baseline.scope
        && candidate.scopeRef === baseline.scopeRef)
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    const snapshot = createContextSnapshot({
      id: store.nextContextSnapshotId(run.taskId),
      taskId: run.taskId,
      scope: baseline.scope,
      scopeRef: baseline.scopeRef,
      sequence: (previous?.sequence ?? baseline.sequence) + 1,
      refs: resources.map(({ ref }) => ref),
      resources,
      ...(baseline.repoCommit === undefined ? {} : { repoCommit: baseline.repoCommit }),
      acceptRefs: baseline.acceptRefs,
      parentRef: contextSnapshotRef(baseline),
      frozenAt: now,
      frozenBy
    });
    store.saveContextSnapshot(snapshot);
    return snapshot;
  }
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

/**
 * Freeze the shared, role-neutral ContextSnapshot anchored by one WorkItem
 * exploration stage Group. Turn snapshots remain role-specific; this
 * record is the durable stage baseline and derives from a fresh WorkItem
 * snapshot so the Group never depends on ambient latest state.
 */
export function freezeExecutionStageContextSnapshot(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    workItemId: string;
    executionGroupId: string;
  }>,
  now: Date
): ContextSnapshot {
  const task = store.getTask(input.taskId);
  if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
  const workItem = store.getWorkItem(input.taskId, input.workItemId);
  if (workItem === null) throw new Error(`WorkItem not found: ${input.workItemId}.`);
  const materialized: MaterializedRef[] = [
    materialize("L2", "task", task.id, task),
    materialize("L3", "work-item", workItem.id, workItem)
  ];
  for (const dependencyId of workItem.dependsOn) {
    const dependency = store.getWorkItem(task.id, dependencyId);
    if (dependency === null || dependency.status !== "completed") {
      throw new Error(`Exploration stage dependency is not accepted: ${dependencyId}.`);
    }
    materialized.push(materialize("L3", "accepted-work-item", dependency.id, dependency));
  }
  for (const binding of task.projectBindings) {
    const project = store.getProject(binding.projectId);
    if (project === null) throw new Error(`Turn Project not found: ${binding.projectId}.`);
    const { knowledge, ...projectPolicy } = project;
    materialized.push(materialize("L1", "project-policy", project.id, projectPolicy));
    for (const entry of knowledge.filter(({ status }) => status === "active")) {
      materialized.push(materialize(
        "L1",
        "project-knowledge",
        `${project.id}:${entry.id}`,
        { projectId: project.id, ...entry }
      ));
    }
  }
  const resources = [...new Map(materialized.map((entry) => [
    contextRefIdentity(entry.ref),
    entry
  ])).values()].sort((left, right) => (
    contextRefIdentity(left.ref).localeCompare(contextRefIdentity(right.ref))
  ));
  const previousWorkItem = store.listContextSnapshots(task.id)
    .filter((candidate) => candidate.scope === "workitem"
      && candidate.scopeRef === workItem.id)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  const workItemSnapshot = createContextSnapshot({
    id: store.nextContextSnapshotId(task.id),
    taskId: task.id,
    scope: "workitem",
    scopeRef: workItem.id,
    sequence: (previousWorkItem?.sequence ?? 0) + 1,
    refs: resources.map(({ ref }) => ref),
    resources,
    acceptRefs: [`work-item:${workItem.id}:acceptance`],
    ...(previousWorkItem === undefined
      ? {}
      : { parentRef: contextSnapshotRef(previousWorkItem) }),
    frozenAt: now,
    frozenBy: "controller"
  });
  store.saveContextSnapshot(workItemSnapshot);
  const stageSnapshot = createContextSnapshot({
    id: store.nextContextSnapshotId(task.id),
    taskId: task.id,
    scope: "stage",
    scopeRef: input.executionGroupId,
    sequence: workItemSnapshot.sequence + 1,
    refs: resources.map(({ ref }) => ref),
    resources,
    acceptRefs: [`work-item:${workItem.id}:acceptance`],
    parentRef: contextSnapshotRef(workItemSnapshot),
    frozenAt: now,
    frozenBy: "controller"
  });
  store.saveContextSnapshot(stageSnapshot);
  return stageSnapshot;
}

/**
 * Freeze the role-neutral baseline for one Reviewer ExecutionGroup before
 * admission. Delayed or retried sibling Lanes reuse the same immutable
 * ReviewRound/Task/Project values and add only their Role overlay.
 */
export function freezeReviewStageContextSnapshot(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    reviewRoundId: string;
    executionGroupId: string;
  }>,
  now: Date
): ContextSnapshot {
  const existing = store.listContextSnapshots(input.taskId)
    .filter((candidate) => candidate.scope === "stage"
      && candidate.scopeRef === input.executionGroupId
      && candidate.parentRef === undefined)
    .sort((left, right) => left.sequence - right.sequence)
    .at(0);
  if (existing !== undefined) return validateContextSnapshot(existing);

  const round = store.getReviewRound(input.taskId, input.reviewRoundId);
  if (round === null) throw new Error(`ReviewRound not found: ${input.reviewRoundId}.`);
  const materialized = collectAuthorizedContext(store, {
    taskId: input.taskId,
    roleName: round.reviewerRoleName,
    purpose: "review",
    ...(round.workItemId === undefined ? {} : { workItemId: round.workItemId }),
    reviewRoundId: round.id
  }).filter(({ ref }) => (
    ref.store !== "role-profile" && ref.store !== "managed-workspace"
  ));
  if (!materialized.some(({ ref }) => (
    ref.store === "review-round" && ref.refId === round.id
  ))) {
    throw new Error(`ReviewRound Context baseline is unavailable: ${round.id}.`);
  }
  const resources = [...new Map(materialized.map((entry) => [
    contextRefIdentity(entry.ref),
    entry
  ])).values()].sort((left, right) => (
    contextRefIdentity(left.ref).localeCompare(contextRefIdentity(right.ref))
  ));
  const snapshot = createContextSnapshot({
    id: store.nextContextSnapshotId(input.taskId),
    taskId: input.taskId,
    scope: "stage",
    scopeRef: input.executionGroupId,
    sequence: 1,
    refs: resources.map(({ ref }) => ref),
    resources,
    acceptRefs: round.workItemId === undefined ? [] : [`work-item:${round.workItemId}:acceptance`],
    frozenAt: now,
    frozenBy: "controller"
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
  return Object.freeze([...new Set(changed)].sort().slice(0, TURN_INPUT_MAX_DELTAS));
}

export function buildTurnContextPack(store: TaskStore, taskId: string, turnId: string): TurnContextPack {
  const run = requireExactTurn(store, taskId, turnId);
  const current = collectAuthorizedContext(store, run);
  let pointers: readonly ContextRef[] = current.map(({ ref }) => ref);
  let snapshotRef: ContextSnapshotRef | undefined;
  if (run.inputs[0]!.input.contextSnapshotRef !== undefined) {
    const expected = run.inputs[0]!.input.contextSnapshotRef;
    const snapshot = store.getContextSnapshot(taskId, expected.id);
    if (snapshot === null) throw new Error(`Turn Context Snapshot is missing: ${expected.id}.`);
    validateContextSnapshot(snapshot);
    if (snapshot.digest !== expected.digest || snapshot.taskId !== taskId) {
      throw new Error(`Turn Context Snapshot identity drifted: ${expected.id}.`);
    }
    pointers = snapshot.refs;
    snapshotRef = contextSnapshotRef(snapshot);
  }
  if (pointers.length > TURN_CONTEXT_PACK_MAX_REFS) {
    throw new Error(`Turn Context exceeds ${TURN_CONTEXT_PACK_MAX_REFS} authorized refs.`);
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
    schemaVersion: TURN_CONTEXT_PACK_SCHEMA_VERSION,
    identity: Object.freeze({
      taskId,
      turnId: turnId,
      roleName: run.roleName,
      purpose: run.purpose,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      workspace: run.effective.workspace.root
    }),
    ...(snapshotRef === undefined ? {} : { snapshot: snapshotRef }),
    input: run.inputs[0]!.input,
    authority: Object.freeze({ view, readableRefs: pointers, writableProjectIds }),
    pointers,
    summaries,
    deltas: pointers.filter((ref) => run.inputs[0]!.input.deltaRefIds.includes(ref.refId)),
    completion: Object.freeze({
      allowedActions: completionActions(view),
      exactTurnRef: `${taskId}/${turnId}`
    })
  };
  const digest = contextContentDigest(body);
  const preliminaryBytes = Buffer.byteLength(JSON.stringify({ ...body, digest }), "utf8");
  if (preliminaryBytes > TURN_CONTEXT_PACK_MAX_BYTES) {
    throw new Error(`Turn Context Pack exceeds ${TURN_CONTEXT_PACK_MAX_BYTES} bytes.`);
  }
  const pack = Object.freeze({
    ...body,
    budget: Object.freeze({
      maxRefs: TURN_CONTEXT_PACK_MAX_REFS,
      returnedRefs: pointers.length,
      maxBytes: TURN_CONTEXT_PACK_MAX_BYTES,
      returnedBytes: preliminaryBytes,
      truncated: false as const
    }),
    digest
  });
  return pack;
}

export function expandTurnContextRef(
  store: TaskStore,
  taskId: string,
  turnId: string,
  refId: string,
  refStore?: string
): Readonly<{ ref: ContextRef; value: unknown; digest: string }> {
  const pack = buildTurnContextPack(store, taskId, turnId);
  const authorized = pack.pointers.filter((ref) => (
    ref.refId === refId && (refStore === undefined || ref.store === refStore)
  ));
  const selector = refStore === undefined ? refId : `${refStore}/${refId}`;
  if (authorized.length !== 1) {
    throw new Error(`Turn Context ref is not uniquely authorized: ${selector}.`);
  }
  const run = requireExactTurn(store, taskId, turnId);
  const snapshotRef = run.inputs[0]!.input.contextSnapshotRef;
  const materialized = snapshotRef === undefined
    ? collectAuthorizedContext(store, run).find(({ ref }) => (
        contextRefIdentity(ref) === contextRefIdentity(authorized[0]!)
      ))
    : store.getContextSnapshot(taskId, snapshotRef.id)?.resources.find(({ ref }) => (
        contextRefIdentity(ref) === contextRefIdentity(authorized[0]!)
      ));
  if (materialized === undefined || materialized.ref.digest !== authorized[0]!.digest) {
    throw new Error(`Turn Context ref is unavailable or drifted: ${selector}.`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(materialized.value), "utf8");
  if (bytes > TURN_CONTEXT_EXPAND_MAX_BYTES) {
    throw new Error(`Turn Context expansion exceeds ${TURN_CONTEXT_EXPAND_MAX_BYTES} bytes.`);
  }
  return Object.freeze({
    ref: materialized.ref,
    value: materialized.value,
    digest: contextContentDigest({ ref: materialized.ref, value: materialized.value })
  });
}

/** Fail-closed delta cursor resolution for one immutable Turn lineage. */
export function buildTurnContextDelta(
  store: TaskStore,
  taskId: string,
  turnId: string,
  after: string
): Readonly<{ schemaVersion: 1; after: string; cursor: string; refs: readonly ContextRef[] }> {
  const pack = buildTurnContextPack(store, taskId, turnId);
  if (after === pack.digest || after === pack.snapshot?.digest) {
    return Object.freeze({ schemaVersion: 1, after, cursor: pack.digest, refs: [] });
  }
  const run = requireExactTurn(store, taskId, turnId);
  const snapshotRef = run.inputs[0]!.input.contextSnapshotRef;
  const snapshot = snapshotRef === undefined
    ? null
    : store.getContextSnapshot(taskId, snapshotRef.id);
  const parentDigest = snapshot?.parentRef?.digest;
  if (!((parentDigest !== undefined && after === parentDigest)
    || (parentDigest === undefined && after === "none"))) {
    throw new Error("Turn Context delta cursor is outside the frozen Snapshot lineage.");
  }
  return Object.freeze({
    schemaVersion: 1,
    after,
    cursor: pack.digest,
    refs: pack.deltas
  });
}

function requireExactTurn(store: TaskStore, taskId: string, turnId: string): Turn {
  const run = store.getTurn(taskId, turnId);
  if (run === null || run.taskId !== taskId || run.id !== turnId) {
    throw new Error(`Turn not found: ${taskId}/${turnId}.`);
  }
  return run;
}

function collectAuthorizedContext(
  store: TaskStore,
  run: Readonly<Pick<
    Turn,
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
  result.push(...collectTurnContextOverlays(store, run));
  if (run.workItemId !== undefined) {
    const item = store.getWorkItem(task.id, run.workItemId);
    if (item === null) throw new Error(`Turn WorkItem not found: ${run.workItemId}.`);
    result.push(materialize("L3", "work-item", item.id, item));
    if (view === "worker") {
      for (const dependencyId of item.dependsOn) {
        const dependency = store.getWorkItem(task.id, dependencyId);
        if (dependency === null
          || (dependency.status !== "completed" && dependency.status !== "retired")) {
          throw new Error(`Turn WorkItem dependency is not accepted: ${dependencyId}.`);
        }
        if (dependency.status === "retired") continue;
        result.push(materialize("L3", "accepted-work-item", dependency.id, dependency));
      }
    }
  }
  if (run.reviewRoundId !== undefined) {
    const round = store.getReviewRound(task.id, run.reviewRoundId);
    if (round === null) throw new Error(`Turn ReviewRound not found: ${run.reviewRoundId}.`);
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
    if (project === null) throw new Error(`Turn Project not found: ${binding.projectId}.`);
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
    const events = store.listEvents(task.id);
    for (const item of store.listWorkItems(task.id).filter(({ status }) => status !== "retired")) {
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
    for (const turn of operationalTaskRecords(
      store.listTurns(task.id),
      events,
      "turn"
    ).slice(-24)) {
      result.push(materialize("L4", "turn", turn.id, turn));
    }
    for (const message of operationalTaskRecords(
      store.listMessages(task.id),
      events,
      "message"
    ).slice(-16)) {
      result.push(materialize("L4", "task-message", message.id, message));
    }
    const publishedTreeAuthorizations = [];
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

/** Lane-specific context that may be layered over an immutable stage base. */
function collectTurnContextOverlays(
  store: TaskStore,
  run: Readonly<Pick<
    Turn,
    "taskId" | "roleName" | "purpose" | "workItemId" | "reviewRoundId" | "workspace"
  >>
): MaterializedRef[] {
  const role = store.getRole(run.taskId, run.roleName);
  if (role === null) throw new Error(`Turn Role not found: ${run.taskId}/${run.roleName}.`);
  return [
    materialize("L1", "role-profile", role.name, {
      name: role.name,
      defaultAccess: role.defaultAccess,
      description: role.description,
      responsibilities: role.responsibilities ?? [],
      constraints: role.constraints ?? [],
      expectedOutput: role.expectedOutput,
      skills: role.skills ?? [],
      launchRevision: role.launchRevision
    }),
    ...("workspace" in run && run.workspace !== undefined
      ? [materialize(
          "L3",
          "managed-workspace",
          `${run.taskId}/${run.roleName}`,
          run.workspace
        )]
      : [])
  ];
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

function contextView(run: Readonly<Pick<Turn, "roleName" | "purpose">>): TurnContextView {
  if (run.purpose === "review") return "reviewer";
  if (run.roleName === "leader") return "leader";
  if (run.roleName === "operator") return "operator";
  return "worker";
}

function writableProjects(store: TaskStore, run: Turn, view: TurnContextView): readonly string[] {
  if (view === "leader") return Object.freeze(store.getTask(run.taskId)?.projectBindings.map(({ projectId }) => projectId) ?? []);
  if (view === "reviewer") {
    return Object.freeze(run.workspace?.entries.filter(({ access }) => access === "write").map(({ projectId }) => projectId) ?? []);
  }
  if (run.workItemId === undefined) return Object.freeze([]);
  return Object.freeze(store.getWorkItem(run.taskId, run.workItemId)?.writeProjectIds ?? []);
}

function completionActions(view: TurnContextView): readonly string[] {
  if (view === "leader") return Object.freeze(["finish-turn", "complete-task", "request-input"]);
  if (view === "reviewer") return Object.freeze(["checkpoint", "finish-turn"]);
  if (view === "operator") return Object.freeze(["answer-input", "recover"]);
  return Object.freeze(["checkpoint", "finish-turn"]);
}
