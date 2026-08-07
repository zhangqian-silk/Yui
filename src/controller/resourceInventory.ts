import { resolve } from "node:path";

export type ControllerInventoryScope = "current" | "all";
export type RuntimeProcessKind =
  | "controller"
  | "tmux-server"
  | "app-server"
  | "web"
  | "agent"
  | "other";
export type RuntimeResourceKind =
  | "controller"
  | "agent-session"
  | "tmux-server"
  | "app-server"
  | "web"
  | "process"
  | "artifact";
export type RuntimeResourceState =
  | "current"
  | "running"
  | "superseded"
  | "orphaned"
  | "unattributed"
  | "stale"
  | "dead";
export type CleanupDisposition = "safe" | "review" | "protected" | "report-only";

export type RuntimeProcessFact = Readonly<{
  pid: number;
  ppid: number;
  uid: number;
  startIdentity: string;
  yuiHome?: string;
  kind: RuntimeProcessKind;
  command: string;
  args: readonly string[];
  rssBytes: number;
  cpuTimeMs: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
  ageMs: number;
}>;

export type RuntimeProcessInfo = Readonly<Omit<RuntimeProcessFact, "args" | "kind" | "yuiHome">>;

export type RuntimePaneFact = Readonly<{
  taskId: string;
  roleName: string;
  target: string;
  dead: boolean;
  pid?: number;
  currentCommand: string;
}>;

export type RuntimeRoleFact = Readonly<{
  ownerKind: "task-role" | "global-role";
  taskId?: string;
  taskTitle?: string;
  taskStatus?: "draft" | "active" | "completed" | "retired" | "archived";
  roleName: string;
  agentId: string;
  adapterId?: string;
  nativeSessionId?: string;
  launchId?: string;
  runId?: string;
}>;

export type RuntimeArtifactFact = Readonly<{
  artifactKind: "controller-discovery" | "controller-socket" | "tmux-socket";
  path: string;
  active: boolean;
  fingerprint: string;
}>;

export type ControllerDiscoveryFact =
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "invalid";
      artifact?: RuntimeArtifactFact;
    }>
  | Readonly<{
      status: "valid";
      pid: number;
      processStartIdentity: string;
      socketPath: string;
      socketActive: boolean;
      fingerprint: string;
    }>;

export type RuntimeHomeFact = Readonly<{
  yuiHome: string;
  exists: boolean;
  storageStatus: "current" | "uninitialized" | "invalid" | "unsupported";
  discovery: ControllerDiscoveryFact;
  panes: readonly RuntimePaneFact[];
  roles: readonly RuntimeRoleFact[];
  artifacts: readonly RuntimeArtifactFact[];
}>;

export type RuntimeOwner =
  | Readonly<{ kind: "controller-domain"; yuiHome: string }>
  | Readonly<{
      kind: "task-role";
      taskId: string;
      taskTitle?: string;
      taskStatus?: "draft" | "active" | "completed" | "retired" | "archived";
      roleName: string;
      agentId: string;
      adapterId?: string;
      nativeSessionId?: string;
      launchId?: string;
      runId?: string;
    }>
  | Readonly<{
      kind: "global-role";
      roleName: string;
      agentId: string;
      adapterId?: string;
      nativeSessionId?: string;
      launchId?: string;
      runId?: string;
    }>
  | Readonly<{ kind: "none" }>;

export type RuntimeResource = Readonly<{
  id: string;
  fingerprint: string;
  kind: RuntimeResourceKind;
  state: RuntimeResourceState;
  disposition: CleanupDisposition;
  reasonCode: string;
  yuiHome?: string;
  owner: RuntimeOwner;
  processes: readonly RuntimeProcessInfo[];
  rssBytes: number;
  cpuTimeMs: number;
  ioReadBytes?: number;
  ioWriteBytes?: number;
  ageMs: number;
  target?: string;
  artifact?: RuntimeArtifactFact;
}>;

/** Exact identity carried by one bounded Role resource sample. */
export type RuntimeResourceSampleIdentity = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
}>;

/**
 * Keeps only the immediately previous sample for each Role. The cache is
 * intentionally process-local: a Controller restart starts with a baseline
 * sample and cannot infer progress from cumulative counters left by an older
 * Controller instance.
 */
export type RuntimeResourceActivityTracker = (
  identity: RuntimeResourceSampleIdentity,
  resource: RuntimeResource
) => boolean;

export function createRuntimeResourceActivityTracker(): RuntimeResourceActivityTracker {
  const previous = new Map<string, Readonly<{
    identity: string;
    fingerprint: string;
    cpuTimeMs: number;
    ioReadBytes?: number;
    ioWriteBytes?: number;
  }>>();
  return (identity, resource) => {
    if (!matchesResourceIdentity(identity, resource.owner)) return false;
    if (resource.processes.length === 0) return false;
    const cpuTimeMs = nonNegativeCounter(resource.cpuTimeMs);
    if (cpuTimeMs === undefined) return false;
    const ioReadBytes = optionalCounter(resource.ioReadBytes);
    const ioWriteBytes = optionalCounter(resource.ioWriteBytes);
    const roleKey = `${identity.taskId}\0${identity.roleName}`;
    const identityKey = JSON.stringify([
      identity.runId,
      identity.agentId,
      identity.adapterId,
      identity.nativeSessionId ?? null,
      identity.launchId ?? null
    ]);
    const current = {
      identity: identityKey,
      fingerprint: resource.fingerprint,
      cpuTimeMs,
      ...(ioReadBytes === undefined ? {} : { ioReadBytes }),
      ...(ioWriteBytes === undefined ? {} : { ioWriteBytes })
    };
    const prior = previous.get(roleKey);
    previous.set(roleKey, current);
    if (
      prior === undefined
      || prior.identity !== current.identity
      || prior.fingerprint !== current.fingerprint
    ) return false;
    // Counter resets are a new baseline, not evidence of progress. Replacing
    // the stored sample above lets a subsequent increase become observable.
    if (
      cpuTimeMs < prior.cpuTimeMs
      || counterReset(ioReadBytes, prior.ioReadBytes)
      || counterReset(ioWriteBytes, prior.ioWriteBytes)
    ) return false;
    return cpuTimeMs > prior.cpuTimeMs
      || counterIncrease(ioReadBytes, prior.ioReadBytes)
      || counterIncrease(ioWriteBytes, prior.ioWriteBytes);
  };
}

export type RuntimeDomainSummary = Readonly<{
  yuiHome: string;
  storageStatus: RuntimeHomeFact["storageStatus"];
  resourceCount: number;
  liveProcessCount: number;
  rssBytes: number;
  issueCount: number;
}>;

export type ControllerResourceInventory = Readonly<{
  schemaVersion: 1;
  observedAt: string;
  currentHome: string;
  scope: ControllerInventoryScope;
  summary: Readonly<{
    domainCount: number;
    resourceCount: number;
    liveProcessCount: number;
    rssBytes: number;
    byDisposition: Readonly<Record<CleanupDisposition, number>>;
  }>;
  domains: readonly RuntimeDomainSummary[];
  resources: readonly RuntimeResource[];
  warnings: readonly string[];
}>;

export type ControllerInventoryFacts = Readonly<{
  schemaVersion: 1;
  observedAt: string;
  currentHome: string;
  scope: ControllerInventoryScope;
  processes: readonly RuntimeProcessFact[];
  homes: readonly RuntimeHomeFact[];
  globalArtifacts: readonly RuntimeArtifactFact[];
  warnings?: readonly string[];
}>;

export function buildControllerResourceInventory(
  facts: ControllerInventoryFacts
): ControllerResourceInventory {
  const currentHome = resolve(facts.currentHome);
  const processes = [...facts.processes];
  const resources: RuntimeResource[] = [];
  const claimed = new Set<number>();

  for (const homeFact of facts.homes) {
    const yuiHome = resolve(homeFact.yuiHome);
    const homeProcesses = processes.filter((process) => process.yuiHome === yuiHome);
    const currentController = currentControllerProcess(homeFact.discovery, homeProcesses);

    for (const process of homeProcesses.filter(({ kind }) => kind === "controller")) {
      claimed.add(process.pid);
      const exactCurrent = currentController?.pid === process.pid
        && currentController.startIdentity === process.startIdentity;
      const superseded = !exactCurrent && currentController !== undefined;
      const safeEmptyOrphan = !homeFact.exists
        && processes.every((candidate) => (
          candidate.pid === process.pid || candidate.ppid !== process.pid
        ))
        && homeFact.panes.length === 0;
      resources.push(processResource({
        kind: "controller",
        state: exactCurrent ? "current" : superseded ? "superseded" : "orphaned",
        disposition: exactCurrent
          ? "protected"
          : superseded || safeEmptyOrphan ? "safe" : "review",
        reasonCode: exactCurrent
          ? "current-controller"
          : superseded
            ? "superseded-controller"
            : safeEmptyOrphan
              ? "orphan-controller-empty-home"
              : "orphan-controller",
        yuiHome,
        owner: { kind: "controller-domain", yuiHome },
        processes: [process]
      }));
    }

    for (const pane of homeFact.panes) {
      const paneProcesses = pane.pid === undefined
        ? []
        : processTree(processes, pane.pid);
      for (const process of paneProcesses) claimed.add(process.pid);
      const role = findRole(homeFact.roles, pane);
      const archived = role?.taskStatus === "archived";
      resources.push(processResource({
        kind: "agent-session",
        state: pane.dead ? "dead" : role === undefined ? "orphaned" : "running",
        disposition: role === undefined
          ? pane.dead ? "safe" : "review"
          : archived ? "safe" : "protected",
        reasonCode: role === undefined
          ? pane.dead ? "dead-orphan-pane" : "orphan-pane"
          : archived ? "archived-task-pane" : "owned-role-pane",
        yuiHome,
        owner: role === undefined ? { kind: "none" } : roleOwner(role),
        processes: paneProcesses,
        target: pane.target
      }));
    }

    for (const process of homeProcesses) {
      if (claimed.has(process.pid)) continue;
      claimed.add(process.pid);
      const kind = publicProcessKind(process.kind);
      const ownedTmuxServer = process.kind === "tmux-server"
        && homeFact.panes.length > 0;
      const disposition: CleanupDisposition = ownedTmuxServer
        ? "protected"
        : process.kind === "app-server"
          || process.kind === "agent"
          || process.kind === "tmux-server"
          ? "review"
          : "report-only";
      resources.push(processResource({
        kind,
        state: ownedTmuxServer
          ? "running"
          : disposition === "review" ? "orphaned" : "unattributed",
        disposition,
        reasonCode: ownedTmuxServer
          ? "owned-tmux-server"
          : disposition === "review"
            ? `orphan-${process.kind}`
            : `unattributed-${process.kind}`,
        yuiHome,
        owner: ownedTmuxServer
          ? { kind: "controller-domain", yuiHome }
          : { kind: "none" },
        processes: [process]
      }));
    }

    const discoveryArtifact = homeFact.discovery.status === "invalid"
      ? homeFact.discovery.artifact
      : homeFact.discovery.status === "valid" && currentController === undefined
        ? homeFact.artifacts.find(({ artifactKind }) => artifactKind === "controller-discovery")
        : undefined;
    const artifacts = discoveryArtifact === undefined
      ? homeFact.artifacts
      : [discoveryArtifact, ...homeFact.artifacts.filter((artifact) => (
          artifact.path !== discoveryArtifact.path
        ))];
    for (const artifact of artifacts) {
      resources.push(artifactResource(artifact, yuiHome));
    }
  }

  for (const artifact of facts.globalArtifacts) {
    resources.push(artifactResource(artifact));
  }

  const ordered = resources.sort(compareResources);
  const domains = facts.homes.map((home): RuntimeDomainSummary => {
    const yuiHome = resolve(home.yuiHome);
    const owned = ordered.filter((resource) => resource.yuiHome === yuiHome);
    return {
      yuiHome,
      storageStatus: home.storageStatus,
      resourceCount: owned.length,
      liveProcessCount: uniqueProcesses(owned).length,
      rssBytes: sum(uniqueProcesses(owned).map(({ rssBytes }) => rssBytes)),
      issueCount: owned.filter(({ disposition }) => disposition !== "protected").length
    };
  }).sort((left, right) => left.yuiHome.localeCompare(right.yuiHome));
  const allProcesses = uniqueProcesses(ordered);
  const byDisposition: Record<CleanupDisposition, number> = {
    safe: 0,
    review: 0,
    protected: 0,
    "report-only": 0
  };
  for (const resource of ordered) byDisposition[resource.disposition] += 1;
  return {
    schemaVersion: 1,
    observedAt: facts.observedAt,
    currentHome,
    scope: facts.scope,
    summary: {
      domainCount: domains.length,
      resourceCount: ordered.length,
      liveProcessCount: allProcesses.length,
      rssBytes: sum(allProcesses.map(({ rssBytes }) => rssBytes)),
      byDisposition
    },
    domains,
    resources: ordered,
    warnings: [...(facts.warnings ?? [])]
  };
}

function currentControllerProcess(
  discovery: ControllerDiscoveryFact,
  processes: readonly RuntimeProcessFact[]
): RuntimeProcessFact | undefined {
  if (discovery.status !== "valid") return undefined;
  return processes.find((process) => (
    process.kind === "controller"
    && process.pid === discovery.pid
    && process.startIdentity === discovery.processStartIdentity
  ));
}

function findRole(
  roles: readonly RuntimeRoleFact[],
  pane: RuntimePaneFact
): RuntimeRoleFact | undefined {
  if (pane.taskId === "operator") {
    return roles.find((role) => (
      role.ownerKind === "global-role" && role.roleName === pane.roleName
    ));
  }
  return roles.find((role) => (
    role.ownerKind === "task-role"
    && role.taskId === pane.taskId
    && role.roleName === pane.roleName
  ));
}

function roleOwner(role: RuntimeRoleFact): RuntimeOwner {
  if (role.ownerKind === "global-role") {
    return {
      kind: "global-role",
      roleName: role.roleName,
      agentId: role.agentId,
      ...(role.adapterId === undefined ? {} : { adapterId: role.adapterId }),
      ...(role.nativeSessionId === undefined ? {} : { nativeSessionId: role.nativeSessionId }),
      ...(role.launchId === undefined ? {} : { launchId: role.launchId }),
      ...(role.runId === undefined ? {} : { runId: role.runId })
    };
  }
  return {
    kind: "task-role",
    taskId: role.taskId ?? "",
    ...(role.taskTitle === undefined ? {} : { taskTitle: role.taskTitle }),
    ...(role.taskStatus === undefined ? {} : { taskStatus: role.taskStatus }),
    roleName: role.roleName,
    agentId: role.agentId,
    ...(role.adapterId === undefined ? {} : { adapterId: role.adapterId }),
    ...(role.nativeSessionId === undefined ? {} : { nativeSessionId: role.nativeSessionId }),
    ...(role.launchId === undefined ? {} : { launchId: role.launchId }),
    ...(role.runId === undefined ? {} : { runId: role.runId })
  };
}

function processTree(
  processes: readonly RuntimeProcessFact[],
  rootPid: number
): RuntimeProcessFact[] {
  const byParent = new Map<number, RuntimeProcessFact[]>();
  for (const process of processes) {
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const root = processes.find(({ pid }) => pid === rootPid);
  if (root === undefined) return [];
  const result: RuntimeProcessFact[] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current.pid)) continue;
    seen.add(current.pid);
    result.push(current);
    queue.push(...(byParent.get(current.pid) ?? []));
  }
  return result;
}

function processResource(input: Readonly<{
  kind: RuntimeResourceKind;
  state: RuntimeResourceState;
  disposition: CleanupDisposition;
  reasonCode: string;
  yuiHome: string;
  owner: RuntimeOwner;
  processes: readonly RuntimeProcessFact[];
  target?: string;
}>): RuntimeResource {
  const processes = input.processes.map(publicProcess);
  const identity = processes.map(({ pid, startIdentity }) => `${pid}:${startIdentity}`).sort().join(",");
  return {
    id: `${input.kind}:${input.yuiHome}:${input.target ?? (identity || input.reasonCode)}`,
    fingerprint: `${input.kind}:${identity}:${input.target ?? ""}`,
    kind: input.kind,
    state: input.state,
    disposition: input.disposition,
    reasonCode: input.reasonCode,
    yuiHome: input.yuiHome,
    owner: input.owner,
    processes,
    rssBytes: sum(processes.map(({ rssBytes }) => rssBytes)),
    cpuTimeMs: sum(processes.map(({ cpuTimeMs }) => cpuTimeMs)),
    ...optionalCounterFields(processes, "ioReadBytes"),
    ...optionalCounterFields(processes, "ioWriteBytes"),
    ageMs: max(processes.map(({ ageMs }) => ageMs)),
    ...(input.target === undefined ? {} : { target: input.target })
  };
}

function artifactResource(
  artifact: RuntimeArtifactFact,
  yuiHome?: string
): RuntimeResource {
  const stale = !artifact.active;
  return {
    id: `artifact:${artifact.path}`,
    fingerprint: artifact.fingerprint,
    kind: "artifact",
    state: stale ? "stale" : "unattributed",
    disposition: stale ? "safe" : "report-only",
    reasonCode: stale ? `stale-${artifact.artifactKind}` : `active-unmapped-${artifact.artifactKind}`,
    ...(yuiHome === undefined ? {} : { yuiHome }),
    owner: yuiHome === undefined
      ? { kind: "none" }
      : { kind: "controller-domain", yuiHome },
    processes: [],
    rssBytes: 0,
    cpuTimeMs: 0,
    ageMs: 0,
    artifact
  };
}

function publicProcess(process: RuntimeProcessFact): RuntimeProcessInfo {
  return {
    pid: process.pid,
    ppid: process.ppid,
    uid: process.uid,
    startIdentity: process.startIdentity,
    command: process.command,
    rssBytes: process.rssBytes,
    cpuTimeMs: process.cpuTimeMs,
    ...(process.ioReadBytes === undefined ? {} : { ioReadBytes: process.ioReadBytes }),
    ...(process.ioWriteBytes === undefined ? {} : { ioWriteBytes: process.ioWriteBytes }),
    ageMs: process.ageMs
  };
}

function optionalCounterFields(
  processes: readonly Readonly<{
    ioReadBytes?: number;
    ioWriteBytes?: number;
  }>[],
  field: "ioReadBytes" | "ioWriteBytes"
): Readonly<{ ioReadBytes?: number; ioWriteBytes?: number }> {
  const values = processes
    .map((process) => process[field])
    .filter((value): value is number => value !== undefined);
  return values.length === 0
    ? {}
    : field === "ioReadBytes"
      ? { ioReadBytes: sum(values) }
      : { ioWriteBytes: sum(values) };
}

function matchesResourceIdentity(
  identity: RuntimeResourceSampleIdentity,
  owner: RuntimeOwner
): boolean {
  if (
    owner.kind !== "task-role"
    || owner.taskId !== identity.taskId
    || owner.roleName !== identity.roleName
    || owner.runId !== identity.runId
    || owner.agentId !== identity.agentId
    || owner.adapterId !== identity.adapterId
  ) return false;
  if (identity.nativeSessionId === undefined && identity.launchId === undefined) return false;
  if (
    identity.nativeSessionId !== undefined
    && owner.nativeSessionId !== identity.nativeSessionId
  ) return false;
  if (identity.launchId !== undefined && owner.launchId !== identity.launchId) return false;
  return true;
}

function nonNegativeCounter(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalCounter(value: number | undefined): number | undefined {
  return nonNegativeCounter(value);
}

function counterReset(current: number | undefined, prior: number | undefined): boolean {
  return current !== undefined && prior !== undefined && current < prior;
}

function counterIncrease(current: number | undefined, prior: number | undefined): boolean {
  return current !== undefined && prior !== undefined && current > prior;
}

function publicProcessKind(kind: RuntimeProcessKind): RuntimeResourceKind {
  switch (kind) {
    case "tmux-server": return "tmux-server";
    case "app-server": return "app-server";
    case "web": return "web";
    default: return "process";
  }
}

function uniqueProcesses(resources: readonly RuntimeResource[]): RuntimeProcessInfo[] {
  const processes = new Map<string, RuntimeProcessInfo>();
  for (const resource of resources) {
    for (const process of resource.processes) {
      processes.set(`${process.pid}:${process.startIdentity}`, process);
    }
  }
  return [...processes.values()];
}

function compareResources(left: RuntimeResource, right: RuntimeResource): number {
  const home = (left.yuiHome ?? "\uffff").localeCompare(right.yuiHome ?? "\uffff");
  if (home !== 0) return home;
  const kind = resourceKindOrder(left.kind) - resourceKindOrder(right.kind);
  if (kind !== 0) return kind;
  return left.id.localeCompare(right.id);
}

function resourceKindOrder(kind: RuntimeResourceKind): number {
  return [
    "controller",
    "agent-session",
    "tmux-server",
    "app-server",
    "web",
    "process",
    "artifact"
  ].indexOf(kind);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function max(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}
