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
  stopTaskRoleSessions(taskId: string, roleNames: readonly string[]): Promise<void>;
  stopGlobalRoleSession(roleName: string): Promise<void>;
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
  candidates: readonly RuntimeSessionCandidate[];
  dormant: readonly DormantRuntimeOwnerCandidate[];
  runtime: SessionStopRuntime;
  environment?: NodeJS.ProcessEnv;
}>): Promise<SessionStopResult> {
  void input.options;
  if (input.environment?.YUI_SESSION_SCOPE !== undefined) {
    throw usageError(
      "Session stop must be run by the user from a normal shell, outside a managed Yui Session."
    );
  }
  if (input.candidates.length === 0) {
    return {
      output: "No managed Sessions are running. Re-run `yui update` to check the remaining runtime state.\n",
      data: { stopped: [], blocked: [] },
      exitCode: 0
    };
  }

  const blocked = input.candidates.flatMap((session) => {
    const idle = input.dormant.some((candidate) => sameStopCandidate(session, candidate));
    if (idle) return [];
    return [{
      session,
      reason: session.status === "running"
        ? "running" as const
        : "runtime-work-pending" as const
    }];
  });
  if (blocked.length > 0) {
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

  const taskRoles = new Map<string, string[]>();
  const globalRoles: string[] = [];
  for (const session of input.candidates) {
    if (session.owner.scope === "task") {
      const roles = taskRoles.get(session.owner.taskId) ?? [];
      roles.push(session.owner.roleName);
      taskRoles.set(session.owner.taskId, roles);
    } else {
      globalRoles.push(session.owner.roleName);
    }
  }
  for (const [taskId, roleNames] of taskRoles) {
    await input.runtime.stopTaskRoleSessions(taskId, roleNames);
  }
  for (const roleName of globalRoles) {
    await input.runtime.stopGlobalRoleSession(roleName);
  }
  return {
    output: `Stopped ${input.candidates.length} managed Sessions. Re-run \`yui update\` to check `
      + "the remaining runtime state.\n",
    data: { stopped: input.candidates, blocked: [] },
    exitCode: 0
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
