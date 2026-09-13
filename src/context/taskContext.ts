import { usageError, taskNotFound } from "../errors/cliError.js";
import { resolveManagedTaskReader } from "../runtime/managedCaller.js";
import type { TaskStore } from "../storage/taskStore.js";
import { contextContentDigest } from "./contextSnapshot.js";
import { buildRunContextPack } from "./runContextPack.js";
import { sourceRunContextValue } from "./sourceRunContext.js";
import { expandTaskMessageResult, type TaskMessage } from "../message/message.js";
import { managedWorkspaceKey } from "../worktree/managedWorkspace.js";
import { runExecutionObservation, type AgentRun } from "../agentRun/agentRun.js";
import { isGitArtifactRefString, parseGitArtifactRef } from "../artifacts/gitArtifactRef.js";
import { projectTaskRemoteDeliveryFromStore } from "../commands/taskRemoteDeliveryCommand.js";
import { providerRetryProjection } from "../runtime/providerRetry.js";

const MAX_RECORDS = 256;
const MAX_VALUE_BYTES = 4096;
const MAX_PAGE_BYTES = 128 * 1024;
const MAX_INSPECT_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 100;
const MAX_ATTENTION_REFS = 8;
type Ref = Readonly<{ store: string; refId: string; revision: string; digest: string }>;
type Entry = Readonly<{ ref: Ref; value: unknown }>;
type Cursor = Readonly<{ taskId: string; sequence: number; revision: number }>;
type PageCursor = Cursor & Readonly<{ after: number }>;
export type ContextObservation = Readonly<{
  source: string;
  observedAt: string;
  coverage: "known" | "partial" | "unknown";
  status: "available" | "unavailable";
  value?: unknown;
}>;
export type ContextObservationProvider = Readonly<{
  source: string;
  read: (core: Readonly<ReturnType<typeof readTaskContext>>, signal: AbortSignal) =>
    Promise<Readonly<{ coverage: ContextObservation["coverage"]; value: unknown }>>;
}>;

/** A current read model, not a second snapshot store or a delivery receipt.
 * Every public path checks the same scope before reading, counting or paging.
 */
export function readTaskContext(
  store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv = {}
) {
  return store.transaction((reader) => {
    const entries = authorizedEntries(reader, taskId, environment);
    const cursor = currentCursor(reader, taskId);
    // Reserve a small, classified view before ordinary history consumes the
    // page. Counts and samples come from the exact same authorized read.
    const attention = summarizeAttention(entries);
    let bytes = Buffer.byteLength(JSON.stringify(attention));
    const records: Array<{ ref: Ref; summary?: string; value?: unknown; omitted: boolean;
      execution?: ReturnType<typeof runExecutionObservation> }> = [];
    const runtimeEvents = entries.some((entry) => entry.ref.store === "run") ? reader.listEvents(taskId) : [];
    for (const entry of entries) {
      const valueBytes = Buffer.byteLength(JSON.stringify(entry.value));
      const content = valueBytes > MAX_VALUE_BYTES
        ? { ref: entry.ref, summary: summarize(entry.value), omitted: true }
        : { ...entry, omitted: false };
      const record = { ...content, ...(entry.ref.store === "run" ? {
        execution: runExecutionObservation(entry.value as AgentRun,
          reader.getTaskRoleSessionSet(taskId, (entry.value as AgentRun).roleName)?.providerBinding, runtimeEvents)
      } : {}), ...(entry.ref.store === "role" ? {
        providerRetry: providerRetryProjection(reader.getTaskRoleSessionSet(taskId,
          (entry.value as { name: string }).name)?.providerBinding)
      } : {}) };
      const size = Buffer.byteLength(JSON.stringify(record));
      if (records.length >= MAX_RECORDS || bytes + size > MAX_PAGE_BYTES) break;
      records.push(record);
      bytes += size;
    }
    return {
      taskId, coreCursor: encode(cursor), throughCursor: encode(cursor),
      attention,
      records, count: entries.length,
      omitted: { records: entries.length - records.length, values: records.filter((r) => r.omitted).length },
      observations: [] as ContextObservation[],
      limits: { records: MAX_RECORDS, valueBytes: MAX_VALUE_BYTES, pageBytes: MAX_PAGE_BYTES,
        attentionRefsPerCategory: MAX_ATTENTION_REFS, attentionRefBytesPerCategory: MAX_VALUE_BYTES }
    };
  });
}

function summarizeAttention(entries: readonly Entry[]) {
  const group = () => ({ count: 0, refs: [] as Ref[], omittedRefs: 0 });
  const attention = {
    openInputs: group(), pendingOperations: group(), unknownOperations: group()
  };
  const bytes = { openInputs: 0, pendingOperations: 0, unknownOperations: 0 };
  for (const entry of entries) {
    const status = (entry.value as { status?: string }).status;
    const category = entry.ref.store === "input-request" && status === "open" ? "openInputs"
      : entry.ref.store === "job" && status === "unknown-needs-attention" ? "unknownOperations"
      : entry.ref.store === "job" && (status === "queued" || status === "running") ? "pendingOperations"
      : undefined;
    if (category === undefined) continue;
    const summary = attention[category];
    summary.count++;
    const size = Buffer.byteLength(JSON.stringify(entry.ref)) + 1;
    if (summary.refs.length < MAX_ATTENTION_REFS && bytes[category] + size <= MAX_VALUE_BYTES) {
      summary.refs.push(entry.ref);
      bytes[category] += size;
    } else {
      summary.omittedRefs++;
    }
  }
  return attention;
}

/** Delta is immutable Task event history, not latest mutable record contents
 * mislabeled as an old snapshot. Inspect/read explicitly obtains current facts.
 * A continuation carries the first page's fixed upper event bound.
 */
export function readTaskContextDelta(
  store: TaskStore, taskId: string,
  input: Readonly<{ after: string; continuation?: string; limit?: number }>,
  environment: NodeJS.ProcessEnv = {}
) {
  return store.transaction((reader) => {
    const { allow } = authorizeContext(reader, taskId, environment);
    const history = reader.listEvents(taskId);
    const start = decode(input.after, taskId);
    const now = currentCursor(reader, taskId, history);
    const continuation = input.continuation === undefined ? undefined : decodePage(input.continuation, taskId);
    const bound = continuation ?? now;
    const after = continuation?.after ?? start.sequence;
    if (start.sequence > bound.sequence || after < start.sequence || after > bound.sequence
      || bound.sequence > now.sequence || start.revision > now.revision || bound.revision > now.revision) {
      throw usageError("Context cursor is outside the current Task history.");
    }
    const limit = input.limit ?? MAX_EVENTS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS) {
      throw usageError(`Context delta limit must be between 1 and ${MAX_EVENTS}.`);
    }
    const events = history
      .filter((event) => isAllowed(allow, "task-event", event.id)
        && sequence(event.id) > after && sequence(event.id) <= bound.sequence)
      .sort((a, b) => sequence(a.id) - sequence(b.id));
    const page: Array<{ ref: Ref; value?: unknown; omitted: boolean }> = [];
    let bytes = 0;
    for (const event of events) {
      const entry = materialize("task-event", event.id, event);
      const record = Buffer.byteLength(JSON.stringify(event)) > MAX_VALUE_BYTES
        ? { ref: entry.ref, omitted: true }
        : { ...entry, omitted: false };
      const size = Buffer.byteLength(JSON.stringify(record));
      if (page.length >= limit || bytes + size > MAX_PAGE_BYTES) break;
      page.push(record);
      bytes += size;
    }
    const last = page.at(-1)?.ref.refId;
    const more = events.length > page.length;
    const through = { taskId, sequence: bound.sequence, revision: bound.revision };
    return {
      taskId, events: page, count: events.length, throughCursor: encode(through),
      ...(more && last !== undefined
        ? { continuation: encode({ ...through, after: sequence(last) }) } : {}),
      observations: [] as ContextObservation[]
    };
  });
}

export function inspectTaskContext(
  store: TaskStore, taskId: string, selector: Readonly<{ store: string; refId: string; digest?: string }>,
  environment: NodeJS.ProcessEnv = {}
) {
  return store.transaction((reader) => {
    const scope = authorizeContext(reader, taskId, environment);
    const value = isAllowed(scope.allow, selector.store, selector.refId)
      ? inspectValue(reader, scope, selector) : null;
    if (value === null) throw usageError("Context reference is unavailable in the caller's current scope.");
    const entry = materialize(selector.store, selector.refId, value);
    if (selector.digest !== undefined && entry.ref.digest !== selector.digest) {
      throw usageError("Context reference changed; read its current reference before inspecting again.", undefined, {
        currentRef: entry.ref
      });
    }
    if (Buffer.byteLength(JSON.stringify(entry.value)) > MAX_INSPECT_BYTES) {
      throw usageError("Context value exceeds the bounded inspect limit.", undefined, { ref: entry.ref, maxBytes: MAX_INSPECT_BYTES });
    }
    const expansion = selector.store === "task-message"
      ? expandTaskMessageResult(value as TaskMessage, (task, run) => reader.getRun(task, run))
      : undefined;
    const response = { ...entry, ...(expansion !== undefined && "result" in expansion
      ? { result: expansion.result } : {}),
      ...(selector.store === "run" ? { execution: runExecutionObservation(value as AgentRun,
        reader.getTaskRoleSessionSet(taskId, (value as AgentRun).roleName)?.providerBinding, reader.listEvents(taskId)) } : {}),
      coreCursor: encode(currentCursor(reader, taskId)) };
    if (Buffer.byteLength(JSON.stringify(response)) > MAX_INSPECT_BYTES) {
      throw usageError("Expanded Context exceeds the bounded inspect limit.", undefined,
        { ref: entry.ref, maxBytes: MAX_INSPECT_BYTES });
    }
    return response;
  });
}

export function listContextMessages(
  store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv = {}
): TaskMessage[] {
  return store.transaction((reader) => {
    const { allow } = authorizeContext(reader, taskId, environment);
    return reader.listMessages(taskId)
      .filter((message) => isAllowed(allow, "task-message", message.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  });
}

/** Optional read-only providers receive only the caller's bounded core view.
 * No Store, credentials or mutation port is exposed. An unavailable provider
 * cannot prevent returning the core. This is a trusted in-process port, not a
 * JavaScript sandbox; executable plugin admission belongs to its owner.
 */
export async function withContextObservations(
  core: ReturnType<typeof readTaskContext>,
  providers: readonly ContextObservationProvider[],
  timeoutMs = 250
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000 || providers.length > 8) {
    throw usageError("Optional Context providers exceed the bounded observation budget.");
  }
  const observations = await Promise.all(providers.map(async (provider): Promise<ContextObservation> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => provider.read(freeze(JSON.parse(JSON.stringify(core))), controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
        })
      ]);
      if (!["known", "partial", "unknown"].includes(value.coverage)
        || Buffer.byteLength(JSON.stringify(value)) > MAX_VALUE_BYTES) throw new Error("unbounded observation");
      return { source: provider.source.slice(0, 200), observedAt: new Date().toISOString(),
        coverage: value.coverage, status: "available", value: JSON.parse(JSON.stringify(value.value)) };
    } catch {
      return { source: provider.source.slice(0, 200), observedAt: new Date().toISOString(),
        coverage: "unknown", status: "unavailable" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }));
  return { ...core, observations };
}

/** Shared current/historical Session read identity; discovery may only narrow it. */
export function resolveContextReader(store: TaskStore, environment: NodeJS.ProcessEnv) {
  const caller = resolveManagedTaskReader(store, environment);
  if (caller === undefined && environment.YUI_SESSION_SCOPE === "global" && environment.YUI_ROLE !== "operator") {
    throw usageError("Only Operator may read Task context from a global Session.");
  }
  if (caller === undefined && environment.YUI_SESSION_SCOPE === undefined
    && (environment.YUI_ROLE !== undefined || environment.YUI_NATIVE_SESSION_ID !== undefined
      || environment.YUI_TASK_ID !== undefined || environment.YUI_AGENT_ID !== undefined)) {
    throw usageError("Incomplete managed Context caller identity.");
  }
  if (environment.YUI_SESSION_SCOPE !== undefined && !["task", "global"].includes(environment.YUI_SESSION_SCOPE)) {
    throw usageError("Incomplete managed Context caller identity.");
  }
  return caller;
}

function authorizeContext(store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv) {
  const caller = resolveContextReader(store, environment);
  if (caller !== undefined && caller.taskId !== taskId) throw usageError("Context is outside the caller's Task.");
  const task = store.getTask(taskId);
  if (task === null) throw taskNotFound(taskId);
  let allow: Set<string> | undefined;
  if (caller !== undefined && caller.roleName !== "leader") {
    if (caller.currentRunId === undefined) throw usageError("A managed Role needs a current AgentRun to read its scoped Context.");
    const pack = buildRunContextPack(store, taskId, caller.currentRunId);
    allow = new Set(pack.authority.readableRefs.map((ref) => `${ref.store}:${ref.refId}`));
    allow.add(`role:${caller.roleName}`);
    allow.add(`turn:${caller.currentRunId}`);
    // A steer targets exactly one Role's current native Turn and is never shared
    // Task intent (decision-3 §9). A Leader steer in particular stores as an
    // untargeted `user` Message (no recipient/WorkItem/Run scope, since a Leader
    // holds no Assignment), so recognize it explicitly: the shared block below
    // must never leak it, and the steer-delta block authorizes it only to its own
    // recipient. `interruptThen.reusedInput` is the interrupt-then composition
    // whose carried input can itself be a steer.
    const isSteerMessage = (message: TaskMessage) =>
      message.inputControl?.action === "steer"
      || message.interruptThen?.reusedInput?.action === "steer";
    // A frozen Assignment is not a cutoff for the Task's current user intent.
    // Untargeted human/Operator messages are shared Task requirements; scoped
    // messages, other Roles' results, and steers still require an explicit grant.
    const sharedMessageIds = new Set(store.listMessages(taskId)
      .filter(message => (message.kind === "user" || message.kind === "operator")
        && message.recipient === undefined && message.workItemId === undefined
        && message.runId === undefined && !isSteerMessage(message))
      .map(message => message.id));
    for (const id of sharedMessageIds) allow.add(`task-message:${id}`);
    for (const event of store.listEvents(taskId)) {
      if (event.type.startsWith("message.") && sharedMessageIds.has(event.payload.messageId)) {
        allow.add(`task-event:${event.id}`);
      }
    }
    // A steer targets this Role's exact current native Turn (decision-3 §9,
    // message-5 gap E). Unlike a queued or addressed Message — which reaches the
    // Role through a new AgentRun's frozen Context pack — a steer is pushed into
    // the *current* turn and is never captured by any frozen snapshot. So the
    // steer header directs the recipient to reconcile the input "through your
    // authorized Context read path"; that path must therefore resolve the exact
    // steer Message it names. Authorize the steers addressed to this caller's
    // exact current Assignment scope as a live delta — the same way untargeted
    // user intent is layered on — WITHOUT expanding the frozen Assignment's
    // readableRefs. Scope is the tightest signal a steer carries (it never gains
    // a continuation runId), so a steer for a different WorkItem/Round is not
    // authorized, and only genuine steers gain this read (an ordinary addressed
    // Message still requires its own frozen delta).
    const run = store.getRun(taskId, caller.currentRunId);
    const steerMessageIds = new Set(store.listMessages(taskId)
      .filter(message => isSteerMessage(message)
        && message.recipient?.roleName === caller.roleName
        && message.recipient.workItemId === run?.workItemId
        && message.recipient.reviewRoundId === run?.reviewRoundId)
      .map(message => message.id));
    for (const id of steerMessageIds) allow.add(`task-message:${id}`);
    for (const event of store.listEvents(taskId)) {
      if (event.type.startsWith("message.") && steerMessageIds.has(event.payload.messageId)) {
        allow.add(`task-event:${event.id}`);
      }
    }
  }
  return { task, allow, caller };
}

function isAllowed(allow: Set<string> | undefined, family: string, id: string): boolean {
  return allow === undefined || allow.has(`${family}:${id}`);
}

function roleProfile(role: NonNullable<ReturnType<TaskStore["getRole"]>>) {
  return {
    name: role.name, defaultAccess: role.defaultAccess, description: role.description,
    responsibilities: role.responsibilities ?? [], constraints: role.constraints ?? [],
    skills: role.skills ?? [], launchRevision: role.launchRevision
  };
}

/** Resolve just the requested family. Families without a singular Store read
 * use their existing list primitive, without constructing unrelated Context.
 */
function inspectValue(
  store: TaskStore,
  { task, allow, caller }: ReturnType<typeof authorizeContext>,
  { store: family, refId }: Readonly<{ store: string; refId: string }>
): unknown | null {
  const taskId = task.id;
  switch (family) {
    case "task": return refId === taskId ? task : null;
    case "task-brief": return refId === taskId ? store.getTaskBrief(taskId) : null;
    case "remote-delivery": return refId === taskId && allow === undefined
      ? projectTaskRemoteDeliveryFromStore(store, task) : null;
    case "role": return store.getRole(taskId, refId);
    case "role-profile": {
      const role = store.getRole(taskId, refId);
      return role === null ? null : roleProfile(role);
    }
    case "project-policy":
    case "project-knowledge": {
      const binding = task.projectBindings.find(({ projectId }) => family === "project-policy"
        ? projectId === refId : refId.startsWith(`${projectId}:`));
      if (binding === undefined) return null;
      const project = store.getProject(binding.projectId);
      if (project === null) return null;
      const { knowledge, ...policy } = project;
      if (family === "project-policy") return policy;
      const entry = knowledge.find((item) => item.status === "active" && `${project.id}:${item.id}` === refId);
      return entry === undefined ? null : { projectId: project.id, ...entry };
    }
    case "input-request": return store.getInputRequest(taskId, refId);
    case "work-item": return store.getWorkItem(taskId, refId);
    case "accepted-work-item":
      return allow?.has(`accepted-work-item:${refId}`) ? store.getWorkItem(taskId, refId) : null;
    case "candidate": {
      const parts = refId.split("/");
      if (parts.length !== 2) return null;
      return store.getWorkItem(taskId, parts[0]!)?.candidates
        .find((candidate) => candidate.id === parts[1]) ?? null;
    }
    case "task-message": return store.listMessages(taskId).find((message) => message.id === refId) ?? null;
    case "run": return store.getRun(taskId, refId);
    case "source-run": {
      if (!allow?.has(`source-turn:${refId}`)) return null;
      const run = store.getRun(taskId, refId);
      return run === null ? null : sourceRunContextValue(run);
    }
    case "review-round": return store.getReviewRound(taskId, refId);
    case "artifact": {
      // A file artifact is addressed by its self-certifying commit-pinned refId
      // (git:<commit>:<relativePath>). Resolve it to the pure pointer only; the
      // bytes are read on the async `artifact.read` path, never synchronously in
      // this transaction.
      if (!isGitArtifactRefString(refId)) return null;
      try {
        const pinned = parseGitArtifactRef(refId, taskId);
        return {
          taskId: pinned.taskId,
          commit: pinned.commit,
          relativePath: pinned.relativePath,
          ...(pinned.digest === undefined ? {} : { digest: pinned.digest })
        };
      } catch { return null; }
    }
    case "environment-preparation": return store.getEnvironmentPreparation(taskId, refId);
    case "change-set": return store.getChangeSet(taskId, refId);
    case "managed-workspace": {
      // Existing frozen AgentRun overlays use the Task/Role alias; owner keys
      // identify the durable workspace in current Task reads.
      if (caller?.currentRunId !== undefined && refId === `${taskId}/${caller.roleName}`) {
        return store.getRun(taskId, caller.currentRunId)?.workspace ?? null;
      }
      return store.listManagedWorkspaces(taskId)
        .find((workspace) => managedWorkspaceKey(workspace.owner) === refId) ?? null;
    }
    case "mailbox": {
      if (allow !== undefined) return null;
      if (refId === "task") return store.getWorkMailbox({ kind: "task", taskId });
      const roleName = refId.startsWith("role:") ? refId.slice("role:".length) : undefined;
      return roleName !== undefined && store.getRole(taskId, roleName) !== null
        ? store.getWorkMailbox({ kind: "role", taskId, roleName }) : null;
    }
    case "task-decision": return store.getDecision(taskId, refId);
    case "task-milestone": return store.getMilestone(taskId, refId);
    case "job": return store.getDurableJob(taskId, refId);
    case "publication": return store.listPublicationReferences(taskId).find((item) => item.id === refId) ?? null;
    case "task-event": return store.listEvents(taskId).find((event) => event.id === refId) ?? null;
    default: return null;
  }
}

function authorizedEntries(store: TaskStore, taskId: string, environment: NodeJS.ProcessEnv): Entry[] {
  const { task, allow, caller } = authorizeContext(store, taskId, environment);
  const entries: Entry[] = [];
  const add = (family: string, id: string, value: unknown) => {
    if (value !== null && isAllowed(allow, family, id)) {
      entries.push(materialize(family, id, value));
    }
  };
  add("task", taskId, task);
  add("task-brief", taskId, store.getTaskBrief(taskId));
  if (allow === undefined) add("remote-delivery", taskId, projectTaskRemoteDeliveryFromStore(store, task));
  for (const role of store.listRoles(taskId)) {
    add("role", role.name, role);
    add("role-profile", role.name, roleProfile(role));
  }
  for (const binding of task.projectBindings) {
    const project = store.getProject(binding.projectId);
    if (project === null) continue;
    const { knowledge, ...policy } = project;
    add("project-policy", project.id, policy);
    for (const entry of knowledge.filter((k) => k.status === "active")) {
      add("project-knowledge", `${project.id}:${entry.id}`, { projectId: project.id, ...entry });
    }
  }
  // Current responsibilities and unanswered inputs precede historical bulk.
  for (const request of store.listInputRequests(taskId).filter((r) => r.status === "open")) add("input-request", request.id, request);
  for (const item of store.listWorkItems(taskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    add("work-item", item.id, item);
    if (allow?.has(`accepted-work-item:${item.id}`)) add("accepted-work-item", item.id, item);
    for (const candidate of [...item.candidates].reverse()) add("candidate", `${item.id}/${candidate.id}`, candidate);
  }
  // File artifacts are not enumerated into the synchronous Context listing: the
  // core cursor does not cover file edits and an ambient directory index here
  // would be the forbidden update-time mirror (§3.7). Current artifacts are
  // listed on demand via the async `artifact.list` capability; frozen Candidate
  // artifacts remain reachable as commit-pinned pointers under their Candidate.
  for (const preparation of store.listEnvironmentPreparations(taskId)) add("environment-preparation", preparation.id, preparation);
  for (const workspace of store.listManagedWorkspaces(taskId)) add("managed-workspace", managedWorkspaceKey(workspace.owner), workspace);
  if (caller?.currentRunId !== undefined) {
    add("managed-workspace", `${taskId}/${caller.roleName}`,
      store.getRun(taskId, caller.currentRunId)?.workspace ?? null);
  }
  for (const changeSet of store.listChangeSets(taskId)) add("change-set", changeSet.id, changeSet);
  for (const message of store.listMessages(taskId).reverse()) add("task-message", message.id, message);
  for (const run of store.listRuns(taskId).reverse()) {
    add("run", run.id, run);
    if (allow?.has(`source-turn:${run.id}`)) add("source-run", run.id, sourceRunContextValue(run));
  }
  for (const round of store.listReviewRounds(taskId).reverse()) add("review-round", round.id, round);
  for (const request of store.listInputRequests(taskId).filter((r) => r.status !== "open")) add("input-request", request.id, request);
  if (allow === undefined) {
    add("mailbox", "task", store.getWorkMailbox({ kind: "task", taskId }));
    for (const role of store.listRoles(taskId)) {
      add("mailbox", `role:${role.name}`, store.getWorkMailbox({ kind: "role", taskId, roleName: role.name }));
    }
  }
  for (const decision of store.listDecisions(taskId)) add("task-decision", decision.id, decision);
  for (const milestone of store.listMilestones(taskId)) add("task-milestone", milestone.id, milestone);
  for (const job of store.listDurableJobs(taskId)) add("job", job.id, job);
  for (const publication of store.listPublicationReferences(taskId)) add("publication", publication.id, publication);
  for (const event of store.listEvents(taskId).reverse()) add("task-event", event.id, event);
  return entries;
}

export function materialize(store: string, refId: string, value: unknown): Entry {
  const digest = contextContentDigest(value);
  const record = value as Record<string, unknown>;
  return { ref: { store, refId, revision: String(record.revision ?? record.updatedAt ?? record.createdAt ?? digest), digest }, value };
}
function currentCursor(store: TaskStore, taskId: string, events = store.listEvents(taskId)): Cursor {
  return { taskId, sequence: events.reduce((max, e) => Math.max(max, sequence(e.id)), 0), revision: store.getStateRevision() };
}
function sequence(id: string): number {
  const result = /^event-(\d+)$/.exec(id);
  if (result === null || !Number.isSafeInteger(Number(result[1]))) throw usageError("Task event has an invalid sequence.");
  return Number(result[1]);
}
function encode(value: Cursor | PageCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(value: string, taskId: string): Cursor {
  try {
    if (value.length > 1024) throw new Error("size");
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString()) as Cursor;
    if (cursor.taskId !== taskId || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0
      || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0) throw new Error("shape");
    return cursor;
  } catch { throw usageError("Invalid Context cursor for this Task."); }
}
function decodePage(value: string, taskId: string): PageCursor {
  const cursor = decode(value, taskId) as PageCursor;
  if (!Number.isSafeInteger(cursor.after) || cursor.after < 0) throw usageError("Invalid Context continuation.");
  return cursor;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function summarize(value: unknown): string {
  const record = value as Record<string, unknown>;
  return ["title", "objective", "summary", "body", "status"]
    .flatMap((key) => typeof record[key] === "string" ? [`${key}: ${record[key]}`] : [])
    .join("; ").slice(0, 400);
}
