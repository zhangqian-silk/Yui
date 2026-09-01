import type { ChangeSetManifestTag } from "./changeSetManifest.js";
import { manifestTagsForPath } from "./manifestTags.js";
import type { ChangeSet } from "./changeSet.js";
import { formatTaskRecordReference } from "../task/taskRecordReference.js";

/**
 * Read-only cross-Task overlap diagnostics.
 *
 * The diagnostics are static metadata analysis: they consume the latest
 * ChangeSet per (Task, WorkItem, Project) and classify pairwise overlap by
 * semantic category.  They never gate development and never mutate state;
 * the suggested integration order and review areas are advisory.
 */

export type OverlapFindingKind =
  | "path-only"
  | "contract"
  | "schema-migration"
  | "cli-surface"
  | "package-version"
  | "high-risk-deletion";

export type OverlapRisk = "high" | "medium" | "low";

export type OverlapSubject = Readonly<{
  taskId: string;
  workItemId: string;
  projectId: string;
  changeSetId: string;
  baseCommit: string;
  headCommit: string;
  changedPaths: readonly string[];
  manifestTags: readonly ChangeSetManifestTag[];
  deletedPaths: readonly string[];
}>;

export type OverlapFinding = Readonly<{
  kind: OverlapFindingKind;
  risk: OverlapRisk;
  /**
   * The two ChangeSets whose overlap produced this finding, sorted.  Each
   * entry is a qualified Task record reference (`taskId/changeSetId`) so that
   * same-local-id ChangeSets from different Tasks stay distinct.
   */
  changeSetIds: readonly string[];
  /** The shared paths that drive this finding, sorted. */
  paths: readonly string[];
  detail: string;
}>;

export type OverlapReport = Readonly<{
  subjects: readonly OverlapSubject[];
  findings: readonly OverlapFinding[];
  /**
   * Qualified ChangeSet references (`taskId/changeSetId`) in the suggested
   * integration order.
   */
  suggestedOrder: readonly string[];
  /** Human-readable semantic review areas for high/medium findings. */
  reviewAreas: readonly string[];
}>;

/**
 * Qualified Task record reference for a subject's ChangeSet.  A bare
 * `changeSetId` is only unique within its Task, so cross-Task findings and
 * ordering key subjects by `taskId/changeSetId`.
 */
export function overlapSubjectKey(subject: OverlapSubject): string {
  return formatTaskRecordReference(subject.taskId, subject.changeSetId, "changeSet");
}

export const OVERLAP_FINDING_KINDS: readonly OverlapFindingKind[] = [
  "path-only",
  "contract",
  "schema-migration",
  "cli-surface",
  "package-version",
  "high-risk-deletion"
];

export function overlapSubjectFromChangeSet(changeSet: ChangeSet): OverlapSubject {
  return {
    taskId: changeSet.taskId,
    workItemId: changeSet.workItemId,
    projectId: changeSet.projectId,
    changeSetId: changeSet.id,
    baseCommit: changeSet.baseCommit,
    headCommit: changeSet.headCommit,
    changedPaths: changeSet.changedPaths,
    manifestTags: changeSet.manifest.tags,
    deletedPaths: changeSet.manifest.deletedPaths
  };
}

/**
 * Diagnose pairwise overlap between ChangeSets of the same Project.
 * Subjects of different Projects never overlap (a Project is the integration
 * boundary), and a pair may produce several findings when their shared paths
 * span categories.
 */
export function diagnoseOverlap(subjects: readonly OverlapSubject[]): OverlapReport {
  const sortedSubjects = [...subjects].sort(compareSubjects);
  const findings: OverlapFinding[] = [];
  for (let index = 0; index < sortedSubjects.length; index += 1) {
    for (let other = index + 1; other < sortedSubjects.length; other += 1) {
      const left = sortedSubjects[index]!;
      const right = sortedSubjects[other]!;
      if (left.projectId !== right.projectId) continue;
      findings.push(...pairFindings(left, right));
    }
  }
  findings.sort(compareFindings);
  return {
    subjects: sortedSubjects,
    findings,
    suggestedOrder: suggestedOrder(sortedSubjects, findings),
    reviewAreas: reviewAreas(findings)
  };
}

function pairFindings(left: OverlapSubject, right: OverlapSubject): OverlapFinding[] {
  const shared = sortedIntersection(left.changedPaths, right.changedPaths);
  if (shared.length === 0) return [];
  const pair = [overlapSubjectKey(left), overlapSubjectKey(right)].sort();
  const findings: OverlapFinding[] = [];

  // Deletions that touch paths the other side still changes are the highest
  // risk: one side removes what the other side builds on.  The trigger is the
  // real deleted-path overlap itself; requiring both sides to carry the
  // deletion tag would miss the ordinary delete-vs-modify case, where only
  // the deleting side can record the deletion.
  const deletedVsOther = sortedIntersection(left.deletedPaths, right.changedPaths)
    .concat(sortedIntersection(right.deletedPaths, left.changedPaths));
  const deletedOverlap = [...new Set(deletedVsOther)].sort();
  if (deletedOverlap.length > 0) {
    findings.push({
      kind: "high-risk-deletion",
      risk: "high",
      changeSetIds: pair,
      paths: deletedOverlap,
      detail: "One ChangeSet deletes paths the other still changes; reconcile deletion intent before integration."
    });
  }

  const schemaPaths = shared.filter((path) => manifestTagsForPath(path).some(
    (tag) => tag === "schema" || tag === "migration"
  ));
  if (bothTagged(left, right, "schema") || bothTagged(left, right, "migration")) {
    if (schemaPaths.length > 0) {
      const bothMigration = hasTag(left, "migration") && hasTag(right, "migration");
      findings.push({
        kind: "schema-migration",
        risk: bothMigration ? "high" : "medium",
        changeSetIds: pair,
        paths: schemaPaths,
        detail: bothMigration
          ? "Both ChangeSets add migrations; their sequence must be reviewed to keep the migration order linear."
          : "Both ChangeSets touch schema or migration code; review the schema evolution order."
      });
    }
  }

  const contractPaths = shared.filter((path) => manifestTagsForPath(path).includes("contract"));
  if (bothTagged(left, right, "contract") && contractPaths.length > 0) {
    findings.push({
      kind: "contract",
      risk: "high",
      changeSetIds: pair,
      paths: contractPaths,
      detail: "Both ChangeSets modify the same public contract; review API compatibility before integration."
    });
  }

  const cliPaths = shared.filter((path) => manifestTagsForPath(path).some(
    (tag) => tag === "command" || tag === "snapshot"
  ));
  const bothCli = (hasTag(left, "command") || hasTag(left, "snapshot"))
    && (hasTag(right, "command") || hasTag(right, "snapshot"));
  if (bothCli && cliPaths.length > 0) {
    findings.push({
      kind: "cli-surface",
      risk: "medium",
      changeSetIds: pair,
      paths: cliPaths,
      detail: "Both ChangeSets touch the CLI surface or its snapshots; review the combined command behavior."
    });
  }

  const packagePaths = shared.filter((path) => manifestTagsForPath(path).includes("package"));
  if (bothTagged(left, right, "package") && packagePaths.length > 0) {
    findings.push({
      kind: "package-version",
      risk: "medium",
      changeSetIds: pair,
      paths: packagePaths,
      detail: "Both ChangeSets modify package metadata; review the merged version and dependency set."
    });
  }

  // Everything else that still shares paths is a plain text overlap: likely
  // to conflict on apply, but with no declared semantic surface at stake.
  const claimed = new Set(findings.flatMap((finding) => finding.paths));
  const remaining = shared.filter((path) => !claimed.has(path));
  if (remaining.length > 0) {
    findings.push({
      kind: "path-only",
      risk: "low",
      changeSetIds: pair,
      paths: remaining,
      detail: "Changed paths overlap without a shared semantic tag; expect a text conflict resolved by Git."
    });
  }
  return findings;
}

/**
 * Suggested integration order:
 *  1. schema/migration-bearing ChangeSets first (they define the sequence
 *     everything else builds on),
 *  2. then subjects by ascending high-risk finding count,
 *  3. then by qualified ChangeSet reference for a deterministic order.
 */
function suggestedOrder(
  subjects: readonly OverlapSubject[],
  findings: readonly OverlapFinding[]
): readonly string[] {
  const highRiskCount = new Map<string, number>();
  for (const finding of findings) {
    if (finding.risk !== "high") continue;
    for (const ref of finding.changeSetIds) {
      highRiskCount.set(ref, (highRiskCount.get(ref) ?? 0) + 1);
    }
  }
  return [...subjects]
    .sort((left, right) => {
      const leftSchema = carriesSchemaOrMigration(left) ? 0 : 1;
      const rightSchema = carriesSchemaOrMigration(right) ? 0 : 1;
      if (leftSchema !== rightSchema) return leftSchema - rightSchema;
      const leftRisk = highRiskCount.get(overlapSubjectKey(left)) ?? 0;
      const rightRisk = highRiskCount.get(overlapSubjectKey(right)) ?? 0;
      if (leftRisk !== rightRisk) return leftRisk - rightRisk;
      return compareSubjects(left, right);
    })
    .map((subject) => overlapSubjectKey(subject));
}

const REVIEW_AREA_LABELS: Readonly<Record<OverlapFindingKind, string>> = {
  "path-only": "path overlap (low): text conflicts resolved by Git",
  contract: "public contract (high): API compatibility",
  "schema-migration": "schema/migration (high/medium): migration sequence and schema evolution",
  "cli-surface": "CLI surface (medium): combined command behavior and snapshots",
  "package-version": "package metadata (medium): merged version and dependencies",
  "high-risk-deletion": "high-risk deletion (high): deletion intent across Tasks"
};

function reviewAreas(findings: readonly OverlapFinding[]): readonly string[] {
  const kinds = new Set<OverlapFindingKind>();
  for (const finding of findings) {
    if (finding.risk === "high" || finding.risk === "medium") kinds.add(finding.kind);
  }
  return OVERLAP_FINDING_KINDS.filter((kind) => kinds.has(kind))
    .map((kind) => REVIEW_AREA_LABELS[kind]);
}

function carriesSchemaOrMigration(subject: OverlapSubject): boolean {
  return hasTag(subject, "schema") || hasTag(subject, "migration");
}

function hasTag(subject: OverlapSubject, tag: ChangeSetManifestTag): boolean {
  return subject.manifestTags.includes(tag);
}

function bothTagged(
  left: OverlapSubject,
  right: OverlapSubject,
  tag: ChangeSetManifestTag
): boolean {
  return hasTag(left, tag) && hasTag(right, tag);
}

function sortedIntersection(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return [...new Set(left.filter((path) => other.has(path)))].sort();
}

function compareSubjects(left: OverlapSubject, right: OverlapSubject): number {
  return overlapSubjectKey(left).localeCompare(overlapSubjectKey(right));
}

function compareFindings(left: OverlapFinding, right: OverlapFinding): number {
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;
  return left.changeSetIds.join(",").localeCompare(right.changeSetIds.join(","));
}
