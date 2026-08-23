import type { RuntimeOwner } from "./runtimeOwner.js";
import type {
  LinuxProcessIdentity,
  SessionOwnerIdentity
} from "./sessionOwnerIdentity.js";

/**
 * Issue 03 termination outcomes. The durable `stopped` transition is only
 * committed after `stop-confirmed`; `stop-blocked` keeps the Session
 * non-terminal and preserves every owner record for Operator recovery.
 */
export type SessionTerminationStage =
  | "stop-requested"
  | "graceful-stop"
  | "forced-stop"
  | "stop-confirmed"
  | "stop-blocked";

export type SessionTerminationEvent = Readonly<{
  stage: SessionTerminationStage;
  owner: RuntimeOwner;
  launchId?: string;
  nativeSessionId?: string;
  detail?: string;
  at: Date;
}>;

export type SessionTerminationPorts = Readonly<{
  /** Existing exact-owner tmux stop (kill-window + postcondition probe). */
  gracefulStop(owner: RuntimeOwner): Promise<boolean>;
  /** Reads one Linux process identity; undefined is a verification gap. */
  processIdentity(pid: number): LinuxProcessIdentity | undefined;
  /**
   * Whether `/proc/<pid>` exists. Distinguishes a process that has exited
   * (entry gone -> absent) from an unreadable entry (verification gap).
   */
  procEntryExists(pid: number): boolean;
  /**
   * Lists live processes carrying the exact `YUI_LAUNCH_ID` fence. Used to
   * verify Provider children after the root has exited; a process without
   * the fence is unattributed and is never signaled.
   */
  listLaunchFencedProcesses(launchId: string): readonly number[];
  signalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  signalProcessGroup(processGroupId: number, signal: "SIGTERM" | "SIGKILL"): void;
  sleep(milliseconds: number): Promise<void>;
  /** Audit sink; must never throw into the termination path. */
  emit(event: SessionTerminationEvent): void;
  now(): Date;
}>;

export type SessionTerminationResult = Readonly<{
  outcome: "stop-confirmed" | "stop-blocked";
  owner: RuntimeOwner;
  /** Records whose roots were proven absent. */
  confirmed: readonly SessionOwnerIdentity[];
  /** Records whose roots could not be proven absent. */
  remaining: readonly Readonly<{
    record: SessionOwnerIdentity;
    detail: string;
  }>[];
  /** Set when /proc could not prove physical zero (never claim confirmed). */
  verificationGap?: string;
}>;

export type SessionTerminationOptions = Readonly<{
  gracefulGraceMs?: number;
  forcedGraceMs?: number;
  pollMs?: number;
}>;

export const DEFAULT_GRACEFUL_GRACE_MS = 3_000;
export const DEFAULT_FORCED_GRACE_MS = 2_000;
export const DEFAULT_TERMINATION_POLL_MS = 100;

type TrackedFencedChildren = Map<string, Map<number, string>>;

/**
 * Stops one Role owner with physical exit proof.
 *
 * Sequence: graceful exact-owner tmux stop -> bounded grace -> forced
 * SIGTERM/SIGKILL of the exact Provider root and its process group -> final
 * /proc re-verification. Only when every owned root is absent (PID gone or
 * start identity changed) does the result become `stop-confirmed`; otherwise
 * the Session stays non-terminal and the caller must not commit `stopped`.
 *
 * PID reuse is handled structurally: liveness always pairs the PID with its
 * recorded start identity, so a recycled PID is treated as absent and never
 * signaled.
 */
export async function terminateSessionOwners(
  owner: RuntimeOwner,
  records: readonly SessionOwnerIdentity[],
  ports: SessionTerminationPorts,
  options: SessionTerminationOptions = {}
): Promise<SessionTerminationResult> {
  const gracefulGraceMs = positiveDuration(
    options.gracefulGraceMs,
    DEFAULT_GRACEFUL_GRACE_MS,
    "gracefulGraceMs"
  );
  const forcedGraceMs = positiveDuration(
    options.forcedGraceMs,
    DEFAULT_FORCED_GRACE_MS,
    "forcedGraceMs"
  );
  const pollMs = positiveDuration(
    options.pollMs,
    DEFAULT_TERMINATION_POLL_MS,
    "pollMs"
  );
  const now = ports.now();
  ports.emit({ stage: "stop-requested", owner, at: now });
  // Persist one exact launch receipt before any graceful stop can kill the
  // Host. The owner-wide event remains for compatibility and summary display.
  for (const record of records) {
    ports.emit({
      stage: "stop-requested",
      owner,
      launchId: record.launchId,
      ...(record.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: record.nativeSessionId }),
      at: now
    });
  }

  // A launch-fence scan is a point-in-time observation, not a durable owner
  // inventory: /proc entries can disappear between the directory and
  // environment reads. Retain every exact child identity observed during the
  // stop so one later scan miss cannot be mistaken for physical zero.
  const trackedChildren: TrackedFencedChildren = new Map(
    records.map((record) => [record.launchId, new Map<number, string>()])
  );
  for (const record of records) {
    refreshTrackedFencedChildren(record, ports, trackedChildren);
  }

  let gracefulOk = true;
  try {
    gracefulOk = await ports.gracefulStop(owner);
  } catch (error) {
    gracefulOk = false;
    ports.emit({
      stage: "graceful-stop",
      owner,
      detail: error instanceof Error ? error.message : String(error),
      at: ports.now()
    });
  }
  if (gracefulOk) {
    ports.emit({ stage: "graceful-stop", owner, at: ports.now() });
  }

  if (records.length === 0) {
    // No physical owner record: tmux-level cleanup is the only proof
    // available. Report the gap rather than claiming physical zero.
    return {
      outcome: gracefulOk ? "stop-confirmed" : "stop-blocked",
      owner,
      confirmed: [],
      remaining: [],
      ...(gracefulOk
        ? {}
        : { verificationGap: "no-owner-record: tmux stop unconfirmed" })
    };
  }

  // Bounded graceful grace: poll the exact owned trees for exit.
  if (await waitForTreesAbsent(records, ports, trackedChildren, gracefulGraceMs, pollMs)) {
    ports.emit({ stage: "stop-confirmed", owner, at: ports.now() });
    return {
      outcome: "stop-confirmed",
      owner,
      confirmed: records,
      remaining: []
    };
  }

  // Forced escalation against the exact roots only. A root whose identity
  // cannot be verified (verification gap) is never signaled: PID reuse
  // safety requires pairing the PID with its start identity.
  ports.emit({ stage: "forced-stop", owner, at: ports.now() });
  for (const record of records) {
    escalateRecord(record, ports, trackedChildren, "SIGTERM");
  }
  await waitForTreesAbsent(records, ports, trackedChildren, forcedGraceMs, pollMs);
  for (const record of records) {
    escalateRecord(record, ports, trackedChildren, "SIGKILL");
  }
  await waitForTreesAbsent(records, ports, trackedChildren, forcedGraceMs, pollMs);

  const remaining: Array<{ record: SessionOwnerIdentity; detail: string }> = [];
  const confirmed: SessionOwnerIdentity[] = [];
  let verificationGap: string | undefined;
  for (const record of records) {
    const verdict = treeVerdict(record, ports, trackedChildren);
    if (verdict.kind === "absent") {
      confirmed.push(record);
      continue;
    }
    if (verdict.kind === "gap") {
      verificationGap = `/proc unreadable for launch ${record.launchId}`;
      remaining.push({ record, detail: verificationGap });
      continue;
    }
    const root = rootVerdict(record, ports);
    remaining.push({
      record,
      detail: root.kind === "live"
        ? `provider root pid ${record.providerRoot.pid} still live`
        : `provider children still live for launch ${record.launchId}`
    });
  }
  const outcome = remaining.length === 0 ? "stop-confirmed" : "stop-blocked";
  ports.emit({
    stage: outcome === "stop-confirmed" ? "stop-confirmed" : "stop-blocked",
    owner,
    ...(outcome === "stop-blocked"
      ? {
          detail: remaining
            .map(({ record, detail }) => `${record.launchId}: ${detail}`)
            .join("; ")
        }
      : {}),
    at: ports.now()
  });
  return {
    outcome,
    owner,
    confirmed,
    remaining,
    ...(verificationGap === undefined ? {} : { verificationGap })
  };
}

function rootVerdict(
  record: SessionOwnerIdentity,
  ports: SessionTerminationPorts
): { kind: "absent" } | { kind: "live" } | { kind: "gap" } {
  const { pid, startIdentity } = record.providerRoot;
  const current = ports.processIdentity(pid);
  if (current === undefined) {
    // /proc unreadable or entry gone. Gone is absent; unreadable is a gap.
    return ports.procEntryExists(pid) ? { kind: "gap" } : { kind: "absent" };
  }
  // A zombie has already exited; only the unreaped task struct remains. It
  // cannot execute or hold resources, so it counts as absent for physical
  // exit proof (the parent reaping the zombie does not change liveness).
  if (current.state === "Z") return { kind: "absent" };
  return current.startIdentity === startIdentity
    ? { kind: "live" }
    : { kind: "absent" };
}

/**
 * Verdict for the whole owned tree: the Provider root plus any surviving
 * child carrying the exact launch fence. A verification gap counts as
 * present: the grace polls must not short-circuit to `stop-confirmed` while
 * `/proc` is unreadable, because that would claim physical zero without
 * proof. The final verdict turns a persistent gap into `stop-blocked`.
 */
function treeVerdict(
  record: SessionOwnerIdentity,
  ports: SessionTerminationPorts,
  trackedChildren: TrackedFencedChildren
): { kind: "absent" } | { kind: "live" } | { kind: "gap" } {
  const scanGap = refreshTrackedFencedChildren(record, ports, trackedChildren);
  const root = rootVerdict(record, ports);
  const children = trackedChildrenVerdict(record, ports, trackedChildren);
  if (root.kind === "live" || children.kind === "live") return { kind: "live" };
  if (root.kind === "gap" || children.kind === "gap" || scanGap) return { kind: "gap" };
  return { kind: "absent" };
}

function refreshTrackedFencedChildren(
  record: SessionOwnerIdentity,
  ports: SessionTerminationPorts,
  trackedChildren: TrackedFencedChildren
): boolean {
  const tracked = trackedChildren.get(record.launchId);
  if (tracked === undefined) return true;
  let verificationGap = false;
  for (const pid of ports.listLaunchFencedProcesses(record.launchId)) {
    if (pid === record.providerRoot.pid) continue;
    const identity = ports.processIdentity(pid);
    if (identity === undefined) {
      if (ports.procEntryExists(pid)) verificationGap = true;
      continue;
    }
    if (identity.state === "Z") continue;
    tracked.set(pid, identity.startIdentity);
  }
  return verificationGap;
}

function trackedChildrenVerdict(
  record: SessionOwnerIdentity,
  ports: SessionTerminationPorts,
  trackedChildren: TrackedFencedChildren
): { kind: "absent" } | { kind: "live" } | { kind: "gap" } {
  const tracked = trackedChildren.get(record.launchId);
  if (tracked === undefined) return { kind: "gap" };
  let verificationGap = false;
  for (const [pid, startIdentity] of tracked) {
    const current = ports.processIdentity(pid);
    if (current === undefined) {
      if (ports.procEntryExists(pid)) {
        verificationGap = true;
      } else {
        tracked.delete(pid);
      }
      continue;
    }
    if (current.state === "Z" || current.startIdentity !== startIdentity) {
      tracked.delete(pid);
      continue;
    }
    return { kind: "live" };
  }
  return verificationGap ? { kind: "gap" } : { kind: "absent" };
}

/**
 * Signals the exact root (only when its identity is verified) and, while the
 * root is live, its process group. When the root has already exited but a
 * fenced child survives, each fenced child is signaled individually: the
 * group can no longer be proven ours once its leader is gone.
 */
function escalateRecord(
  record: SessionOwnerIdentity,
  ports: SessionTerminationPorts,
  trackedChildren: TrackedFencedChildren,
  signal: "SIGTERM" | "SIGKILL"
): void {
  const root = rootVerdict(record, ports);
  if (root.kind === "live") {
    try {
      ports.signalProcess(record.providerRoot.pid, signal);
    } catch {
      // The root may have exited between verdict and signal; the final
      // verification is authoritative.
    }
    const { processGroupId } = record.providerRoot;
    if (processGroupId !== undefined) {
      try {
        ports.signalProcessGroup(processGroupId, signal);
      } catch {
        // Group may already be gone or the root may not be its leader.
      }
    }
    return;
  }
  if (root.kind !== "absent") return;
  refreshTrackedFencedChildren(record, ports, trackedChildren);
  const tracked = trackedChildren.get(record.launchId);
  if (tracked === undefined) return;
  for (const [pid, startIdentity] of tracked) {
    const current = ports.processIdentity(pid);
    if (
      current === undefined
      || current.state === "Z"
      || current.startIdentity !== startIdentity
    ) {
      continue;
    }
    try {
      ports.signalProcess(pid, signal);
    } catch {
      // A child may have exited between scan and signal.
    }
  }
}

async function waitForTreesAbsent(
  records: readonly SessionOwnerIdentity[],
  ports: SessionTerminationPorts,
  trackedChildren: TrackedFencedChildren,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (
      records.every(
        (record) => treeVerdict(record, ports, trackedChildren).kind === "absent"
      )
    ) {
      return true;
    }
    if (Date.now() - start >= timeoutMs) return false;
    await ports.sleep(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - start))));
  }
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return resolved;
}
