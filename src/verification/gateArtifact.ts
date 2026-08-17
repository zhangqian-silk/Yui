import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  requireIdentity,
  requirePositiveInteger,
  requireText,
  requireTimestamp
} from "../domain/validation.js";

/**
 * Issue 08: the reusable exact-SHA gate evidence record.
 *
 * A GateArtifact binds one gate run to its full identity tuple: Project,
 * candidate commit, VerificationPlan digest, toolchain digest, and (for L2)
 * the source/base/target boundary. The same tuple reuses the same successful
 * artifact; any tuple change invalidates it. Artifacts live in their own
 * file namespace under the Home (`artifacts/gates/`), backend-neutral, so
 * no aggregate schema change is involved.
 */

export const GATE_ARTIFACT_SCHEMA_VERSION = 1 as const;

export type GateArtifactLevel = "L1" | "L2";

export type GateArtifactStatus = "incomplete" | "complete";
export type GateArtifactOutcome = "unknown" | "succeeded" | "failed";

/** The source/base/target boundary an L2 gate ran against. */
export type GateArtifactBoundary = Readonly<{
  targetRef: string;
  baseHead: string;
}>;

/** The content-addressed identity tuple of a gate. */
export type GateArtifactIdentity = Readonly<{
  projectId: string;
  level: GateArtifactLevel;
  commit: string;
  planDigest: string;
  toolchainDigest: string;
  /** L2 only: the boundary the candidate integrated onto. */
  boundary?: GateArtifactBoundary;
}>;

export type GateArtifactStep = Readonly<{
  name: string;
  /** Shell-equivalent command, used for evidence coverage matching. */
  command: string;
  argv?: readonly string[];
  outcome: "passed" | "failed" | "skipped";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Log path relative to the artifact's own log directory. */
  logPath: string;
  /** SHA-256 of the log content; a missing/mismatched log invalidates reuse. */
  logDigest: string;
  logBytes: number;
}>;

export type GateArtifact = Readonly<{
  schemaVersion: typeof GATE_ARTIFACT_SCHEMA_VERSION;
  key: string;
  projectId: string;
  level: GateArtifactLevel;
  commit: string;
  planId: string;
  planVersion: string;
  planDigest: string;
  toolchainDigest: string;
  boundary?: GateArtifactBoundary;
  steps: readonly GateArtifactStep[];
  generator: string;
  status: GateArtifactStatus;
  outcome: GateArtifactOutcome;
  /** Shadow metric: how often a record-mode run saw a reusable artifact. */
  potentialReuseCount: number;
  /** How often this artifact was actually reused. */
  reuseCount: number;
  createdAt: string;
  completedAt?: string;
  lastUsedAt: string;
}>;

/** The evidence-reference scheme carried in manifests and queue entries. */
export const GATE_ARTIFACT_REF_PREFIX = "gate-artifact:";

export function gateArtifactRef(key: string): string {
  return `${GATE_ARTIFACT_REF_PREFIX}${key}`;
}

export function parseGateArtifactRef(ref: string): string | undefined {
  return ref.startsWith(GATE_ARTIFACT_REF_PREFIX)
    ? ref.slice(GATE_ARTIFACT_REF_PREFIX.length)
    : undefined;
}

/** Content-addressed key: the same identity tuple always maps to one key. */
export function gateArtifactKey(identity: GateArtifactIdentity): string {
  return createHash("sha256")
    .update(canonicalJson(identity))
    .digest("hex");
}

export function createGateArtifact(
  identity: GateArtifactIdentity,
  metadata: Readonly<{ planId: string; planVersion: string; generator: string }>,
  now: Date
): GateArtifact {
  const timestamp = now.toISOString();
  return validateGateArtifact({
    schemaVersion: GATE_ARTIFACT_SCHEMA_VERSION,
    key: gateArtifactKey(identity),
    projectId: identity.projectId,
    level: identity.level,
    commit: identity.commit,
    planId: requireIdentity(metadata.planId, "GateArtifact planId"),
    planVersion: requireText(metadata.planVersion, "GateArtifact planVersion"),
    planDigest: identity.planDigest,
    toolchainDigest: identity.toolchainDigest,
    ...(identity.boundary === undefined ? {} : { boundary: identity.boundary }),
    steps: Object.freeze([]),
    generator: requireText(metadata.generator, "GateArtifact generator"),
    status: "incomplete",
    outcome: "unknown",
    potentialReuseCount: 0,
    reuseCount: 0,
    createdAt: timestamp,
    lastUsedAt: timestamp
  });
}

/** Terminalize an artifact with its step results. */
export function completeGateArtifact(
  artifact: GateArtifact,
  steps: readonly GateArtifactStep[],
  outcome: Exclude<GateArtifactOutcome, "unknown">,
  now: Date
): GateArtifact {
  validateGateArtifact(artifact);
  if (artifact.status !== "incomplete") {
    throw new Error(`GateArtifact is already complete: ${artifact.key}.`);
  }
  const timestamp = now.toISOString();
  return validateGateArtifact({
    ...artifact,
    steps,
    status: "complete",
    outcome,
    completedAt: timestamp,
    lastUsedAt: timestamp
  });
}

/** Record a shadow potential-reuse observation (record mode). */
export function recordGateArtifactPotentialReuse(
  artifact: GateArtifact,
  now: Date
): GateArtifact {
  validateGateArtifact(artifact);
  return validateGateArtifact({
    ...artifact,
    potentialReuseCount: artifact.potentialReuseCount + 1,
    lastUsedAt: now.toISOString()
  });
}

/** Record an actual reuse (reuse/enforce mode). */
export function recordGateArtifactReuse(
  artifact: GateArtifact,
  now: Date
): GateArtifact {
  validateGateArtifact(artifact);
  if (artifact.status !== "complete" || artifact.outcome !== "succeeded") {
    throw new Error(`Only a complete successful GateArtifact can be reused: ${artifact.key}.`);
  }
  return validateGateArtifact({
    ...artifact,
    reuseCount: artifact.reuseCount + 1,
    lastUsedAt: now.toISOString()
  });
}

export function validateGateArtifact(artifact: GateArtifact): GateArtifact {
  if (artifact.schemaVersion !== GATE_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `GateArtifact must use schemaVersion ${GATE_ARTIFACT_SCHEMA_VERSION}.`
    );
  }
  requireIdentity(artifact.projectId, "GateArtifact projectId");
  if (artifact.level !== "L1" && artifact.level !== "L2") {
    throw new Error(`GateArtifact level is invalid: ${String(artifact.level)}.`);
  }
  requireCommit(artifact.commit, "GateArtifact commit");
  requireDigest(artifact.planDigest, "GateArtifact planDigest");
  requireDigest(artifact.toolchainDigest, "GateArtifact toolchainDigest");
  requireDigest(artifact.key, "GateArtifact key");
  if (artifact.key !== gateArtifactKey({
    projectId: artifact.projectId,
    level: artifact.level,
    commit: artifact.commit,
    planDigest: artifact.planDigest,
    toolchainDigest: artifact.toolchainDigest,
    ...(artifact.boundary === undefined ? {} : { boundary: artifact.boundary })
  })) {
    throw new Error("GateArtifact key does not match its identity tuple.");
  }
  if (artifact.level === "L2" && artifact.boundary === undefined) {
    throw new Error("An L2 GateArtifact requires a target boundary.");
  }
  if (artifact.boundary !== undefined) {
    requireText(artifact.boundary.targetRef, "GateArtifact boundary targetRef");
    requireCommit(artifact.boundary.baseHead, "GateArtifact boundary baseHead");
  }
  if (!["incomplete", "complete"].includes(artifact.status)) {
    throw new Error(`GateArtifact status is invalid: ${String(artifact.status)}.`);
  }
  if (!["unknown", "succeeded", "failed"].includes(artifact.outcome)) {
    throw new Error(`GateArtifact outcome is invalid: ${String(artifact.outcome)}.`);
  }
  if (artifact.status === "incomplete" && artifact.outcome !== "unknown") {
    throw new Error("An incomplete GateArtifact must have outcome unknown.");
  }
  if (artifact.status === "complete" && artifact.outcome === "unknown") {
    throw new Error("A complete GateArtifact must have a terminal outcome.");
  }
  const names = new Set<string>();
  for (const step of artifact.steps) {
    requireIdentity(step.name, "GateArtifact step name");
    if (names.has(step.name)) {
      throw new Error(`GateArtifact step names must be unique: ${step.name}.`);
    }
    names.add(step.name);
    requireText(step.command, `GateArtifact step ${step.name} command`);
    if (!["passed", "failed", "skipped"].includes(step.outcome)) {
      throw new Error(`GateArtifact step ${step.name} outcome is invalid.`);
    }
    requirePositiveInteger(step.durationMs + 1, `GateArtifact step ${step.name} durationMs`);
    requireText(step.logPath, `GateArtifact step ${step.name} logPath`);
    if (isAbsolute(step.logPath) || step.logPath.includes("..")) {
      throw new Error(`GateArtifact step ${step.name} logPath must be relative.`);
    }
    requireDigest(step.logDigest, `GateArtifact step ${step.name} logDigest`);
    if (!Number.isSafeInteger(step.logBytes) || step.logBytes < 0) {
      throw new Error(`GateArtifact step ${step.name} logBytes is invalid.`);
    }
  }
  requirePositiveInteger(artifact.potentialReuseCount + 1, "GateArtifact potentialReuseCount");
  requirePositiveInteger(artifact.reuseCount + 1, "GateArtifact reuseCount");
  requireTimestamp(artifact.createdAt, "GateArtifact createdAt");
  requireTimestamp(artifact.lastUsedAt, "GateArtifact lastUsedAt");
  if (artifact.completedAt !== undefined) {
    requireTimestamp(artifact.completedAt, "GateArtifact completedAt");
  }
  return artifact;
}

export type GateArtifactLogVerification = Readonly<{
  ok: boolean;
  missing: readonly string[];
  corrupted: readonly string[];
}>;

/**
 * Verify that every step log is present in the log map and matches its
 * recorded digest. A lost or corrupted log means the artifact cannot serve
 * as complete L2 evidence: consumers must treat it as a gap.
 */
export function verifyGateArtifactLogs(
  artifact: GateArtifact,
  logs: ReadonlyMap<string, Buffer>
): GateArtifactLogVerification {
  const missing: string[] = [];
  const corrupted: string[] = [];
  for (const step of artifact.steps) {
    const content = logs.get(step.name);
    if (content === undefined) {
      missing.push(step.name);
      continue;
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== step.logDigest || content.length !== step.logBytes) {
      corrupted.push(step.name);
    }
  }
  return Object.freeze({
    ok: missing.length === 0 && corrupted.length === 0,
    missing: Object.freeze(missing),
    corrupted: Object.freeze(corrupted)
  });
}

export function isReusableGateArtifact(artifact: GateArtifact): boolean {
  return artifact.status === "complete" && artifact.outcome === "succeeded";
}

function requireCommit(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireDigest(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Store port (Issue 08 DB-only adaptation)
// ---------------------------------------------------------------------------

/** One step's raw outcome before the store hashes and persists its log. */
export type GateArtifactStepInput = Readonly<{
  name: string;
  command: string;
  argv?: readonly string[];
  outcome: "passed" | "failed" | "skipped";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Absolute path to the step log produced by the runner. */
  sourceLogPath: string;
  /** Log file name inside the artifact log directory. */
  logName: string;
}>;

export type GateArtifactPruneOptions = Readonly<{
  now: Date;
  ttlMs: number;
  /**
   * Re-verify references before deletion. Only artifacts this reports as
   * unreferenced AND older than the TTL window are removed.
   */
  isReferenced(key: string): boolean;
}>;

export type GateArtifactPruneResult = Readonly<{
  retained: number;
  deleted: number;
}>;

/**
 * The persistence seam for GateArtifacts. Both the SQLite and file-backed
 * TaskStore implementations satisfy this port. The artifact record and its
 * step logs are saved atomically so a crash never leaves a complete record
 * without its evidence.
 */
export type GateArtifactStorePort = Readonly<{
  saveGateArtifact(
    artifact: GateArtifact,
    logs: ReadonlyMap<string, Buffer>
  ): void;
  /**
   * Update only the artifact record (counters, timestamps) without touching
   * its step logs.  Used for reuse/potential-reuse counter updates where the
   * evidence is unchanged.
   */
  touchGateArtifact(artifact: GateArtifact): void;
  getGateArtifact(projectId: string, key: string): GateArtifact | null;
  findGateArtifactByIdentity(identity: GateArtifactIdentity): GateArtifact | null;
  findL2GateArtifactsForCommit(query: Readonly<{
    projectId: string;
    commit: string;
    planDigest: string;
    toolchainDigest: string;
    targetRef: string;
  }>): GateArtifact[];
  /** All step logs for an artifact, keyed by step name. */
  getGateArtifactLogs(artifactKey: string): ReadonlyMap<string, Buffer>;
  pruneGateArtifacts(
    projectId: string,
    options: GateArtifactPruneOptions
  ): GateArtifactPruneResult;
}>;
