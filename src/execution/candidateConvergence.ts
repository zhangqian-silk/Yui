import { requireIdentity, requireText } from "../domain/validation.js";
import type {
  ExecutionGroup,
  ExecutionLaneResult,
  ExecutionParentResultRef,
  ExecutionStageContext,
  WorkItemExplorationStage
} from "./executionGroup.js";
import type { WorkItem } from "../workItem/workItem.js";

export const CANDIDATE_CONVERGENCE_SCHEMA_VERSION = 1 as const;

export const CANDIDATE_ARTIFACT_TYPES = [
  "research",
  "architecture",
  "code"
] as const;

export type CandidateArtifactType = typeof CANDIDATE_ARTIFACT_TYPES[number];

export type NormalizedCandidate = Readonly<{
  key: string;
  claims: readonly Readonly<{
    id: string;
    statement: string;
    evidenceRefs: readonly string[];
  }>[];
  artifactRefs: readonly string[];
  assumptions: readonly string[];
  tradeoffs: readonly string[];
}>;

export type CandidateConvergenceEnvelope = Readonly<{
  schemaVersion: typeof CANDIDATE_CONVERGENCE_SCHEMA_VERSION;
  stage: WorkItemExplorationStage;
  artifactType: CandidateArtifactType;
  parentResultRefs: readonly string[];
  comparison?: Readonly<{
    clusters: readonly Readonly<{
      id: string;
      resultRefs: readonly string[];
      rationale: string;
    }>[];
    selectedResultRefs: readonly string[];
    evidenceBasis: readonly Readonly<{
      resultRef: string;
      kind: "executable-check" | "direct-source" | "frozen-artifact" | "derived-analysis";
      detail: string;
    }>[];
    contradictions: readonly string[];
  }>;
  candidate?: NormalizedCandidate;
  synthesis?: Readonly<{
    strategy: "claim-evidence-table" | "decision-matrix" | "frozen-code-selection";
    sourceResultRefs: readonly string[];
    unresolvedContradictions: readonly string[];
  }>;
  verification?: Readonly<{
    subjectResultRef: string;
    disposition: "passed" | "needs-next-round" | "inconclusive";
    criteria: readonly Readonly<{
      criterion: string;
      status: "passed" | "failed" | "unverified";
      evidenceRefs: readonly string[];
    }>[];
    gaps: readonly string[];
  }>;
  resolution?: Readonly<{
    subjectResultRef: string;
    disposition: "candidate" | "next-round";
    rationale: string;
  }>;
}>;

/** The exact stage-local result contract appended to managed Lane assignments. */
export function candidateConvergenceDirective(stage: ExecutionStageContext): string {
  if (stage.convergence === undefined) return "";
  const parentRefs = stage.parentResults.map(parentResultRef);
  const common = [
    "Candidate convergence contract v1 is active.",
    "Yield one JSON object. Keep summary/checks/findings/evidence at the top level and add convergence={schemaVersion:1,stage,artifactType,parentResultRefs,...}.",
    `convergence.stage must be ${stage.stage}; parentResultRefs must equal ${JSON.stringify(parentRefs)} in this order.`,
    "artifactType is research, architecture, or code and must stay unchanged across the round.",
    "Use only frozen parent result references; never replay sibling transcripts. Direct sources, executable checks, and frozen artifacts outrank derived analysis or vote counts."
  ];
  const specific: Record<WorkItemExplorationStage, string> = {
    plan: "Choose artifactType and state the evidence and acceptance plan in the report; parentResultRefs is empty.",
    generate: "Add candidate={key,claims:[{id,statement,evidenceRefs}],artifactRefs,assumptions,tradeoffs}. Independent hypotheses may be unsupported here, but every evidenceRef must name top-level evidence.",
    compare: "Add comparison={clusters:[{id,resultRefs,rationale}],selectedResultRefs,evidenceBasis:[{resultRef,kind,detail}],contradictions}. Clusters partition every parent exactly once; every selected result needs executable-check, direct-source, or frozen-artifact evidence.",
    synthesize: "Add candidate plus synthesis={strategy,sourceResultRefs,unresolvedContradictions}. strategy is claim-evidence-table for research, decision-matrix for architecture, and frozen-code-selection for code. Code selects one frozen tree; do not splice unfrozen edits.",
    verify: "Add verification={subjectResultRef,disposition,criteria:[{criterion,status,evidenceRefs}],gaps}. disposition is passed, needs-next-round, or inconclusive. passed requires every criterion passed with evidence and no gaps; code also requires passed executable checks on the unchanged frozen Git snapshot.",
    resolve: "Add resolution={subjectResultRef,disposition,rationale}. disposition=candidate only for a passed Verify parent; otherwise disposition=next-round so the Leader can use Resolve retry within the frozen round budget."
  };
  return [...common, specific[stage.stage]].join("\n");
}

/**
 * Parse one selected Lane's durable JSON report at an exploration boundary.
 * Unknown report fields remain preserved in ExecutionLaneResult.report; this
 * parser validates only the convergence contract that the control plane can
 * prove without pretending to perform semantic comparison itself.
 */
export function validateCandidateConvergenceReport(
  result: ExecutionLaneResult,
  stage: WorkItemExplorationStage,
  parentResults: readonly ExecutionParentResultRef[]
): CandidateConvergenceEnvelope {
  const report = requireText(result.report ?? "", "Candidate convergence report");
  let parsed: unknown;
  try {
    parsed = JSON.parse(report) as unknown;
  } catch {
    throw new Error("Candidate convergence report must be a JSON object.");
  }
  const root = asObject(parsed, "Candidate convergence report");
  const envelope = asObject(root.convergence, "Candidate convergence envelope");
  if (envelope.schemaVersion !== CANDIDATE_CONVERGENCE_SCHEMA_VERSION) {
    throw new Error("Candidate convergence envelope must use schemaVersion 1.");
  }
  if (envelope.stage !== stage) {
    throw new Error(`Candidate convergence stage does not match ${stage}.`);
  }
  if (!CANDIDATE_ARTIFACT_TYPES.includes(envelope.artifactType as CandidateArtifactType)) {
    throw new Error("Candidate convergence artifactType is invalid.");
  }
  const expectedParents = parentResults.map(parentResultRef);
  const declaredParents = textArray(envelope.parentResultRefs, "Candidate parent result ref");
  if (!sameStrings(declaredParents, expectedParents)) {
    throw new Error("Candidate convergence parentResultRefs do not match the frozen stage parents.");
  }
  const base = {
    schemaVersion: CANDIDATE_CONVERGENCE_SCHEMA_VERSION,
    stage,
    artifactType: envelope.artifactType as CandidateArtifactType,
    parentResultRefs: declaredParents
  };
  if (stage === "compare") {
    return { ...base, comparison: validateComparison(envelope.comparison, expectedParents) };
  }
  if (stage === "synthesize") {
    return {
      ...base,
      candidate: validateCandidate(
        envelope.candidate,
        envelope.artifactType as CandidateArtifactType,
        result,
        true
      ),
      synthesis: validateSynthesis(
        envelope.synthesis,
        envelope.artifactType as CandidateArtifactType,
        expectedParents
      )
    };
  }
  if (stage === "verify") {
    return {
      ...base,
      verification: validateVerification(
        envelope.verification,
        envelope.artifactType as CandidateArtifactType,
        expectedParents,
        result
      )
    };
  }
  if (stage === "generate") {
    return {
      ...base,
      candidate: validateCandidate(
        envelope.candidate,
        envelope.artifactType as CandidateArtifactType,
        result,
        false
      )
    };
  }
  if (stage === "resolve") {
    const resolution = validateResolutionPayload(envelope.resolution, expectedParents);
    return {
      ...base,
      resolution
    };
  }
  return base;
}

/**
 * Verify runs must not reuse a Role that authored the selected synthesized
 * subject. Task Roles own distinct native Sessions, so this direct-parent
 * check supplies the minimum provider-neutral independence boundary without
 * excluding independent generators or critics from later verification.
 */
export function assertIndependentVerificationRoles(
  workItem: Pick<WorkItem, "executionGroups">,
  stage: ExecutionStageContext,
  roleNames: readonly string[]
): void {
  if (stage.stage !== "verify" || stage.convergence === undefined) return;
  const forbidden = new Set(stage.parentResults.map((parent) => (
    requireParentLane(workItem, parent).lane.roleName
  )));
  const reused = roleNames.filter((roleName) => forbidden.has(roleName));
  if (reused.length > 0) {
    throw new Error(
      `Verify Roles must be independent from selected Synthesize authors in round ${stage.round}: `
      + reused.join(", ")
    );
  }
}

/**
 * Validate the Leader's durable Group decision against the selected stage
 * reports. Semantic judgment remains with Agents and Leader; only structural
 * evidence, independence and passed-vs-next-round boundaries are enforced.
 */
export function validateCandidateConvergenceResolution(
  workItem: Pick<WorkItem, "executionGroups">,
  group: ExecutionGroup
): void {
  const stage = group.stage;
  const resolution = group.resolution;
  if (stage?.convergence === undefined || resolution === undefined) return;
  if (resolution.decision !== "accept"
    && !(stage.stage === "resolve" && resolution.decision === "retry")) {
    return;
  }
  const selected = resolution.selectedLaneIds.map((laneId) => {
    const lane = group.lanes.find(({ id }) => id === laneId);
    if (lane?.result === undefined) {
      throw new Error(`Selected convergence Lane result is missing: ${group.id}/${laneId}.`);
    }
    return {
      lane,
      envelope: validateCandidateConvergenceReport(
        lane.result,
        stage.stage,
        stage.parentResults
      )
    };
  });
  const parentTypes = stage.parentResults.map((parent) => {
    const source = requireParentLane(workItem, parent);
    if (source.group.stage?.convergence === undefined || source.lane.result === undefined) {
      throw new Error(`Candidate convergence parent is not structured: ${parentResultRef(parent)}.`);
    }
    return validateCandidateConvergenceReport(
      source.lane.result,
      source.group.stage.stage,
      source.group.stage.parentResults
    ).artifactType;
  });
  const artifactTypes = new Set([
    ...parentTypes,
    ...selected.map(({ envelope }) => envelope.artifactType)
  ]);
  if (artifactTypes.size > 1) {
    throw new Error("Candidate convergence cannot mix artifact types across a stage boundary.");
  }
  if (stage.stage === "compare") {
    for (const { envelope } of selected) {
      for (const basis of envelope.comparison!.evidenceBasis) {
        if (basis.kind === "derived-analysis") continue;
        const evidence = resultForRef(workItem, basis.resultRef);
        const supported = basis.kind === "executable-check"
          ? (evidence.checks ?? []).some(({ outcome }) => outcome === "passed")
          : basis.kind === "direct-source"
            ? (evidence.evidence?.length ?? 0) > 0
            : evidence.gitSnapshot !== undefined || evidence.evidenceCommit !== undefined;
        if (!supported) {
          throw new Error(
            `Candidate comparison ${basis.kind} is not supported by ${basis.resultRef}.`
          );
        }
      }
      if (envelope.artifactType === "code"
        && envelope.comparison!.selectedResultRefs.length !== 1) {
        throw new Error("Code comparison must select one frozen candidate before synthesis.");
      }
    }
  }
  if (stage.stage === "verify") {
    for (const { lane, envelope } of selected) {
      if (envelope.artifactType === "code"
        && envelope.verification!.disposition === "passed") {
        assertSameGitSnapshot(
          lane.result!.gitSnapshot,
          resultForRef(workItem, envelope.verification!.subjectResultRef).gitSnapshot,
          "Passed code verification"
        );
      }
    }
  }
  if (stage.stage !== "resolve") return;
  for (const { lane, envelope } of selected) {
    const verification = convergenceForRef(workItem, envelope.resolution!.subjectResultRef);
    if (verification.verification === undefined) {
      throw new Error("Resolve subject is not a Verify result.");
    }
    if (resolution.decision === "accept") {
      if (envelope.resolution!.disposition !== "candidate"
        || verification.verification.disposition !== "passed") {
        throw new Error("Resolve cannot accept a Candidate without passed verification.");
      }
      if (envelope.artifactType === "code") {
        assertSameGitSnapshot(
          lane.result!.gitSnapshot,
          resultForRef(workItem, envelope.resolution!.subjectResultRef).gitSnapshot,
          "Resolved code Candidate"
        );
      }
      continue;
    }
    if (envelope.resolution!.disposition !== "next-round"
      || verification.verification.disposition === "passed") {
      throw new Error("Resolve retry requires a non-passing Verify result and next-round disposition.");
    }
  }
}

function validateComparison(
  value: unknown,
  expectedParents: readonly string[]
): NonNullable<CandidateConvergenceEnvelope["comparison"]> {
  const comparison = asObject(value, "Candidate comparison");
  if (!Array.isArray(comparison.clusters) || comparison.clusters.length === 0) {
    throw new Error("Candidate comparison requires explicit clusters.");
  }
  const clusterIds = new Set<string>();
  const clusteredRefs: string[] = [];
  const clusters = comparison.clusters.map((value, index) => {
    const cluster = asObject(value, `Candidate cluster ${index + 1}`);
    const id = requireIdentity(requiredText(cluster.id, "Candidate cluster id"), "Candidate cluster id");
    if (clusterIds.has(id)) throw new Error(`Candidate cluster is duplicated: ${id}.`);
    clusterIds.add(id);
    const resultRefs = textArray(cluster.resultRefs, "Candidate cluster result ref");
    if (resultRefs.length === 0) throw new Error(`Candidate cluster is empty: ${id}.`);
    clusteredRefs.push(...resultRefs);
    return {
      id,
      resultRefs,
      rationale: requiredText(cluster.rationale, "Candidate cluster rationale")
    };
  });
  if (new Set(clusteredRefs).size !== clusteredRefs.length
    || !sameStringSets(clusteredRefs, expectedParents)) {
    throw new Error("Candidate comparison clusters must partition every frozen parent result exactly once.");
  }
  const selectedResultRefs = textArray(
    comparison.selectedResultRefs,
    "Selected candidate result ref"
  );
  if (selectedResultRefs.length === 0
    || new Set(selectedResultRefs).size !== selectedResultRefs.length
    || selectedResultRefs.some((ref) => !expectedParents.includes(ref))) {
    throw new Error("Candidate comparison selectedResultRefs are invalid.");
  }
  if (!Array.isArray(comparison.evidenceBasis)) {
    throw new Error("Candidate comparison evidenceBasis is invalid.");
  }
  const evidenceBasis = comparison.evidenceBasis.map((value, index) => {
    const basis = asObject(value, `Candidate evidence basis ${index + 1}`);
    const resultRef = requiredText(basis.resultRef, "Candidate evidence result ref");
    if (!expectedParents.includes(resultRef)) {
      throw new Error(`Candidate evidence references an unknown result: ${resultRef}.`);
    }
    if (basis.kind !== "executable-check"
      && basis.kind !== "direct-source"
      && basis.kind !== "frozen-artifact"
      && basis.kind !== "derived-analysis") {
      throw new Error("Candidate evidence kind is invalid.");
    }
    return {
      resultRef,
      kind: basis.kind as NonNullable<CandidateConvergenceEnvelope["comparison"]>["evidenceBasis"][number]["kind"],
      detail: requiredText(basis.detail, "Candidate evidence detail")
    };
  });
  for (const selected of selectedResultRefs) {
    const direct = evidenceBasis.some(({ resultRef, kind }) => (
      resultRef === selected && kind !== "derived-analysis"
    ));
    if (!direct) {
      throw new Error(
        `Selected candidate ${selected} requires direct or executable evidence; `
        + "derived analysis or voting alone is insufficient."
      );
    }
  }
  return {
    clusters,
    selectedResultRefs,
    evidenceBasis,
    contradictions: textArray(comparison.contradictions, "Candidate contradiction")
  };
}

function validateCandidate(
  value: unknown,
  artifactType: CandidateArtifactType,
  result: ExecutionLaneResult,
  requireEvidence: boolean
): NormalizedCandidate {
  const candidate = asObject(value, "Normalized candidate");
  if (!Array.isArray(candidate.claims) || candidate.claims.length === 0) {
    throw new Error("Normalized candidate requires material claims.");
  }
  const evidence = new Set(result.evidence ?? []);
  const claimIds = new Set<string>();
  const claims = candidate.claims.map((value, index) => {
    const claim = asObject(value, `Candidate claim ${index + 1}`);
    const id = requireIdentity(requiredText(claim.id, "Candidate claim id"), "Candidate claim id");
    if (claimIds.has(id)) throw new Error(`Candidate claim is duplicated: ${id}.`);
    claimIds.add(id);
    const evidenceRefs = textArray(claim.evidenceRefs, "Candidate claim evidence ref");
    if (requireEvidence && evidenceRefs.length === 0) {
      throw new Error(`Synthesized candidate claim requires evidence: ${id}.`);
    }
    if (evidenceRefs.some((ref) => !evidence.has(ref))) {
      throw new Error(`Candidate claim references unavailable evidence: ${id}.`);
    }
    return {
      id,
      statement: requiredText(claim.statement, "Candidate claim statement"),
      evidenceRefs
    };
  });
  const artifactRefs = textArray(candidate.artifactRefs, "Candidate artifact ref");
  if (artifactRefs.length === 0) throw new Error("Normalized candidate requires artifactRefs.");
  if (artifactType === "code" && result.gitSnapshot === undefined) {
    throw new Error("A code candidate requires a frozen Git snapshot.");
  }
  return {
    key: requiredText(candidate.key, "Candidate key"),
    claims,
    artifactRefs,
    assumptions: optionalTextArray(candidate.assumptions, "Candidate assumption"),
    tradeoffs: optionalTextArray(candidate.tradeoffs, "Candidate tradeoff")
  };
}

function validateResolutionPayload(
  value: unknown,
  expectedParents: readonly string[]
): NonNullable<CandidateConvergenceEnvelope["resolution"]> {
  const resolution = asObject(value, "Candidate resolution");
  const subjectResultRef = requiredText(
    resolution.subjectResultRef,
    "Candidate resolution subject result ref"
  );
  if (!expectedParents.includes(subjectResultRef)) {
    throw new Error("Candidate resolution subjectResultRef is not a frozen parent result.");
  }
  if (resolution.disposition !== "candidate" && resolution.disposition !== "next-round") {
    throw new Error("Candidate resolution disposition is invalid.");
  }
  return {
    subjectResultRef,
    disposition: resolution.disposition,
    rationale: requiredText(resolution.rationale, "Candidate resolution rationale")
  };
}

function validateSynthesis(
  value: unknown,
  artifactType: CandidateArtifactType,
  expectedParents: readonly string[]
): NonNullable<CandidateConvergenceEnvelope["synthesis"]> {
  const synthesis = asObject(value, "Candidate synthesis");
  const expectedStrategy = artifactType === "research"
    ? "claim-evidence-table"
    : artifactType === "architecture"
      ? "decision-matrix"
      : "frozen-code-selection";
  if (synthesis.strategy !== expectedStrategy) {
    throw new Error(
      `Candidate ${artifactType} synthesis must use ${expectedStrategy}.`
    );
  }
  const sourceResultRefs = textArray(
    synthesis.sourceResultRefs,
    "Candidate synthesis source result ref"
  );
  if (sourceResultRefs.length === 0
    || new Set(sourceResultRefs).size !== sourceResultRefs.length
    || sourceResultRefs.some((ref) => !expectedParents.includes(ref))) {
    throw new Error("Candidate synthesis sourceResultRefs are invalid.");
  }
  return {
    strategy: expectedStrategy,
    sourceResultRefs,
    unresolvedContradictions: textArray(
      synthesis.unresolvedContradictions,
      "Candidate synthesis unresolved contradiction"
    )
  };
}

function validateVerification(
  value: unknown,
  artifactType: CandidateArtifactType,
  expectedParents: readonly string[],
  result: ExecutionLaneResult
): NonNullable<CandidateConvergenceEnvelope["verification"]> {
  const verification = asObject(value, "Candidate verification");
  const subjectResultRef = requiredText(
    verification.subjectResultRef,
    "Candidate verification subject result ref"
  );
  if (!expectedParents.includes(subjectResultRef)) {
    throw new Error("Candidate verification subjectResultRef is not a frozen parent result.");
  }
  if (verification.disposition !== "passed"
    && verification.disposition !== "needs-next-round"
    && verification.disposition !== "inconclusive") {
    throw new Error("Candidate verification disposition is invalid.");
  }
  if (!Array.isArray(verification.criteria) || verification.criteria.length === 0) {
    throw new Error("Candidate verification requires acceptance criteria.");
  }
  const availableEvidence = new Set([
    ...(result.evidence ?? []),
    ...(result.checks ?? [])
      .filter(({ outcome }) => outcome === "passed")
      .map(({ name }) => name)
  ]);
  const criteria = verification.criteria.map((value, index) => {
    const criterion = asObject(value, `Candidate verification criterion ${index + 1}`);
    if (criterion.status !== "passed"
      && criterion.status !== "failed"
      && criterion.status !== "unverified") {
      throw new Error("Candidate verification criterion status is invalid.");
    }
    const evidenceRefs = textArray(
      criterion.evidenceRefs,
      "Candidate verification criterion evidence ref"
    );
    if (evidenceRefs.some((ref) => !availableEvidence.has(ref))) {
      throw new Error("Candidate verification criterion references unavailable evidence.");
    }
    return {
      criterion: requiredText(criterion.criterion, "Candidate verification criterion"),
      status: criterion.status as NonNullable<CandidateConvergenceEnvelope["verification"]>["criteria"][number]["status"],
      evidenceRefs
    };
  });
  const gaps = textArray(verification.gaps, "Candidate verification gap");
  if (verification.disposition === "passed") {
    if (gaps.length > 0
      || criteria.some(({ status, evidenceRefs }) => status !== "passed" || evidenceRefs.length === 0)
      || (result.checks ?? []).some(({ outcome }) => outcome !== "passed")
      || (result.findings ?? []).some(({ status, severity }) => (
        status === "open" && (severity === "high" || severity === "critical")
      ))) {
      throw new Error("A passed verification requires complete criterion evidence and no gaps or failed checks.");
    }
    if (artifactType === "code"
      && ((result.checks?.length ?? 0) === 0 || result.gitSnapshot === undefined)) {
      throw new Error("Passed code verification requires executable checks and a frozen Git snapshot.");
    }
  } else if (gaps.length === 0
    || criteria.every(({ status }) => status === "passed")) {
    throw new Error("A non-passing verification must identify a bounded gap for the next round.");
  }
  return {
    subjectResultRef,
    disposition: verification.disposition,
    criteria,
    gaps
  };
}

function parentResultRef(parent: ExecutionParentResultRef): string {
  return `${parent.executionGroupId}/${parent.executionLaneId}`;
}

function requireParentLane(
  workItem: Pick<WorkItem, "executionGroups">,
  parent: Pick<ExecutionParentResultRef, "executionGroupId" | "executionLaneId">
): Readonly<{
  group: ExecutionGroup;
  lane: ExecutionGroup["lanes"][number];
}> {
  const group = workItem.executionGroups.find(({ id }) => id === parent.executionGroupId);
  const lane = group?.lanes.find(({ id }) => id === parent.executionLaneId);
  if (group === undefined || lane === undefined) {
    throw new Error(
      `Candidate convergence parent result is missing: `
      + `${parent.executionGroupId}/${parent.executionLaneId}.`
    );
  }
  return { group, lane };
}

function splitResultRef(value: string): Readonly<{
  executionGroupId: string;
  executionLaneId: string;
}> {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf("/", separator + 1) !== -1) {
    throw new Error(`Candidate result ref is invalid: ${value}.`);
  }
  return {
    executionGroupId: value.slice(0, separator),
    executionLaneId: value.slice(separator + 1)
  };
}

function resultForRef(
  workItem: Pick<WorkItem, "executionGroups">,
  value: string
): ExecutionLaneResult {
  const source = requireParentLane(workItem, splitResultRef(value));
  if (source.lane.result === undefined) {
    throw new Error(`Candidate convergence result is missing: ${value}.`);
  }
  return source.lane.result;
}

function convergenceForRef(
  workItem: Pick<WorkItem, "executionGroups">,
  value: string
): CandidateConvergenceEnvelope {
  const ref = splitResultRef(value);
  const source = requireParentLane(workItem, ref);
  if (source.group.stage?.convergence === undefined || source.lane.result === undefined) {
    throw new Error(`Candidate convergence result is not structured: ${value}.`);
  }
  return validateCandidateConvergenceReport(
    source.lane.result,
    source.group.stage.stage,
    source.group.stage.parentResults
  );
}

function assertSameGitSnapshot(
  actual: ExecutionLaneResult["gitSnapshot"],
  expected: ExecutionLaneResult["gitSnapshot"],
  label: string
): void {
  const normalized = (snapshot: ExecutionLaneResult["gitSnapshot"]): readonly string[] | null => (
    snapshot === undefined
      ? null
      : snapshot.projects
        .map(({ projectId, headCommit }) => `${projectId}\0${headCommit}`)
        .sort()
  );
  const actualProjects = normalized(actual);
  const expectedProjects = normalized(expected);
  if (actual === undefined
    || expected === undefined
    || JSON.stringify(actualProjects) !== JSON.stringify(expectedProjects)) {
    throw new Error(`${label} must preserve the selected frozen Git snapshot.`);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function textArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} list is invalid.`);
  return value.map((entry) => requiredText(entry, label));
}

function optionalTextArray(value: unknown, label: string): readonly string[] {
  return value === undefined ? [] : textArray(value, label);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return requireText(value, label);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
