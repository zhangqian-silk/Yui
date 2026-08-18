import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type {
  ControllerInventoryScope,
  ControllerResourceInventory,
  RuntimeOwner,
  RuntimeResource
} from "../controller/resourceInventory.js";
import { DEFAULT_RECONCILIATION_INTERVAL_SECONDS } from "../config/yuiConfig.js";
import {
  evaluateStorageHealth,
  UNSUPPORTED,
  type RuntimeBuildIdentity,
  type StorageIdentity
} from "../observability/runtimeIdentity.js";
import type { JsonValue } from "../core/protocol.js";

export type ControllerStatusOptions = Readonly<{
  scope: ControllerInventoryScope;
  verbose: boolean;
}>;

export type ControllerCleanupOptions = Readonly<{
  scope: ControllerInventoryScope;
}>;

export type ControllerCleanupIo = Readonly<{
  interactive: boolean;
  write(value: string): void;
  question(prompt: string): Promise<string | undefined>;
}>;

export type ControllerCleanupResult = Readonly<{
  output: string;
  data: Readonly<{
    selected: readonly string[];
    cleaned: readonly Readonly<{ id: string; rssBytes: number }>[];
    skipped: readonly Readonly<{ id: string; reason: string }>[];
    failed: readonly Readonly<{ id: string; message: string }>[];
    reclaimedRssBytes: number;
    remainingIssues: number;
  }>;
}>;

export function parseControllerStatusOptions(args: readonly string[]): ControllerStatusOptions {
  const allowed = new Set(["--all", "--verbose"]);
  if (
    args.some((argument) => !allowed.has(argument))
    || new Set(args).size !== args.length
  ) {
    throw usageError(
      "Controller status usage: yui controller status [--all] [--verbose]."
    );
  }
  return {
    scope: args.includes("--all") ? "all" : "current",
    verbose: args.includes("--verbose")
  };
}

export function parseControllerCleanupOptions(args: readonly string[]): ControllerCleanupOptions {
  if (
    args.some((argument) => argument !== "--all")
    || new Set(args).size !== args.length
  ) {
    throw usageError("Controller cleanup usage: yui controller cleanup [--all].");
  }
  return { scope: args.includes("--all") ? "all" : "current" };
}

export function renderControllerResourceStatus(
  snapshot: ControllerResourceInventory,
  verbose: boolean,
  width = defaultTableWidth()
): string {
  const warnings = snapshot.warnings ?? [];
  const current = snapshot.resources.find((resource) => (
    resource.kind === "controller"
    && resource.state === "current"
    && resource.yuiHome === snapshot.currentHome
  ));
  const currentPid = current?.processes[0]?.pid;
  const lines = [
    currentPid === undefined
      ? "Controller is not running."
      : `Controller is running (PID ${currentPid}).`,
    "",
    `Observed ${snapshot.summary.domainCount} control domain(s), ${
      snapshot.summary.liveProcessCount
    } live process(es), ${formatBytes(snapshot.summary.rssBytes)} RSS.`
  ];

  if (
    snapshot.scope === "all"
    || snapshot.domains.length > 1
    || snapshot.domains.some(({ domainKind }) => domainKind !== undefined)
  ) {
    const visibleDomains = selectVisibleDomains(snapshot, verbose);
    lines.push("", renderTable(
      "Control domains",
      [
        { header: "YUI_HOME", minWidth: 16, maxWidth: 54 },
        { header: "Domain", minWidth: 10, maxWidth: 18 },
        { header: "Lifetime", minWidth: 10, maxWidth: 18 },
        { header: "Storage", minWidth: 8, maxWidth: 13 },
        { header: "Resources", minWidth: 9, maxWidth: 9 },
        { header: "Processes", minWidth: 9, maxWidth: 9 },
        { header: "RSS", minWidth: 8, maxWidth: 11 },
        { header: "Issues", minWidth: 6, maxWidth: 6 },
        { header: "Reason", minWidth: 12, maxWidth: 30 }
      ],
      visibleDomains.map((domain) => [
        domain.yuiHome,
        domain.domainKind ?? "legacy",
        domain.liveness === undefined
          ? "—"
          : `${domain.liveness}/${domain.disposition ?? "review"}`,
        domain.storageStatus,
        String(domain.resourceCount),
        String(domain.liveProcessCount),
        formatBytes(domain.rssBytes),
        String(domain.issueCount),
        domain.reasonCode ?? "—"
      ]),
      width
    ));
    lines.push(
      "",
      `Automatic ephemeral reap: every ${DEFAULT_RECONCILIATION_INTERVAL_SECONDS}s; `
        + "only expired marked test domains with matching identities are eligible."
    );
    if (visibleDomains.length < snapshot.domains.length) {
      lines.push(
        "",
        `${snapshot.domains.length - visibleDomains.length} residual-only control domain(s) `
          + "are summarized below; use --verbose to expand them."
      );
    }
  }

  const sessions = snapshot.resources.filter((resource) => (
    resource.kind === "agent-session"
    && (verbose || resource.disposition === "protected")
  ));
  if (sessions.length > 0) {
    lines.push("", renderTable(
      "Agent sessions",
      [
        { header: "Task", minWidth: 8, maxWidth: 18 },
        { header: "Role", minWidth: 12, maxWidth: 22 },
        { header: "Agent", minWidth: 7, maxWidth: 14 },
        { header: "State", minWidth: 8, maxWidth: 12 },
        { header: "PID", minWidth: 5, maxWidth: 8 },
        { header: "RSS", minWidth: 8, maxWidth: 11 }
      ],
      sessions.map((resource) => sessionRow(resource)),
      width
    ));
  }

  const residual = snapshot.resources.filter(({ disposition }) => disposition !== "protected");
  if (residual.length > 0) {
    lines.push("", renderTable(
      "Residual resources",
      [
        { header: "Reason", minWidth: 16, maxWidth: 34 },
        { header: "Count", minWidth: 5, maxWidth: 5 },
        { header: "Live", minWidth: 4, maxWidth: 4 },
        { header: "RSS", minWidth: 8, maxWidth: 11 },
        { header: "Oldest", minWidth: 7, maxWidth: 10 },
        { header: "Action", minWidth: 10, maxWidth: 12 }
      ],
      residualSummaryRows(residual),
      width
    ));
  }

  const liveAnomalies = residual.filter((resource) => resource.processes.length > 0)
    .sort((left, right) => right.rssBytes - left.rssBytes);
  const visible = verbose ? liveAnomalies : liveAnomalies.slice(0, 5);
  if (visible.length > 0) {
    lines.push("", renderTable(
      verbose ? "Live anomalous resources" : "Largest live anomalies",
      [
        { header: "Kind", minWidth: 10, maxWidth: 18 },
        { header: "Reason", minWidth: 16, maxWidth: 30 },
        { header: "PID", minWidth: 5, maxWidth: 8 },
        { header: "RSS", minWidth: 8, maxWidth: 11 },
        { header: "Age", minWidth: 7, maxWidth: 10 },
        { header: "Owner", minWidth: 12, maxWidth: 30 }
      ],
      visible.map((resource) => [
        resource.kind,
        resource.reasonCode,
        processLabel(resource),
        formatBytes(resource.rssBytes),
        formatDuration(resource.ageMs),
        ownerLabel(resource.owner)
      ]),
      width
    ));
    if (!verbose && visible.length < liveAnomalies.length) {
      lines.push(
        "",
        `${liveAnomalies.length - visible.length} more live anomalous resource(s); `
          + "use --verbose to expand them."
      );
    }
  }

  if (warnings.length > 0) {
    lines.push(
      "",
      "Warnings",
      ...warnings.slice(0, verbose ? warnings.length : 5)
        .map((warning) => `  ! ${warning}`)
    );
    if (!verbose && warnings.length > 5) {
      lines.push(`  ! ${warnings.length - 5} more warning(s); use --verbose.`);
    }
  }

  return lines.join("\n");
}

/**
 * Issue 11 read-only identity/metrics section for `controller status`.
 * Everything here is observed: build provenance, durable-vs-physical storage
 * evidence, Controller runtime metrics (when the socket answers), and the
 * durable/physical Session mismatch. Missing producers render `unsupported`;
 * storage contradictions fail closed (see {@link evaluateStorageHealth}).
 */
export type ControllerRuntimeSnapshot = Readonly<{
  source: "controller.status" | "unsupported";
  pid?: number;
  uptimeMs?: number;
  rssBytes?: number;
  protocolVersion?: number;
  inbox?: Readonly<{ depth: number; semanticDepth: number; progressDepth: number }>;
  coalescedEvents?: number;
  droppedEvents?: number | "unsupported";
  queueDepth?: number;
  oldestInFlightAgeMs?: number | null;
  eventLoopMaxLagMs?: number;
  error?: string;
}>;

export type DurablePhysicalMismatch = Readonly<{
  durableActiveSessions: number;
  residualProcesses: number;
  liveResidualResources: number;
  protectedWithoutProcess: number;
}>;

export function summarizeDurablePhysicalMismatch(
  snapshot: ControllerResourceInventory
): DurablePhysicalMismatch {
  let durableActiveSessions = 0;
  let residualProcesses = 0;
  let liveResidualResources = 0;
  let protectedWithoutProcess = 0;
  for (const resource of snapshot.resources) {
    if (resource.kind === "agent-session") {
      if (resource.disposition === "protected") {
        durableActiveSessions += 1;
        if (resource.processes.length === 0) protectedWithoutProcess += 1;
      } else if (resource.processes.length > 0) {
        liveResidualResources += 1;
      }
    }
    if (resource.disposition !== "protected") {
      residualProcesses += resource.processes.length;
    }
  }
  return {
    durableActiveSessions,
    residualProcesses,
    liveResidualResources,
    protectedWithoutProcess
  };
}

export function parseControllerRuntimeSnapshot(
  result: JsonValue | null,
  droppedEvents: number | "unsupported"
): ControllerRuntimeSnapshot {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { source: "unsupported", droppedEvents };
  }
  const record = result as Record<string, unknown>;
  const runtime = (record.runtime ?? {}) as Record<string, unknown>;
  const inbox = runtime.inbox as Record<string, unknown> | undefined;
  const drain = runtime.drain as Record<string, unknown> | undefined;
  const commands = runtime.commands as Record<string, unknown> | undefined;
  const routes = commands?.routes as Record<string, unknown> | undefined;
  const dispatcher = commands?.dispatcher as Record<string, unknown> | undefined;
  const eventLoopDelay = commands?.eventLoopDelay as Record<string, unknown> | undefined;
  const queueDepth =
    (typeof routes?.inFlight === "number" ? routes.inFlight : 0)
    + (typeof dispatcher?.inFlight === "number" ? dispatcher.inFlight : 0);
  return {
    source: "controller.status",
    pid: typeof record.pid === "number" ? record.pid : undefined,
    uptimeMs: typeof record.uptimeMs === "number" ? record.uptimeMs : undefined,
    rssBytes: typeof record.rssBytes === "number" ? record.rssBytes : undefined,
    protocolVersion: typeof record.protocolVersion === "number"
      ? record.protocolVersion
      : undefined,
    inbox: inbox === undefined ? undefined : {
      depth: typeof inbox.depth === "number" ? inbox.depth : 0,
      semanticDepth: typeof inbox.semanticDepth === "number" ? inbox.semanticDepth : 0,
      progressDepth: typeof inbox.progressDepth === "number" ? inbox.progressDepth : 0
    },
    coalescedEvents: typeof drain?.progressEventsCoalesced === "number"
      ? drain.progressEventsCoalesced
      : undefined,
    droppedEvents,
    queueDepth,
    oldestInFlightAgeMs: typeof routes?.oldestInFlightAgeMs === "number"
      ? routes.oldestInFlightAgeMs
      : null,
    eventLoopMaxLagMs: typeof eventLoopDelay?.maximumLagMs === "number"
      ? eventLoopDelay.maximumLagMs
      : undefined
  };
}

export function renderRuntimeIdentitySection(input: Readonly<{
  build: RuntimeBuildIdentity;
  storage: StorageIdentity;
  runtime: ControllerRuntimeSnapshot;
  mismatch: DurablePhysicalMismatch;
  inventoryRssBytes: number;
}>): string {
  const { build, storage, runtime, mismatch, inventoryRssBytes } = input;
  const health = evaluateStorageHealth(storage);
  const lines = [
    "Runtime identity",
    `  Package         ${build.packageName} ${build.packageVersion}`,
    `  Package digest  ${build.packageDigest}`,
    `  Entry           ${build.entryPath}`,
    `  Entry digest    ${build.entryDigest}`,
    `  Source commit   ${build.sourceCommit}`,
    `  Node            ${build.nodeVersion} (${build.platform})`,
    `  Storage         layout ${storage.logicalLayout} (manifest ${storage.manifestStatus}) · backend ${storage.configuredBackend} · worker ${storage.workerEnabled ? "on" : "off"}`,
    `  Store files     state.json ${storage.physicalStateJson.present ? "present" : "absent"} · yui.db ${storage.physicalDatabase.present ? "present" : "absent"}${storage.physicalDatabase.wal ? " +WAL" : ""}${storage.physicalDatabase.present && storage.physicalDatabase.health !== UNSUPPORTED ? ` (${storage.physicalDatabase.health})` : ""}`
  ];
  for (const finding of storage.findings) {
    lines.push(
      `  ! ${finding.severity === "contradiction" ? "CONTRADICTION" : finding.severity === "needs-repair" ? "NEEDS-REPAIR" : "warning"} ${finding.code}: ${finding.message}`,
      `    remediation: ${finding.remediation}`
    );
  }
  lines.push(
    `  Health          ${health.status === "ok" ? "ok" : health.status === "degraded" ? "DEGRADED (needs-repair above)" : "FAIL (contradictions above)"}`,
    `  Controller      ${runtime.source === "controller.status" && runtime.pid !== undefined
      ? `PID ${runtime.pid}${runtime.uptimeMs === undefined ? "" : `, up ${formatDuration(runtime.uptimeMs)}`}${runtime.protocolVersion === undefined ? "" : `, protocol ${runtime.protocolVersion}`}`
      : "not running (unsupported)"}`,
    `  Controller RSS  ${runtime.rssBytes !== undefined ? formatBytes(runtime.rssBytes) : UNSUPPORTED} (inventory ${formatBytes(inventoryRssBytes)})`,
    `  Command queue   depth ${runtime.queueDepth ?? UNSUPPORTED} · oldest ${
      runtime.oldestInFlightAgeMs === undefined
        ? UNSUPPORTED
        : runtime.oldestInFlightAgeMs === null
          ? "—"
          : formatDuration(runtime.oldestInFlightAgeMs)
    }`,
    `  Runtime inbox   ${runtime.inbox === undefined
      ? UNSUPPORTED
      : `depth ${runtime.inbox.depth} (semantic ${runtime.inbox.semanticDepth}, progress ${runtime.inbox.progressDepth})`} · coalesced ${runtime.coalescedEvents ?? UNSUPPORTED} · dropped ${runtime.droppedEvents ?? UNSUPPORTED}`,
    `  Event loop      ${runtime.eventLoopMaxLagMs === undefined
      ? UNSUPPORTED
      : `max lag ${runtime.eventLoopMaxLagMs.toFixed(0)}ms`}`,
    // Persistence latency/lock-wait have no producer in the current
    // controller.status RPC; render the documented `unsupported` fallback
    // rather than silently dropping the field. A future capability provider
    // can register a persistence observer without changing this schema.
    `  Persistence     latency ${UNSUPPORTED} · lock/busy wait ${UNSUPPORTED}`,
    `  Durable/physical ${mismatch.durableActiveSessions} active sessions · ${mismatch.residualProcesses} residual processes · ${mismatch.liveResidualResources} live residual · ${mismatch.protectedWithoutProcess} protected without process`
  );
  return lines.join("\n");
}

export async function runInteractiveControllerCleanup(input: Readonly<{
  io: ControllerCleanupIo;
  scan(): Promise<ControllerResourceInventory>;
  clean(resource: RuntimeResource): Promise<void>;
}>): Promise<ControllerCleanupResult> {
  if (!input.io.interactive) {
    throw usageError("Controller cleanup requires an interactive terminal.");
  }
  const initial = await input.scan();
  const safe = initial.resources.filter(({ disposition }) => disposition === "safe");
  const review = initial.resources.filter(({ disposition }) => disposition === "review");
  const protectedCount = initial.resources.filter(
    ({ disposition }) => disposition === "protected"
  ).length;
  const reportOnlyCount = initial.resources.filter(
    ({ disposition }) => disposition === "report-only"
  ).length;
  input.io.write(renderCleanupPlan(safe, review, protectedCount, reportOnlyCount));

  const selected: RuntimeResource[] = [];
  if (safe.length > 0 && await confirmed(
    input.io,
    `Clean ${safe.length} safe resource(s), reclaiming up to ${
      formatBytes(totalRss(safe))
    }? [y/N]: `
  )) {
    selected.push(...safe);
  }
  if (review.length > 0 && await confirmed(
    input.io,
    `Review ${review.length} live resource(s) individually? [y/N]: `
  )) {
    for (const resource of review) {
      input.io.write(`${cleanupResourceLabel(resource)}\n`);
      if (await confirmed(
        input.io,
        `Clean ${resource.kind} ${resource.id}? This may interrupt running work. [y/N]: `
      )) {
        selected.push(resource);
      }
    }
  }

  if (selected.length === 0) {
    return cleanupResult("No resources were selected; nothing was changed.", [], [], [], [], initial);
  }
  if (
    selected.some(({ processes }) => processes.length > 0)
    && (await input.io.question(
      `Type cleanup to stop ${selected.filter(({ processes }) => processes.length > 0).length} `
        + `live resource(s) and clean ${selected.length} selected resource(s): `
    ))?.trim().toLowerCase() !== "cleanup"
  ) {
    return cleanupResult("Cancelled; nothing was changed.", selected, [], [], [], initial);
  }

  const revalidated = await input.scan();
  const currentById = new Map(revalidated.resources.map((resource) => [resource.id, resource]));
  const ready: RuntimeResource[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const resource of selected) {
    const current = currentById.get(resource.id);
    if (
      current === undefined
      || current.fingerprint !== resource.fingerprint
      || (current.disposition !== "safe" && current.disposition !== "review")
      || (resource.disposition === "safe" && current.disposition !== "safe")
    ) {
      skipped.push({ id: resource.id, reason: "changed-since-scan" });
      continue;
    }
    ready.push(current);
  }

  const cleaned: { id: string; rssBytes: number }[] = [];
  const failed: { id: string; message: string }[] = [];
  for (const resource of ready) {
    try {
      await input.clean(resource);
      cleaned.push({ id: resource.id, rssBytes: resource.rssBytes });
    } catch (error) {
      failed.push({
        id: resource.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const after = await input.scan();
  const output = [
    `Cleaned ${cleaned.length} resource(s); skipped ${skipped.length}; failed ${failed.length}.`,
    `Estimated reclaimed RSS: ${formatBytes(
      cleaned.reduce((total, resource) => total + resource.rssBytes, 0)
    )}.`,
    `Remaining issues: ${after.resources.filter(
      ({ disposition }) => disposition !== "protected"
    ).length}.`,
    ...failed.map((failure) => `Failed ${failure.id}: ${failure.message}`)
  ].join("\n");
  return cleanupResult(output, selected, cleaned, skipped, failed, after);
}

function sessionRow(resource: RuntimeResource): string[] {
  const pid = resource.processes[0]?.pid;
  if (resource.owner.kind === "task-role") {
    return [
      resource.owner.taskId,
      resource.owner.roleName,
      resource.owner.agentId,
      resource.state,
      pid === undefined ? "—" : String(pid),
      formatBytes(resource.rssBytes)
    ];
  }
  if (resource.owner.kind === "global-role") {
    return [
      "global",
      resource.owner.roleName,
      resource.owner.agentId,
      resource.state,
      pid === undefined ? "—" : String(pid),
      formatBytes(resource.rssBytes)
    ];
  }
  return [
    "—",
    resource.target ?? resource.kind,
    "—",
    resource.state,
    pid === undefined ? "—" : String(pid),
    formatBytes(resource.rssBytes)
  ];
}

function selectVisibleDomains(
  snapshot: ControllerResourceInventory,
  verbose: boolean
): ControllerResourceInventory["domains"] {
  if (verbose) return snapshot.domains;
  const activeHomes = new Set<string>([
    snapshot.currentHome,
    ...snapshot.resources
      .filter(({ disposition }) => disposition === "protected")
      .flatMap(({ yuiHome }) => yuiHome === undefined ? [] : [yuiHome])
  ]);
  const active = snapshot.domains.filter(({ yuiHome }) => activeHomes.has(yuiHome));
  const residual = snapshot.domains
    .filter(({ yuiHome }) => !activeHomes.has(yuiHome))
    .sort((left, right) => right.rssBytes - left.rssBytes)
    .slice(0, 5);
  return [...active, ...residual];
}

function residualSummaryRows(resources: readonly RuntimeResource[]): string[][] {
  const groups = new Map<string, RuntimeResource[]>();
  for (const resource of resources) {
    const entries = groups.get(resource.reasonCode) ?? [];
    entries.push(resource);
    groups.set(resource.reasonCode, entries);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, entries]) => [
      reason,
      String(entries.length),
      String(entries.filter(({ processes }) => processes.length > 0).length),
      formatBytes(entries.reduce((total, resource) => total + resource.rssBytes, 0)),
      formatDuration(Math.max(0, ...entries.map(({ ageMs }) => ageMs))),
      strongestDisposition(entries)
    ]);
}

function strongestDisposition(resources: readonly RuntimeResource[]): string {
  if (resources.some(({ disposition }) => disposition === "review")) return "review";
  if (resources.some(({ disposition }) => disposition === "safe")) return "safe";
  return "report-only";
}

function ownerLabel(owner: RuntimeOwner): string {
  switch (owner.kind) {
    case "controller-domain": return owner.yuiHome;
    case "task-role": return `${owner.taskId}/${owner.roleName}`;
    case "global-role": return `global/${owner.roleName}`;
    case "none": return "unattributed";
  }
}

function processLabel(resource: RuntimeResource): string {
  const first = resource.processes[0]?.pid;
  if (first === undefined) return "—";
  return resource.processes.length === 1
    ? String(first)
    : `${first} +${resource.processes.length - 1}`;
}

function renderCleanupPlan(
  safe: readonly RuntimeResource[],
  review: readonly RuntimeResource[],
  protectedCount: number,
  reportOnlyCount: number
): string {
  const domains = [...safe, ...review].reduce((counts, resource) => {
    const home = resource.yuiHome ?? "unattributed";
    counts.set(home, (counts.get(home) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  return [
    "Controller cleanup plan",
    "",
    `  Safe          ${safe.length} resource(s), ${formatBytes(totalRss(safe))} RSS`,
    `  Review        ${review.length} resource(s), ${formatBytes(totalRss(review))} RSS`,
    `  Protected     ${protectedCount} resource(s)`,
    `  Report only   ${reportOnlyCount} resource(s)`,
    ...(domains.size === 0 ? [] : [
      "",
      "  Domains",
      ...[...domains.entries()].map(([home, count]) => `    ${home}: ${count} candidate(s)`)
    ]),
    ""
  ].join("\n");
}

function cleanupResourceLabel(resource: RuntimeResource): string {
  const pids = resource.processes.map(({ pid }) => pid).join(",") || "—";
  const domain = resource.domain;
  return [
    `${resource.kind}: ${resource.reasonCode}`,
    `  Home  ${resource.yuiHome ?? "unattributed"}`,
    `  PID   ${pids}`,
    `  RSS   ${formatBytes(resource.rssBytes)}`,
    `  Age   ${formatDuration(resource.ageMs)}`,
    `  Owner ${ownerLabel(resource.owner)}`,
    ...(domain === undefined ? [] : [
      `  Domain ${domain.kind}/${domain.liveness}/${domain.disposition}`,
      `  Host  ${domain.hostPid === undefined ? "—" : `${domain.hostPid}:${domain.hostProcessStartIdentity ?? "?"}`}`,
      `  Cost  ${formatBytes(resource.rssBytes)} RSS; tmux=${domain.tmuxTargets.length}`
    ])
  ].join("\n");
}

async function confirmed(io: ControllerCleanupIo, prompt: string): Promise<boolean> {
  const answer = (await io.question(prompt))?.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function cleanupResult(
  output: string,
  selected: readonly RuntimeResource[],
  cleaned: readonly Readonly<{ id: string; rssBytes: number }>[],
  skipped: readonly Readonly<{ id: string; reason: string }>[],
  failed: readonly Readonly<{ id: string; message: string }>[],
  finalSnapshot: ControllerResourceInventory
): ControllerCleanupResult {
  return {
    output,
    data: {
      selected: selected.map(({ id }) => id),
      cleaned,
      skipped,
      failed,
      reclaimedRssBytes: cleaned.reduce((total, resource) => total + resource.rssBytes, 0),
      remainingIssues: finalSnapshot.resources.filter(
        ({ disposition }) => disposition !== "protected"
      ).length
    }
  };
}

function totalRss(resources: readonly RuntimeResource[]): number {
  return resources.reduce((total, resource) => total + resource.rssBytes, 0);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
