import type { TaskEvent } from "../event/taskEvent.js";
import type { AgentRun } from "../run/agentRun.js";
import { matchYieldReceipt } from "../run/yieldReceipt.js";
import type { ReviewFinding } from "./reviewFinding.js";
import type { ReviewRound } from "./reviewRound.js";
import {
  isTaskRecordRetired,
  operationalTaskRecords
} from "../task/taskRecordRetirement.js";

/**
 * Review outcome classification is a read-only projection over existing
 * Round/Run/Event/Finding evidence.  It deliberately adds no mutable Review
 * status: old Homes can be classified more precisely as their corroborating
 * records become available, while ambiguous evidence continues to fail
 * closed.
 */

export type ReviewInfraFailureKind =
  | "session-not-stopped"
  | "run-start"
  | "storage-lock"
  | "tmux-exit"
  | "yield-timeout"
  | "run-identity"
  | "policy"
  | "baseline-contamination"
  | "context-load"
  | "workspace-binding"
  | "other-infra";

export type ReviewOutcomeClassification = Readonly<{
  kind: "semantic" | "non-semantic" | "ambiguous";
  infraKind?: ReviewInfraFailureKind;
  reason: string;
}>;

export type ReviewOutcomeEvidenceStore = Readonly<{
  listAgentRuns(taskId: string): readonly AgentRun[];
  listReviewFindings(taskId: string): readonly ReviewFinding[];
  listEvents(taskId: string): readonly TaskEvent[];
}>;

const INFRA_SIGNATURES: readonly Readonly<{
  kind: ReviewInfraFailureKind;
  pattern: RegExp;
}>[] = [
  { kind: "session-not-stopped", pattern: /session must be stopped before workspace migration/iu },
  { kind: "run-start", pattern: /role run could not start|could not start (?:the )?(?:reviewer|role) run/iu },
  { kind: "storage-lock", pattern: /\.state\.lock|state lock|lock timeout|storage lock/iu },
  { kind: "tmux-exit", pattern: /tmux[^\n]{0,80}(?:exited|exit|died|vanished)|pane (?:exited|died)/iu },
  { kind: "yield-timeout", pattern: /yield timeout|controller yield timeout|yield timed out/iu },
  { kind: "run-identity", pattern: /wrong run id|unknown run id|run id (?:is )?(?:invalid|unknown|mismatch)/iu },
  { kind: "policy", pattern: /cyber_?policy|policy denial|permission denied by policy/iu },
  { kind: "baseline-contamination", pattern: /cross[-\s]?baseline|baseline pollution|contaminated baseline|wrong base sha/iu },
  { kind: "context-load", pattern: /(?:run )?(?:context|context pack) load (?:failed|unavailable|unauthorized|stale|mismatched|malformed)/iu },
  { kind: "workspace-binding", pattern: /workspace is not the durable owner|workspace-binding failure/iu }
];

/** Classify one terminal Round without rewriting it. */
export function classifyReviewRoundOutcome(
  round: ReviewRound,
  evidence?: ReviewOutcomeEvidenceStore
): ReviewOutcomeClassification | null {
  if (round.status !== "completed" && round.status !== "failed") return null;

  if (evidence !== undefined && round.reviewerRunId !== undefined
    && isTaskRecordRetired(
      evidence.listEvents(round.taskId),
      "agent-run",
      round.reviewerRunId
    )) {
    return {
      kind: "non-semantic",
      infraKind: "run-identity",
      reason: `Reviewer Run ${round.reviewerRunId} was retired from operational evidence.`
    };
  }

  const infraKind = classifyInfraKind(`${round.summary ?? ""}\n${round.report ?? ""}`);
  if (round.status === "failed") {
    const semanticEvidence = failedRoundSemanticEvidence(round, evidence);
    return semanticEvidence === null
      ? {
          kind: "non-semantic",
          infraKind,
          reason: "Failed Review execution carries no semantic report evidence."
        }
      : {
          kind: "ambiguous",
          infraKind,
          reason: semanticEvidence
        };
  }

  if (!explicitCompletedReviewInfrastructureFailure(round.summary ?? "", round)) {
    return { kind: "semantic", reason: "Reviewer delivered a terminal report." };
  }
  if (evidence === undefined) {
    return {
      kind: "ambiguous",
      infraKind,
      reason: "Completed Round claims an infrastructure failure but corroborating Run/Event evidence was not supplied."
    };
  }
  const corroborationFailure = completedInfrastructureCorroborationFailure(round, evidence);
  return corroborationFailure === null
    ? {
        kind: "non-semantic",
        infraKind,
        reason: "Completed Round and yielded Run agree on an explicit pre-review infrastructure failure."
      }
    : {
        kind: "ambiguous",
        infraKind,
        reason: corroborationFailure
      };
}

/** True only when a Round contains semantic Reviewer evidence. */
export function isSemanticReviewRound(
  round: ReviewRound,
  evidence?: ReviewOutcomeEvidenceStore
): boolean {
  return classifyReviewRoundOutcome(round, evidence)?.kind === "semantic";
}

function classifyInfraKind(text: string): ReviewInfraFailureKind {
  return INFRA_SIGNATURES.find(({ pattern }) => pattern.test(text))?.kind ?? "other-infra";
}

function failedRoundSemanticEvidence(
  round: ReviewRound,
  evidence: ReviewOutcomeEvidenceStore | undefined
): string | null {
  if ((round.checks ?? []).length > 0) return "Failed Round records review checks.";
  if (round.evidenceCommit !== undefined) return "Failed Round records a review evidence commit.";
  if (round.deltaRecheck?.disposition !== undefined || round.deltaRecheck?.reasoning !== undefined) {
    return "Failed Round records a semantic delta-recheck disposition.";
  }
  if (round.report !== round.summary) return "Failed Round stores a report distinct from its terminal summary.";
  if (runtimeFailureSummaryHasReviewerOutput(round.report ?? "")) {
    return "Failed Round stores non-empty Reviewer output in its runtime failure summary.";
  }
  if (looksLikeStructuredReviewReport(round.report ?? "")) {
    return "Failed Round stores a structured Reviewer report.";
  }
  const semanticLane = (round.executionGroup?.lanes ?? []).find((lane) => (
    (lane.result?.checks ?? []).length > 0
    || (lane.result?.findings ?? []).length > 0
    || (lane.result?.evidence ?? []).length > 0
    || lane.result?.evidenceCommit !== undefined
    || lane.result?.gitSnapshot !== undefined
    || lane.status === "yielded"
    || lane.status === "completed"
  ));
  if (semanticLane !== undefined) return `Reviewer Lane ${semanticLane.id} delivered semantic evidence.`;
  if (evidence !== undefined) {
    const events = evidence.listEvents(round.taskId);
    const reviewRun = operationalTaskRecords(
      evidence.listAgentRuns(round.taskId),
      events,
      "agent-run"
    ).find((run) => (
      run.purpose === "review"
      && run.reviewRoundId === round.id
      && (run.status === "yielded" || runtimeFailureSummaryHasReviewerOutput(run.summary ?? ""))
    ));
    if (reviewRun !== undefined) return `Reviewer Run ${reviewRun.id} records Reviewer output.`;
    const finding = evidence.listReviewFindings(round.taskId).find((entry) => (
      entry.firstReviewRoundId === round.id || entry.lastReviewRoundId === round.id
    ));
    if (finding !== undefined) return `Review finding ${finding.id} references the Round.`;
    const completion = events.find((event) => (
      event.type === "review.completed" && event.payload.reviewRoundId === round.id
    ));
    if (completion !== undefined) return `Review completion Event ${completion.id} exists.`;
  }
  return null;
}

function completedInfrastructureCorroborationFailure(
  round: ReviewRound,
  store: ReviewOutcomeEvidenceStore
): string | null {
  if ((round.checks ?? []).length > 0) return "Completed Round records review checks.";
  if (round.evidenceCommit !== round.reviewBaseCommit) {
    return "Completed Round lacks an exact frozen-head evidence commit.";
  }
  if (round.report !== round.summary) {
    return "Completed Round stores a report distinct from its terminal summary.";
  }
  if (runtimeFailureSummaryHasReviewerOutput(round.report ?? "")) {
    return "Completed Round stores non-empty Reviewer output in its runtime failure summary.";
  }
  if (round.deltaRecheck?.disposition !== undefined || round.deltaRecheck?.reasoning !== undefined) {
    return "Completed Round records a semantic delta-recheck disposition.";
  }
  if (looksLikeStructuredReviewReport(round.report ?? "")) {
    return "Completed Round stores a structured Reviewer report.";
  }

  for (const lane of round.executionGroup?.lanes ?? []) {
    if (lane.status === "pending" || lane.status === "running") {
      return `Reviewer Lane ${lane.id} is still active.`;
    }
    if ((lane.result?.checks ?? []).length > 0
      || (lane.result?.findings ?? []).length > 0
      || (lane.result?.evidence ?? []).length > 0
      || (lane.result?.evidenceCommit !== undefined
        && lane.result.evidenceCommit !== round.reviewBaseCommit)
      || lane.result?.gitSnapshot !== undefined) {
      return `Reviewer Lane ${lane.id} delivered semantic evidence.`;
    }
    if (lane.status === "yielded" || lane.status === "completed") {
      if (lane.result === undefined
        || lane.result.summary !== round.summary
        || lane.result.report !== round.report
        || lane.result.evidenceCommit !== round.reviewBaseCommit) {
        return `Reviewer Lane ${lane.id} output is absent or differs from the Round.`;
      }
    } else {
      return `Completed Round has non-completed Reviewer Lane ${lane.id}/${lane.status}.`;
    }
  }

  const allEvents = store.listEvents(round.taskId);
  const runs = operationalTaskRecords(
    store.listAgentRuns(round.taskId),
    allEvents,
    "agent-run"
  ).filter((run) => (
    run.purpose === "review" && run.reviewRoundId === round.id
  ));
  const active = runs.find(({ status }) => status === "active");
  if (active !== undefined) return `Reviewer Run ${active.id} is still active.`;
  const output = runs.find((run) => (
    run.status === "failed" && runtimeFailureSummaryHasReviewerOutput(run.summary ?? "")
  ));
  if (output !== undefined) return `Reviewer Run ${output.id} records Reviewer output.`;
  const yielded = runs.filter(({ status }) => status === "yielded");
  if (round.reviewerRunId === undefined
    || yielded.length !== 1
    || yielded[0]!.id !== round.reviewerRunId) {
    return "Completed Round lacks one exact yielded Reviewer Run.";
  }
  const run = yielded[0]!;
  if (run.roleName !== round.reviewerRoleName
    || run.summary !== round.summary
    || run.yieldReceipt === undefined) {
    return `Reviewer Run ${run.id} does not match the non-semantic Round receipt.`;
  }
  const receiptMatch = matchYieldReceipt(run.yieldReceipt, {
    status: "yielded",
    summary: round.summary ?? "",
    reviewResult: {
      report: round.report ?? "",
      checks: round.checks ?? [],
      evidenceCommit: round.reviewBaseCommit
    }
  });
  if (receiptMatch?.kind !== "replayed") {
    return `Reviewer Run ${run.id} yield receipt does not cover the Round outcome.`;
  }

  const finding = store.listReviewFindings(round.taskId).find((entry) => (
    entry.firstReviewRoundId === round.id || entry.lastReviewRoundId === round.id
  ));
  if (finding !== undefined) return `Review finding ${finding.id} references the Round.`;
  const events = allEvents.filter((event) => (
    event.type === "review.completed" && event.payload.reviewRoundId === round.id
  ));
  if (events.length !== 1) return "Completed Round lacks one exact completion Event.";
  const event = events[0]!;
  if (event.payload.workItemId !== round.workItemId
    || event.payload.candidateId !== round.candidateId
    || event.payload.reviewBaseCommit !== round.reviewBaseCommit
    || event.payload.evidenceCommit !== round.reviewBaseCommit
    || event.payload.checks !== "none") {
    return `Review completion Event ${event.id} carries mismatched or semantic evidence.`;
  }
  return null;
}

function explicitCompletedReviewInfrastructureFailure(summary: string, round: ReviewRound): boolean {
  if (exactCompletedReviewInfrastructureFailureReport(summary)) return true;
  const report = summary.trim();
  if (report === `Role Run workspace is not the durable owner: ${round.taskId}/${round.reviewerRoleName}.`
    || (round.reviewerRunId !== undefined
      && report === `Review Run workspace is not the durable owner: ${round.reviewerRunId}.`)) {
    return true;
  }
  return /^(?:Run )?(?:Context|Context Pack) load (?:failed|unavailable|unauthorized|stale|mismatched|malformed)(?:: (?:failure|mismatch|unavailable|unauthorized|stale|mismatched|malformed))?\.?$/iu
    .test(report);
}

function exactCompletedReviewInfrastructureFailureReport(summary: string): boolean {
  const lines = summary.trim().split(/\r?\n/u);
  const envelope: readonly RegExp[] = [
    /^# Review result: (?:context-load|workspace-binding) failure$/u,
    /^$/u,
    /^The assigned Run context could not be safely matched to this native session, so no candidate review was performed\.$/u,
    /^$/u,
    /^- Run: `[^`\r\n]+`$/u,
    /^- ReviewRound: `[^`\r\n]+`$/u,
    /^- Review base commit: `[0-9a-f]{40}`$/u,
    /^- Frozen target: `[^`\r\n]+`$/u,
    /^- Authorized workspace from the exact Context Pack: `[^`\r\n]+`$/u,
    /^- Session-attached workspace: `[^`\r\n]+`$/u,
    /^- Verification: both paths resolve distinctly and have different filesystem inodes \(`[^`\r\n]+` vs `[^`\r\n]+`\)\.$/u,
    /^$/u,
    /^## Findings$/u,
    /^$/u,
    /^- Verified-fixed findings: none; review did not start\.$/u,
    /^- New findings: none; candidate sources were intentionally not inspected\.$/u,
    /^- Accepted risks: none accepted\.$/u,
    /^- Residual verification gaps: the complete frozen diff, changed control-flow paths, callers, data-integrity behavior, and required deterministic checks remain unreviewed because the Review workspace binding is mismatched\.$/u,
    /^$/u,
    /^## Checks actually run$/u,
    /^$/u,
    /^- Exact Context API load: passed for Task\/Run\/Role\/purpose\/subject\/snapshot\/adapter\.$/u,
    /^- Workspace binding verification: failed\.$/u,
    /^- Candidate build\/tests\/package checks: not run\.$/u,
    /^- Real-provider E2E: not run and not authorized\.$/u,
    /^$/u,
    /^## Required next action$/u,
    /^$/u,
    /^Attach the native Reviewer session to the exact workspace recorded by the Context Pack, or issue a fresh internally consistent Review Run\/Context Pack\. Then perform the complete bounded Task-final review at the frozen head\.$/u
  ];
  return lines.length === envelope.length
    && envelope.every((pattern, index) => pattern.test(lines[index]!));
}

function runtimeFailureSummaryHasReviewerOutput(summary: string): boolean {
  const output = /(?:^|\n)last_assistant_message:[ \t]*([\s\S]*)$/u.exec(summary)?.[1];
  return output !== undefined && output.trim().length > 0;
}

function looksLikeStructuredReviewReport(report: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(report) as unknown; } catch { return false; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return [
    "summary", "report", "checks", "findings", "evidence", "evidenceCommit",
    "deltaDisposition", "deltaReasoning"
  ].some((key) => Object.hasOwn(record, key));
}
