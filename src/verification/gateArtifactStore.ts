import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeTextFileAtomically } from "../storage/durableFile.js";
import {
  gateArtifactKey,
  isReusableGateArtifact,
  validateGateArtifact,
  verifyGateArtifactLogs,
  type GateArtifact,
  type GateArtifactIdentity,
  type GateArtifactStep
} from "./gateArtifact.js";

/**
 * Issue 08: the file-backed GateArtifact store.
 *
 * Layout under the Home (backend-neutral, no aggregate schema change):
 *
 *   artifacts/gates/<projectId>/<key>.json        the artifact record
 *   artifacts/gates/<projectId>/<key>/<log>       per-step logs
 *
 * The store owns its own minimal retention: artifacts referenced by active
 * evidence are always retained; unreferenced successful artifacts are kept
 * for the plan's TTL window and re-checked for references before deletion.
 * Incomplete artifacts from crashed gates are unreferenced and expire the
 * same way. Issue 10's GC treats unknown artifact references as retained and
 * never controls their semantics.
 */

export function gateArtifactRecordPath(home: string, projectId: string, key: string): string {
  return join(gateProjectRoot(home, projectId), `${key}.json`);
}

export function gateArtifactLogsRoot(home: string, projectId: string, key: string): string {
  return join(gateProjectRoot(home, projectId), key);
}

function gateProjectRoot(home: string, projectId: string): string {
  return join(resolve(home), "artifacts", "gates", projectId);
}

export function saveGateArtifact(home: string, artifact: GateArtifact): void {
  validateGateArtifact(artifact);
  writeTextFileAtomically(
    gateArtifactRecordPath(home, artifact.projectId, artifact.key),
    `${JSON.stringify(artifact, null, 2)}\n`
  );
}

export function loadGateArtifact(
  home: string,
  projectId: string,
  key: string
): GateArtifact | null {
  const path = gateArtifactRecordPath(home, projectId, key);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as GateArtifact;
  return validateGateArtifact(parsed);
}

export function findGateArtifact(
  home: string,
  identity: GateArtifactIdentity
): GateArtifact | null {
  return loadGateArtifact(home, identity.projectId, gateArtifactKey(identity));
}

/**
 * Find a reusable L2 artifact for an exact commit, matched on Project,
 * commit, plan digest, toolchain digest, and target ref. Unlike
 * {@link findGateArtifact} the base head is not part of the match: a release
 * consumes the gate that proved the exact frozen tree, regardless of which
 * base it integrated onto. Logs are verified before returning.
 */
export async function findL2ArtifactForCommit(
  home: string,
  query: Readonly<{
    projectId: string;
    commit: string;
    planDigest: string;
    toolchainDigest: string;
    targetRef: string;
  }>
): Promise<GateArtifact | null> {
  const root = gateProjectRoot(home, query.projectId);
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".json")) continue;
    let artifact: GateArtifact | null;
    try {
      artifact = loadGateArtifact(home, query.projectId, entry.slice(0, -".json".length));
    } catch {
      continue;
    }
    if (artifact === null
      || !isReusableGateArtifact(artifact)
      || artifact.level !== "L2"
      || artifact.commit !== query.commit
      || artifact.planDigest !== query.planDigest
      || artifact.toolchainDigest !== query.toolchainDigest
      || artifact.boundary?.targetRef !== query.targetRef) {
      continue;
    }
    const verification = await verifyGateArtifactLogs(
      artifact,
      gateArtifactLogsRoot(home, query.projectId, artifact.key)
    );
    if (verification.ok) return artifact;
  }
  return null;
}

/** One step's raw outcome before the store hashes and files its log. */
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

/**
 * Copy each step log into the artifact's log directory and bind it to its
 * SHA-256 digest. A missing source log is a malformed gate result: the caller
 * must not record a successful artifact without its evidence.
 */
export async function importGateArtifactSteps(
  home: string,
  artifact: GateArtifact,
  steps: readonly GateArtifactStepInput[]
): Promise<readonly GateArtifactStep[]> {
  const logsRoot = gateArtifactLogsRoot(home, artifact.projectId, artifact.key);
  await mkdir(logsRoot, { recursive: true, mode: 0o700 });
  const imported: GateArtifactStep[] = [];
  for (const step of steps) {
    const destination = join(logsRoot, step.logName);
    await copyFile(step.sourceLogPath, destination);
    const content = await readFile(destination);
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
  return Object.freeze(imported);
}

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
 * Minimal retention for one Project's artifacts. Referenced artifacts are
 * always retained. An unreferenced artifact is deleted only when its
 * `lastUsedAt` is older than the TTL window; the reference check runs at
 * deletion time, so a freshly referenced artifact survives the sweep.
 */
export function pruneGateArtifacts(
  home: string,
  projectId: string,
  options: GateArtifactPruneOptions
): GateArtifactPruneResult {
  const root = gateProjectRoot(home, projectId);
  if (!existsSync(root)) return Object.freeze({ retained: 0, deleted: 0 });
  let retained = 0;
  let deleted = 0;
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".json")) continue;
    const key = entry.slice(0, -".json".length);
    let artifact: GateArtifact;
    try {
      artifact = loadGateArtifact(home, projectId, key)!;
      if (artifact === null) continue;
    } catch {
      // A malformed record is not evidence; leave it for diagnosis rather
      // than deleting it silently.
      retained += 1;
      continue;
    }
    const age = options.now.getTime() - Date.parse(artifact.lastUsedAt);
    if (options.isReferenced(key) || age < options.ttlMs) {
      retained += 1;
      continue;
    }
    rmSync(gateArtifactRecordPath(home, projectId, key), { force: true });
    rmSync(gateArtifactLogsRoot(home, projectId, key), {
      recursive: true,
      force: true
    });
    deleted += 1;
  }
  return Object.freeze({ retained, deleted });
}
