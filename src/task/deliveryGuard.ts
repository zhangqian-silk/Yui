import type { NextActionFacts, NextActionRef } from "./nextAction.js";

/**
 * Issue 07 (Leader convergence): duplicate/convergence guard and semantic
 * progress budget for Task mutations.
 *
 * The guard is pure and exact-evidence based: it hard-blocks only on exact
 * matches (same IDs, same commits, same scope). Suspected semantic
 * duplicates are warnings, never blocks. The budget derives entirely from
 * existing records — an exhausted budget is a warning for the Leader, not a
 * mutation block.
 */

export type LeaderNextActionMode = "display" | "warn" | "enforce";

export type WorkItemScopeInput = Readonly<{
  title: string;
  objective: string;
  acceptance: readonly string[];
  writeProjectIds: readonly string[];
}>;

export type DeliveryGuardIntent =
  | { kind: "create-work-item"; scope: WorkItemScopeInput }
  | {
      kind: "integration-start";
      projectId: string;
      changeSetIds: readonly string[];
    }
  | {
      kind: "review-request";
      reviewerRoleName: string;
      taskCandidateCommits: readonly string[];
    }
  | { kind: "complete-task" };

export type DeliveryDuplicate = Readonly<{
  severity: "exact" | "suspected";
  reason: string;
  refs: readonly NextActionRef[];
  /** Existing command that already proves this delivery, when one exists. */
  reuseCommand?: string;
}>;

export type DeliveryGuardOutcome = Readonly<{
  blocked: DeliveryDuplicate | null;
  warnings: readonly DeliveryDuplicate[];
}>;

const OPEN_WORK_ITEM_STATUSES = new Set(["pending", "running", "awaiting_acceptance"]);

export function detectDeliveryDuplicates(
  facts: NextActionFacts,
  intent: DeliveryGuardIntent
): readonly DeliveryDuplicate[] {
  switch (intent.kind) {
    case "create-work-item":
      return detectWorkItemDuplicates(facts, intent.scope);
    case "integration-start":
      return detectIntegrationDuplicates(facts, intent);
    case "review-request":
      return detectReviewDuplicates(facts, intent);
    case "complete-task":
      return detectCompleteDuplicates(facts);
  }
}

/**
 * Apply the configured mode. `display` never interferes; `warn` reports every
 * match as a warning; `enforce` hard-blocks on exact evidence and warns on
 * suspected duplicates.
 */
export function evaluateDeliveryGuard(
  duplicates: readonly DeliveryDuplicate[],
  mode: LeaderNextActionMode
): DeliveryGuardOutcome {
  if (mode === "display" || duplicates.length === 0) {
    return { blocked: null, warnings: [] };
  }
  const exact = duplicates.filter((duplicate) => duplicate.severity === "exact");
  const suspected = duplicates.filter((duplicate) => duplicate.severity === "suspected");
  if (mode === "enforce" && exact.length > 0) {
    return { blocked: exact[0]!, warnings: suspected };
  }
  return { blocked: null, warnings: [...exact, ...suspected] };
}

export function formatDeliveryDuplicate(duplicate: DeliveryDuplicate): string {
  const refs = duplicate.refs.map((ref) => `${ref.kind} ${ref.id}`).join(", ");
  const reuse = duplicate.reuseCommand === undefined
    ? ""
    : ` Existing proof: ${duplicate.reuseCommand}`;
  return `${duplicate.severity === "exact" ? "Exact duplicate" : "Suspected duplicate"}: ${duplicate.reason} (${refs}).${reuse}`;
}

function detectWorkItemDuplicates(
  facts: NextActionFacts,
  scope: WorkItemScopeInput
): readonly DeliveryDuplicate[] {
  const wanted = normalizeScope(scope);
  const duplicates: DeliveryDuplicate[] = [];
  for (const item of facts.workItems) {
    const existing = normalizeScope({
      title: item.title,
      objective: item.objective,
      acceptance: item.acceptance,
      writeProjectIds: item.writeProjectIds
    });
    const sameScope = existing.title === wanted.title
      && existing.objective === wanted.objective
      && existing.acceptance === wanted.acceptance
      && existing.writeProjectIds === wanted.writeProjectIds;
    const ref = { kind: "work-item", id: item.id } as const;
    if (sameScope && OPEN_WORK_ITEM_STATUSES.has(item.status)) {
      duplicates.push({
        severity: "exact",
        reason: `Work Item ${item.id} is already open with the identical scope`,
        refs: [ref],
        reuseCommand: `yui task work show ${facts.task.id}/${item.id}`
      });
      continue;
    }
    if (sameScope && item.status === "completed") {
      duplicates.push({
        severity: "suspected",
        reason: `Work Item ${item.id} already delivered the identical scope; re-creating it may be a duplicate successor`,
        refs: [ref],
        reuseCommand: `yui task work show ${facts.task.id}/${item.id}`
      });
      continue;
    }
    if (!sameScope
      && OPEN_WORK_ITEM_STATUSES.has(item.status)
      && existing.writeProjectIds === wanted.writeProjectIds
      && wanted.writeProjectIds.length > 0
      && overlap(existing.acceptance, wanted.acceptance)) {
      duplicates.push({
        severity: "suspected",
        reason: `Open Work Item ${item.id} shares the same Project scope and acceptance lines`,
        refs: [ref]
      });
    }
  }
  return duplicates;
}

function detectIntegrationDuplicates(
  facts: NextActionFacts,
  intent: Extract<DeliveryGuardIntent, { kind: "integration-start" }>
): readonly DeliveryDuplicate[] {
  const wanted = new Set(intent.changeSetIds);
  const duplicates: DeliveryDuplicate[] = [];
  for (const attempt of facts.integrations) {
    if (attempt.projectId !== intent.projectId) continue;
    const existing = new Set(attempt.changeSetIds);
    const sameSet = existing.size === wanted.size
      && [...wanted].every((id) => existing.has(id));
    const ref = { kind: "integration-attempt", id: attempt.id } as const;
    if (sameSet && attempt.status === "committed") {
      duplicates.push({
        severity: "exact",
        reason: `Integration ${attempt.id} already committed this exact ChangeSet set`,
        refs: [ref],
        reuseCommand: `yui task integration show ${facts.task.id}/${attempt.id}`
      });
      continue;
    }
    if (sameSet
      && (attempt.status === "running" || attempt.status === "validating")) {
      duplicates.push({
        severity: "suspected",
        reason: `Integration ${attempt.id} is already ${attempt.status} for this exact ChangeSet set`,
        refs: [ref],
        reuseCommand: `yui task integration show ${facts.task.id}/${attempt.id}`
      });
    }
  }
  return duplicates;
}

function detectReviewDuplicates(
  facts: NextActionFacts,
  intent: Extract<DeliveryGuardIntent, { kind: "review-request" }>
): readonly DeliveryDuplicate[] {
  const wanted = new Set(intent.taskCandidateCommits.map((commit) => commit.toLowerCase()));
  const duplicates: DeliveryDuplicate[] = [];
  for (const round of facts.reviewRounds) {
    if ((round.scope ?? "work-item") !== "task") continue;
    if (round.reviewerRoleName !== intent.reviewerRoleName) continue;
    const commits = new Set(
      (round.taskCandidate?.projects ?? []).map((project) => project.commit.toLowerCase())
    );
    const sameCandidate = commits.size === wanted.size
      && commits.size > 0
      && [...wanted].every((commit) => commits.has(commit));
    if (!sameCandidate) continue;
    const ref = { kind: "review-round", id: round.id } as const;
    if (round.status === "completed") {
      duplicates.push({
        severity: "exact",
        reason: `Task-final Review ${round.id} already attests this exact head`,
        refs: [ref]
      });
    } else if (round.status === "pending" || round.status === "running") {
      duplicates.push({
        severity: "suspected",
        reason: `Task-final Review ${round.id} is already ${round.status} for this exact head`,
        refs: [ref]
      });
    }
  }
  return duplicates;
}

function detectCompleteDuplicates(facts: NextActionFacts): readonly DeliveryDuplicate[] {
  if (facts.task.status === "completed" || facts.task.status === "archived") {
    return [{
      severity: "exact",
      reason: `Task ${facts.task.id} is already ${facts.task.status}`,
      refs: [{ kind: "task", id: facts.task.id }]
    }];
  }
  return [];
}

type NormalizedScope = Readonly<{
  title: string;
  objective: string;
  acceptance: string;
  writeProjectIds: string;
}>;

function normalizeScope(scope: WorkItemScopeInput): NormalizedScope {
  return {
    title: scope.title.trim().toLowerCase(),
    objective: scope.objective.trim().toLowerCase(),
    acceptance: [...scope.acceptance]
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0)
      .sort()
      .join("\n"),
    writeProjectIds: [...scope.writeProjectIds].map((id) => id.trim()).sort().join(",")
  };
}

function overlap(left: string, right: string): boolean {
  const rightLines = new Set(right.split("\n"));
  return left.split("\n").some((line) => line.length > 0 && rightLines.has(line));
}

export type SemanticBudget = Readonly<{
  exhausted: boolean;
  reason: string;
  evidence: readonly string[];
}>;

/**
 * Default number of consecutive yielded Leader turns that must produce no
 * durable delivery change before the budget is exhausted.
 */
export const DEFAULT_SEMANTIC_BUDGET_TURNS = 3;

/**
 * Evaluate the semantic-progress budget from existing records only. The
 * budget is exhausted when the last `turns` Leader Runs all yielded and no
 * WorkItem/ChangeSet/Integration/Review record changed at or after the first
 * of those Runs. Active execution (any Run) never exhausts the budget: a
 * slow but progressing Worker or Leader is never interrupted.
 */
export function evaluateSemanticBudget(
  facts: NextActionFacts,
  turns = DEFAULT_SEMANTIC_BUDGET_TURNS
): SemanticBudget {
  if (facts.activeRuns.length > 0) {
    return {
      exhausted: false,
      reason: "Active execution is in flight; the budget never interrupts a progressing Run.",
      evidence: facts.activeRuns.map((run) => run.id)
    };
  }
  const recentLeaderRuns = facts.leaderRuns
    .filter((run) => run.status === "yielded")
    .slice(-turns);
  if (recentLeaderRuns.length < turns) {
    return {
      exhausted: false,
      reason: `Fewer than ${turns} consecutive yielded Leader turns.`,
      evidence: recentLeaderRuns.map((run) => run.id)
    };
  }
  const firstStartedAt = Math.min(
    ...recentLeaderRuns.map((run) => Date.parse(run.createdAt))
  );
  const changed = latestDeliveryChangeAt(facts);
  if (changed >= firstStartedAt) {
    return {
      exhausted: false,
      reason: "A delivery record changed during the recent Leader turns.",
      evidence: recentLeaderRuns.map((run) => run.id)
    };
  }
  return {
    exhausted: true,
    reason: `${turns} consecutive Leader turns produced no durable delivery change; record a diagnosis/yield and wait for new facts instead of creating more records.`,
    evidence: recentLeaderRuns.map((run) => run.id)
  };
}

function latestDeliveryChangeAt(facts: NextActionFacts): number {
  const timestamps = [
    ...facts.workItems.map((item) => Date.parse(item.updatedAt)),
    ...facts.changeSets.map((changeSet) => Date.parse(changeSet.createdAt)),
    ...facts.integrations.map((attempt) =>
      Math.max(Date.parse(attempt.updatedAt), Date.parse(attempt.endedAt ?? attempt.updatedAt))),
    ...facts.reviewRounds.map((round) =>
      Math.max(Date.parse(round.createdAt), Date.parse(round.endedAt ?? round.createdAt)))
  ];
  return timestamps.length === 0 ? 0 : Math.max(...timestamps);
}
