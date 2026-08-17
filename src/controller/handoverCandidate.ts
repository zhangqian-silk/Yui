/**
 * Controller handover candidate prelude (Issue 02).
 *
 * A handover candidate is the new release's Controller process started while
 * the old Controller still owns the Home. It does NOT bind the main socket or
 * run the scheduler: it proves the new release starts, publishes its identity
 * receipt, and waits until the old owner exits AND the active release pointer
 * names its release. Only then does it promote itself by starting the full
 * Controller runtime in-process.
 *
 * If the old owner stays live after the commit (a stuck Controller), the
 * candidate stays read-only and reports `dualOwner: true` in its identity
 * receipt; it never writes while another owner is live.
 */

import { fileURLToPath } from "node:url";

import { buildRuntimeIdentityReceipt } from "../core/controllerServer.js";
import { resolveStoreWorkerEnabledForHome } from "../storage/storeRpc.js";
import { resolveTaskStoreBackendForHome } from "../storage/sqliteStore.js";
import {
  detectRunningRelease,
  isOwnerLive,
  readActiveReleasePointer,
  readHandoverFence,
  removeCandidateDiscovery,
  removeHandoverFence,
  writeCandidateDiscovery,
  writeHandoverFence,
  writeHandoverReceipt,
  writeRuntimeIdentity,
  type HandoverFence
} from "../release/runtimeRelease.js";
import { startFileTaskControllerRuntime } from "./runtime.js";
import { readLinuxProcessStartIdentity } from "./domainIdentity.js";

export const CONTROLLER_CANDIDATE_ENV = "YUI_CONTROLLER_CANDIDATE";
export const CONTROLLER_HANDOVER_ID_ENV = "YUI_CONTROLLER_HANDOVER_ID";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_DUAL_OWNER_GRACE_MS = 30_000;

export type HandoverCandidateOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  dualOwnerGraceMs?: number;
  now?: () => Date;
}>;

export type HandoverCandidateResult = Readonly<{
  outcome: "promoted" | "aborted";
  reason: string;
}>;

/** Reads the candidate configuration from the process environment. */
export function handoverCandidateFromEnvironment(
  environment: NodeJS.ProcessEnv
): { handoverId: string } | null {
  if (environment[CONTROLLER_CANDIDATE_ENV] !== "1") return null;
  const handoverId = environment[CONTROLLER_HANDOVER_ID_ENV];
  if (
    typeof handoverId !== "string"
    || handoverId.length === 0
    || handoverId.length > 128
  ) {
    throw new Error(
      `Handover candidate requires ${CONTROLLER_HANDOVER_ID_ENV} with a valid handover id.`
    );
  }
  return { handoverId };
}

/**
 * Runs the candidate prelude and, on promotion, the full Controller runtime.
 * Resolves when the promoted Controller closes or the candidate aborts.
 */
export async function runHandoverCandidate(
  home: string,
  handoverId: string,
  options: HandoverCandidateOptions = {}
): Promise<HandoverCandidateResult> {
  const environment = options.environment ?? process.env;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const dualOwnerGraceMs = options.dualOwnerGraceMs ?? DEFAULT_DUAL_OWNER_GRACE_MS;
  const now = options.now ?? (() => new Date());
  const release = detectRunningRelease(fileURLToPath(import.meta.url));
  const startIdentity = readLinuxProcessStartIdentity(process.pid);
  if (startIdentity === undefined) {
    throw new Error(
      `Cannot read process start identity for handover candidate PID ${process.pid}.`
    );
  }

  const fence = readHandoverFence(home);
  if (fence === null || fence.handoverId !== handoverId) {
    throw new Error(
      `Handover fence for ${handoverId} is missing or does not match; aborting candidate.`
    );
  }

  // Publish the candidate identity so the activator can read back build ID,
  // backend, and worker state before committing the handover.
  writeCandidateDiscovery(home, { pid: process.pid, processStartIdentity: startIdentity });
  writeRuntimeIdentity(home, buildRuntimeIdentityReceipt({
    home,
    release,
    storageBackend: resolveTaskStoreBackendForHome(home, environment),
    workerEnabled: resolveStoreWorkerEnabledForHome(home, environment),
    processStartIdentity: startIdentity,
    mode: "candidate",
    dualOwner: false
  }));

  advanceFence(home, fence, "candidate-ready", now().toISOString());
  const committedAt = Date.now();
  let dualOwnerReported = false;

  for (;;) {
    const current = readHandoverFence(home);
    if (current === null || current.handoverId !== handoverId) {
      removeCandidateDiscovery(home);
      return {
        outcome: "aborted",
        reason: "Handover fence disappeared; the handover was rolled back."
      };
    }
    const oldDead = !isOwnerLive(current.old);
    const pointer = readActiveReleasePointer(home);
    const pointerSwitched = pointer !== null && pointer.releaseId === current.toReleaseId;
    if (oldDead && pointerSwitched) {
      return await promote(home, current, environment, now);
    }
    if (
      current.phase === "committed"
      && !oldDead
      && Date.now() - committedAt > dualOwnerGraceMs
      && !dualOwnerReported
    ) {
      // The old Controller was told to exit but is still live. Stay read-only
      // and make the dual-owner condition visible; never write concurrently.
      dualOwnerReported = true;
      writeRuntimeIdentity(home, buildRuntimeIdentityReceipt({
        home,
        release,
        storageBackend: resolveTaskStoreBackendForHome(home, environment),
        workerEnabled: resolveStoreWorkerEnabledForHome(home, environment),
        processStartIdentity: startIdentity,
        mode: "candidate",
        dualOwner: true
      }));
    }
    await delay(pollIntervalMs);
  }
}

async function promote(
  home: string,
  fence: HandoverFence,
  environment: NodeJS.ProcessEnv,
  now: () => Date
): Promise<HandoverCandidateResult> {
  removeCandidateDiscovery(home);
  const controller = await startFileTaskControllerRuntime(home, { environment });
  // The promoted Controller server has already published its primary identity
  // receipt. Complete the handover record and release the fence.
  writeHandoverReceipt(home, Object.freeze({
    schemaVersion: 1,
    handoverId: fence.handoverId,
    outcome: "completed",
    old: fence.old,
    candidate: fence.candidate,
    previousReleaseId: fence.fromReleaseId,
    activatedReleaseId: fence.toReleaseId,
    startedAt: fence.createdAt,
    completedAt: now().toISOString()
  }));
  removeHandoverFence(home);
  const stop = (): void => {
    void controller.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await controller.closed;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return { outcome: "promoted", reason: "Candidate promoted and Controller closed." };
}

function advanceFence(
  home: string,
  fence: HandoverFence,
  phase: HandoverFence["phase"],
  updatedAt: string
): void {
  writeHandoverFence(home, Object.freeze({ ...fence, phase, updatedAt }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
