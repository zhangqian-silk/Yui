/**
 * `yui execution audit` — read-only execution history report (Issue 11 §3).
 *
 * The command opens the Home read-only, aggregates durable records, and never
 * writes state or wakes a Leader. Filtering is by Task and optional ISO time
 * window. Output is a compact text report; `--json` emits the full report.
 */
import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  runExecutionAudit,
  type ExecutionAuditOptions,
  type ExecutionAuditReport
} from "../observability/executionAudit.js";

export type ExecutionAuditCommandOptions = ExecutionAuditOptions;

export function parseExecutionAuditOptions(
  args: readonly string[]
): ExecutionAuditCommandOptions {
  const options: {
    taskId?: string;
    since?: Date;
    until?: Date;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--task") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        throw usageError("execution audit --task requires a Task id.");
      }
      options.taskId = value;
      continue;
    }
    if (argument === "--since" || argument === "--until") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        throw usageError(`execution audit ${argument} requires an ISO timestamp.`);
      }
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw usageError(`execution audit ${argument} timestamp is invalid: ${value}.`);
      }
      if (argument === "--since") options.since = parsed;
      else options.until = parsed;
      continue;
    }
    throw usageError(
      "execution audit usage: yui execution audit [--task <id>] [--since <iso>] [--until <iso>]."
    );
  }
  if (
    options.since !== undefined
    && options.until !== undefined
    && options.since.getTime() > options.until.getTime()
  ) {
    throw usageError("execution audit --since must not be after --until.");
  }
  return options;
}

export type ExecutionAuditResult = Readonly<{
  output: string;
  report: ExecutionAuditReport;
}>;

export function runExecutionAuditCommand(
  home: string,
  options: ExecutionAuditCommandOptions
): ExecutionAuditResult {
  const report = runExecutionAudit(home, options);
  return { output: renderExecutionAudit(report), report };
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "—";
  const hours = milliseconds / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const minutes = milliseconds / 60_000;
  if (minutes >= 1) return `${minutes.toFixed(1)}m`;
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatBytes(bytes: number | string): string {
  if (typeof bytes === "string") return bytes;
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function sectionError(name: string, report: ExecutionAuditReport): string[] {
  const section = report[name as keyof ExecutionAuditReport] as
    | { status?: string; error?: string }
    | undefined;
  if (section?.status === "error") {
    return [`${name}: read error — ${section.error ?? "unknown error"}`];
  }
  return [];
}

export function renderExecutionAudit(
  report: ExecutionAuditReport,
  width = defaultTableWidth()
): string {
  const lines: string[] = [
    `Execution audit for ${report.home}`,
    `Generated ${report.generatedAt} · Home identity ${report.homeIdentity}`,
    `Scope: ${
      report.scope.taskId ?? "all Tasks"
    }${report.scope.since === undefined ? "" : ` since ${report.scope.since}`}${
      report.scope.until === undefined ? "" : ` until ${report.scope.until}`
    }`
  ];

  if (report.tasks.status === "ok" && report.tasks.data !== undefined) {
    lines.push(
      "",
      `Tasks: ${report.tasks.data.total} total · ${report.tasks.data.archived} archived · ${report.tasks.data.active} active`
    );
  } else {
    lines.push("", ...sectionError("tasks", report));
  }

  if (report.turns.status === "ok" && report.turns.data !== undefined) {
    const turns = report.turns.data;
    lines.push(
      "",
      `Turns: ${turns.total} total · ${turns.failed} failed (${(turns.failureRate * 100).toFixed(1)}%) · ${turns.completed} completed · ${turns.active} active`,
      `Duration: ${formatDuration(turns.cumulativeDurationMs)} total · ${formatDuration(turns.failedDurationMs)} in failed Turns`,
      `By role: ${turns.byRole.leader} leader · ${turns.byRole.reviewer} reviewer · ${turns.byRole.implementer} implementer/worker · ${turns.byRole.other} other`,
      `By purpose: ${turns.byPurpose.execution} execution · ${turns.byPurpose.review} review`
    );
    const faultRows = Object.entries(turns.faultClasses)
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1]);
    if (faultRows.length > 0) {
      lines.push(
        renderTable(
          "Turn failure classes",
          [
            { header: "Class", minWidth: 24, maxWidth: 40 },
            { header: "Count", minWidth: 5, maxWidth: 8 }
          ],
          faultRows.map(([name, count]) => [name, String(count)]),
          width
        )
      );
    }
    if (turns.launchFailures.total > 0) {
      const phaseRows = Object.entries(turns.launchFailures.byPhase)
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1]);
      const kindRows = Object.entries(turns.launchFailures.byKind)
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1]);
      lines.push(
        "",
        `Launch failures: ${turns.launchFailures.total}`,
        `By phase: ${phaseRows.map(([name, count]) => `${name}=${count}`).join(" · ")}`,
        `By kind: ${kindRows.map(([name, count]) => `${name}=${count}`).join(" · ")}`
      );
    }
  } else {
    lines.push("", ...sectionError("turns", report));
  }

  if (report.wakes.status === "ok" && report.wakes.data !== undefined) {
    const wakes = report.wakes.data;
    lines.push(
      "",
      `Leader wakes: ${wakes.leaderTurns} Turns · ${wakes.withWakeReasons} with reasons`
    );
    if (wakes.suppressedWakes.status === "ok") {
      lines.push(`Suppressed wakes: ${wakes.suppressedWakes.data ?? 0} (scheduler single-flight, not failed Turns)`);
    } else if (wakes.suppressedWakes.status === "unsupported") {
      lines.push("Suppressed wakes: unsupported (no quiescence producer in this build)");
    }
    const reasonRows = Object.entries(wakes.byReason).slice(0, 8);
    if (reasonRows.length > 0) {
      lines.push(
        renderTable(
          "Wake reasons",
          [
            { header: "Reason", minWidth: 20, maxWidth: 40 },
            { header: "Count", minWidth: 5, maxWidth: 8 }
          ],
          reasonRows.map(([name, count]) => [name, String(count)]),
          width
        )
      );
    }
  } else {
    lines.push("", ...sectionError("wakes", report));
  }

  if (report.sessions.status === "ok" && report.sessions.data !== undefined) {
    const sessions = report.sessions.data;
    lines.push(
      "",
      `Sessions: ${sessions.generations} generations · ${sessions.broken} broken · ${sessions.stopped} stopped · ${sessions.other} other`,
      `Resets: ${sessions.resets} · Historical conversation switches ${sessions.conversationSwitches}`
        + ` · lifecycle events ${sessions.lifecycleEvents} · stop failures ${sessions.stopFailures}`,
      `Terminal by Turn relation: ${sessions.terminalByTurnRelation.postTurnCompleted} post-turn-completed`
        + ` · ${sessions.terminalByTurnRelation.turnFailed} turn-failed`
        + ` · ${sessions.terminalByTurnRelation.activeTurn} active-turn`
        + ` · ${sessions.terminalByTurnRelation.noTurn} no-turn`
    );
  } else {
    lines.push("", ...sectionError("sessions", report));
  }

  if (report.reviews.status === "ok" && report.reviews.data !== undefined) {
    const reviews = report.reviews.data;
    lines.push(
      "",
      `Review rounds: ${reviews.total} total · ${reviews.completed} completed · ${reviews.failed} failed`,
      `Execution failures: ${reviews.infraFailed}`,
      ...(reviews.deltaRechecks === 0
        ? []
        : [`Delta-rechecks: ${reviews.deltaRechecks} total`])
    );
  } else {
    lines.push("", ...sectionError("reviews", report));
  }

  if (report.integrations.status === "ok" && report.integrations.data !== undefined) {
    const integrations = report.integrations.data;
    lines.push(
      "",
      `Integration attempts: ${integrations.total} total · ${integrations.committed} committed · ${integrations.failed} failed · ${integrations.superseded} superseded`,
      `Failure classes: ${integrations.environmentFailures} environment · ${integrations.staleCasFailures} stale-base/CAS · ${integrations.candidateFailures} candidate`,
      `Gate reuse: ${integrations.gateReuse} attempt(s) reused an exact (commit, checks) signature`
    );
  } else {
    lines.push("", ...sectionError("integrations", report));
  }

  if (report.publications.status === "ok" && report.publications.data !== undefined) {
    const publications = report.publications.data;
    lines.push(
      "",
      `Publication references: ${publications.total} total · ${publications.merged} merged · ${publications.verified} verified · ${publications.open} open · ${publications.closed} closed · ${publications.superseded} superseded`
    );
  } else {
    lines.push("", ...sectionError("publications", report));
  }

  if (report.events.status === "ok" && report.events.data !== undefined) {
    const events = report.events.data;
    lines.push(
      "",
      `Events: ${events.total} total · ${events.progressEvents} provider-progress (${(events.progressShare * 100).toFixed(1)}%) · ${events.semanticEvents} semantic · ${events.obsoleteEvents} obsolete`,
      `Messages: ${events.messages}`
    );
  } else {
    lines.push("", ...sectionError("events", report));
  }

  if (report.agentErrors.status === "ok" && report.agentErrors.data !== undefined) {
    const errors = report.agentErrors.data;
    if (errors.total > 0) {
      lines.push(
        "",
        `Agent errors: ${errors.total} · ${Object.entries(errors.byCategory)
          .map(([category, count]) => `${category}:${count}`).join(", ")}`
      );
      lines.push(
        renderTable(
          "Agent errors",
          [
            { header: "Task", minWidth: 8, maxWidth: 14 },
            { header: "Turn", minWidth: 14, maxWidth: 24 },
            { header: "Role", minWidth: 8, maxWidth: 12 },
            { header: "Category", minWidth: 12, maxWidth: 20 },
            { header: "Code", minWidth: 16, maxWidth: 32 },
            { header: "Session", minWidth: 12, maxWidth: 16 }
          ],
          errors.entries.map((entry) => [
            entry.taskId,
            entry.turnId,
            entry.roleName,
            entry.category,
            entry.code,
            entry.sessionDisposition
          ]),
          width
        )
      );
    }
  } else {
    lines.push("", ...sectionError("agentErrors", report));
  }

  if (report.workItems.status === "ok" && report.workItems.data !== undefined) {
    const items = report.workItems.data;
    lines.push(
      "",
      `Work items: ${items.total} total · ${items.completed} completed · ${items.retired} retired`
    );
  } else {
    lines.push("", ...sectionError("workItems", report));
  }

  if (report.orchestration.status === "ok" && report.orchestration.data !== undefined) {
    const orchestration = report.orchestration.data;
    lines.push(
      "",
      `Orchestration: ${orchestration.tasks.length} Task(s) · ${orchestration.advisoryCount} advisory finding(s)`
    );
    if (orchestration.tasks.length > 0) {
      lines.push(renderTable(
        "Task orchestration metrics",
        [
          { header: "Task", minWidth: 7, maxWidth: 14 },
          { header: "Type", minWidth: 8, maxWidth: 12 },
          { header: "Turns", minWidth: 4, maxWidth: 6 },
          { header: "WIs", minWidth: 3, maxWidth: 5 },
          { header: "Review F/D/X", minWidth: 12, maxWidth: 16 },
          { header: "Integration A/F/R", minWidth: 17, maxWidth: 20 },
          { header: "Pre-progress gen", minWidth: 12, maxWidth: 16 },
          { header: "Terminal ws", minWidth: 10, maxWidth: 12 },
          { header: "Advice", minWidth: 6, maxWidth: 8 }
        ],
        orchestration.tasks.map((task) => [
          task.taskId,
          task.taskType ?? "unspecified",
          String(task.turns.total),
          String(task.workItems),
          `${task.reviews.full}/${task.reviews.delta}/${task.reviews.failed}`,
          `${task.integrations.attempts}/${task.integrations.failed}/${task.integrations.repeatedIdentities}`,
          String(task.providerGenerationsBeforeFirstProgress),
          String(task.terminalWorkspaceCount),
          String(task.advisories.length)
        ]),
        width
      ));
    }
  } else {
    lines.push("", ...sectionError("orchestration", report));
  }

  if (report.storage.status === "ok" && report.storage.data !== undefined) {
    const storage = report.storage.data;
    lines.push(
      "",
      `Storage: backend ${storage.backend} · state.json ${formatBytes(storage.stateJsonBytes)} · yui.db ${formatBytes(storage.databaseBytes)}`
      + ` · runtime/ ${formatBytes(storage.runtimeDirBytes)} · deployments ${formatBytes(storage.deploymentsBytes)}`
    );
  } else {
    lines.push("", ...sectionError("storage", report));
  }

  if (report.runtimeProtocol.status === "ok" && report.runtimeProtocol.data !== undefined) {
    const runtime = report.runtimeProtocol.data;
    const versions = Object.entries(runtime.contextProtocolVersions)
      .map(([version, count]) => `${version}:${count}`)
      .join(", ") || "none";
    const errorCategories = Object.entries(runtime.agentErrorCategories)
      .map(([category, count]) => `${category}:${count}`)
      .join(", ") || "none";
    const exits = Object.entries(runtime.processExitClassifications)
      .map(([classification, count]) => `${classification}:${count}`)
      .join(", ") || "none";
    const usage = Object.entries(runtime.usageSemantics)
      .map(([semantics, count]) => `${semantics}:${count}`)
      .join(", ") || "none";
    lines.push(
      "",
      `Runtime protocol: context versions ${versions} · manifest compatibility identities ${runtime.manifestCompatibilityDigests}`,
      `Agent errors: ${runtime.agentErrors} [${errorCategories}]`,
      `Process exits: ${runtime.processExitObservations} [${exits}] · capacity failures ${runtime.contextCapacityFailures}`,
      `Context telemetry: usage [${usage}] · native compaction events ${runtime.compactionEvents}`
    );
  } else {
    lines.push("", ...sectionError("runtimeProtocol", report));
  }

  if (report.topLongRunning.status === "ok" && report.topLongRunning.data !== undefined) {
    const entries = report.topLongRunning.data;
    if (entries.length > 0) {
      lines.push(
        "",
        renderTable(
          "Top long-running Turns",
          [
            { header: "Task", minWidth: 8, maxWidth: 14 },
            { header: "Turn", minWidth: 14, maxWidth: 24 },
            { header: "Role", minWidth: 10, maxWidth: 20 },
            { header: "Status", minWidth: 8, maxWidth: 10 },
            { header: "Duration", minWidth: 8, maxWidth: 10 }
          ],
          entries.map((entry) => [
            entry.taskId,
            entry.turnId,
            entry.roleName,
            entry.status,
            formatDuration(entry.durationMs)
          ]),
          width
        )
      );
    }
  } else {
    lines.push("", ...sectionError("topLongRunning", report));
  }

  return lines.join("\n");
}
