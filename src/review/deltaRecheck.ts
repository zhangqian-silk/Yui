import { createHash } from "node:crypto";

import {
  validateDeltaRecheckRecord,
  type DeltaRecheckRecord,
  type ReviewRound,
  type TaskReviewCandidate
} from "./reviewRound.js";

/**
 * Issue 07: delta-recheck protocol.
 *
 * A delta-recheck is a Task-final ReviewRound that rechecks a proven diff on
 * top of an already-accepted frozen head.  It never copies the old
 * acceptance: the new head always receives a fresh Reviewer disposition, and
 * any uncertainty returns to the Leader. The control plane enforces only the
 * technical evidence boundary (accepted baseline, contiguous base, exact
 * scope and reproducible diff).
 */

/** Minimal Git boundary satisfied structurally by NodeGitWorkspace. */
export type DeltaRecheckGitPort = Readonly<{
  isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string
  ): Promise<boolean>;
  changedFilesBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<string[]>;
  diffTextBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<string>;
  diffNumstatBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<{ addedLines: number; deletedLines: number }>;
}>;

/** The assessed delta, computed once by the CLI preflight and reused at dispatch. */
export type DeltaRecheckPreflight = Readonly<{
  record: DeltaRecheckRecord;
  diffByProject: Readonly<Record<string, string>>;
}>;

export type DeltaRecheckAssessment = Readonly<
  | { kind: "eligible"; preflight: DeltaRecheckPreflight }
  | { kind: "ineligible"; reason: string }
>;

/**
 * Assesses whether a trustworthy delta can be constructed. Only technical
 * unavailability fails closed; Agents retain the semantic judgment.
 */
export async function assessDeltaRecheck(input: Readonly<{
  /** Exact repository for every Project in the frozen Task candidate. */
  repositoryPaths: Readonly<Record<string, string>>;
  previousRound: ReviewRound;
  candidate: TaskReviewCandidate;
  git: DeltaRecheckGitPort;
}>): Promise<DeltaRecheckAssessment> {
  const { repositoryPaths, previousRound, candidate, git } = input;
  if (previousRound.status !== "completed"
    || previousRound.reviewerTurnId === undefined
    || (previousRound.scope ?? "work-item") !== "task") {
    return {
      kind: "ineligible",
      reason: "Delta recheck requires a semantic completed Task-final ReviewRound."
    };
  }
  if (previousRound.taskCandidate === undefined) {
    return {
      kind: "ineligible",
      reason: "Previous Task-final ReviewRound has no frozen candidate."
    };
  }
  const previousByProject = new Map(
    previousRound.taskCandidate.projects.map((project) => [project.projectId, project.commit])
  );
  if (previousByProject.size !== candidate.projects.length) {
    return {
      kind: "ineligible",
      reason: "Delta recheck Project scope differs from the accepted baseline."
    };
  }
  const diffByProject: Record<string, string> = {};
  const changedFiles: string[] = [];
  let addedLines = 0;
  let deletedLines = 0;
  let anyChange = false;
  for (const project of candidate.projects) {
    const repositoryPath = repositoryPaths[project.projectId];
    if (repositoryPath === undefined) {
      return {
        kind: "ineligible",
        reason: `Delta recheck repository is unavailable for Project ${project.projectId}.`
      };
    }
    const previousHead = previousByProject.get(project.projectId);
    if (previousHead === undefined) {
      return {
        kind: "ineligible",
        reason: `Delta recheck scope changed: Project ${project.projectId} was not in the previous Review.`
      };
    }
    if (previousHead === project.commit) continue;
    if (!await git.isAncestor(repositoryPath, previousHead, project.commit)) {
      return {
        kind: "ineligible",
        reason: `Delta recheck requires a contiguous base: ${project.projectId} ${previousHead} `
          + `is not an ancestor of ${project.commit}.`
      };
    }
    let files: string[];
    let numstat: { addedLines: number; deletedLines: number };
    let diffText: string;
    try {
      files = await git.changedFilesBetween({
        repositoryPath,
        fromCommit: previousHead,
        toCommit: project.commit
      });
      numstat = await git.diffNumstatBetween({
        repositoryPath,
        fromCommit: previousHead,
        toCommit: project.commit
      });
      diffText = await git.diffTextBetween({
        repositoryPath,
        fromCommit: previousHead,
        toCommit: project.commit
      });
    } catch (error) {
      return {
        kind: "ineligible",
        reason: `Delta recheck cannot assess the diff for ${project.projectId}: `
          + `${error instanceof Error ? error.message : String(error)}`
      };
    }
    diffByProject[project.projectId] = diffText;
    changedFiles.push(...files);
    addedLines += numstat.addedLines;
    deletedLines += numstat.deletedLines;
    anyChange = true;
  }
  if (!anyChange) {
    return {
      kind: "ineligible",
      reason: "Frozen heads are unchanged; the previous acceptance already covers this candidate."
    };
  }
  const record = validateDeltaRecheckRecord({
    schemaVersion: 1,
    previousReviewRoundId: previousRound.id,
    previousBaseCommit: previousRound.taskCandidate.projects[0]!.commit,
    diffDigest: digestDiff(diffByProject),
    changedFiles,
    addedLines,
    deletedLines
  });
  return { kind: "eligible", preflight: { record, diffByProject } };
}

/** Fails closed when the dispatch diff does not match the recorded digest. */
export function verifyDeltaRecheckDiff(
  record: DeltaRecheckRecord,
  diffByProject: Readonly<Record<string, string>>
): void {
  if (digestDiff(diffByProject) !== record.diffDigest) {
    throw new Error("Delta recheck diff digest does not match the recorded recheck.");
  }
}

/** Builds the delta-recheck dispatch context block. */
export function buildDeltaRecheckDispatchContext(input: Readonly<{
  round: ReviewRound;
  previousRound: ReviewRound;
  diffByProject: Readonly<Record<string, string>>;
}>): string {
  const { round, previousRound, diffByProject } = input;
  const record = round.deltaRecheck;
  if (record === undefined) {
    throw new Error(`ReviewRound is not a delta-recheck: ${round.id}.`);
  }
  const lines = [
    "Review mode: delta-recheck (Issue 07). This is a fresh Review of the new frozen head;",
    "the previous acceptance is evidence, not a shortcut. You may return exactly one disposition:",
    "- equivalent-and-accepted: you proved the diff preserves every accepted semantic and",
    "  every evidence reference below remains valid. State the proof explicitly.",
    "- finding: the diff introduces a material problem; report it as a finding.",
    "- requires-full-review: you cannot prove equivalence (uncertainty, cross-scope,",
    "  semantic change, evidence doubt). This is the safe default.",
    "Yui verified only the technical delta boundary; a Task-control Agent selected this mode.",
    `Previous accepted ReviewRound: ${previousRound.id}@${record.previousBaseCommit}`,
    `Previous Reviewer Turn: ${previousRound.reviewerTurnId ?? "unavailable"}`,
    "Read that exact source Turn's original result from the frozen Context Snapshot.",
    ...(round.taskCandidate?.projects.map((project) => {
      const previous = previousRound.taskCandidate?.projects
        .find((entry) => entry.projectId === project.projectId)?.commit;
      return previous === project.commit
        ? `Exact boundary for ${project.projectId}: unchanged at ${project.commit}`
        : `Exact diff for ${project.projectId}: ${previous}..${project.commit}`;
    }) ?? []),
    `Changed files: ${record.changedFiles.join(", ") || "none"}`,
    `Diff size: +${record.addedLines}/-${record.deletedLines} (digest ${record.diffDigest})`,
    "Precise diff:",
    ...Object.entries(diffByProject).flatMap(([projectId, diff]) => (
      diff.trim().length === 0
        ? []
        : [`--- ${projectId} ---`, diff]
    )),
    "Return one complete result with the chosen disposition, reasoning, findings,",
    "verification, uncertainty, and recommended next action. Markdown or JSON is acceptable;",
    "Yui Core preserves the original text and does not parse or validate its structure."
  ];
  return lines.join("\n");
}

function digestDiff(diffByProject: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(
    Object.entries(diffByProject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, diff]) => [projectId, diff])
  );
  return createHash("sha256").update(canonical).digest("hex");
}
