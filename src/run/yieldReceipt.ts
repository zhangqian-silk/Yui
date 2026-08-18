import { createHash } from "node:crypto";

import { requireIdentity, requireText, requireTimestamp } from "../domain/validation.js";

/**
 * Issue 04 — idempotent yield receipt.
 *
 * A yield request is identified deterministically by `taskId + runId +
 * terminal outcome digest`, so a client whose response was lost after the
 * commit can resend the exact same request and receive the same receipt
 * without creating a second Candidate, ReviewRound, or Event. A different
 * digest on an already-terminal Run fails closed and shows the existing
 * receipt.
 */
export type YieldReceipt = Readonly<{
  schemaVersion: 1;
  /** Deterministic request id: `yield:<taskId>:<runId>:<digest>`. */
  requestId: string;
  /** Durable commit receipt id: `yield-receipt:<taskId>:<runId>:<digest>`. */
  receiptId: string;
  /** sha256 of the canonical terminal outcome. */
  outcomeDigest: string;
  committedAt: string;
}>;

export type YieldOutcomeDigestInput = Readonly<{
  status: "yielded" | "failed";
  summary: string;
  reviewResult?: Readonly<{
    report?: string;
    checks?: readonly Readonly<{ name: string; outcome: string; details?: string }>[];
    findings?: readonly unknown[];
    evidence?: readonly string[];
    evidenceCommit?: string;
    gitSnapshot?: unknown;
  }>;
}>;

const DIGEST_PREFIX_LENGTH = 16;

function canonicalDigestValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDigestValue).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalDigestValue(entry)}`)
    .join(",")}}`;
}

/**
 * Computes the terminal outcome digest. The canonical form sorts object keys
 * and drops `undefined` fields so the same outcome always hashes identically
 * regardless of object construction order.
 */
export function computeYieldOutcomeDigest(input: YieldOutcomeDigestInput): string {
  return createHash("sha256")
    .update(canonicalDigestValue(input))
    .digest("hex");
}

export function formatYieldReceiptRequestId(
  taskId: string,
  runId: string,
  outcomeDigest: string
): string {
  return `yield:${taskId}:${runId}:${outcomeDigest.slice(0, DIGEST_PREFIX_LENGTH)}`;
}

export function formatYieldReceiptId(
  taskId: string,
  runId: string,
  outcomeDigest: string
): string {
  return `yield-receipt:${taskId}:${runId}:${outcomeDigest.slice(0, DIGEST_PREFIX_LENGTH)}`;
}

export function createYieldReceipt(
  taskId: string,
  runId: string,
  outcome: YieldOutcomeDigestInput,
  now: Date
): YieldReceipt {
  const outcomeDigest = computeYieldOutcomeDigest(outcome);
  return validateYieldReceipt({
    schemaVersion: 1,
    requestId: formatYieldReceiptRequestId(taskId, runId, outcomeDigest),
    receiptId: formatYieldReceiptId(taskId, runId, outcomeDigest),
    outcomeDigest,
    committedAt: now.toISOString()
  });
}

export function validateYieldReceipt(value: YieldReceipt): YieldReceipt {
  if (value.schemaVersion !== 1) {
    throw new Error("Yield receipt must use schemaVersion 1.");
  }
  requireIdentity(value.requestId, "Yield receipt requestId");
  requireIdentity(value.receiptId, "Yield receipt receiptId");
  requireText(value.outcomeDigest, "Yield receipt outcomeDigest");
  requireTimestamp(value.committedAt, "Yield receipt committedAt");
  return value;
}

/** A resend disposition for an already-terminal Run. */
export type YieldReplayDisposition =
  | { kind: "replayed"; receipt: YieldReceipt }
  | { kind: "digest-mismatch"; existing: YieldReceipt };

/**
 * Matches a presented outcome against a terminal Run's committed receipt.
 * The same digest replays the receipt; a different digest fails closed.
 */
export function matchYieldReceipt(
  receipt: YieldReceipt | undefined,
  outcome: YieldOutcomeDigestInput
): YieldReplayDisposition | null {
  if (receipt === undefined) return null;
  const presented = computeYieldOutcomeDigest(outcome);
  if (presented === receipt.outcomeDigest) {
    return { kind: "replayed", receipt };
  }
  return { kind: "digest-mismatch", existing: receipt };
}
