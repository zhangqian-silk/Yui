import { createHash } from "node:crypto";

import {
  deltaRecheckMaxChangedFiles,
  deltaRecheckMaxChangedLines,
  type ReviewConfig
} from "./reviewConfig.js";
import {
  validateDeltaRecheckRecord,
  type DeltaRecheckRecord,
  type ReviewRound,
  type TaskReviewCandidate
} from "./reviewRound.js";
import { isSemanticReviewRound } from "./reviewOutcomeClassifier.js";

/**
 * Issue 07: delta-recheck protocol.
 *
 * A delta-recheck is a Task-final ReviewRound that rechecks a small, proven
 * diff on top of an already-accepted frozen head.  It never copies the old
 * acceptance: the new head always receives a fresh Reviewer disposition, and
 * any uncertainty escalates to a full Review.  The control plane enforces the
 * deterministic gates (contiguous base, attempt thresholds, evidence-file
 * overlap); the Reviewer alone judges semantic equivalence.
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
 * Assesses whether a delta-recheck may be attempted.  Every deterministic
 * gate fails closed here; semantic equivalence is always left to the
 * Reviewer's explicit disposition.
 */
export async function assessDeltaRecheck(input: Readonly<{
  /** Exact repository for every Project in the frozen Task candidate. */
  repositoryPaths: Readonly<Record<string, string>>;
  previousRound: ReviewRound;
  candidate: TaskReviewCandidate;
  git: DeltaRecheckGitPort;
  config: ReviewConfig;
}>): Promise<DeltaRecheckAssessment> {
  const { repositoryPaths, previousRound, candidate, git, config } = input;
  if (!isSemanticReviewRound(previousRound)
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
  const maxFiles = deltaRecheckMaxChangedFiles(config);
  if (changedFiles.length > maxFiles) {
    return {
      kind: "ineligible",
      reason: `Delta recheck attempt threshold exceeded: ${changedFiles.length} changed file(s) > ${maxFiles}.`
    };
  }
  const maxLines = deltaRecheckMaxChangedLines(config);
  if (addedLines + deletedLines > maxLines) {
    return {
      kind: "ineligible",
      reason: `Delta recheck attempt threshold exceeded: ${addedLines + deletedLines} changed line(s) > ${maxLines}.`
    };
  }
  // Evidence overlap: a diff touching a file the previous Round cited as
  // evidence cannot be proven equivalent by a delta recheck.
  const evidencePaths = extractEvidencePaths(previousRound);
  const overlapping = changedFiles.filter((file) => (
    evidencePaths.some((evidence) => pathEvidenceMatches(evidence, file))
  ));
  if (overlapping.length > 0) {
    return {
      kind: "ineligible",
      reason: "Delta recheck cannot prove evidence validity for changed evidence file(s): "
        + `${overlapping.join(", ")}.`
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
  ledgerContext: string;
}>): string {
  const { round, previousRound, diffByProject, ledgerContext } = input;
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
    "Path/line thresholds only allowed this attempt; they never imply safety.",
    `Previous accepted ReviewRound: ${previousRound.id}@${record.previousBaseCommit}`,
    `Previous acceptance summary: ${compact(previousRound.summary ?? previousRound.report ?? "")}`,
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
    ...(previousEvidenceReferences(previousRound).length === 0
      ? []
      : [
          "Previous evidence references:",
          ...previousEvidenceReferences(previousRound).map((entry) => `- ${entry}`)
        ]),
    ledgerContext,
    "Report JSON with deltaDisposition (one of the three values above) and deltaReasoning",
    "(the explicit proof or the reason a full Review is required). Findings, checks, and",
    "evidence use the same fields as a full Review."
  ];
  return lines.join("\n");
}

function compact(text: string, limit = 600): string {
  const flattened = text.replace(/\s+/gu, " ").trim();
  return flattened.length <= limit ? flattened : `${flattened.slice(0, limit)}...`;
}

function digestDiff(diffByProject: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(
    Object.entries(diffByProject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, diff]) => [projectId, diff])
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Extracts path-like evidence references from the previous Round's report.
 * Free-form evidence that is not a path is still passed to the Reviewer in
 * the dispatch context; only path-like entries drive the deterministic gate.
 */
function extractEvidencePaths(round: ReviewRound): string[] {
  return previousEvidenceReferences(round)
    .filter((entry) => isPathLike(entry));
}

/** All path-like evidence references from Markdown or JSON Review reports. */
function previousEvidenceReferences(round: ReviewRound): string[] {
  const report = round.report ?? "";
  return [...new Set([
    ...extractDeclaredEvidence(report),
    ...extractEvidenceReferences(report)
  ])];
}

/** Preserve the free-form evidence array that older JSON reports exposed. */
function extractDeclaredEvidence(report: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(report) as unknown;
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const evidence = (parsed as Record<string, unknown>).evidence;
  if (!Array.isArray(evidence)) return [];
  return evidence.flatMap((entry) => (
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []
  ));
}

/**
 * Reviewer reports intentionally accept clear Markdown or JSON without a
 * fixed schema. Extract conservative repo-relative path tokens from the full
 * preserved report so evidence overlap cannot be bypassed by presentation
 * format, nested JSON, Markdown links, backticks, or line-qualified paths.
 */
function extractEvidenceReferences(report: string): string[] {
  const references = report.match(
    /(?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}/gu
  ) ?? [];
  return [...new Set(references.map((entry) => entry.replace(/^\.\//u, "")))]
    .filter((entry) => isPathLike(entry));
}

function isPathLike(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (/\s/u.test(value)) return false;
  if (value.includes("://")) return false;
  // A repo-relative path: at least one slash or a known file extension, no
  // shell/argument metacharacters.
  if (/[;&|`$(){}!<>]/u.test(value)) return false;
  return value.includes("/") || /\.[A-Za-z0-9]{1,12}$/u.test(value);
}

function pathEvidenceMatches(evidencePath: string, changedFile: string): boolean {
  const normalizedEvidence = evidencePath.replace(/^\.\//u, "").replace(/\/+$/u, "");
  const normalizedFile = changedFile.replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (normalizedEvidence === normalizedFile) return true;
  // A directory-level evidence reference covers every file under it.
  return normalizedFile.startsWith(`${normalizedEvidence}/`);
}
