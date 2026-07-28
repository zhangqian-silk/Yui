import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type {
  ControllerInventoryScope,
  ControllerResourceInventory,
  RuntimeOwner,
  RuntimeResource
} from "../controller/resourceInventory.js";

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

  if (snapshot.scope === "all" || snapshot.domains.length > 1) {
    const visibleDomains = selectVisibleDomains(snapshot, verbose);
    lines.push("", renderTable(
      "Control domains",
      [
        { header: "YUI_HOME", minWidth: 16, maxWidth: 54 },
        { header: "Storage", minWidth: 8, maxWidth: 13 },
        { header: "Resources", minWidth: 9, maxWidth: 9 },
        { header: "Processes", minWidth: 9, maxWidth: 9 },
        { header: "RSS", minWidth: 8, maxWidth: 11 },
        { header: "Issues", minWidth: 6, maxWidth: 6 }
      ],
      visibleDomains.map((domain) => [
        domain.yuiHome,
        domain.storageStatus,
        String(domain.resourceCount),
        String(domain.liveProcessCount),
        formatBytes(domain.rssBytes),
        String(domain.issueCount)
      ]),
      width
    ));
    if (visibleDomains.length < snapshot.domains.length) {
      lines.push(
        "",
        `${snapshot.domains.length - visibleDomains.length} residual-only control domain(s) `
          + "are summarized below; use --verbose to expand them."
      );
    }
  }

  const sessions = snapshot.resources.filter((resource) => (
    (resource.kind === "agent-session" || resource.kind === "execution-attempt")
    && (verbose || resource.disposition === "protected")
  ));
  if (sessions.length > 0) {
    lines.push("", renderTable(
      "Agent sessions",
      [
        { header: "Task", minWidth: 8, maxWidth: 18 },
        { header: "Role/Attempt", minWidth: 12, maxWidth: 22 },
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
  if (resource.owner.kind === "attempt") {
    return [
      resource.owner.taskId,
      resource.owner.attemptId,
      resource.owner.profileId,
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
    case "attempt": return `${owner.taskId}/${owner.attemptId}`;
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
  return [
    "Controller cleanup plan",
    "",
    `  Safe          ${safe.length} resource(s), ${formatBytes(totalRss(safe))} RSS`,
    `  Review        ${review.length} resource(s), ${formatBytes(totalRss(review))} RSS`,
    `  Protected     ${protectedCount} resource(s)`,
    `  Report only   ${reportOnlyCount} resource(s)`,
    ""
  ].join("\n");
}

function cleanupResourceLabel(resource: RuntimeResource): string {
  const pids = resource.processes.map(({ pid }) => pid).join(",") || "—";
  return [
    `${resource.kind}: ${resource.reasonCode}`,
    `  Home  ${resource.yuiHome ?? "unattributed"}`,
    `  PID   ${pids}`,
    `  RSS   ${formatBytes(resource.rssBytes)}`,
    `  Age   ${formatDuration(resource.ageMs)}`,
    `  Owner ${ownerLabel(resource.owner)}`
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
