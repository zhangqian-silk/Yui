import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type { SessionOwnerReconciliation } from "../controller/sessionOwnerReconciliation.js";
import type { SessionReconciliationReport } from "../runtime/index.js";

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
