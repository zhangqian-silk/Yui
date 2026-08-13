import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  type Stats
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { activeLiveRoleAgentSession } from "../executor/agentExecutor.js";
import {
  inspectStorageSchema,
  type StorageSchemaState
} from "../storage/storageSchema.js";
import { openCompatibleFileTaskStore } from "../storage/compatibleTaskStore.js";
import { NodeCommandExecutor } from "../tmux/commandExecutor.js";
import {
  TmuxManager,
  yuiTmuxServerName
} from "../tmux/tmuxManager.js";
import { readControllerDiscovery } from "../core/controllerClient.js";
import {
  CONTROLLER_DISCOVERY_PATH
} from "../core/protocol.js";
import { controllerSocketPath } from "../core/controllerEndpoint.js";
import {
  buildControllerResourceInventory,
  type ControllerDiscoveryFact,
  type ControllerInventoryScope,
  type ControllerResourceInventory,
  type RuntimeArtifactFact,
  type RuntimeHomeFact,
  type RuntimePaneFact,
  type RuntimeProcessFact,
  type RuntimeProcessKind,
  type RuntimeRoleFact
} from "./resourceInventory.js";
import {
  CONTROLLER_DOMAIN_PATH,
  EPHEMERAL_DOMAIN_GRACE_MS,
  ephemeralDomainFingerprint,
  readEphemeralDomainIdentity,
  readLinuxProcessStartIdentity
} from "./domainIdentity.js";

export type ControllerInventoryScanOptions = Readonly<{
  currentHome: string;
  scope: ControllerInventoryScope;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Reuse the caller's one full pane inventory when already available. */
  panes?: readonly RuntimePaneFact[];
  inspectStorage?: (home: string) => StorageSchemaState;
  openCompatibleStore?: (
    home: string
  ) => ReturnType<typeof openCompatibleFileTaskStore>;
}>;

type LinuxProcessStat = Readonly<{
  ppid: number;
  startIdentity: string;
  cpuTimeMs: number;
  ageMs: number;
}>;

type LinuxProcessIo = Readonly<{
  ioReadBytes: number;
  ioWriteBytes: number;
}>;

const LINUX_PROCESS_SCAN_BATCH_SIZE = 64;

export async function scanControllerResourceInventory(
  options: ControllerInventoryScanOptions
): Promise<ControllerResourceInventory> {
  const currentHome = resolve(options.currentHome);
  const environment = options.environment ?? process.env;
  const observedAt = (options.now ?? (() => new Date()))();
  const warnings: string[] = [];
  const activeSockets = readActiveUnixSocketPaths(warnings);
  const processes = (await listLinuxProcesses(warnings))
    .filter(({ pid }) => pid !== process.pid);
  const homes = new Set<string>([currentHome]);
  if (options.scope === "all") {
    for (const process of processes) {
      if (process.yuiHome !== undefined) homes.add(process.yuiHome);
    }
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const rawTmuxArtifacts = listSocketArtifacts(
    join(tmpdir(), `tmux-${uid}`),
    /^yui-[a-f0-9]{24}$/u,
    "tmux-socket",
    activeSockets
  );
  const homeFacts: RuntimeHomeFact[] = [];
  const associatedArtifacts = new Set<string>();
  for (const home of [...homes].sort()) {
    const matchingProcesses = processes.filter(({ yuiHome }) => yuiHome === home);
    const state = loadHomeState(home, warnings, options);
    const domain = inspectRuntimeDomain(
      home,
      matchingProcesses,
      state.roles,
      state.storageStatus,
      observedAt
    );
    const tmuxSocketPath = join(tmpdir(), `tmux-${uid}`, yuiTmuxServerName(home));
    const tmuxArtifact = rawTmuxArtifacts.find(({ path }) => path === tmuxSocketPath);
    if (tmuxArtifact !== undefined) associatedArtifacts.add(tmuxArtifact.path);
    const panes = options.panes !== undefined
      ? options.panes
      : tmuxArtifact?.active === true
        ? inspectHomePanes(home, environment.YUI_TMUX_BIN ?? "tmux", warnings)
        : [];
    const discovery = await inspectDiscovery(home, matchingProcesses, activeSockets);
    if (
      discovery.status === "valid"
      && !discovery.socketActive
      && matchingProcesses.some((candidate) => (
        candidate.kind === "controller"
        && candidate.pid === discovery.pid
        && candidate.startIdentity === discovery.processStartIdentity
      ))
    ) {
      warnings.push(`Controller socket is not reachable for ${home}.`);
    }
    const artifacts: RuntimeArtifactFact[] = [];
    if (discovery.status === "invalid" && discovery.artifact !== undefined) {
      associatedArtifacts.add(discovery.artifact.path);
    }
    // Keep active sockets visible as report-only resources too. An expired
    // domain must not self-close while its tmux namespace is still active;
    // the next bounded pass can reclassify the exact socket after the pane and
    // server converge.
    if (tmuxArtifact !== undefined) artifacts.push(tmuxArtifact);

    const domainPath = join(home, CONTROLLER_DOMAIN_PATH);
    const domainIdentity = readEphemeralDomainIdentity(home);
    if (domainIdentity.status !== "absent" && existsSync(domainPath)) {
      artifacts.push(fileArtifact(
        domainPath,
        "domain-identity",
        domain?.liveness === "active"
      ));
    }

    const validDiscoveryProcess = discovery.status === "valid"
      && (
        matchingProcesses.some((candidate) => (
          candidate.pid === discovery.pid
          && candidate.startIdentity === discovery.processStartIdentity
        ))
        // The scanner omits its own process from signalable resources. A
        // Controller nevertheless must recognize its exact discovery fence;
        // otherwise its own expired-domain pass would delete controller.json
        // and strand the still-running server without a callable endpoint.
        || (
          discovery.pid === process.pid
          && readLinuxProcessStartIdentity(process.pid) === discovery.processStartIdentity
        )
      );
    const discoveryPath = join(home, CONTROLLER_DISCOVERY_PATH);
    const expectedControllerSocketPath = controllerSocketPath(home);
    if (
      discovery.status === "valid"
      && !validDiscoveryProcess
      && existsSync(discoveryPath)
    ) {
      artifacts.push(fileArtifact(discoveryPath, "controller-discovery", false));
    }
    if (
      existsSync(expectedControllerSocketPath)
      && !activeSockets.has(expectedControllerSocketPath)
      && !validDiscoveryProcess
    ) {
      artifacts.push(fileArtifact(expectedControllerSocketPath, "controller-socket", false));
    }

    homeFacts.push({
      yuiHome: home,
      exists: existsSync(home),
      storageStatus: state.storageStatus,
      discovery,
      panes,
      roles: state.roles,
      artifacts,
      ...(domain === undefined ? {} : { domain })
    });
  }

  const globalArtifacts = options.scope === "all"
    ? rawTmuxArtifacts.filter(({ path }) => (
        !associatedArtifacts.has(path)
      ))
    : [];
  return buildControllerResourceInventory({
    schemaVersion: 1,
    observedAt: observedAt.toISOString(),
    currentHome,
    scope: options.scope,
    processes: options.scope === "all"
      ? processes
      : processes.filter(({ yuiHome }) => yuiHome === currentHome),
    homes: homeFacts,
    globalArtifacts,
    warnings
  });
}

export function parseLinuxProcessStat(
  stat: string,
  clockTicks: number,
  systemUptimeMs: number
): LinuxProcessStat {
  const closing = stat.lastIndexOf(")");
  if (closing < 0) throw new Error("Linux process stat command is invalid.");
  const fields = stat.slice(closing + 1).trim().split(/\s+/u);
  const ppid = Number(fields[1]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startIdentity = fields[19];
  if (
    !Number.isSafeInteger(ppid)
    || ppid < 0
    || !Number.isFinite(userTicks)
    || userTicks < 0
    || !Number.isFinite(systemTicks)
    || systemTicks < 0
    || startIdentity === undefined
    || !/^[0-9]{1,32}$/u.test(startIdentity)
    || !Number.isFinite(clockTicks)
    || clockTicks <= 0
  ) {
    throw new Error("Linux process stat fields are invalid.");
  }
  const startTicks = Number(startIdentity);
  return {
    ppid,
    startIdentity,
    cpuTimeMs: Math.max(0, Math.round((userTicks + systemTicks) * 1000 / clockTicks)),
    ageMs: Math.max(0, Math.round(systemUptimeMs - startTicks * 1000 / clockTicks))
  };
}

export function classifyRuntimeProcess(
  args: readonly string[],
  command: string
): RuntimeProcessKind {
  if (args.some((argument) => /(?:^|\/)controllerMain\.js$/u.test(argument))) {
    return "controller";
  }
  if (args.includes("app-server")) return "app-server";
  if (
    command.startsWith("tmux: server")
    || args.some((argument, index) => (
      argument === "-L"
      && /^yui-[a-f0-9]{24}$/u.test(args[index + 1] ?? "")
    ))
  ) {
    return "tmux-server";
  }
  const executable = basename(args[0] ?? command);
  if (
    args.includes("web")
    && args.some((argument) => /(?:^|\/)(?:cli|yui)(?:\.js)?$/u.test(argument))
  ) {
    return "web";
  }
  if (executable === "codex" || executable === "claude") return "agent";
  return "other";
}

async function listLinuxProcesses(warnings: string[]): Promise<RuntimeProcessFact[]> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const clockTicks = readClockTicks();
  const uptimeMs = readSystemUptimeMs();
  let entries;
  try {
    // Request names only. On some Node/filesystem combinations, Dirent
    // construction may lstat unknown /proc entries while readdir is still in
    // progress; a process exiting in that window aborts the whole inventory.
    entries = readdirSync("/proc", { encoding: "utf8" });
  } catch (error) {
    warnings.push(`Cannot enumerate Linux processes: ${message(error)}`);
    return [];
  }
  const result: RuntimeProcessFact[] = [];
  await forEachInEventLoopBatches(
    entries,
    LINUX_PROCESS_SCAN_BATCH_SIZE,
    (entryName) => {
      const pid = linuxProcessEntryPid(entryName);
      if (pid === undefined) return;
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const processUid = parseStatusNumber(status, "Uid");
        if (processUid === uid) {
          const parsed = parseLinuxProcessStat(
            readFileSync(`/proc/${pid}/stat`, "utf8"),
            clockTicks,
            uptimeMs
          );
          const args = splitNullDelimited(readFileSync(`/proc/${pid}/cmdline`));
          const command = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
          const yuiHome = readYuiHome(pid);
          const io = readProcessIo(pid);
          result.push({
            pid,
            ppid: parsed.ppid,
            uid: processUid,
            startIdentity: parsed.startIdentity,
            ...(yuiHome === undefined ? {} : { yuiHome }),
            kind: classifyRuntimeProcess(args, command),
            command,
            args,
            rssBytes: parseStatusNumber(status, "VmRSS", 0) * 1024,
            cpuTimeMs: parsed.cpuTimeMs,
            ...(io === undefined ? {} : io),
            ageMs: parsed.ageMs
          });
        }
      } catch {
        // Processes commonly exit during a /proc scan. A point-in-time inventory
        // omits those races instead of turning them into persistent warnings.
      }
    }
  );
  return result;
}

/** Cooperatively visits synchronous inventory entries in bounded turns. */
export async function forEachInEventLoopBatches<T>(
  entries: readonly T[],
  batchSize: number,
  visit: (entry: T, index: number) => void
): Promise<void> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("Event-loop batch size must be a positive integer.");
  }
  for (let index = 0; index < entries.length; index += 1) {
    visit(entries[index]!, index);
    if ((index + 1) % batchSize === 0 && index + 1 < entries.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * Resolve one numeric /proc entry name without asking the filesystem for
 * entry metadata. Its process files are then read inside the per-PID race
 * boundary above.
 */
export function linuxProcessEntryPid(
  entryName: string
): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(entryName)) return undefined;
  const pid = Number(entryName);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function readYuiHome(pid: number): string | undefined {
  const environment = splitNullDelimited(readFileSync(`/proc/${pid}/environ`));
  const entry = environment.find((value) => value.startsWith("YUI_HOME="));
  const value = entry?.slice("YUI_HOME=".length);
  return value === undefined || value.length === 0 ? undefined : resolve(value);
}

function readProcessIo(pid: number): LinuxProcessIo | undefined {
  try {
    const contents = readFileSync(`/proc/${pid}/io`, "utf8");
    const readBytes = parseOptionalIoCounter(contents, "read_bytes");
    const writeBytes = parseOptionalIoCounter(contents, "write_bytes");
    return readBytes === undefined || writeBytes === undefined
      ? undefined
      : { ioReadBytes: readBytes, ioWriteBytes: writeBytes };
  } catch {
    // /proc/<pid>/io can disappear or be restricted during a point-in-time scan.
    // CPU/RSS inventory remains useful, but no IO activity is inferred.
    return undefined;
  }
}

function parseOptionalIoCounter(contents: string, label: string): number | undefined {
  const match = new RegExp(`^${label}:\\s+([0-9]+)`, "mu").exec(contents);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function splitNullDelimited(value: Buffer): string[] {
  return value.toString("utf8").split("\0").filter((entry) => entry.length > 0);
}

function parseStatusNumber(status: string, label: string, fallback?: number): number {
  const match = new RegExp(`^${label}:\\s+([0-9]+)`, "mu").exec(status);
  if (match === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Linux process ${label} is unavailable.`);
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Linux process ${label} is invalid.`);
  }
  return value;
}

function readClockTicks(): number {
  const result = spawnSync("getconf", ["CLK_TCK"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const value = Number(result.stdout?.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : 100;
}

function readSystemUptimeMs(): number {
  const seconds = Number(readFileSync("/proc/uptime", "utf8").split(/\s+/u)[0]);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("Linux system uptime is invalid.");
  }
  return seconds * 1000;
}

function readActiveUnixSocketPaths(warnings: string[]): Set<string> {
  try {
    const lines = readFileSync("/proc/net/unix", "utf8").split("\n").slice(1);
    return new Set(lines.flatMap((line): string[] => {
      const fields = line.trim().split(/\s+/u);
      const path = fields[7];
      return path === undefined || !path.startsWith("/") ? [] : [path];
    }));
  } catch (error) {
    warnings.push(`Cannot inspect Unix sockets: ${message(error)}`);
    return new Set();
  }
}

function listSocketArtifacts(
  directory: string,
  pattern: RegExp,
  artifactKind: RuntimeArtifactFact["artifactKind"],
  activeSockets: ReadonlySet<string>
): RuntimeArtifactFact[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (!pattern.test(entry.name)) return [];
      const path = join(directory, entry.name);
      let metadata: Stats;
      try {
        metadata = lstatSync(path);
      } catch {
        return [];
      }
      if (!metadata.isSocket()) return [];
      return [{
        artifactKind,
        path,
        active: activeSockets.has(path),
        fingerprint: statFingerprint(metadata)
      }];
    });
  } catch {
    return [];
  }
}

async function inspectDiscovery(
  home: string,
  processes: readonly RuntimeProcessFact[],
  activeSockets: ReadonlySet<string>
): Promise<ControllerDiscoveryFact> {
  const path = join(home, CONTROLLER_DISCOVERY_PATH);
  try {
    const discovery = await readControllerDiscovery(home);
    return {
      status: "valid",
      pid: discovery.pid,
      processStartIdentity: discovery.processStartIdentity,
      socketPath: discovery.socketPath,
      socketActive: activeSockets.has(discovery.socketPath),
      fingerprint: existsSync(path)
        ? statFingerprint(lstatSync(path))
        : `${discovery.pid}:${discovery.processStartIdentity}`
    };
  } catch (error) {
    if (!existsSync(path)) return { status: "absent" };
    const artifact = fileArtifact(path, "controller-discovery", false);
    const possibleOwner = processes.some(({ kind }) => kind === "controller");
    return possibleOwner
      ? { status: "invalid", artifact: { ...artifact, active: true } }
      : { status: "invalid", artifact };
  }
}

function inspectRuntimeDomain(
  home: string,
  processes: readonly RuntimeProcessFact[],
  roles: readonly RuntimeRoleFact[],
  storageStatus: RuntimeHomeFact["storageStatus"],
  now: Date
): RuntimeHomeFact["domain"] {
  const stored = readEphemeralDomainIdentity(home);
  if (stored.status === "absent") {
    // A current, ordinary YUI_HOME is a real control domain, not a disposable
    // test domain. Keep it visible even when it is currently idle so a stale
    // artifact cannot acquire ephemeral cleanup authority by omission. An
    // uninitialized temporary directory with no runtime facts remains absent
    // to preserve the legacy empty-home inventory behavior.
    if (
      storageStatus !== "current"
      && processes.length === 0
      && roles.length === 0
    ) return undefined;
    return {
      kind: "unmarked",
      liveness: "unknown",
      disposition: "review",
      reasonCode: "unmarked-domain",
      fingerprint: `unmarked:${home}`,
      tmuxTargets: [],
      ageMs: 0,
      graceMs: EPHEMERAL_DOMAIN_GRACE_MS
    };
  }
  if (stored.status === "invalid" || stored.identity === undefined) {
    return {
      kind: "invalid",
      liveness: "unknown",
      disposition: "review",
      reasonCode: "invalid-domain-identity",
      fingerprint: `invalid:${stored.fingerprint ?? home}`,
      tmuxTargets: [],
      ageMs: 0,
      graceMs: EPHEMERAL_DOMAIN_GRACE_MS
    };
  }

  const identity = stored.identity;
  const ageMs = Math.max(0, now.getTime() - Date.parse(identity.createdAt));
  if (identity.tmuxServer !== yuiTmuxServerName(home)) {
    return {
      kind: "invalid",
      liveness: "unknown",
      disposition: "review",
      reasonCode: "invalid-domain-tmux-server",
      fingerprint: ephemeralDomainFingerprint(identity, stored.fingerprint),
      hostPid: identity.hostPid,
      hostProcessStartIdentity: identity.hostProcessStartIdentity,
      token: identity.token,
      tmuxServer: identity.tmuxServer,
      tmuxTargets: identity.tmuxTargets,
      createdAt: identity.createdAt,
      ageMs,
      graceMs: EPHEMERAL_DOMAIN_GRACE_MS
    };
  }
  const hostStartIdentity = readLinuxProcessStartIdentity(identity.hostPid);
  const hostPathExists = existsSync(`/proc/${identity.hostPid}`);
  const hostActive = hostStartIdentity === identity.hostProcessStartIdentity;
  const storageSafe = storageStatus === "current";
  if (hostActive) {
    return {
      kind: "ephemeral-test",
      liveness: "active",
      disposition: "protected",
      reasonCode: "ephemeral-host-active",
      fingerprint: ephemeralDomainFingerprint(identity, stored.fingerprint),
      hostPid: identity.hostPid,
      hostProcessStartIdentity: identity.hostProcessStartIdentity,
      token: identity.token,
      tmuxServer: identity.tmuxServer,
      tmuxTargets: identity.tmuxTargets,
      createdAt: identity.createdAt,
      ageMs,
      graceMs: EPHEMERAL_DOMAIN_GRACE_MS
    };
  }

  const activeRole = roles.some((role) => (
    (role.ownerKind === "task-role" && role.taskStatus === "active")
    // Global Roles have no Task status. Only a live native Session is a
    // durable liveness fact for that scope; stopped/broken history must not
    // protect an expired disposable domain merely because it has an ID.
    || (role.ownerKind === "global-role" && role.nativeSessionId !== undefined)
  ));
  if (!storageSafe) {
    return {
      kind: "ephemeral-test",
      liveness: hostActive ? "active" : "expired",
      disposition: "review",
      reasonCode: `ephemeral-storage-${storageStatus}`,
      fingerprint: ephemeralDomainFingerprint(identity, stored.fingerprint),
      hostPid: identity.hostPid,
      hostProcessStartIdentity: identity.hostProcessStartIdentity,
      token: identity.token,
      tmuxServer: identity.tmuxServer,
      tmuxTargets: identity.tmuxTargets,
      createdAt: identity.createdAt,
      ageMs,
      graceMs: EPHEMERAL_DOMAIN_GRACE_MS
    };
  }
  if (activeRole) {
    return {
      kind: "ephemeral-test",
      liveness: "expired",
      disposition: "protected",
      reasonCode: "ephemeral-active-task-role",
      fingerprint: ephemeralDomainFingerprint(identity, stored.fingerprint),
      hostPid: identity.hostPid,
      hostProcessStartIdentity: identity.hostProcessStartIdentity,
      token: identity.token,
      tmuxServer: identity.tmuxServer,
      tmuxTargets: identity.tmuxTargets,
      createdAt: identity.createdAt,
      ageMs,
      graceMs: EPHEMERAL_DOMAIN_GRACE_MS
    };
  }
  if (hostStartIdentity === undefined && hostPathExists) {
    return {
      kind: "ephemeral-test",
      liveness: "expired",
      disposition: "review",
      reasonCode: "ephemeral-host-identity-unavailable",
      fingerprint: ephemeralDomainFingerprint(identity, stored.fingerprint),
      hostPid: identity.hostPid,
      hostProcessStartIdentity: identity.hostProcessStartIdentity,
      token: identity.token,
      tmuxServer: identity.tmuxServer,
      tmuxTargets: identity.tmuxTargets,
      createdAt: identity.createdAt,
      ageMs,
      graceMs: EPHEMERAL_DOMAIN_GRACE_MS
    };
  }
  if (ageMs < EPHEMERAL_DOMAIN_GRACE_MS) {
    return {
      kind: "ephemeral-test",
      liveness: "expired",
      disposition: "review",
      reasonCode: hostStartIdentity === undefined
        ? "ephemeral-host-identity-unavailable"
        : "ephemeral-host-grace",
      fingerprint: ephemeralDomainFingerprint(identity, stored.fingerprint),
      hostPid: identity.hostPid,
      hostProcessStartIdentity: identity.hostProcessStartIdentity,
      token: identity.token,
      tmuxServer: identity.tmuxServer,
      tmuxTargets: identity.tmuxTargets,
      createdAt: identity.createdAt,
      ageMs,
      graceMs: EPHEMERAL_DOMAIN_GRACE_MS
    };
  }
  return {
    kind: "ephemeral-test",
    liveness: "expired",
    disposition: "safe",
    reasonCode: hostStartIdentity === undefined
      ? "ephemeral-host-dead"
      : "ephemeral-host-identity-mismatch",
    fingerprint: ephemeralDomainFingerprint(identity, stored.fingerprint),
    hostPid: identity.hostPid,
    hostProcessStartIdentity: identity.hostProcessStartIdentity,
    token: identity.token,
    tmuxServer: identity.tmuxServer,
    tmuxTargets: identity.tmuxTargets,
    createdAt: identity.createdAt,
    ageMs,
    graceMs: EPHEMERAL_DOMAIN_GRACE_MS
  };
}

function loadHomeState(
  home: string,
  warnings: string[],
  options: Pick<ControllerInventoryScanOptions, "inspectStorage" | "openCompatibleStore">
): Readonly<{
  storageStatus: RuntimeHomeFact["storageStatus"];
  roles: RuntimeRoleFact[];
}> {
  const schema = (options.inspectStorage ?? inspectStorageSchema)(home);
  const recordOnlyOlder = schema.status === "unsupported"
    && schema.incompatibleComponent === "record"
    && schema.direction === "older"
    && schema.currentLayoutVersion === schema.latestLayoutVersion
    && schema.currentAggregateSchemaVersion === schema.latestAggregateSchemaVersion;
  if (schema.status !== "current" && !recordOnlyOlder) {
    return {
      storageStatus: schema.status,
      roles: []
    };
  }
  try {
    const store = (options.openCompatibleStore ?? openCompatibleFileTaskStore)(home);
    const roles: RuntimeRoleFact[] = store.listGlobalRoles().map((role) => {
      const session = activeLiveRoleAgentSession(store.getGlobalRoleSessionSet(role.name));
      const binding = role.agentBindings[role.activeAgentId];
      const agentId = session?.effective.agentId ?? role.activeAgentId;
      const adapterId = session?.effective.adapterId ?? binding?.adapterId;
      return {
        ownerKind: "global-role",
        roleName: role.name,
        agentId,
        ...(adapterId === undefined ? {} : { adapterId }),
        ...(session === null ? {} : { nativeSessionId: session.nativeSessionId }),
        ...(session?.launchId === undefined ? {} : { launchId: session.launchId })
      };
    });
    for (const task of store.listTasks()) {
      for (const role of store.listRoles(task.id)) {
        const session = activeLiveRoleAgentSession(store.getRoleSessionSet(task.id, role.name));
        const binding = role.agentBindings[role.activeAgentId];
        const run = store.getActiveAgentRun(task.id, role.name);
        const agentId = session?.effective.agentId ?? role.activeAgentId;
        const adapterId = session?.effective.adapterId ?? binding?.adapterId;
        roles.push({
          ownerKind: "task-role",
          taskId: task.id,
          taskTitle: task.title,
          taskStatus: task.status,
          roleName: role.name,
          agentId,
          ...(adapterId === undefined ? {} : { adapterId }),
          ...(session === null ? {} : { nativeSessionId: session.nativeSessionId }),
          ...(session?.launchId === undefined ? {} : { launchId: session.launchId }),
          ...(run === null ? {} : { runId: run.id })
        });
      }
    }
    return { storageStatus: schema.status, roles };
  } catch (error) {
    warnings.push(`Cannot load runtime ownership for ${home}: ${message(error)}`);
    return { storageStatus: "invalid", roles: [] };
  }
}

function inspectHomePanes(
  home: string,
  tmuxBin: string,
  warnings: string[]
) {
  try {
    return new TmuxManager(tmuxBin, new NodeCommandExecutor(), {
      yuiHome: home
    }).inspectRolePaneInventory();
  } catch (error) {
    warnings.push(`Cannot inspect tmux for ${home}: ${message(error)}`);
    return [];
  }
}

function fileArtifact(
  path: string,
  artifactKind: RuntimeArtifactFact["artifactKind"],
  active: boolean
): RuntimeArtifactFact {
  const metadata = lstatSync(path);
  return {
    artifactKind,
    path,
    active,
    fingerprint: statFingerprint(metadata)
  };
}

function statFingerprint(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    Math.trunc(metadata.mtimeMs)
  ].join(":");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
