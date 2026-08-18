import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionGroup,
  recordExecutionLaneResult
} from "../../dist/execution/executionGroup.js";
import { createReviewRound, finishReviewRound } from "../../dist/review/reviewRound.js";
import {
  extractPaths,
  extractReviewFindings,
  parseReportFindings,
  planRepairWave
} from "../../dist/task/repairWave.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const BASE = "0".repeat(40);

function finding(id, severity, summary) {
  return { id, severity, summary, status: "open" };
}

function reviewWithFindings(findings) {
  let group = createExecutionGroup("group-1", "task-1", {
    purpose: "review",
    roleName: "reviewer",
    lanes: [{ roleName: "reviewer", reviewRoundId: "review-round-1" }],
    target: {
      schemaVersion: 1,
      kind: "work-item",
      taskId: "task-1",
      workItemId: "work-item-1",
      candidateId: "candidate-1",
      revision: 1,
      projects: [{ projectId: "project-1", commit: BASE }],
      fingerprint: "fp-1"
    }
  }, NOW);
  group = recordExecutionLaneResult(group, "group-1-lane-1", {
    summary: "review verdict",
    findings
  }, "completed", NOW);
  return createReviewRound(
    "review-round-1",
    "task-1",
    "work-item-1",
    "candidate-1",
    "reviewer",
    "leader",
    BASE,
    NOW,
    group
  );
}

test("repair wave: six non-overlapping findings form six parallel groups", () => {
  const paths = [
    "src/parser/lexer.ts",
    "src/parser/parser.ts",
    "src/ast/nodes.ts",
    "src/runtime/eval.ts",
    "src/cli/main.ts",
    "docs/guide.md"
  ];
  const round = reviewWithFindings(
    paths.map((path, index) => finding(`finding-${index + 1}`, "high", `Fix ${path}:12`))
  );
  const findings = extractReviewFindings(round);
  assert.equal(findings.length, 6);
  assert.ok(findings.every((finding) => finding.source === "structured"));
  const wave = planRepairWave(round.id, findings);
  assert.equal(wave.openFindingCount, 6);
  assert.equal(wave.groups.length, 6);
  for (const group of wave.groups) {
    assert.equal(group.findingIds.length, 1);
    assert.ok(group.reason.includes("parallel-safe"));
  }
});

test("repair wave: findings sharing a path merge into one group", () => {
  const findings = [
    finding("finding-1", "high", "Fix src/parser/lexer.ts:10"),
    finding("finding-2", "high", "Fix src/parser/lexer.ts:42"),
    finding("finding-3", "medium", "Fix src/ast/nodes.ts:5")
  ];
  const wave = planRepairWave("review-1", findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    summary: finding.summary,
    paths: extractPaths(finding.summary),
    source: "structured"
  })));
  assert.equal(wave.groups.length, 2);
  const merged = wave.groups.find((group) => group.findingIds.length === 2);
  assert.ok(merged !== undefined);
  assert.deepEqual(merged.findingIds.sort(), ["finding-1", "finding-2"]);
  assert.ok(merged.reason.includes("Shared path(s)"));
});

test("repair wave: findings without parseable paths merge conservatively", () => {
  const findings = [
    { id: "finding-1", severity: "high", summary: "State machine is wrong", paths: [], source: "structured" },
    { id: "finding-2", severity: "high", summary: "Invariant broken", paths: [], source: "structured" },
    { id: "finding-3", severity: "medium", summary: "Fix src/cli/main.ts:1", paths: ["src/cli/main.ts"], source: "structured" }
  ];
  const wave = planRepairWave("review-1", findings);
  assert.equal(wave.groups.length, 2);
  const merged = wave.groups.find((group) => group.findingIds.length === 2);
  assert.ok(merged !== undefined);
  assert.deepEqual(merged.findingIds.sort(), ["finding-1", "finding-2"]);
  assert.ok(merged.reason.includes("No parseable paths"));
});

test("repair wave: empty findings produce no groups", () => {
  const wave = planRepairWave("review-1", []);
  assert.equal(wave.openFindingCount, 0);
  assert.equal(wave.groups.length, 0);
});

test("repair wave: structured findings win over the report body", () => {
  const round = reviewWithFindings([
    finding("finding-1", "high", "Fix src/parser/lexer.ts:1")
  ]);
  const finished = finishReviewRound(round, "failed", "P1: src/other.ts:2", NOW);
  const findings = extractReviewFindings(finished);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "finding-1");
  assert.equal(findings[0].source, "structured");
});

test("repair wave: P1/P2 report lines are parsed when no structured findings exist", () => {
  const round = createReviewRound(
    "review-round-1",
    "task-1",
    "work-item-1",
    "candidate-1",
    "reviewer",
    "leader",
    BASE,
    NOW
  );
  const finished = finishReviewRound(round, "failed", [
    "Review failed.",
    "P1: src/parser/lexer.ts:12 token stream desync",
    "- P2 src/cli/main.ts:8 wrong exit code",
    "P2: docs/guide.md outdated section"
  ].join("\n"), NOW);
  const findings = extractReviewFindings(finished);
  assert.equal(findings.length, 3);
  assert.ok(findings.every((finding) => finding.source === "report"));
  assert.equal(findings[0].severity, "p1");
  assert.ok(findings[0].paths.includes("src/parser/lexer.ts:12"));
  const wave = planRepairWave(finished.id, findings);
  assert.equal(wave.groups.length, 3);
});

test("repair wave: a completed Review without findings yields an empty wave", () => {
  const round = createReviewRound(
    "review-round-1",
    "task-1",
    "work-item-1",
    "candidate-1",
    "reviewer",
    "leader",
    BASE,
    NOW
  );
  const finished = finishReviewRound(round, "completed", "all good", NOW);
  assert.deepEqual(extractReviewFindings(finished), []);
});

test("extractPaths pulls file paths out of free text", () => {
  assert.deepEqual(
    extractPaths("see src/foo.ts:12 and src/bar.ts"),
    ["src/bar.ts", "src/foo.ts:12"]
  );
  assert.deepEqual(extractPaths("no paths here"), []);
});

test("parseReportFindings ignores non-P1/P2 lines", () => {
  const findings = parseReportFindings([
    "Summary line.",
    "P3: not a finding",
    "P1: src/foo.ts:1 broken",
    "plain text"
  ].join("\n"));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "p1");
});
