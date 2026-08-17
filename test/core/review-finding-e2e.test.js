import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runTaskCommand, dispatchPreparedReviewRound } from "../../dist/commands/taskCommands.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import {
  attachReviewRoundWorkspace
} from "../../dist/review/reviewRound.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import {
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const INITIAL_COMMIT = "a".repeat(40);
const NEXT_COMMIT = "b".repeat(40);

function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), "yui-review-finding-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new SqliteTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: codex.id,
      defaultWorkspace: root,
      review: {
        roleName: "reviewer",
        trigger: "final",
        ...(config.findingLedger === undefined ? {} : { findingLedger: config.findingLedger })
      }
    });
    tx.saveConfiguredAgent(codex);
    tx.saveGlobalRole(createGlobalRole(
      "leader", [createRoleAgentBinding(codex)], codex.id, root, NOW
    ));
    tx.saveGlobalRole(createGlobalRole(
      "reviewer", [createRoleAgentBinding(codex)], codex.id, root, NOW
    ));
    tx.saveProject(createProject(
      "project-1",
      "one",
      join(root, "one"),
      { stable: "main", development: "main" },
      NOW
    ));
  });

  runTaskCommand(["create", "delivery", "--project", "project-1"], store, { now: () => NOW });
  const task = store.getTask("task-1");
  runTaskCommand(["activate", task.id], store, { now: () => NOW });
  runTaskCommand(["work", "create", task.id, "initial delivery"], store, { now: () => NOW });
  const item = store.getWorkItem(task.id, "work-item-1");
  const leaderOptions = {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    },
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: "project-1", commit: INITIAL_COMMIT }]
    }
  };
  store.transaction((tx) => {
    const running = updateWorkItemStatus(item, "running", NOW);
    tx.saveWorkItem(task.id, running);
    const candidate = submitWorkItemCandidate(running, {
      summary: "initial integrated candidate",
      source: { type: "direct" }
    }, NOW);
    tx.saveWorkItem(task.id, candidate);
    tx.saveWorkItem(task.id, updateWorkItemStatus(
      candidate,
      "completed",
      NOW,
      "accepted for Task-final Review"
    ));
  });
  return { root, store, task, item, leaderOptions };
}

function setTaskHead(fx, commit) {
  fx.leaderOptions.actualTaskReviewCandidate = {
    schemaVersion: 1,
    projects: [{ projectId: "project-1", commit }]
  };
}

function requestFinalReview(fx, summary = "request Task-final Review") {
  const result = runTaskCommand(
    ["complete", fx.task.id, "--summary", summary],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(result.kind, "output");
  return result.data.reviewRound;
}

function dispatchReview(fx, round) {
  const workspaceRoot = join(fx.root, "reviews", round.id);
  const workspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: fx.task.id, reviewRoundId: round.id },
    root: workspaceRoot,
    entries: [{
      projectId: "project-1",
      directory: "one",
      access: "write",
      path: join(workspaceRoot, "one"),
      branch: `yui/${fx.task.id}/${round.id}`,
      baseRef: round.taskCandidate.projects[0].commit,
      baseCommit: round.taskCandidate.projects[0].commit
    }]
  }, NOW);
  fx.store.transaction((tx) => {
    tx.saveManagedWorkspace(workspace);
    tx.saveReviewRound(fx.task.id, attachReviewRoundWorkspace(round, workspace));
  });
  return dispatchPreparedReviewRound(
    fx.task.id,
    round.id,
    fx.store,
    fx.leaderOptions
  );
}

function finishReviewRun(fx, run, findings, options = {}) {
  const report = JSON.stringify({
    summary: options.summary ?? "Review complete",
    findings,
    ...(options.acceptedRisks === undefined ? {} : { acceptedRisks: options.acceptedRisks }),
    ...(options.residualVerificationGaps === undefined
      ? {}
      : { residualVerificationGaps: options.residualVerificationGaps })
  });
  fx.store.transaction((tx) => {
    const result = terminalizeExactTaskRun(tx, {
      taskId: fx.task.id,
      roleName: run.roleName,
      agentId: run.effective.agentId,
      runId: run.id,
      receiptId: formatAgentRunReceiptId(fx.task.id, run.id),
      outcome: {
        status: options.outcomeStatus ?? "yielded",
        summary: options.summary ?? "Review complete"
      },
      ...(options.outcomeStatus === "failed"
        ? {}
        : {
            reviewResult: {
              report,
              checks: [{ name: "focused review", outcome: "passed" }],
              evidenceCommit: options.evidenceCommit ?? run.effective.reviewBaseCommit
            }
          })
    }, NOW);
    assert.equal(result.disposition, "applied");
  });
}

const SIX_FINDINGS = [
  { id: "F1", severity: "p1", status: "open", invariant: "queue-cas", title: "CAS race", paths: ["src/queue.ts"], symbols: ["enqueue"] },
  { id: "F2", severity: "p1", status: "open", invariant: "queue-cas", title: "Lost update", paths: ["src/queue.ts"], symbols: ["dequeue"] },
  { id: "F3", severity: "p2", status: "open", invariant: "authz", title: "Missing scope", paths: ["src/auth.ts"] },
  { id: "F4", severity: "p2", status: "open", invariant: "authz", title: "Weak token", paths: ["src/token.ts"], symbols: ["verify"] },
  { id: "F5", severity: "p1", status: "open", invariant: "isolation", title: "SQLite leak", paths: ["src/sqlite.ts"] },
  { id: "F6", severity: "p3", status: "open", invariant: "style", title: "Naming nit" }
];

test("E2E: six findings create three repair groups and converge after one re-review", (t) => {
  const fx = fixture(t, { findingLedger: "enforce" });
  const firstRound = requestFinalReview(fx);
  assert.equal(firstRound.id, "review-round-1");
  finishReviewRun(fx, dispatchReview(fx, firstRound), SIX_FINDINGS);

  const findings = fx.store.listReviewFindings(fx.task.id);
  assert.equal(findings.length, 6);
  const wave = runTaskCommand(
    ["review", "finding", "repair-wave", fx.task.id, "--create"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(wave.data.groups.length, 3);
  assert.deepEqual(
    wave.data.groups.map(({ group }) => group.findingIds),
    [["review-finding-1", "review-finding-2"], ["review-finding-3", "review-finding-4"], ["review-finding-5"]]
  );

  fx.store.transaction((tx) => {
    for (const { item } of wave.data.groups) {
      tx.saveWorkItem(fx.task.id, updateWorkItemStatus(
        tx.getWorkItem(fx.task.id, item.id),
        "running",
        NOW
      ));
      tx.saveWorkItem(fx.task.id, updateWorkItemStatus(
        tx.getWorkItem(fx.task.id, item.id),
        "completed",
        NOW,
        "repair integrated"
      ));
    }
  });
  for (const { group, item } of wave.data.groups) {
    for (const findingId of group.findingIds) {
      runTaskCommand(
        ["review", "finding", "dispose", `${fx.task.id}/${findingId}`,
          "--disposition", "fixed-pending-review",
          "--work-item", item.id,
          "--commit", NEXT_COMMIT],
        fx.store,
        fx.leaderOptions
      );
    }
  }

  setTaskHead(fx, NEXT_COMMIT);
  const reReview = requestFinalReview(fx, "request repaired-head Review");
  assert.equal(reReview.id, "review-round-2");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);
  const secondRun = dispatchReview(fx, reReview);
  assert.match(secondRun.input, /Review convergence context:/);
  assert.match(secondRun.input, new RegExp(`Exact diff for project-1: ${INITIAL_COMMIT}\\.\\.${NEXT_COMMIT}`));
  assert.match(secondRun.input, /fixed-pending-review:\n  - review-finding-1/s);

  finishReviewRun(fx, secondRun, SIX_FINDINGS.slice(0, 5).map((finding) => ({
    ...finding,
    status: "resolved"
  })), {
    evidenceCommit: NEXT_COMMIT,
    acceptedRisks: ["No accepted P1/P2 risk remains."],
    residualVerificationGaps: ["None for the repaired exact head."]
  });
  for (const findingId of ["review-finding-1", "review-finding-2", "review-finding-3", "review-finding-4", "review-finding-5"]) {
    runTaskCommand(
      ["review", "finding", "dispose", `${fx.task.id}/${findingId}`,
        "--disposition", "verified-fixed",
        "--verification", `re-verified in ${reReview.id}`],
      fx.store,
      fx.leaderOptions
    );
  }

  const completed = runTaskCommand(
    ["complete", fx.task.id, "--summary", "delivery accepted"],
    fx.store,
    fx.leaderOptions
  );
  assert.match(completed.output, /Completed task/);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);
  const finalFindings = fx.store.listReviewFindings(fx.task.id);
  assert.equal(finalFindings.filter(({ disposition }) => disposition === "verified-fixed").length, 5);
  assert.equal(finalFindings.find(({ id }) => id === "review-finding-6").disposition, "open");
  const finalReport = JSON.parse(fx.store.getReviewRound(fx.task.id, reReview.id).report);
  assert.deepEqual(finalReport.acceptedRisks, ["No accepted P1/P2 risk remains."]);
  assert.deepEqual(finalReport.residualVerificationGaps, ["None for the repaired exact head."]);
});

test("E2E: infra failure retry reuses the same Round and creates no findings", (t) => {
  const fx = fixture(t, { findingLedger: "enforce" });
  const round = requestFinalReview(fx);
  const run = dispatchReview(fx, round);
  finishReviewRun(fx, run, [], {
    outcomeStatus: "failed",
    summary: "Role Run could not start: reviewer"
  });
  assert.equal(fx.store.listReviewFindings(fx.task.id).length, 0);

  const retried = runTaskCommand(
    ["run", "retry", run.id],
    fx.store,
    fx.leaderOptions
  );
  assert.match(retried.output, /Review retry requested/);
  assert.equal(retried.data.reviewRound.id, round.id);
  assert.equal(retried.data.reviewRound.status, "pending");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);

  const repeated = runTaskCommand(
    ["run", "retry", run.id],
    fx.store,
    fx.leaderOptions
  );
  assert.match(repeated.output, /already requested/);
  assert.equal(repeated.data.reviewRound.id, round.id);

  finishReviewRun(fx, dispatchReview(fx, retried.data.reviewRound), [SIX_FINDINGS[0]]);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
  assert.equal(fx.store.listReviewFindings(fx.task.id).length, 1);
});

test("E2E: same stable finding is updated, not duplicated", (t) => {
  const fx = fixture(t, { findingLedger: "enforce" });
  finishReviewRun(fx, dispatchReview(fx, requestFinalReview(fx)), [SIX_FINDINGS[0]]);
  const first = fx.store.listReviewFindings(fx.task.id)[0];

  setTaskHead(fx, NEXT_COMMIT);
  const secondRound = requestFinalReview(fx, "request changed-head Review");
  assert.notEqual(secondRound.id, first.firstReviewRoundId);
  finishReviewRun(fx, dispatchReview(fx, secondRound), [{
    ...SIX_FINDINGS[0],
    id: "F1-again",
    title: "Same finding, different wording",
    evidence: ["new evidence"]
  }], { evidenceCommit: NEXT_COMMIT });

  const findings = fx.store.listReviewFindings(fx.task.id);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, first.id);
  assert.equal(findings[0].lastReviewRoundId, secondRound.id);
  assert.deepEqual(findings[0].evidence, ["new evidence"]);
});

test("E2E: completion gate blocks open P1/P2 but allows P3 and accepted risk", (t) => {
  const fx = fixture(t, { findingLedger: "enforce" });
  finishReviewRun(fx, dispatchReview(fx, requestFinalReview(fx)), [
    SIX_FINDINGS[0],
    SIX_FINDINGS[5]
  ]);

  assert.throws(
    () => runTaskCommand(
      ["complete", fx.task.id, "--summary", "must not complete"],
      fx.store,
      fx.leaderOptions
    ),
    /undispositioned open P1\/P2/
  );

  runTaskCommand(
    ["review", "finding", "dispose", `${fx.task.id}/review-finding-1`,
      "--disposition", "accepted-risk",
      "--note", "Product explicitly accepts this residual risk."],
    fx.store,
    fx.leaderOptions
  );
  const completed = runTaskCommand(
    ["complete", fx.task.id, "--summary", "delivery accepted with P3 backlog"],
    fx.store,
    fx.leaderOptions
  );
  assert.match(completed.output, /Completed task/);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
  assert.equal(
    fx.store.listReviewFindings(fx.task.id).find(({ severity }) => severity === "p3").disposition,
    "open"
  );
});

test("E2E: shadow mode records findings but does not block completion", (t) => {
  const fx = fixture(t, { findingLedger: "shadow" });
  finishReviewRun(fx, dispatchReview(fx, requestFinalReview(fx)), [SIX_FINDINGS[0]]);
  assert.equal(fx.store.listReviewFindings(fx.task.id).length, 1);

  const completed = runTaskCommand(
    ["complete", fx.task.id, "--summary", "legacy completion behavior"],
    fx.store,
    fx.leaderOptions
  );
  assert.match(completed.output, /Completed task/);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
});

test("E2E: ledger write failure preserves the Review report and fails completion closed", (t) => {
  const fx = fixture(t, { findingLedger: "enforce" });
  const round = requestFinalReview(fx);
  const run = dispatchReview(fx, round);
  const realStore = fx.store;
  fx.store = new Proxy(realStore, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (callback) => target.transaction((tx) => callback(new Proxy(tx, {
          get(transactionTarget, transactionProperty, transactionReceiver) {
            if (transactionProperty === "saveReviewFinding") {
              return () => {
                throw new Error("ledger write unavailable");
              };
            }
            const value = Reflect.get(
              transactionTarget,
              transactionProperty,
              transactionReceiver
            );
            return typeof value === "function" ? value.bind(transactionTarget) : value;
          }
        })));
      }
      if (property === "saveReviewFinding") {
        return () => {
          throw new Error("ledger write unavailable");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  finishReviewRun(fx, run, [SIX_FINDINGS[0]]);

  const delivered = realStore.getReviewRound(fx.task.id, round.id);
  assert.equal(delivered.status, "completed");
  assert.match(delivered.report, /CAS race/);
  assert.equal(realStore.listReviewFindings(fx.task.id).length, 0);
  assert.equal(
    realStore.listEvents(fx.task.id).some(({ type }) => type === "review.findings-reconcile-failed"),
    true
  );
  assert.throws(
    () => runTaskCommand(
      ["complete", fx.task.id, "--summary", "must not complete without ledger"],
      fx.store,
      fx.leaderOptions
    ),
    /Review finding ledger was unavailable/
  );
});

test("E2E: finding list shows disposition and repair lineage", (t) => {
  const fx = fixture(t, { findingLedger: "enforce" });
  finishReviewRun(fx, dispatchReview(fx, requestFinalReview(fx)), SIX_FINDINGS);
  runTaskCommand(
    ["review", "finding", "dispose", `${fx.task.id}/review-finding-1`,
      "--disposition", "fixed-pending-review",
      "--work-item", "work-item-2",
      "--commit", NEXT_COMMIT],
    fx.store,
    fx.leaderOptions
  );

  const list = runTaskCommand(
    ["review", "finding", "list", fx.task.id],
    fx.store,
    { now: () => NOW }
  );
  assert.match(list.output, /review-finding-1 \[p1\/fixed-pending-review\]/);
  assert.match(list.output, /repair: work-item-2@/);
  assert.match(list.output, /review-finding-6 \[p3\/open\]/);
});
