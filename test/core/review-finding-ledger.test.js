import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReviewFinding,
  disposeReviewFinding,
  isReviewFindingBlocking,
  normalizeReviewFindingSeverity,
  redetectReviewFinding,
  reviewFindingStableKey,
  validateReviewFinding
} from "../../dist/review/reviewFinding.js";
import {
  classifyReviewRoundOutcome,
  isSemanticReviewRound
} from "../../dist/review/reviewOutcomeClassifier.js";
import {
  blockingOpenFindings,
  completionGateBlocked,
  dispositionReviewFinding,
  extractReportedFindings,
  planRepairGroups,
  reconcileReviewFindings,
  reconcileReviewFindingsAfterReview,
  reviewFindingLedgerWriteFailed,
  renderFindingLedgerContext,
  reusableTaskReviewEvidence,
  reviewFindingLedgerMode,
  summarizeFindingLedger
} from "../../dist/review/reviewFindingLedger.js";
import {
  createReviewRound,
  createTaskReviewRound,
  finishReviewRound
} from "../../dist/review/reviewRound.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { addTaskProjectBinding, createTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const COMMIT = "a".repeat(40);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-review-finding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1 });
    const project = createProject("project-1", "one", join(root, "one"), {
      stable: "main",
      development: "main"
    }, NOW);
    tx.saveProject(project);
    const task = addTaskProjectBinding(
      createTask("task-1", "Review finding test", NOW),
      { projectId: "project-1", directory: "one", baseRef: "main" },
      NOW
    );
    tx.saveTask(task);
    const item = createWorkItem("work-item-1", "task-1", {
      title: "Test work",
      objective: "Test work"
    }, NOW);
    const running = updateWorkItemStatus(item, "running", NOW);
    const withCandidate = submitWorkItemCandidate(running, {
      summary: "candidate-1",
      source: { type: "direct" }
    }, NOW);
    tx.saveWorkItem("task-1", withCandidate);
  });
  return { root, store };
}

function completedTaskRound(store, taskId, roundId, report) {
  const round = createReviewRound(
    roundId,
    taskId,
    "work-item-1",
    "candidate-1",
    "reviewer",
    "leader",
    COMMIT,
    NOW
  );
  const terminal = finishReviewRound(round, "completed", "review done", NOW, {
    report,
    checks: [{ name: "build", outcome: "passed" }],
    evidenceCommit: COMMIT
  });
  store.transaction((tx) => tx.saveReviewRound(taskId, terminal));
  return terminal;
}

// ---------------------------------------------------------------------------
// Severity normalization and stable keys
// ---------------------------------------------------------------------------

test("normalizeReviewFindingSeverity maps reviewer vocabularies", () => {
  assert.equal(normalizeReviewFindingSeverity("p1"), "p1");
  assert.equal(normalizeReviewFindingSeverity("critical"), "p1");
  assert.equal(normalizeReviewFindingSeverity("blocker"), "p1");
  assert.equal(normalizeReviewFindingSeverity("p2"), "p2");
  assert.equal(normalizeReviewFindingSeverity("high"), "p2");
  assert.equal(normalizeReviewFindingSeverity("major"), "p2");
  assert.equal(normalizeReviewFindingSeverity("p3"), "p3");
  assert.equal(normalizeReviewFindingSeverity("medium"), "p3");
  assert.equal(normalizeReviewFindingSeverity("low"), "p3");
  assert.equal(normalizeReviewFindingSeverity("style"), "p3");
  assert.throws(() => normalizeReviewFindingSeverity("unknown"));
});

test("reviewFindingStableKey is deterministic for the same invariant/path/symbol", () => {
  const key1 = reviewFindingStableKey({
    invariant: "queue-cas",
    primaryPath: "src/queue.ts",
    primarySymbol: "enqueue",
    title: "CAS race"
  });
  const key2 = reviewFindingStableKey({
    invariant: "queue-cas",
    primaryPath: "src/queue.ts",
    primarySymbol: "enqueue",
    title: "Different title"
  });
  assert.equal(key1, key2);
  assert.match(key1, /^rf-[0-9a-f]{16}$/);

  const key3 = reviewFindingStableKey({
    invariant: "queue-cas",
    primaryPath: "src/queue.ts",
    primarySymbol: "dequeue",
    title: "CAS race"
  });
  assert.notEqual(key1, key3);
});

// ---------------------------------------------------------------------------
// Finding lifecycle and transitions
// ---------------------------------------------------------------------------

test("createReviewFinding starts open with the Round lineage", () => {
  const finding = createReviewFinding("review-finding-1", "task-1", {
    stableKey: "rf-abc",
    severity: "p1",
    invariant: "at-most-once",
    title: "Duplicate job dispatch",
    affectedPaths: ["src/job.ts"],
    affectedSymbols: ["dispatch"],
    evidence: ["repro: run twice"],
    reviewRoundId: "review-round-1"
  }, NOW);
  assert.equal(finding.disposition, "open");
  assert.equal(finding.firstReviewRoundId, "review-round-1");
  assert.equal(finding.lastReviewRoundId, "review-round-1");
  assert.equal(isReviewFindingBlocking(finding), true);
  validateReviewFinding(finding);
});

test("disposeReviewFinding enforces the Leader transition rules", () => {
  const finding = createReviewFinding("review-finding-1", "task-1", {
    stableKey: "rf-abc",
    severity: "p1",
    invariant: "at-most-once",
    title: "Duplicate job dispatch",
    reviewRoundId: "review-round-1"
  }, NOW);

  const fixed = disposeReviewFinding(finding, {
    disposition: "fixed-pending-review",
    by: "agent-run-5",
    repair: { workItemId: "work-item-3", commit: COMMIT },
    now: NOW
  });
  assert.equal(fixed.disposition, "fixed-pending-review");
  assert.equal(fixed.repair.workItemId, "work-item-3");
  assert.equal(isReviewFindingBlocking(fixed), true);

  const verified = disposeReviewFinding(fixed, {
    disposition: "verified-fixed",
    by: "agent-run-6",
    now: NOW
  });
  assert.equal(verified.disposition, "verified-fixed");
  assert.equal(isReviewFindingBlocking(verified), false);

  // Terminal dispositions cannot be re-dispositioned.
  assert.throws(() => disposeReviewFinding(verified, {
    disposition: "accepted-risk",
    by: "agent-run-7",
    now: NOW
  }));
});

test("redetectReviewFinding reopens a fixed-pending-review regression", () => {
  const finding = createReviewFinding("review-finding-1", "task-1", {
    stableKey: "rf-abc",
    severity: "p1",
    invariant: "at-most-once",
    title: "Duplicate job dispatch",
    reviewRoundId: "review-round-1"
  }, NOW);
  const fixed = disposeReviewFinding(finding, {
    disposition: "fixed-pending-review",
    by: "agent-run-5",
    now: NOW
  });
  const reopened = redetectReviewFinding(fixed, {
    reviewRoundId: "review-round-2",
    evidence: ["still reproduces"],
    now: NOW
  });
  assert.equal(reopened.disposition, "open");
  assert.equal(reopened.lastReviewRoundId, "review-round-2");
  assert.equal(reopened.evidence.length, 1);
  assert.equal(reopened.repair, undefined);
});

test("redetectReviewFinding keeps accepted-risk terminal but refreshes evidence", () => {
  const finding = createReviewFinding("review-finding-1", "task-1", {
    stableKey: "rf-abc",
    severity: "p2",
    invariant: "authz",
    title: "Edge case",
    reviewRoundId: "review-round-1"
  }, NOW);
  const accepted = disposeReviewFinding(finding, {
    disposition: "accepted-risk",
    by: "agent-run-5",
    note: "Documented residual risk",
    now: NOW
  });
  const retouched = redetectReviewFinding(accepted, {
    reviewRoundId: "review-round-3",
    now: NOW
  });
  assert.equal(retouched.disposition, "accepted-risk");
  assert.equal(retouched.lastReviewRoundId, "review-round-3");
});

test("resolved report without repair refs keeps an old finding open", (t) => {
  const { store } = fixture(t);
  const firstReport = JSON.stringify({
    summary: "Round 1",
    findings: [{
      id: "F1",
      severity: "p1",
      status: "open",
      invariant: "at-most-once",
      title: "Duplicate job dispatch",
      paths: ["src/job.ts"],
      symbols: ["dispatch"]
    }]
  });
  completedTaskRound(store, "task-1", "review-round-1", firstReport);
  reconcileReviewFindings(store, "task-1", "review-round-1", NOW);

  const resolvedReport = JSON.stringify({
    summary: "Round 2",
    findings: [{
      id: "F1",
      severity: "p1",
      status: "resolved",
      invariant: "at-most-once",
      title: "Duplicate job dispatch",
      paths: ["src/job.ts"],
      symbols: ["dispatch"],
      evidence: ["claimed fixed without repair refs"]
    }]
  });
  completedTaskRound(store, "task-1", "review-round-2", resolvedReport);
  reconcileReviewFindings(store, "task-1", "review-round-2", NOW);

  const finding = store.listReviewFindings("task-1")[0];
  assert.equal(finding.disposition, "open");
  assert.equal(finding.repair, undefined);
  assert.equal(finding.lastReviewRoundId, "review-round-2");
  assert.deepEqual(finding.evidence, ["claimed fixed without repair refs"]);
});

test("resolved report with repair refs moves an open finding to repair-pending", (t) => {
  const { store } = fixture(t);
  store.transaction((tx) => tx.saveReviewFinding("task-1", validateReviewFinding({
    ...createReviewFinding("review-finding-1", "task-1", {
      stableKey: reviewFindingStableKey({
        invariant: "at-most-once",
        primaryPath: "src/job.ts",
        primarySymbol: "dispatch",
        title: "Duplicate job dispatch"
      }),
      severity: "p1",
      invariant: "at-most-once",
      title: "Duplicate job dispatch",
      affectedPaths: ["src/job.ts"],
      affectedSymbols: ["dispatch"],
      reviewRoundId: "review-round-1"
    }, NOW),
    repair: { workItemId: "work-item-2", commit: COMMIT }
  })));

  const resolvedReport = JSON.stringify({
    summary: "Round 2",
    findings: [{
      id: "F1",
      severity: "p1",
      status: "resolved",
      invariant: "at-most-once",
      title: "Duplicate job dispatch",
      paths: ["src/job.ts"],
      symbols: ["dispatch"],
      evidence: ["repair verified in review workspace"]
    }]
  });
  completedTaskRound(store, "task-1", "review-round-2", resolvedReport);
  reconcileReviewFindings(store, "task-1", "review-round-2", NOW);

  const finding = store.listReviewFindings("task-1")[0];
  assert.equal(finding.disposition, "fixed-pending-review");
  assert.equal(finding.repair.workItemId, "work-item-2");
  assert.equal(finding.repair.commit, COMMIT);
  assert.deepEqual(finding.evidence, ["repair verified in review workspace"]);
});

test("P3 findings never block completion", () => {
  const finding = createReviewFinding("review-finding-1", "task-1", {
    stableKey: "rf-abc",
    severity: "p3",
    invariant: "style",
    title: "Naming nit",
    reviewRoundId: "review-round-1"
  }, NOW);
  assert.equal(isReviewFindingBlocking(finding), false);
});

// ---------------------------------------------------------------------------
// Infra/semantic classification
// ---------------------------------------------------------------------------

test("classifyReviewRoundOutcome separates infra failures from semantic reports", () => {
  const base = createTaskReviewRound(
    "review-round-1", "task-1", "work-item-1", "candidate-1", "reviewer", "leader",
    { schemaVersion: 1, projects: [{ projectId: "project-1", commit: COMMIT }] }, NOW
  );
  const completed = finishReviewRound(base, "completed", "done", NOW, { report: "{}" });
  assert.equal(classifyReviewRoundOutcome(completed).kind, "semantic");
  assert.equal(isSemanticReviewRound(completed), true);

  const infraCases = [
    "Task Role session must be stopped before workspace migration",
    "Role Run could not start: reviewer",
    ".state.lock timeout after 5000ms",
    "tmux pane exited before yield",
    "Controller yield timeout",
    "wrong Run ID for this Round",
    "cyber_policy denial",
    "cross-baseline contamination detected"
  ];
  for (const summary of infraCases) {
    const failed = finishReviewRound(base, "failed", summary, NOW, { report: summary });
    const classification = classifyReviewRoundOutcome(failed);
    assert.equal(classification.kind, "infra", summary);
    assert.notEqual(classification.infraKind, undefined);
    assert.equal(isSemanticReviewRound(failed), false);
  }
});

// ---------------------------------------------------------------------------
// Ledger reconciliation
// ---------------------------------------------------------------------------

test("reconcileReviewFindings creates findings from a completed Round report", (t) => {
  const { store } = fixture(t);
  const report = JSON.stringify({
    summary: "Review complete",
    findings: [
      {
        id: "F1",
        severity: "p1",
        status: "open",
        invariant: "at-most-once",
        title: "Duplicate job dispatch",
        paths: ["src/job.ts"],
        symbols: ["dispatch"],
        evidence: ["repro: run twice"]
      },
      {
        id: "F2",
        severity: "p2",
        status: "open",
        invariant: "authz",
        title: "Missing scope check",
        paths: ["src/auth.ts"]
      },
      {
        id: "F3",
        severity: "p3",
        status: "open",
        invariant: "style",
        title: "Naming nit"
      }
    ]
  });
  completedTaskRound(store, "task-1", "review-round-1", report);
  const result = reconcileReviewFindings(store, "task-1", "review-round-1", NOW);
  assert.equal(result.skipped, false);
  assert.equal(result.created.length, 3);

  const findings = store.listReviewFindings("task-1");
  assert.equal(findings.length, 3);
  assert.deepEqual(findings.map((f) => f.severity).sort(), ["p1", "p2", "p3"]);
  assert.equal(findings[0].firstReviewRoundId, "review-round-1");
});

test("reconcileReviewFindings preserves a malformed free-text report without disposition", (t) => {
  const { store } = fixture(t);
  const rawReport = "Review complete: one material P1 remains, but the JSON block is truncated.";
  const round = completedTaskRound(store, "task-1", "review-round-1", rawReport);
  const result = reconcileReviewFindings(store, "task-1", "review-round-1", NOW);
  assert.equal(result.skipped, true);
  assert.equal(store.listReviewFindings("task-1").length, 0);
  assert.equal(store.getReviewRound("task-1", round.id).report, rawReport);
});

test("reconcileReviewFindings skips failed (infra) Rounds without creating findings", (t) => {
  const { store } = fixture(t);
  const round = createTaskReviewRound(
    "review-round-1", "task-1", "work-item-1", "candidate-1", "reviewer", "leader",
    { schemaVersion: 1, projects: [{ projectId: "project-1", commit: COMMIT }] }, NOW
  );
  const failed = finishReviewRound(
    round, "failed", "Role Run could not start: reviewer", NOW
  );
  store.transaction((tx) => tx.saveReviewRound("task-1", failed));
  const result = reconcileReviewFindings(store, "task-1", "review-round-1", NOW);
  assert.equal(result.skipped, true);
  assert.equal(store.listReviewFindings("task-1").length, 0);
});

test("reconcileReviewFindings reuses the stable key across Rounds", (t) => {
  const { store } = fixture(t);
  const report1 = JSON.stringify({
    summary: "Round 1",
    findings: [{
      id: "F1",
      severity: "p1",
      status: "open",
      invariant: "at-most-once",
      title: "Duplicate job dispatch",
      paths: ["src/job.ts"],
      symbols: ["dispatch"]
    }]
  });
  completedTaskRound(store, "task-1", "review-round-1", report1);
  reconcileReviewFindings(store, "task-1", "review-round-1", NOW);
  const first = store.listReviewFindings("task-1")[0];

  const report2 = JSON.stringify({
    summary: "Round 2",
    findings: [{
      id: "F1-again",
      severity: "p1",
      status: "open",
      invariant: "at-most-once",
      title: "Same finding, different wording",
      paths: ["src/job.ts"],
      symbols: ["dispatch"],
      evidence: ["new evidence"]
    }]
  });
  completedTaskRound(store, "task-1", "review-round-2", report2);
  const result = reconcileReviewFindings(store, "task-1", "review-round-2", NOW);
  assert.equal(result.created.length, 0);
  assert.equal(result.updated.length, 1);
  const findings = store.listReviewFindings("task-1");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, first.id);
  assert.equal(findings[0].lastReviewRoundId, "review-round-2");
  assert.equal(findings[0].evidence.length, 1);
});

test("reconcileReviewFindings flags stable-key collisions for Leader merge", (t) => {
  const { store } = fixture(t);
  const stableKey = reviewFindingStableKey({
    invariant: "at-most-once",
    primaryPath: "src/job.ts",
    primarySymbol: "dispatch",
    title: "Duplicate job dispatch"
  });
  // Two pre-existing records with the same stable key (simulating a bad merge).
  store.transaction((tx) => {
    tx.saveReviewFinding("task-1", createReviewFinding("review-finding-1", "task-1", {
      stableKey, severity: "p1", invariant: "at-most-once",
      title: "Duplicate job dispatch", reviewRoundId: "review-round-1"
    }, NOW));
    tx.saveReviewFinding("task-1", createReviewFinding("review-finding-2", "task-1", {
      stableKey, severity: "p1", invariant: "at-most-once",
      title: "Duplicate job dispatch (duplicate record)", reviewRoundId: "review-round-1"
    }, NOW));
  });
  const report = JSON.stringify({
    summary: "Round 2",
    findings: [{
      id: "F1",
      severity: "p1",
      status: "open",
      invariant: "at-most-once",
      title: "Duplicate job dispatch",
      paths: ["src/job.ts"],
      symbols: ["dispatch"]
    }]
  });
  completedTaskRound(store, "task-1", "review-round-2", report);
  const result = reconcileReviewFindings(store, "task-1", "review-round-2", NOW);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].mergeRequired, true);
  // Both original records are preserved; nothing was silently overwritten.
  assert.equal(store.listReviewFindings("task-1").length, 3);
});

// ---------------------------------------------------------------------------
// Repair wave planning
// ---------------------------------------------------------------------------

test("planRepairGroups groups open P1/P2 findings by path/symbol/invariant overlap", (t) => {
  const { store } = fixture(t);
  const findings = [
    ["review-finding-1", "p1", "queue-cas", "CAS race", ["src/queue.ts"], ["enqueue"]],
    ["review-finding-2", "p1", "queue-cas", "Lost update", ["src/queue.ts"], ["dequeue"]],
    ["review-finding-3", "p2", "authz", "Missing scope", ["src/auth.ts"], []],
    ["review-finding-4", "p2", "authz", "Weak token", ["src/token.ts"], ["verify"]],
    ["review-finding-5", "p1", "isolation", "SQLite leak", ["src/sqlite.ts"], []],
    ["review-finding-6", "p3", "style", "Naming nit", [], []]
  ];
  store.transaction((tx) => {
    for (const [id, severity, invariant, title, paths, symbols] of findings) {
      tx.saveReviewFinding("task-1", createReviewFinding(id, "task-1", {
        stableKey: `rf-${id}`,
        severity,
        invariant,
        title,
        affectedPaths: paths,
        affectedSymbols: symbols,
        reviewRoundId: "review-round-1"
      }, NOW));
    }
  });
  const groups = planRepairGroups(store, "task-1");
  // P3 is excluded; the two queue-cas findings share an invariant; the two
  // authz findings share an invariant; isolation is alone.
  assert.equal(groups.length, 3);
  assert.equal(groups[0].findings.length, 2);
  assert.equal(groups[1].findings.length, 2);
  assert.equal(groups[2].findings.length, 1);
});

// ---------------------------------------------------------------------------
// Completion gate
// ---------------------------------------------------------------------------

test("completionGateBlocked fails closed on open P1/P2 in enforce mode", (t) => {
  const { store } = fixture(t);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      review: { roleName: "reviewer", trigger: "final", findingLedger: "enforce" }
    });
    tx.saveReviewFinding("task-1", createReviewFinding("review-finding-1", "task-1", {
      stableKey: "rf-1", severity: "p1", invariant: "at-most-once",
      title: "Duplicate job dispatch", reviewRoundId: "review-round-1"
    }, NOW));
  });
  assert.equal(completionGateBlocked(store, "task-1"), true);
  assert.equal(blockingOpenFindings(store, "task-1").length, 1);
});

test("completionGateBlocked does not block in shadow mode", (t) => {
  const { store } = fixture(t);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      review: { roleName: "reviewer", trigger: "final", findingLedger: "shadow" }
    });
    tx.saveReviewFinding("task-1", createReviewFinding("review-finding-1", "task-1", {
      stableKey: "rf-1", severity: "p1", invariant: "at-most-once",
      title: "Duplicate job dispatch", reviewRoundId: "review-round-1"
    }, NOW));
  });
  assert.equal(completionGateBlocked(store, "task-1"), false);
});

test("ledger reconciliation failure preserves the Review and fails completion closed", (t) => {
  const { store } = fixture(t);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      review: { roleName: "reviewer", trigger: "final", findingLedger: "enforce" }
    });
  });
  const report = JSON.stringify({
    summary: "Review complete",
    findings: [{
      id: "F1",
      severity: "p1",
      status: "open",
      invariant: "at-most-once",
      title: "Duplicate job dispatch",
      paths: ["src/job.ts"]
    }]
  });
  completedTaskRound(store, "task-1", "review-round-1", report);
  const failingStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "saveReviewFinding") {
        return () => {
          throw new Error("ledger write unavailable");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const result = reconcileReviewFindingsAfterReview(
    failingStore,
    "task-1",
    "review-round-1",
    NOW
  );
  assert.equal(result.skipped, true);
  assert.match(result.reason, /ledger write unavailable/);
  assert.equal(store.listReviewFindings("task-1").length, 0);
  assert.equal(reviewFindingLedgerWriteFailed(store, "task-1"), true);
  assert.equal(completionGateBlocked(store, "task-1"), true);

  const recovered = reconcileReviewFindings(store, "task-1", "review-round-1", NOW);
  assert.equal(recovered.created.length, 1);
  assert.equal(reviewFindingLedgerWriteFailed(store, "task-1"), false);
});

test("completionGateBlocked clears after disposition", (t) => {
  const { store } = fixture(t);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      review: { roleName: "reviewer", trigger: "final", findingLedger: "enforce" }
    });
    tx.saveReviewFinding("task-1", createReviewFinding("review-finding-1", "task-1", {
      stableKey: "rf-1", severity: "p1", invariant: "at-most-once",
      title: "Duplicate job dispatch", reviewRoundId: "review-round-1"
    }, NOW));
  });
  dispositionReviewFinding(store, "task-1", "review-finding-1", {
    disposition: "verified-fixed",
    by: "agent-run-5",
    now: NOW
  });
  assert.equal(completionGateBlocked(store, "task-1"), false);
});

test("reviewFindingLedgerMode defaults to shadow", () => {
  assert.equal(reviewFindingLedgerMode({ schemaVersion: 1 }), "shadow");
  assert.equal(reviewFindingLedgerMode({
    schemaVersion: 1,
    review: { roleName: "reviewer", trigger: "final" }
  }), "shadow");
  assert.equal(reviewFindingLedgerMode({
    schemaVersion: 1,
    review: { roleName: "reviewer", trigger: "final", findingLedger: "enforce" }
  }), "enforce");
});

// ---------------------------------------------------------------------------
// Ledger summary and context rendering
// ---------------------------------------------------------------------------

test("renderFindingLedgerContext lists every disposition class", (t) => {
  const { store } = fixture(t);
  store.transaction((tx) => {
    const open = createReviewFinding("review-finding-1", "task-1", {
      stableKey: "rf-1", severity: "p1", invariant: "at-most-once",
      title: "Open finding", reviewRoundId: "review-round-1"
    }, NOW);
    tx.saveReviewFinding("task-1", open);
    const verified = disposeReviewFinding(open, {
      disposition: "verified-fixed", by: "agent-run-5", now: NOW
    });
    // Re-save as a new record to keep the open one too.
    tx.saveReviewFinding("task-1", createReviewFinding("review-finding-2", "task-1", {
      stableKey: "rf-2", severity: "p2", invariant: "authz",
      title: "Accepted risk", reviewRoundId: "review-round-1"
    }, NOW));
    tx.saveReviewFinding("task-1", disposeReviewFinding(
      createReviewFinding("review-finding-3", "task-1", {
        stableKey: "rf-3", severity: "p3", invariant: "style",
        title: "Backlog nit", reviewRoundId: "review-round-1"
      }, NOW),
      { disposition: "not-actionable", by: "agent-run-5", now: NOW }
    ));
    // Overwrite finding-1 with the verified disposition to test the verified list.
    tx.saveReviewFinding("task-1", { ...verified, id: "review-finding-1" });
  });
  const summary = summarizeFindingLedger(store, "task-1");
  assert.equal(summary.verifiedFixed.length, 1);
  assert.equal(summary.open.length, 1);
  assert.equal(summary.notActionable.length, 1);
  const context = renderFindingLedgerContext(summary);
  assert.match(context, /verified-fixed/);
  assert.match(context, /open \(new\/repair pending\)/);
  assert.match(context, /not-actionable \(backlog\)/);
  assert.match(context, /residual blocking P1\/P2: review-finding-2/);
});

// ---------------------------------------------------------------------------
// Reusable evidence fallback
// ---------------------------------------------------------------------------

test("reusableTaskReviewEvidence reuses checks only for the exact same head", (t) => {
  const { store } = fixture(t);
  const round = createTaskReviewRound(
    "review-round-1", "task-1", "work-item-1", "candidate-1", "reviewer", "leader",
    { schemaVersion: 1, projects: [{ projectId: "project-1", commit: COMMIT }] }, NOW
  );
  const terminal = finishReviewRound(round, "completed", "GREEN", NOW, {
    report: JSON.stringify({
      summary: "GREEN",
      checks: [{ name: "build", outcome: "passed" }]
    }),
    checks: [{ name: "build", outcome: "passed" }],
    evidenceCommit: COMMIT
  });
  store.transaction((tx) => tx.saveReviewRound("task-1", terminal));
  const candidate = { schemaVersion: 1, projects: [{ projectId: "project-1", commit: COMMIT }] };
  const reused = reusableTaskReviewEvidence(store, "task-1", candidate);
  assert.notEqual(reused, null);
  assert.equal(reused.reviewRoundId, "review-round-1");
  assert.equal(reused.evidenceCommit, COMMIT);
  assert.match(reused.digest, /^[0-9a-f]{64}$/);

  // A changed head cannot reuse the old GREEN.
  const changed = {
    schemaVersion: 1,
    projects: [{ projectId: "project-1", commit: "b".repeat(40) }]
  };
  assert.equal(reusableTaskReviewEvidence(store, "task-1", changed), null);
});

// ---------------------------------------------------------------------------
// Store round-trip
// ---------------------------------------------------------------------------

test("FileTaskStore persists and retrieves review findings", (t) => {
  const { store } = fixture(t);
  const finding = createReviewFinding("review-finding-1", "task-1", {
    stableKey: "rf-abc",
    severity: "p1",
    invariant: "at-most-once",
    title: "Duplicate job dispatch",
    affectedPaths: ["src/job.ts"],
    affectedSymbols: ["dispatch"],
    evidence: ["repro: run twice"],
    reviewRoundId: "review-round-1"
  }, NOW);
  store.transaction((tx) => tx.saveReviewFinding("task-1", finding));

  const reloaded = new FileTaskRoundStore(store.rootDirectory());
  assert.deepEqual(reloaded.getReviewFinding("task-1", "review-finding-1"), finding);
  assert.equal(reloaded.listReviewFindings("task-1").length, 1);
  assert.equal(reloaded.nextReviewFindingId("task-1"), "review-finding-2");
});

function FileTaskRoundStore(root) {
  return new FileTaskStore(root);
}
