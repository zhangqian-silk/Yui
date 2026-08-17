import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  gateArtifactKey,
  isReusableGateArtifact,
  validateGateArtifact,
  verifyGateArtifactLogs,
  type GateArtifact,
  type GateArtifactIdentity,
  type GateArtifactStep,
  type GateArtifactStepInput,
  type GateArtifactStorePort
} from "./gateArtifact.js";

/**
 * Issue 08: the GateArtifact store adapter.
 *
 * Every function delegates to a {@link GateArtifactStorePort} (satisfied by
 * both SqliteTaskStore and FileTaskStore).  The artifact record and its step
 * logs are persisted atomically by the store implementation; this module
 * owns the domain logic (key computation, log hashing, reuse lookup,
 * retention) but no filesystem paths.
 */

export function saveGateArtifact(
  store: GateArtifactStorePort,
  artifact: GateArtifact,
  logs: ReadonlyMap<string, Buffer>
): void {
  validateGateArtifact(artifact);
  store.saveGateArtifact(artifact, logs);
}

/** Update only the artifact record (counters, timestamps); logs are untouched. */
export function touchGateArtifact(
  store: GateArtifactStorePort,
  artifact: GateArtifact
): void {
  validateGateArtifact(artifact);
  store.touchGateArtifact(artifact);
}

export function loadGateArtifact(
  store: GateArtifactStorePort,
  projectId: string,
  key: string
): GateArtifact | null {
  return store.getGateArtifact(projectId, key);
}

export function findGateArtifact(
  store: GateArtifactStorePort,
  identity: GateArtifactIdentity
): GateArtifact | null {
  return store.findGateArtifactByIdentity(identity);
}

/**
 * Find a reusable L2 artifact for an exact commit, matched on Project,
 * commit, plan digest, toolchain digest, and target ref.  Unlike
 * {@link findGateArtifact} the base head is not part of the match: a release
 * consumes the gate that proved the exact frozen tree, regardless of which
 * base it integrated onto.  Logs are verified before returning.
 */
export async function findL2ArtifactForCommit(
  store: GateArtifactStorePort,
  query: Readonly<{
    projectId: string;
    commit: string;
    planDigest: string;
    toolchainDigest: string;
    targetRef: string;
  }>
): Promise<GateArtifact | null> {
  const artifacts = store.findL2GateArtifactsForCommit(query);
  for (const artifact of artifacts) {
    if (!isReusableGateArtifact(artifact)) continue;
    const logs = store.getGateArtifactLogs(artifact.key);
    const verification = verifyGateArtifactLogs(artifact, logs);
    if (verification.ok) return artifact;
  }
  return null;
}

/**
 * Read each step's source log, hash it, and return the completed step
 * records plus a map of log content keyed by step name.  A missing source
 * log is a malformed gate result: the caller must not record a successful
 * artifact without its evidence.
 */
export async function importGateArtifactSteps(
  steps: readonly GateArtifactStepInput[]
): Promise<{
  steps: readonly GateArtifactStep[];
  logs: ReadonlyMap<string, Buffer>;
}> {
  const imported: GateArtifactStep[] = [];
  const logs = new Map<string, Buffer>();
  for (const step of steps) {
    const content = await readFile(step.sourceLogPath);
    logs.set(step.name, content);
    imported.push(Object.freeze({
      name: step.name,
      command: step.command,
      ...(step.argv === undefined ? {} : { argv: step.argv }),
      outcome: step.outcome,
      exitCode: step.exitCode,
      signal: step.signal,
      timedOut: step.timedOut,
      durationMs: step.durationMs,
      logPath: step.logName,
      logDigest: createHash("sha256").update(content).digest("hex"),
      logBytes: content.length
    }));
  }
  return {
    steps: Object.freeze(imported),
    logs
  };
}

export type GateArtifactPruneOptions = import("./gateArtifact.js").GateArtifactPruneOptions;
export type GateArtifactPruneResult = import("./gateArtifact.js").GateArtifactPruneResult;

/**
 * Minimal retention for one Project's artifacts.  Referenced artifacts are
 * always retained.  An unreferenced artifact is deleted only when its
 * `lastUsedAt` is older than the TTL window; the reference check runs at
 * deletion time, so a freshly referenced artifact survives the sweep.
 */
export function pruneGateArtifacts(
  store: GateArtifactStorePort,
  projectId: string,
  options: GateArtifactPruneOptions
): GateArtifactPruneResult {
  return store.pruneGateArtifacts(projectId, options);
}

export { gateArtifactKey };
export type { GateArtifact, GateArtifactIdentity, GateArtifactStep, GateArtifactStepInput, GateArtifactStorePort };
