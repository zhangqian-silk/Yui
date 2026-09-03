import type { ReviewRound } from "../review/reviewRound.js";

/**
 * Issue 07 (Leader convergence): minimal repair-wave planning.
 *
 * Given one Review's open findings, produce one convergent repair group by
 * default. Parallel grouping remains an explicit Leader choice for cases where
 * independent ownership is worth the extra WorkItems and integrations.
 */

export type RepairSeverity = "low" | "medium" | "high" | "critical" | "p1" | "p2";

export type RepairFinding = Readonly<{
  id: string;
  severity: RepairSeverity;
  summary: string;
  /** Parseable file paths; empty when the finding has no machine-readable path. */
  paths: readonly string[];
  source: "structured" | "report";
}>;

export type RepairWaveGroup = Readonly<{
  id: string;
  findingIds: readonly string[];
  paths: readonly string[];
  reason: string;
}>;

export type RepairWave = Readonly<{
  reviewRoundId: string;
  openFindingCount: number;
  groups: readonly RepairWaveGroup[];
}>;

export type RepairWaveStrategy = "consolidated" | "parallel";

const SEVERITY_RANK: Record<RepairSeverity, number> = {
  p1: 5,
  critical: 4,
  high: 3,
  p2: 2,
  medium: 1,
  low: 0
};

const PATH_PATTERN = /(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sh|yml|yaml|toml|css|html)(?::\d+)?/gu;

/**
 * Extract open findings from the authoritative main Review report.
 * Producer Lane output is deliberately excluded.
 */
export function extractReviewFindings(round: ReviewRound): RepairFinding[] {
  return parseReportFindings(round.report ?? "");
}

export function planRepairWave(
  reviewRoundId: string,
  findings: readonly RepairFinding[],
  strategy: RepairWaveStrategy = "consolidated"
): RepairWave {
  if (findings.length === 0) {
    return { reviewRoundId, openFindingCount: 0, groups: [] };
  }
  if (strategy === "consolidated") {
    const ordered = [...findings].sort((left, right) => (
      left.id.localeCompare(right.id, undefined, { numeric: true })
    ));
    return {
      reviewRoundId,
      openFindingCount: findings.length,
      groups: [{
        id: "repair-1",
        findingIds: ordered.map(({ id }) => id),
        paths: [...new Set(ordered.flatMap(({ paths }) => paths))].sort(),
        reason: "Consolidated by default to minimize repair, integration, and review churn"
      }]
    };
  }
  const parent = new Array(findings.length).fill(0).map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current]!;
    return current;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const unpathable: number[] = [];
  for (let index = 0; index < findings.length; index += 1) {
    if (findings[index]!.paths.length === 0) unpathable.push(index);
  }
  // Unprovable findings merge together: the planner cannot prove they are
  // disjoint from anything, so serializing them is the fail-closed choice.
  for (let index = 1; index < unpathable.length; index += 1) {
    union(unpathable[0]!, unpathable[index]!);
  }
  for (let left = 0; left < findings.length; left += 1) {
    for (let right = left + 1; right < findings.length; right += 1) {
      if (sharePath(findings[left]!, findings[right]!)) union(left, right);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let index = 0; index < findings.length; index += 1) {
    const root = find(index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), index]);
  }
  const groups = [...byRoot.values()]
    .map((members, position) => {
      const waveFindings = members.map((index) => findings[index]!);
      const paths = [...new Set(waveFindings.flatMap((finding) => finding.paths))]
        .sort();
      const reason = paths.length === 0
        ? "No parseable paths; merged conservatively"
        : waveFindings.length === 1
          ? `Distinct path ${paths[0]}; parallel-safe`
          : `Shared path(s) ${paths.join(", ")}; merged`;
      return {
        id: `repair-${position + 1}`,
        findingIds: waveFindings.map((finding) => finding.id),
        paths,
        reason
      };
    })
    .sort((left, right) => {
      const leftRank = Math.max(...left.findingIds.map((id) =>
        SEVERITY_RANK[findings.find((finding) => finding.id === id)!.severity]!));
      const rightRank = Math.max(...right.findingIds.map((id) =>
        SEVERITY_RANK[findings.find((finding) => finding.id === id)!.severity]!));
      if (leftRank !== rightRank) return rightRank - leftRank;
      return left.id.localeCompare(right.id, undefined, { numeric: true });
    })
    .map((group, index) => ({ ...group, id: `repair-${index + 1}` }));

  return {
    reviewRoundId,
    openFindingCount: findings.length,
    groups
  };
}

function sharePath(left: RepairFinding, right: RepairFinding): boolean {
  if (left.paths.length === 0 || right.paths.length === 0) return false;
  const rightPaths = new Set(right.paths.map(filePart));
  return left.paths.some((path) => rightPaths.has(filePart(path)));
}

function filePart(path: string): string {
  return path.split(":")[0]!;
}

export function extractPaths(text: string): string[] {
  const matches = text.match(PATH_PATTERN) ?? [];
  return [...new Set(matches)].sort();
}

/**
 * Fallback finding extraction for Reviews without structured findings: parse
 * P1/P2 lines from the report body. A line like "P1: src/foo.ts:12 ..." or
 * "- P2 src/bar.ts ..." becomes one finding.
 */
export function parseReportFindings(report: string): RepairFinding[] {
  const findings: RepairFinding[] = [];
  const lines = report.split(/\r?\n/u);
  let index = 0;
  for (const line of lines) {
    const match = /^\s*(?:[-*]\s*)?(P[12])\b[:\s-]+(.+)$/u.exec(line);
    if (match === null) continue;
    index += 1;
    const severity = match[1]!.toLowerCase() as "p1" | "p2";
    const summary = match[2]!.trim();
    findings.push({
      id: `report-p${severity === "p1" ? 1 : 2}-${index}`,
      severity,
      summary,
      paths: extractPaths(summary),
      source: "report"
    });
  }
  return findings;
}
