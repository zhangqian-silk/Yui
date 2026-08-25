import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { SessionOwnerReconciliation } from "../controller/sessionOwnerReconciliation.js";
import type { SessionReconciliationReport } from "../runtime/index.js";
import type { RuntimeSessionCandidate } from "../runtime/runtimeSessionCandidate.js";
import type { DormantRuntimeOwnerCandidate } from "../scheduler/ports.js";

export type SessionStopOptions = Readonly<{
  all: true;
}>;

export function parseSessionStopOptions(args: readonly string[]): SessionStopOptions {
  if (args.length !== 1 || args[0] !== "--all") {
    throw usageError("Session stop usage: yui session stop --all.");
  }
  return { all: true };
}

type SessionStopRuntime = Readonly<{
  beginMaintenance(): Readonly<{ release(): void }>;
  snapshot(): Readonly<{
    candidates: readonly RuntimeSessionCandidate[];
    dormant: readonly DormantRuntimeOwnerCandidate[];
  }>;
  drainController(): Promise<void>;
  stopController(): Promise<Readonly<{ stopped: boolean }>>;
  startController(): Promise<void>;
  stopDormantSession(candidate: DormantRuntimeOwnerCandidate): Promise<void>;
}>;

export type SessionStopResult = Readonly<{
  output: string;
  data: Readonly<{
    stopped: readonly RuntimeSessionCandidate[];
    blocked: readonly Readonly<{
      session: RuntimeSessionCandidate;
      reason: "running" | "runtime-work-pending";
    }>[];
  }>;
  exitCode: number;
}>;

/**
 * Stop every current managed Session only when all of them are idle. The
 * all-or-nothing preflight prevents a maintenance command from silently
 * stopping half the topology while another Role is still working.
 */
export async function runSessionStopCommand(input: Readonly<{
  options: SessionStopOptions;
  runtime: SessionStopRuntime;
  environment?: NodeJS.ProcessEnv;
}>): Promise<SessionStopResult> {
  void input.options;
  if (input.environment?.YUI_SESSION_SCOPE !== undefined) {
    throw usageError(
      "Session stop must be run by the user from a normal shell, outside a managed Yui Session."
    );
  }
  const maintenance = input.runtime.beginMaintenance();
  let completed = false;
  try {
    const initial = input.runtime.snapshot();
    const initiallyBlocked = blockedSessions(initial);
    if (initiallyBlocked.length > 0) return blockedStopResult(initiallyBlocked);

    // Stop and drain the Controller while the handover fence prevents a new
    // Leader dispatch. The explicit full pass settles pending runtime inbox and
    // lifecycle work that may exist without a current Session candidate.
    await input.runtime.drainController();
    await input.runtime.stopController();
    // Re-read the authoritative facts after the drain because a Run that was
    // already inside a pass may have changed state meanwhile.
    const settled = input.runtime.snapshot();
    const blockedAfterDrain = blockedSessions(settled);
    if (blockedAfterDrain.length > 0) {
      await input.runtime.startController();
      return blockedStopResult(blockedAfterDrain);
    }

    for (const session of settled.candidates) {
      const candidate = settled.dormant.find((entry) => sameStopCandidate(session, entry));
      if (candidate === undefined) {
        throw new Error(`Dormant Session changed during maintenance: ${renderSessionOwner(session)}.`);
      }
      await input.runtime.stopDormantSession(candidate);
    }
    const count = settled.candidates.length;
    completed = true;
    return {
      output: count === 0
        ? "No managed Sessions were running. The Controller remains stopped; run `yui update` now.\n"
        : `Stopped ${count} managed Sessions. The Controller remains stopped; run \`yui update\` now.\n`,
      data: { stopped: settled.candidates, blocked: [] },
      exitCode: 0
    };
  } catch (error) {
    if (!completed) {
      try {
        await input.runtime.startController();
      } catch (restartError) {
        throw new AggregateError(
          [error, restartError],
          "Session maintenance failed and the Controller could not be restarted."
        );
      }
    }
    throw error;
  } finally {
    maintenance.release();
  }
}

function blockedSessions(input: Readonly<{
  candidates: readonly RuntimeSessionCandidate[];
  dormant: readonly DormantRuntimeOwnerCandidate[];
}>): SessionStopResult["data"]["blocked"] {
  return input.candidates.flatMap((session) => {
    const idle = input.dormant.some((candidate) => sameStopCandidate(session, candidate));
    if (idle) return [];
    return [{
      session,
      reason: session.status === "running"
        ? "running" as const
        : "runtime-work-pending" as const
    }];
  });
}

function blockedStopResult(
  blocked: SessionStopResult["data"]["blocked"]
): SessionStopResult {
  const details = blocked.map(({ session, reason }) => (
    `- ${renderSessionOwner(session)} (${reason === "running"
      ? "a Turn or Run is still running"
      : "an active Run or lifecycle operation is still pending"})`
  ));
  return {
    output: [
      `Cannot stop managed Sessions: ${blocked.length} Session(s) are still busy.`,
      ...details,
      "No Session was stopped. Let the listed work finish, then run `yui session stop --all` again."
    ].join("\n") + "\n",
    data: { stopped: [], blocked },
    exitCode: 5
  };
}

function sameStopCandidate(
  session: RuntimeSessionCandidate,
  candidate: DormantRuntimeOwnerCandidate
): boolean {
  if (session.owner.scope !== candidate.owner.scope) return false;
  if (session.owner.roleName !== candidate.owner.roleName) return false;
  if (
    session.owner.scope === "task"
    && candidate.owner.scope === "task"
    && session.owner.taskId !== candidate.owner.taskId
  ) {
    return false;
  }
  return session.agentId === candidate.agentId
    && session.adapterId === candidate.adapterId
    && session.nativeSessionId === candidate.nativeSessionId
    && session.launchId === candidate.launchId
    && session.sessionUpdatedAt === candidate.sessionUpdatedAt;
}

function renderSessionOwner(session: RuntimeSessionCandidate): string {
  return session.owner.scope === "task"
    ? `${session.owner.taskId}/${session.owner.roleName}`
    : `global/${session.owner.roleName}`;
}

export type SessionReconcileOptions = Readonly<{
  report: boolean;
  cleanup: boolean;
}>;

export function parseSessionReconcileOptions(
  args: readonly string[]
): SessionReconcileOptions {
  const allowed = new Set(["--report", "--cleanup"]);
  if (args.some((argument) => !allowed.has(argument))) {
    throw usageError(
      "Session reconcile usage: yui session reconcile [--report] [--cleanup]."
    );
  }
  return {
    report: args.includes("--report") || !args.includes("--cleanup"),
    cleanup: args.includes("--cleanup")
  };
}

export type SessionReconcileResult = Readonly<{
  output: string;
  data: SessionReconciliationReport;
  exitCode: number;
}>;

/**
 * `yui session reconcile` — read-only durable/physical reconciliation report
 * by default. `--cleanup` performs exact-owner termination of live roots
 * belonging to terminal/archived Tasks.
 */
export async function runSessionReconcileCommand(input: Readonly<{
  reconciliation: SessionOwnerReconciliation;
  options: SessionReconcileOptions;
  environment?: NodeJS.ProcessEnv;
}>): Promise<SessionReconcileResult> {
  if (input.options.cleanup) {
    const before = input.reconciliation.report();
    const targets = before.entries.filter((entry) => entry.archiveBlocked);
    for (const entry of targets) {
      const owner = entry.owner.scope === "task"
        ? {
            scope: "task" as const,
            taskId: entry.owner.taskId!,
            roleName: entry.owner.roleName
          }
        : {
            scope: "global" as const,
            roleName: entry.owner.roleName
          };
      await input.reconciliation.terminateOwner(owner);
    }
  }

  const report = input.reconciliation.report();
  const exitCode = report.summary.archiveBlockers > 0 ? 5 : 0;
  return {
    output: renderSessionReconciliationReport(report),
    data: report,
    exitCode
  };
}

export function renderSessionReconciliationReport(
  report: SessionReconciliationReport,
  width = defaultTableWidth()
): string {
  const lines = [
    "Session reconciliation",
    "",
    `Owners: ${report.summary.owners}; live physical roots: `
      + `${report.summary.livePhysicalRoots}; archive blockers: `
      + `${report.summary.archiveBlockers}; verification gaps: `
      + `${report.summary.verificationGaps}.`
  ];
  if (report.entries.length === 0) {
    lines.push("", "No Session owner records found.");
    return lines.join("\n");
  }
  lines.push("", renderTable(
    "Session owners",
    [
      { header: "Task", minWidth: 8, maxWidth: 18 },
      { header: "Role", minWidth: 12, maxWidth: 22 },
      { header: "Agent", minWidth: 7, maxWidth: 14 },
      { header: "Durable", minWidth: 8, maxWidth: 10 },
      { header: "Physical", minWidth: 8, maxWidth: 10 },
      { header: "PID", minWidth: 5, maxWidth: 8 },
      { header: "RSS", minWidth: 8, maxWidth: 11 },
      { header: "Children", minWidth: 8, maxWidth: 8 },
      { header: "Last stop", minWidth: 12, maxWidth: 16 },
      { header: "Mismatch", minWidth: 12, maxWidth: 30 },
      { header: "Archive", minWidth: 7, maxWidth: 9 }
    ],
    report.entries.map((entry) => [
      entry.owner.scope === "global"
        ? "global"
        : (entry.owner.taskId ?? "—"),
      entry.owner.roleName,
      entry.agentId,
      entry.durableStatus,
      entry.physical === undefined
        ? "gap"
        : entry.physical.alive
          ? "live"
          : "absent",
      entry.physical === undefined ? "—" : String(entry.physical.pid),
      entry.physical === undefined || entry.physical.rssBytes <= 0
        ? "—"
        : formatBytes(entry.physical.rssBytes),
      entry.physical === undefined ? "—" : String(entry.physical.childCount),
      entry.lastStopOutcome ?? "—",
      entry.mismatch ?? "—",
      entry.archiveBlocked ? "blocked" : "ok"
    ]),
    width
  ));
  return lines.join("\n");
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
