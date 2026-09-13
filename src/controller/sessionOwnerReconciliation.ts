import { existsSync } from "node:fs";
import { join } from "node:path";

import { createTaskEvent } from "../event/taskEvent.js";
import {
  createSessionOwnerIdentity,
  isLinuxProcessLive,
  listOwnedProcessTree,
  readLinuxProcessIdentity,
  reconcileSessionOwners,
  terminateSessionOwners,
  type DurableSessionFact,
  type RuntimeOwner,
  type SessionPhysicalObservation,
  type SessionReconciliationReport,
  type SessionTerminationEvent,
  type SessionTerminationPorts,
  type SessionTerminationResult
} from "../runtime/index.js";
import { sessionOwnerProcessKey, type SessionOwnerIdentity } from "../runtime/sessionOwnerIdentity.js";
import { AGENT_HOST_CONTROL_PROTOCOL, sendAgentHostCancelControl } from "../runtime/agentHost.js";
import { settleProviderTurn, cancelQuiescentProviderInput, clearProviderGoal } from "../runtime/providerRuntimeIdentity.js";
import { updateTaskRoleProviderRuntime, taskRoleControlTarget } from "../executor/agentExecutor.js";
import { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import { stopCodexNativeSession, type NativeControlConnection } from "../runtime/nativeSessionControl.js";
import { routeRoleEvent } from "../scheduler/operatorEvent.js";
import { redactAgentErrorText } from "../runtime/agentError.js";
import { runtimeCleanupDisposition, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
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
  cancelInput?: typeof sendAgentHostCancelControl;
  nativeConnection?: (taskId: string, roleName: string) => NativeControlConnection;
  stopNative?: typeof stopCodexNativeSession;
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
  readonly #cancelInput: typeof sendAgentHostCancelControl;
  readonly #nativeConnection: NonNullable<SessionOwnerReconciliationDeps["nativeConnection"]>;
  readonly #stopNative: typeof stopCodexNativeSession;

  constructor(deps: SessionOwnerReconciliationDeps) {
    this.#home = deps.home;
    this.#store = deps.store;
    this.#environment = deps.environment ?? process.env;
    this.#tmux = deps.tmux;
    this.#onWarning = deps.onWarning ?? (() => undefined);
    this.#cancelInput = deps.cancelInput ?? sendAgentHostCancelControl;
    this.#nativeConnection = deps.nativeConnection ?? ((taskId, roleName) =>
      new FileRoleLaunchPlanner(this.#home, this.#store, { environment: this.#environment })
        .planNativeControl(taskId, roleName));
    this.#stopNative = deps.stopNative ?? stopCodexNativeSession;
  }

  /**
   * Capture the created pane's concrete process identity. No inherited
   * environment marker is used to discover or claim other applications.
   */
  recordHostOwner(input: Readonly<{
    owner: RuntimeOwner;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    panePid?: number;
    runtimeRoot?: string;
  }>): void {
    const observed = input.panePid !== undefined
      ? readLinuxProcessIdentity(input.panePid)
      : undefined;
    const root = observed === undefined
      ? undefined
      : { pid: observed.pid, identity: observed };
    if (root === undefined) {
      this.#onWarning(
        `Session owner identity could not read the Host process for ${input.owner.roleName}; `
          + "no owner record was written."
      );
      return;
    }
    const owner = input.owner;
    const taskId = owner.scope === "task" ? owner.taskId : undefined;
    this.#store.saveSessionOwner(createSessionOwnerIdentity({
      owner: {
        scope: owner.scope,
        ...(taskId === undefined ? {} : { taskId }),
        roleName: owner.roleName
      },
      agentId: input.agentId,
      adapterId: input.adapterId,
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
        attribution: "pane-pid"
      },
      ...(input.runtimeRoot === undefined ? {} : { runtimeRoot: input.runtimeRoot }),
      recordedAt: new Date()
    }));
  }

  /** Read-only bidirectional reconciliation; never mutates physical state. */
  report(): SessionReconciliationReport {
    return reconcileSessionOwners({
      records: this.#store.listSessionOwners(),
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
      lastStopOutcome: (taskId, roleName) => (
        lastSessionTerminationOutcome(this.#store, taskId, roleName)
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
    const records = this.#store.listSessionOwnersForOwner(owner);
    // Killing a proxy is not cancelling its remote Turn. Settle the exact
    // owned native input before any Host signal or owner-record removal.
    try { await this.#quiesceInput(owner); } catch (error) {
      this.#recordTerminationEvent({ owner, stage: "stop-blocked",
        detail: redactAgentErrorText(error instanceof Error ? error.message : String(error)).slice(0, 2000),
        at: new Date() });
      throw error;
    }
    const result = await terminateSessionOwners(owner, records, this.#terminationPorts(), options);
    if (result.outcome === "stop-confirmed") {
      // A signalled Host exits into a retained tmux pane. Explicit release
      // removes that window too, after physical exit proof, not on observation.
      if (records.length > 0) {
        this.#tmux?.killRole(owner.scope === "task" ? owner.taskId : "operator", owner.roleName);
      }
      for (const record of result.confirmed) {
        this.#store.removeSessionOwner(sessionOwnerProcessKey(record));
      }
    }
    return result;
  }

  #terminationPorts(): SessionTerminationPorts {
    return {
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
      signalProcess: (pid, signal) => process.kill(pid, signal),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      emit: (event) => this.#recordTerminationEvent(event),
      now: () => new Date()
    };
  }

  async #quiesceInput(owner: RuntimeOwner): Promise<void> {
    if (owner.scope !== "task") return;
    if (runtimeCleanupDisposition(this.#store.getWorkMailbox(runtimeLifecycleTarget(owner))) === "detach-host") return;
    const set = this.#store.getTaskRoleSessionSet(owner.taskId, owner.roleName);
    const binding = set?.providerBinding;
    const input = binding?.run;
    const unsettled = input != null && ["submitting", "accepted", "delivery-unknown"].includes(input.status);
    const hasGoal = binding?.goal != null && binding.goal.status !== "complete";
    const selected = taskRoleControlTarget(set);
    if (set == null || (!unsettled && !hasGoal && selected?.adapterId !== "codex")) return;
    if (selected === undefined) {
      throw new Error("Cannot identify the native execution to stop.");
    }
    const request = this.#store.listEvents(owner.taskId).filter(event =>
      ["runtime.session-replacement-requested", "runtime.session-stop-requested"].includes(event.type)
      && event.payload.roleName === owner.roleName
      && event.payload.nativeSessionId === selected.nativeSessionId).at(-1);
    const operatorStop = this.#store.getTask(owner.taskId)?.executionGate.state === "stopped"
      || (request !== undefined && ["user", "operator"].includes(request.payload.requestedBy));
    if (binding?.authority.owner === "human" && !operatorStop) {
      throw new Error("This native Session is under human control; Operator/user must request its stop or replacement.");
    }
    let terminal: NonNullable<Awaited<ReturnType<typeof sendAgentHostCancelControl>>["cancellation"]>["terminal"];
    try {
      const result = unsettled && binding?.authority.owner === "controller" && binding.authority.holderId !== undefined ? await this.#cancelInput({
      home: this.#home, scope: "task", taskId: owner.taskId, roleName: owner.roleName,
      control: {
        protocol: AGENT_HOST_CONTROL_PROTOCOL, type: "cancel",
        nativeSessionId: selected.nativeSessionId,
        attemptId: input!.attemptId, authority: {
          epoch: binding.authority.epoch, owner: "controller", holderId: binding.authority.holderId
        }
      }
      }) : undefined;
      const proof = result?.cancellation?.terminal;
      if (result?.cancellation?.status !== "unknown" && proof?.clientOwned
        && proof.attemptId === input?.attemptId && proof.nativeSessionId === selected.nativeSessionId
        && (input?.nativeTurnId === undefined || proof.nativeTurnId === input.nativeTurnId)) terminal = proof;
    } catch {
      // Recovery follows the recorded native identity, not the availability of
      // the disposable Host which used to own its control socket.
    }
    if (terminal === undefined || hasGoal || selected.adapterId === "codex") {
      if (selected.adapterId === "codex") {
        await this.#stopNative(this.#nativeConnection(owner.taskId, owner.roleName), {
          conversationId: selected.nativeSessionId,
          nativeTurnId: unsettled && terminal === undefined ? input?.nativeTurnId : undefined,
          clearGoal: true
        });
      } else if (selected.adapterId === "claude") {
        const records = this.#store.listSessionOwnersForOwner(owner);
        const children = records.filter(record => record.nativeSessionId === selected.nativeSessionId
          && record.providerRoot.attribution === "owned-child");
        if (children.length > 0) {
          const stopped = await terminateSessionOwners(owner, children, this.#terminationPorts());
          if (stopped.outcome !== "stop-confirmed") throw new Error("Dedicated native execution is still draining; no resource was released.");
        } else if (selected.status !== "ended"
          || records.some(ownerRootIsLive)
          || this.#tmux?.probeRoleStatus(owner.taskId, owner.roleName) !== "exited") {
          throw new Error("Native process custody is unavailable; inspect the exact local execution before reusing its workspace.");
        }
      } else {
        throw new Error("This Provider has no detached native control proof; inspect its execution resources before replacement.");
      }
    }
    this.#store.transaction(tx => {
      const current = tx.getTaskRoleSessionSet(owner.taskId, owner.roleName);
      const provider = current?.providerBinding;
      if (current == null || provider?.run?.attemptId !== input?.attemptId
        || (selected.fromBinding
          ? current.providerBinding?.conversations.find(entry => entry.status === "current")?.conversationId
          : current.sessions[current.activeAgentId]?.nativeSessionId) !== selected.nativeSessionId
        || provider?.authority.epoch !== binding?.authority.epoch) {
        throw new Error("Native input identity changed while confirming its stop.");
      }
      if (provider != null && (provider.run != null && ["submitting", "accepted", "delivery-unknown"].includes(provider.run.status)
        || hasGoal || selected.adapterId === "codex")) {
        const now = new Date();
        let stopped = provider;
        if (unsettled && input != null) {
          stopped = terminal !== undefined && provider.run?.status === "accepted"
            ? settleProviderTurn(provider, { attemptId: input.attemptId, nativeTurnId: terminal.nativeTurnId,
                status: terminal.status, settledAt: now.toISOString() })
            : cancelQuiescentProviderInput(provider, { attemptId: input.attemptId, cancelledAt: now.toISOString(),
                reason: "Explicit Session stop; native execution quiescence independently verified." });
        }
        if (hasGoal || selected.adapterId === "codex") stopped = clearProviderGoal(stopped);
        tx.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(current, stopped, now));
        tx.saveEvent(owner.taskId, createTaskEvent(tx.nextEventId(owner.taskId), owner.taskId,
          "runtime.input-stop-confirmed", {
            roleName: owner.roleName, ...(input == null ? {} : { attemptId: input.attemptId }),
            nativeSessionId: selected.nativeSessionId, status: stopped.run?.status ?? "quiescent",
            evidence: terminal === undefined ? "native-resource-inspection" : "native-terminal",
            ...(input?.nativeTurnId === undefined ? {} : { nativeTurnId: input.nativeTurnId })
          }, now));
      } else if (selected.adapterId === "codex") {
        tx.saveEvent(owner.taskId, createTaskEvent(tx.nextEventId(owner.taskId), owner.taskId,
          "runtime.input-stop-confirmed", {
            roleName: owner.roleName, nativeSessionId: selected.nativeSessionId,
            status: "quiescent", evidence: "native-resource-inspection"
          }, new Date()));
      }
    });
  }

  #recordTerminationEvent(event: SessionTerminationEvent): void {
    const owner = event.owner;
    if (owner.scope !== "task") return;
    try {
      const last = this.#store.listEvents(owner.taskId).filter(entry =>
        entry.type === "runtime.session-termination" && entry.payload.roleName === owner.roleName).at(-1);
      if (event.stage === "stop-blocked" && last?.payload.outcome === event.stage
        && last.payload.detail === event.detail) return;
      const fact = createTaskEvent(
        this.#store.nextEventId(owner.taskId),
        owner.taskId,
        "runtime.session-termination",
        {
          roleName: owner.roleName,
          nativeSessionId: event.nativeSessionId ?? "",
          outcome: event.stage,
          ...(event.detail === undefined ? {} : { detail: event.detail })
        },
        event.at
      );
      this.#store.saveEvent(owner.taskId, fact);
      if (event.stage === "stop-blocked") routeRoleEvent(this.#store, fact, owner.roleName, "session-recovery-blocked", event.at);
    } catch (error) {
      this.#onWarning(
        `Session termination event could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

/** Projects every durable Role runtime for reconciliation. */
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
  if (current.state === "Z") {
    // Zombie: the process has exited and only the unreaped task struct
    // remains. It cannot execute or hold resources, so it is not alive.
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

/** Reads the latest termination outcome recorded for one Role. */
export function lastSessionTerminationOutcome(
  store: Pick<TaskStore, "listEvents">,
  taskId: string | undefined,
  roleName: string
): string | undefined {
  if (taskId === undefined) return undefined;
  let latest: string | undefined;
  for (const event of store.listEvents(taskId)) {
    if (event.type !== "runtime.session-termination") continue;
    if (event.payload.roleName !== roleName) continue;
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
