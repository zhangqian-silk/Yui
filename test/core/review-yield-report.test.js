import assert from "node:assert/strict";
import test from "node:test";

import { parseReviewYieldReport } from "../../dist/review/reviewRound.js";

test("Review yield accepts a detailed free-form report", () => {
  const report = "# Review\n\nNo material finding.\n\nTests: npm test (passed).";
  assert.deepEqual(parseReviewYieldReport(report), {
    summary: report,
    report,
    checks: []
  });
});

test("Review yield extracts known JSON evidence without rejecting Agent detail", () => {
  const report = JSON.stringify({
    summary: "One material finding",
    findings: [{ severity: "P2", evidence: "reachable" }],
    uncertainty: "Live provider E2E not run"
  });
  assert.deepEqual(parseReviewYieldReport(report), {
    summary: "One material finding",
    report,
    checks: []
  });
});
