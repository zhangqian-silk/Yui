import {
  selectedSchedulerRoles,
  selectedActiveSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerRoleResourceInput,
  type SchedulerRoleResourceEvidence,
  type SchedulerStorePort,
  type TmuxDeliveryPort
} from "./ports.js";
import { formatTaskRecordReference } from "../task/taskRecordReference.js";
import {
  currentRoleRunProgressAt,
  DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS
} from "./roleRunStall.js";

export type RoleLiveStatus = "present" | "absent";
export type RoleLiveStatusSnapshot = ReadonlyMap<string, RoleLiveStatus>;

/**
 * Lightweight liveness only. Host absence may fail a Run only before any
 * prompt bytes were pushed. After push, acceptance may be unknown even when
 * deliveredAt is absent; pane/process loss is therefore runtime-health
 * evidence, not an application-level outcome. The Run stays active so native
 * child work or another observer can still contribute facts, while the stall
 * path raises bounded attention independently.
 * Process liveness is only a recovery signal. An absent pane/Host never proves
 * that the native Session or AgentRun ended; recover the same generation and
 * native identity when possible, otherwise preserve the active Run.
 */
export async function reconcileExitedRoleRuns(
  store: SchedulerStorePort,
  delivery: Pick<
    TmuxDeliveryPort,
    "inspectRole" | "inspectRoles" | "forgetPrepared" | "prepareRoleSession"
  >,
  now: Date,
  selection?: SchedulerReconcileSelection,
  excludedRunRefs: ReadonlySet<string> = new Set(),
  liveStatuses?: Map<string, RoleLiveStatus>,
  resourceEvidence?: Map<string, SchedulerRoleResourceEvidence>,
  targetedInventory = selection !== undefined && !selection.full
): Promise<string[]> {
  const failed: string[] = [];
  const candidates = selectedActiveSchedulerTasks(store, selection).flatMap((task) => (
    selectedSchedulerRoles(store, task.id, selection).flatMap((role) => {
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run === null) return [];
      const session = store.getRoleSession(task.id, role.name, run.effective.agentId);
      return [{
        task,
        role,
        run,
        session,
        inspection: {
          taskId: task.id,
          roleName: role.name,
          agentId: run.effective.agentId,
          adapterId: run.effective.adapterId,
          runId: run.id,
          progressAt: run.deliveredAt ?? run.createdAt,
          ...(session?.launchId === undefined ? {} : { launchId: session.launchId }),
          ...(session?.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: session.nativeSessionId })
        }
      }];
    })
  ));
  if (candidates.length === 0) return failed;
  const eligible = candidates.filter(({ task, run }) => (
    !excludedRunRefs.has(formatTaskRecordReference(task.id, run.id, "agentRun"))
    && run.pushedAt === undefined
  ));
  // Full reconciliation builds one complete provider inventory for every
  // active Run, including delivery-uncertain and completion-pending Runs.
  // The stall phase reuses that snapshot so one full pass never probes the
  // same pane twice. When targetedInventory is true, a dirty pass instead
  // uses exact probes below; stall reconciliation intentionally does not run
  // for that bounded selection.
  const batchSnapshot = liveStatuses !== undefined
    && candidates.every(({ task, role }) => liveStatuses.has(`${task.id}\0${role.name}`))
      ? {
        statuses: liveStatuses,
        resources: resourceEvidence ?? new Map<string, SchedulerRoleResourceEvidence>(),
        hostExits: new Map<string, Readonly<{ deadStatus?: number }>>()
      }
    : await inspectRoleStatuses(
        delivery,
        candidates,
        !targetedInventory
          ? candidates.flatMap(({ task, role, run, session }) => (
              isResourceCandidate(task, run, now)
                ? [{
                    taskId: task.id,
                    roleName: role.name,
                    runId: run.id,
                    agentId: run.effective.agentId,
                    adapterId: run.effective.adapterId,
                    progressAt: currentRoleRunProgressAt(
                      store,
                      task.id,
                      role.name,
                      run
                    ).progressAt,
                    ...(session?.nativeSessionId === undefined
                      ? {}
                      : { nativeSessionId: session.nativeSessionId }),
                    ...(session?.launchId === undefined ? {} : { launchId: session.launchId })
                  }]
                : []
            ))
          : [],
        targetedInventory
      );
  if (liveStatuses !== undefined) {
    for (const [key, status] of batchSnapshot.statuses) liveStatuses.set(key, status);
  }
  if (resourceEvidence !== undefined) {
    for (const [key, resource] of batchSnapshot.resources) {
      const candidate = candidates.find(({ task, role }) => (
        `${task.id}\0${role.name}` === key
      ));
      if (candidate !== undefined) {
        // Keep only the exact Run key. A task/role or bare-Run fallback can
        // bridge an asynchronous sample from a prior generation.
        resourceEvidence.set(`${key}\0${candidate.run.id}`, resource);
      }
    }
  }
  for (const { task, role, run, session, inspection } of eligible) {
      const status = batchSnapshot.statuses.get(`${task.id}\0${role.name}`);
      if (status === undefined) throw new Error("Role liveness snapshot is incomplete.");
      if (status === "present") continue;

      const hostExit = batchSnapshot.hostExits.get(`${task.id}\0${role.name}`);
      if (hostExit !== undefined) {
        store.saveRoleHostExitObservation?.({
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          ...(session?.launchId === undefined ? {} : { launchId: session.launchId }),
          ...(session?.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: session.nativeSessionId }),
          ...(hostExit.deadStatus === undefined ? {} : { deadStatus: hostExit.deadStatus }),
          observedAt: now
        });
      }

      if (session?.nativeSessionId === undefined) {
        store.queueTaskProgress(task.id, "host-missing-native-resume-unproven", now);
        continue;
      }
      try {
        delivery.forgetPrepared?.({
          taskId: task.id,
          roleName: role.name,
          runId: run.id
        });
        const recovered = await delivery.prepareRoleSession({
          taskId: task.id,
          roleName: role.name,
          agentId: run.effective.agentId,
          adapterId: run.effective.adapterId,
          effective: run.effective,
          workspace: run.effective.workspace.root,
          ...(run.workspace === undefined ? {} : { managedWorkspace: run.workspace }),
          mode: "resume",
          runId: run.id,
          nativeSessionId: session.nativeSessionId,
          ...(session.launchId === undefined
            ? {}
            : { hostActivationId: session.launchId })
        });
        store.saveRoleRunPrepared({
          task,
          role,
          run,
          session: recovered.session ?? session,
          ...(recovered.launchId === undefined ? {} : { launchId: recovered.launchId }),
          now
        });
        liveStatuses?.set(`${task.id}\0${role.name}`, "present");
      } catch {
        // Absence plus an inconclusive local recovery attempt is still not a
        // native Session death proof. Keep the exact Run active for the next
        // bounded recovery pass and expose the blocked axis separately.
        store.queueTaskProgress(task.id, "host-missing-native-resume-pending", now);
      }
  }
  return failed;
}

type RoleRunCandidate = Readonly<{
  task: ReturnType<typeof selectedActiveSchedulerTasks>[number];
  role: ReturnType<typeof selectedSchedulerRoles>[number];
  inspection: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    runId: string;
    progressAt: string;
    nativeSessionId?: string;
    launchId?: string;
  }>;
}>;

type RoleInventorySnapshot = Readonly<{
  statuses: RoleLiveStatusSnapshot;
  resources: ReadonlyMap<string, SchedulerRoleResourceEvidence>;
  hostExits: ReadonlyMap<string, Readonly<{ deadStatus?: number }>>;
}>;

async function inspectRoleStatuses(
  delivery: Pick<TmuxDeliveryPort, "inspectRole" | "inspectRoles">,
  candidates: readonly RoleRunCandidate[],
  resourceInputs: readonly SchedulerRoleResourceInput[],
  targeted: boolean
): Promise<RoleInventorySnapshot> {
  // Dirty reconciliation already owns exact Task/Role keys. Probe those keys
  // directly so a concurrent dirty batch does not repeat the provider's
  // global inventory (and its optional process-resource scan) once per Task.
  // Full reconciliation retains the adapter's batch contract below.
  if (targeted && delivery.inspectRole !== undefined) {
    const statuses = new Map<string, RoleLiveStatus>();
    for (const candidate of candidates) {
      const key = `${candidate.task.id}\0${candidate.role.name}`;
      if (statuses.has(key)) {
        throw new Error("Tmux Role targeted liveness selection is invalid.");
      }
      statuses.set(key, await delivery.inspectRole(candidate.inspection));
    }
    return { statuses, resources: new Map(), hostExits: new Map() };
  }
  if (delivery.inspectRoles !== undefined) {
    return exactBatchInventory(
      await delivery.inspectRoles(
        candidates.map(({ inspection }) => inspection),
        resourceInputs
      ),
      candidates
    );
  }
  const entries: [string, RoleLiveStatus][] = [];
  for (const candidate of candidates) {
    entries.push([
      `${candidate.task.id}\0${candidate.role.name}`,
      await delivery.inspectRole(candidate.inspection)
    ]);
  }
  return { statuses: new Map(entries), resources: new Map(), hostExits: new Map() };
}

function exactBatchInventory(
  batch: readonly Readonly<{
    taskId: string;
    roleName: string;
    status: "present" | "absent";
    resource?: SchedulerRoleResourceEvidence;
    hostExit?: Readonly<{ deadStatus?: number }>;
  }>[],
  candidates: readonly Readonly<{
    task: Readonly<{ id: string }>;
    role: Readonly<{ name: string }>;
  }>[]
): RoleInventorySnapshot {
  const expected = new Set(candidates.map(({ task, role }) => `${task.id}\0${role.name}`));
  const statuses = new Map<string, "present" | "absent">();
  const resources = new Map<string, SchedulerRoleResourceEvidence>();
  const hostExits = new Map<string, Readonly<{ deadStatus?: number }>>();
  for (const entry of batch) {
    const key = `${entry.taskId}\0${entry.roleName}`;
    if (!expected.has(key) || statuses.has(key)) {
      throw new Error("Tmux Role batch liveness snapshot is invalid.");
    }
    statuses.set(key, entry.status);
    if (entry.resource !== undefined) resources.set(key, entry.resource);
    if (entry.hostExit !== undefined) hostExits.set(key, entry.hostExit);
  }
  if (statuses.size !== expected.size) {
    throw new Error("Tmux Role batch liveness snapshot is incomplete.");
  }
  return { statuses, resources, hostExits };
}

function isResourceCandidate(
  task: Readonly<{ status: string; executionGate: { state: "enabled" | "stopped" } }>,
  run: Readonly<{ status: string; deliveredAt?: string }>,
  now: Date
): boolean {
  if (
    task.status !== "active"
    || task.executionGate.state !== "enabled"
    || run.status !== "active"
    || run.deliveredAt === undefined
  ) {
    return false;
  }
  const deliveredAt = Date.parse(run.deliveredAt);
  return Number.isFinite(deliveredAt)
    && now.getTime() - deliveredAt >= DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS;
}
