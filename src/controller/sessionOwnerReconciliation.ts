import { existsSync } from "node:fs";
import { join } from "node:path";

import { sessionReconcileModeFromEnvironment } from "../config/yuiConfig.js";
import { createTaskEvent } from "../event/taskEvent.js";
import {
  FileSessionOwnerRegistry,
  createSessionOwnerIdentity,
  discoverProviderRootByLaunchEnv,
  isLinuxProcessLive,
  listLaunchFencedProcesses,
  listOwnedProcessTree,
  readLinuxProcessIdentity,
  reconcileSessionOwners,
  terminateSessionOwners,
  type DurableSessionFact,
  type RuntimeOwner,
  type SessionPhysicalObservation,
  type SessionReconciliationMode,
  type SessionReconciliationReport,
  type SessionTerminationEvent,
  type SessionTerminationPorts,
  type SessionTerminationResult
} from "../runtime/index.js";
import type { SessionOwnerIdentity } from "../runtime/sessionOwnerIdentity.js";
import type { TaskStore } from "../storage/taskStore.js";
import { tmuxSocketDirectory } from "../tmux/tmuxSocketEndpoint.js";
import {
  yuiTmuxServerName,
  yuiTmuxSessionName,
  yuiTmuxTarget
} from "../tmux/tmuxManager.js";

export type SessionOwnerReconciliationDeps = Readonly<{
  home: string;
  store: TaskStore;
  environment?: NodeJS.ProcessEnv;
  tmux?: Readonly<{
    inspectPane(taskId: string, roleName: string): Readonly<{
      pid?: number;
      target: string;
      dead: boolean;
      currentCommand: string;
    }>;
    killRole(taskId: string, roleName: string): void;
    probeRoleStatus(taskId: string, roleName: string): "running" | "exited";
  }>;
  onWarning?: (message: string) => void;
}>;

/**
 * Production I/O adapters for Issue 03 Session owner reconciliation. The pure
 * logic lives in src/runtime; this module only binds it to the durable store,
 * /proc, and the exact tmux namespace of one Home.
 */
export class SessionOwnerReconciliation {
  readonly #home: string;
  readonly #store: TaskStore;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #tmux: SessionOwnerReconciliationDeps["tmux"];
  readonly #onWarning: (message: string) => void;
  readonly #registry: FileSessionOwnerRegistry;

  constructor(deps: SessionOwnerReconciliationDeps) {
    this.#home = deps.home;
    this.#store = deps.store;
    this.#environment = deps.environment ?? process.env;
    this.#tmux = deps.tmux;
    this.#onWarning = deps.onWarning ?? (() => undefined);
    this.#registry = new FileSessionOwnerRegistry(deps.home);
  }

  get registry(): FileSessionOwnerRegistry {
    return this.#registry;
  }

  get mode(): SessionReconciliationMode {
    return sessionReconcileModeFromEnvironment(this.#environment);
  }

  /**
   * Persists the exact physical owner identity after a host created a new
   * Provider process. The Provider root is attributed by the exact
   * YUI_LAUNCH_ID environment fence; the tmux pane PID is only a weaker
   * fallback when the fence cannot be read.
   */
  recordHostOwner(input: Readonly<{
    owner: RuntimeOwner;
    agentId: string;
    adapterId: string;
    launchId: string;
    nativeSessionId?: string;
    panePid?: number;
    runtimeRoot?: string;
  }>): void {
    const discovered = discoverProviderRootByLaunchEnv(input.launchId);
    const fallback = discovered === undefined && input.panePid !== undefined
      ? readLinuxProcessIdentity(input.panePid)
      : undefined;
    const root = discovered ?? (fallback === undefined
      ? undefined
      : { pid: fallback.pid, identity: fallback });
    if (root === undefined) {
      this.#onWarning(
        `Session owner identity could not attribute a Provider root for launch ${input.launchId}; `
          + "no owner record was written."
      );
      return;
    }
    const owner = input.owner;
    const taskId = owner.scope === "task" ? owner.taskId : undefined;
    this.#registry.record(createSessionOwnerIdentity({
      owner: {
        scope: owner.scope,
        ...(taskId === undefined ? {} : { taskId }),
        roleName: owner.roleName
      },
      agentId: input.agentId,
      adapterId: input.adapterId,
      launchId: input.launchId,
      ...(input.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: input.nativeSessionId }),
      tmux: {
        serverName: yuiTmuxServerName(this.#home),
        socketPath: join(
          tmuxSocketDirectory(this.#environment),
          yuiTmuxServerName(this.#home)
        ),
        sessionName: owner.scope === "task"
          ? yuiTmuxSessionName(this.#home, owner.taskId)
          : yuiTmuxSessionName(this.#home, "operator"),
        windowName: owner.roleName,
        ...(input.panePid === undefined ? {} : { panePid: input.panePid })
      },
      providerRoot: {
        pid: root.pid,
        startIdentity: root.identity.startIdentity,
        ...(root.identity.processGroupId === undefined
          ? {}
          : { processGroupId: root.identity.processGroupId }),
        ...(root.identity.processSessionId === undefined
          ? {}
          : { processSessionId: root.identity.processSessionId }),
        attribution: discovered === undefined ? "pane-pid" : "launch-env"
      },
      ...(input.runtimeRoot === undefined ? {} : { runtimeRoot: input.runtimeRoot }),
      recordedAt: new Date()
    }));
  }

  /** Read-only bidirectional reconciliation; never mutates physical state. */
  report(mode: SessionReconciliationMode = this.mode): SessionReconciliationReport {
    return reconcileSessionOwners({
      mode,
      records: this.#registry.list(),
      durable: durableSessionFacts(this.#store),
      taskStatus: (taskId) => this.#store.getTask(taskId)?.status,
      observe: (record) => observeSessionOwnerPhysical(record),
      inspectPane: (taskId, roleName) => {
        if (this.#tmux === undefined || taskId === undefined) return undefined;
        try {
          const pane = this.#tmux.inspectPane(taskId, roleName);
          return { target: pane.target, dead: pane.dead };
        } catch {
          return undefined;
        }
      },
      lastStopOutcome: (taskId, roleName, launchId) => (
        lastSessionTerminationOutcome(this.#store, taskId, roleName, launchId)
      ),
      now: new Date()
    });
  }

  /**
   * Stops one owner with physical exit proof. Removes the owner records only
   * after every root is proven absent; a blocked result preserves them.
   */
  async terminateOwner(
    owner: RuntimeOwner,
    options: { gracefulGraceMs?: number; forcedGraceMs?: number; pollMs?: number } = {}
  ): Promise<SessionTerminationResult> {
    const records = this.#registry.listForOwner(owner);
    const ports: SessionTerminationPorts = {
      gracefulStop: async (target) => {
        if (this.#tmux === undefined) return false;
        const hostId = target.scope === "task" ? target.taskId : "operator";
        try {
          this.#tmux.killRole(hostId, target.roleName);
        } catch {
          return this.#tmux.probeRoleStatus(hostId, target.roleName) === "exited";
        }
        return this.#tmux.probeRoleStatus(hostId, target.roleName) === "exited";
      },
      processIdentity: readLinuxProcessIdentity,
      procEntryExists: (pid) => {
        try {
          return existsSync(`/proc/${pid}`);
        } catch {
          return false;
        }
      },
      listLaunchFencedProcesses: (launchId) => listLaunchFencedProcesses(launchId),
      signalProcess: (pid, signal) => process.kill(pid, signal),
      signalProcessGroup: (processGroupId, signal) => {
        try {
          process.kill(-processGroupId, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      emit: (event) => this.#recordTerminationEvent(event),
      now: () => new Date()
    };
    const result = await terminateSessionOwners(owner, records, ports, options);
    if (result.outcome === "stop-confirmed") {
      for (const record of result.confirmed) {
        this.#registry.remove(record.launchId);
      }
    }
    return result;
  }

  #recordTerminationEvent(event: SessionTerminationEvent): void {
    const owner = event.owner;
    if (owner.scope !== "task") return;
    try {
      this.#store.saveEvent(owner.taskId, createTaskEvent(
        this.#store.nextEventId(owner.taskId),
        owner.taskId,
        "runtime.session-termination",
        {
          roleName: owner.roleName,
          launchId: event.launchId ?? "",
          nativeSessionId: event.nativeSessionId ?? "",
          outcome: event.stage,
          ...(event.detail === undefined ? {} : { detail: event.detail })
        },
        event.at
      ));
    } catch (error) {
      this.#onWarning(
        `Session termination event could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

/** Projects every durable Role session generation for reconciliation. */
export function durableSessionFacts(store: TaskStore): DurableSessionFact[] {
  const facts: DurableSessionFact[] = [];
  for (const task of store.listTasks()) {
    for (const set of store.listRoleSessionSets(task.id)) {
      for (const [agentId, session] of Object.entries(set.sessions)) {
        facts.push({
          scope: "task",
          taskId: task.id,
          roleName: set.owner.roleName,
          agentId,
          adapterId: session.adapterId,
          ...(session.launchId === undefined ? {} : { launchId: session.launchId }),
          ...(session.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: session.nativeSessionId }),
          status: session.status,
          inHistory: false
        });
      }
      for (const history of set.history ?? []) {
        facts.push({
          scope: "task",
          taskId: task.id,
          roleName: set.owner.roleName,
          agentId: history.agentId,
          adapterId: history.adapterId,
          ...(history.launchId === undefined ? {} : { launchId: history.launchId }),
          ...(history.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: history.nativeSessionId }),
          status: history.status,
          inHistory: true
        });
      }
    }
  }
  for (const set of store.listGlobalRoleSessionSets()) {
    for (const [agentId, session] of Object.entries(set.sessions)) {
      facts.push({
        scope: "global",
        roleName: set.owner.roleName,
        agentId,
        adapterId: session.adapterId,
        ...(session.launchId === undefined ? {} : { launchId: session.launchId }),
        ...(session.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: session.nativeSessionId }),
        status: session.status,
        inHistory: false
      });
    }
    const history = (set as { history?: Record<string, typeof set.sessions[string]> }).history;
    for (const session of Object.values(history ?? {})) {
      facts.push({
        scope: "global",
        roleName: set.owner.roleName,
        agentId: session.agentId,
        adapterId: session.adapterId,
        ...(session.launchId === undefined ? {} : { launchId: session.launchId }),
        ...(session.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: session.nativeSessionId }),
        status: session.status,
        inHistory: true
      });
    }
  }
  return facts;
}

/** /proc observation for one owner record; undefined is a verification gap. */
export function observeSessionOwnerPhysical(
  record: SessionOwnerIdentity
): SessionPhysicalObservation | undefined {
  const { pid, startIdentity } = record.providerRoot;
  const current = readLinuxProcessIdentity(pid);
  if (current === undefined) {
    return {
      alive: false,
      identityConflict: false,
      pid,
      startIdentity,
      rssBytes: 0,
      ageMs: 0,
      childCount: 0
    };
  }
  if (current.startIdentity !== startIdentity) {
    // PID reuse: the slot is live but it is a different process. Never kill.
    return {
      alive: false,
      identityConflict: true,
      pid,
      startIdentity,
      rssBytes: current.rssBytes,
      ageMs: 0,
      childCount: 0
    };
  }
  const tree = listOwnedProcessTree(pid, current.processGroupId);
  return {
    alive: true,
    identityConflict: false,
    pid,
    startIdentity,
    rssBytes: current.rssBytes,
    ageMs: 0,
    childCount: Math.max(0, tree.length - 1)
  };
}

/** Reads the latest termination outcome recorded for one generation. */
export function lastSessionTerminationOutcome(
  store: Pick<TaskStore, "listEvents">,
  taskId: string | undefined,
  roleName: string,
  launchId: string
): string | undefined {
  if (taskId === undefined) return undefined;
  let latest: string | undefined;
  for (const event of store.listEvents(taskId)) {
    if (event.type !== "runtime.session-termination") continue;
    if (event.payload.roleName !== roleName) continue;
    if (
      launchId !== ""
      && event.payload.launchId !== undefined
      && event.payload.launchId !== ""
      && event.payload.launchId !== launchId
    ) {
      continue;
    }
    latest = event.payload.outcome;
  }
  return latest;
}

/** True when one owner record's Provider root is still the exact live process. */
export function ownerRootIsLive(record: SessionOwnerIdentity): boolean {
  return isLinuxProcessLive(record.providerRoot.pid, record.providerRoot.startIdentity);
}

/** Exact tmux target for one owner, for reports and diagnostics. */
export function ownerTmuxTarget(
  home: string,
  owner: RuntimeOwner
): string {
  return yuiTmuxTarget(
    home,
    owner.scope === "task" ? owner.taskId : "operator",
    owner.roleName
  );
}
