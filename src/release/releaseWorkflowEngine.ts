import {
  checkGrant,
  grantUseReservations,
  recordGrantUse,
  type CapabilityGrant,
  type CapabilityGrantIrreversibility
} from "../grant/capabilityGrant.js";
import { isConcreteVersion } from "../domain/validation.js";
import {
  completeStep,
  confirmFailedStep,
  confirmStep,
  failStep,
  markStepUnknown,
  recoverRunningStep,
  rebindGrant,
  resumeCursor,
  startStep,
  workflowStatus,
  type ReleaseStepPlan,
  type ReleaseStepRecord,
  type ReleaseWorkflow
} from "./releaseWorkflow.js";
import type { ReleaseStepEffect, ReleaseWorkflowPorts } from "./releaseWorkflowPorts.js";
import { acquireWorkflowFileLock } from "./workflowFileLock.js";

/**
 * Step kinds whose external effect is inherently irreversible. A grant whose
 * ceiling is below this rank cannot authorize the step even when the plan
 * entry omits an explicit irreversibility.
 */
const INHERENT_IRREVERSIBILITY: Readonly<Record<string, CapabilityGrantIrreversibility>> = {
  "npm-publish": "irreversible",
  "version-tag": "irreversible",
  "merge": "irreversible",
  "controller-replace": "irreversible",
  "project-migrate": "irreversible",
  "cli-update": "irreversible",
  // P1-5 (rr22): post-verify executes an arbitrary shell command
  // (`sh -c params.command`). Its effect is inherently irreversible — the
  // command can do anything — so a grant whose ceiling is below
  // "irreversible" must never authorize it, regardless of what the plan
  // entry declares.
  "post-verify": "irreversible"
};

const IRREVERSIBILITY_RANK: Readonly<Record<CapabilityGrantIrreversibility, number>> = {
  none: 0,
  reversible: 1,
  irreversible: 2
};

/**
 * Concurrency guard: prevents two runs of the same workflow from submitting
 * duplicate external effects. Each CLI invocation is a fresh Node process with
 * its own module instance, so an in-process map cannot coordinate across
 * processes. When the store is a FileTaskStore (it exposes its root directory),
 * the guard is a file lock under that root; otherwise (in-memory test stores)
 * it falls back to an in-process map. The second run waits for the first to
 * finish, then re-reads the (now-updated) workflow state.
 */
const workflowLocks = new Map<string, { promise: Promise<void>; resolve: () => void }>();

async function acquireInProcessLock(key: string): Promise<() => void> {
  // Wait for any existing run of this workflow to finish.
  while (workflowLocks.has(key)) {
    await workflowLocks.get(key)!.promise;
  }
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  workflowLocks.set(key, { promise, resolve });
  return () => {
    workflowLocks.delete(key);
    resolve();
  };
}

/**
 * The persistence seam the engine needs. FileTaskStore satisfies it. A store
 * that also exposes `rootDirectory()` (FileTaskStore) gets a cross-process
 * file lock; in-memory stores get the in-process guard.
 */
export type ReleaseWorkflowEngineStore = Readonly<{
  getReleaseWorkflow(taskId: string, workflowId: string): ReleaseWorkflow | null;
  saveReleaseWorkflow(taskId: string, workflow: ReleaseWorkflow): void;
  getCapabilityGrant(taskId: string, grantId: string): CapabilityGrant | null;
  saveCapabilityGrant(taskId: string, grant: CapabilityGrant): void;
  rootDirectory?(): string;
}>;

async function acquireWorkflowLock(
  store: ReleaseWorkflowEngineStore,
  taskId: string,
  workflowId: string
): Promise<() => void> {
  if (typeof store.rootDirectory === "function") {
    const root = store.rootDirectory();
    if (typeof root === "string" && root.length > 0) {
      return acquireWorkflowFileLock(root, taskId, workflowId);
    }
  }
  return acquireInProcessLock(`${taskId}/${workflowId}`);
}

export type ReleaseWorkflowRunOutcome =
  | "succeeded"
  | "failed"
  | "unknown"
  | "unauthorized"
  | "unconfirmed"
  | "budget-exhausted";

export type ReleaseWorkflowRunResult = Readonly<{
  workflow: ReleaseWorkflow;
  status: ReturnType<typeof workflowStatus>;
  outcome: ReleaseWorkflowRunOutcome;
  /** Machine-readable stop reason, absent only when the workflow succeeded. */
  stopReason?: string;
  /** Plan ids the engine submitted (executeStep) this run, in order. */
  attempted: readonly string[];
}>;

export type ReleaseWorkflowRunOptions = Readonly<{
  now?: () => Date;
  /** Hard ceiling on engine iterations per run; defaults to 100. */
  maxSteps?: number;
  /** Supersede the workflow's grant binding before running. */
  grantId?: string;
}>;

/**
 * Runs the workflow from its resume cursor: the first step that is not
 * terminal (succeeded/skipped). Every transition is persisted before the next
 * external call, so a crash at any point resumes correctly:
 *
 * - running/unknown/failed steps that carry an externalIdentity are queried
 *   authoritatively first; "exists" confirms the step without a second
 *   submission, "unknown" stops (a failed step instead re-attempts), "absent"
 *   re-attempts.
 * - a running irreversible step without an externalIdentity crashed before
 *   (or during) its first submission. Its grant reservation only proves the
 *   use was committed; it is never treated as evidence that the effect
 *   landed. The port is queried for the step's predeclared identity first:
 *   "exists" confirms without a second submission, "unknown" stops
 *   unconfirmed, and only "absent" re-attempts, charging the use once when
 *   the reservation was lost to the crash. A running reversible step
 *   re-attempts under the same idempotency key, which makes the retry safe.
 * - every (re)submission re-checks the grant, including its repository,
 *   package, Project, and Home scope; denial fails closed and, for a pending
 *   step, records the denial on the step itself.
 * - irreversible steps additionally require every prior step succeeded.
 * - a timeout without an externalIdentity marks the step as unknown
 *   (unconfirmed); with one, the step becomes unknown and is never
 *   re-submitted blindly.
 * - the grant use is recorded after the step's running state is persisted; a
 *   crash between the two is healed on resume as described above.
 *
 * Concurrent runs of the same workflow are serialized by a cross-process file
 * lock when the store is a FileTaskStore (each CLI invocation is a fresh
 * process), so a second run cannot submit a duplicate effect.
 */
export async function runReleaseWorkflow(
  store: ReleaseWorkflowEngineStore,
  taskId: string,
  workflowId: string,
  ports: ReleaseWorkflowPorts,
  options: ReleaseWorkflowRunOptions = {}
): Promise<ReleaseWorkflowRunResult> {
  // Prevent concurrent runs of the same workflow from submitting duplicate
  // external effects. The second run waits for the first to finish, then
  // re-reads the updated workflow state. The lock is acquired before reading
  // the workflow and released after the run completes.
  const releaseLock = await acquireWorkflowLock(store, taskId, workflowId);
  try {
    return await runReleaseWorkflowLocked(store, taskId, workflowId, ports, options);
  } finally {
    releaseLock();
  }
}

async function runReleaseWorkflowLocked(
  store: ReleaseWorkflowEngineStore,
  taskId: string,
  workflowId: string,
  ports: ReleaseWorkflowPorts,
  options: ReleaseWorkflowRunOptions
): Promise<ReleaseWorkflowRunResult> {
  const clock = options.now ?? (() => new Date());
  const maxSteps = options.maxSteps ?? 100;
  const initial = store.getReleaseWorkflow(taskId, workflowId);
  if (initial === null) {
    throw new Error(`Release workflow not found: ${taskId}/${workflowId}.`);
  }
  let workflow: ReleaseWorkflow = initial;
  if (options.grantId !== undefined && options.grantId !== workflow.grantId) {
    workflow = rebindGrant(workflow, options.grantId, clock());
    store.saveReleaseWorkflow(taskId, workflow);
  }
  const attempted: string[] = [];
  let budget = maxSteps;
  while (budget > 0) {
    budget -= 1;
    const cursor = resumeCursor(workflow);
    if (cursor === null) {
      return finish(workflow, "succeeded", undefined, attempted);
    }
    const plan = requirePlan(workflow, cursor);
    const record: ReleaseStepRecord = workflow.steps[cursor]!;
    const now = clock();
    // Set when a persisted running step's grant use is recognized as already
    // committed: the submit path below then re-attempts without charging again.
    let recognizedPriorUse = false;

    // In-flight or ambiguously failed steps: query authoritatively before any
    // re-submission when we hold an external identity. A running step that
    // crashed before recording a submission result has no identity; the
    // idempotency key makes its re-attempt safe. A crash DURING executeStep
    // is caught below and marks the step unknown (for irreversible steps)
    // so it is never re-submitted blindly.
    if (record.status === "unknown" || record.status === "running" || record.status === "failed") {
      if (record.externalIdentity !== undefined) {
        const identity = record.externalIdentity;
        const query = await ports.queryStepEffect({ step: plan, source: workflow.source, externalIdentity: identity });
        if (query.state === "exists") {
          const logs = [`confirmed by authoritative query: ${identity.kind}=${identity.value}`];
          workflow = record.status === "unknown"
            ? confirmStep(workflow, cursor, { externalId: query.externalId, logs }, now)
            : record.status === "failed"
              ? confirmFailedStep(workflow, cursor, { externalId: query.externalId, logs }, now)
              : completeStep(workflow, cursor, { externalId: query.externalId, logs }, now);
          store.saveReleaseWorkflow(taskId, workflow);
          continue;
        }
        if (query.state === "unknown") {
          // An unknowable effect is never re-submitted blindly, regardless of
          // the step's current status.
          return finish(workflow, "unknown", `unknown:${cursor}`, attempted);
        }
        // The effect is confirmed absent: re-attempt. A running step records
        // the recovery attempt; a failed step re-enters running via startStep below.
        if (record.status === "running") {
          workflow = recoverRunningStep(workflow, cursor, now);
          store.saveReleaseWorkflow(taskId, workflow);
        }
      } else if (record.status === "unknown") {
        // An unknown step without an identity cannot be queried; fail closed.
        return finish(workflow, "unconfirmed", `unconfirmed:${cursor}`, attempted);
      } else if (record.status === "running") {
        // A persisted running step that crashed before recording a submission
        // result (no external identity). For an irreversible step, query the
        // port's effect (the adapter checks the durable idempotency store
        // first) and re-execute only after an authoritative "absent" —
        // regardless of whether a grant use was recognized, because an
        // irreversible effect may have landed through a path the use
        // accounting does not prove. A reversible step always falls through
        // and re-attempts under the same idempotency key.
        const resumeGrant = store.getCapabilityGrant(taskId, workflow.grantId);
        const useRecognized = resumeGrant !== null
          && grantUseRecognized(resumeGrant, workflowId, cursor, record.attempts);
        if (effectiveStepIrreversibility(plan) === "irreversible") {
          const disposition = await ports.queryStepEffect({ step: plan, source: workflow.source });
          if (disposition.state === "exists") {
            // The effect is proven to have landed; confirm the step without a
            // second submission and move on.
            const logs = [`confirmed by authoritative query: ${plan.kind}`];
            workflow = completeStep(workflow, cursor, { externalId: disposition.externalId, logs }, now);
            store.saveReleaseWorkflow(taskId, workflow);
            continue;
          }
          if (disposition.state === "unknown") {
            // The effect cannot be proven absent or present; never re-submit
            // an irreversible effect on an unknowable disposition.
            return finish(workflow, "unconfirmed", `unconfirmed:${cursor}`, attempted);
          }
          // state === "absent": the effect is proven not to have landed.
          // Record the recovery attempt and fall through to re-submit
          // exactly once. A recognized use makes the re-attempt free; an
          // unrecognized one is charged once below.
          workflow = recoverRunningStep(workflow, cursor, now);
          store.saveReleaseWorkflow(taskId, workflow);
        }
        recognizedPriorUse = useRecognized;
      }
      // A failed step without an identity, or a running step whose use was
      // recognized: re-attempt via the submit path below. The idempotency key
      // prevents duplication.
    }

    // P1-1 (rr20): Re-sample the clock after any awaited authoritative query.
    // A query that crosses the grant's expiry must not execute the external
    // call with a stale timestamp — the authorization decision and use
    // reservation must reflect the current time, not the pre-query time.
    // A separate variable keeps `now` stable for state-transition timestamps
    // (updatedAt) so the store's optimistic-concurrency check is unaffected.
    const grantNow = clock();

    // Authorization gate for every (re)submission.
    //
    // A running step WITHOUT an externalIdentity may have crashed before its
    // grant use was committed, so its use is re-checked on resume: an
    // allowance means the use is still owed (consumed below). A
    // uses-exhausted denial is final — only the exact reservation recognized
    // above makes the re-attempt free; inferring "already paid" from the
    // denial itself would let a different Workflow's running attempt bypass
    // maxUses after another Workflow consumed the last use. A running step
    // WITH an identity already consumed its use (it reached executeStep); its
    // re-attempt after an authoritative-absent query skips the use check.
    const wasRunning = workflow.steps[cursor]!.status === "running";
    const recheckGrantUses = wasRunning && record.externalIdentity === undefined;
    const grant = store.getCapabilityGrant(taskId, workflow.grantId);
    if (grant === null) {
      return finish(workflow, "unauthorized", "unauthorized:grant-missing", attempted);
    }
    const params = resolveParams(workflow, plan);
    const effectiveIrreversibility = effectiveStepIrreversibility(plan);
    const decision = checkGrant(grant, {
      action: grantAction(plan),
      params,
      irreversibility: effectiveIrreversibility
    }, grantNow, { skipUsesCheck: wasRunning && !recheckGrantUses });
    // A use is already paid for ONLY when the resume recognized this
    // attempt's exact reservation. A uses-exhausted re-check does not prove
    // this attempt paid: another Workflow may have consumed the last use,
    // and treating the denial as "already paid" would bypass maxUses.
    // The recognized reservation only exempts the uses-exhausted check;
    // revoked, expired, action, parameter, and irreversibility denials
    // must always stand.
    const useAlreadyConsumed = recognizedPriorUse;
    if (!decision.allowed && (decision.reason !== "grant-uses-exhausted" || !useAlreadyConsumed)) {
      if (workflow.steps[cursor]!.status === "pending") {
        workflow = startStep(workflow, cursor, now);
        workflow = failStep(workflow, cursor, { logs: [`unauthorized: ${decision.reason}`] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      return finish(workflow, "unauthorized", `unauthorized:${decision.reason}`, attempted);
    }
    // The grant's repository scope must cover the workflow's exact source.
    const scopeDenial = repositoryScopeDenial(grant, workflow);
    if (scopeDenial !== undefined) {
      if (workflow.steps[cursor]!.status === "pending") {
        workflow = startStep(workflow, cursor, now);
        workflow = failStep(workflow, cursor, { logs: [`unauthorized: ${scopeDenial}`] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      return finish(workflow, "unauthorized", `unauthorized:${scopeDenial}`, attempted);
    }
    // A repo-scoped grant binds a version-tag to the exact source checkout; an
    // alternate path cannot be authenticated as that repository.
    const checkoutDenial = versionTagCheckoutDenial(grant, plan, params);
    if (checkoutDenial !== undefined) {
      if (workflow.steps[cursor]!.status === "pending") {
        workflow = startStep(workflow, cursor, now);
        workflow = failStep(workflow, cursor, { logs: [`unauthorized: ${checkoutDenial}`] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      return finish(workflow, "unauthorized", `unauthorized:${checkoutDenial}`, attempted);
    }
    // The grant's package scope must cover the step's target package.
    const packageDenial = packageScopeDenial(grant, plan, params, workflow);
    if (packageDenial !== undefined) {
      if (workflow.steps[cursor]!.status === "pending") {
        workflow = startStep(workflow, cursor, now);
        workflow = failStep(workflow, cursor, { logs: [`unauthorized: ${packageDenial}`] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      return finish(workflow, "unauthorized", `unauthorized:${packageDenial}`, attempted);
    }
    // Every npm-publish step must bind the tarball to a frozen,
    // content-addressed source artifact; without it the adapter cannot prove
    // the package is the granted one, and — because the workflow source is
    // immutable — the step is unrecoverable: each resume would consume
    // another grant use before the adapter failed. Reject before any use is
    // deducted, regardless of grant scope.
    const artifactDenial = publishArtifactDenial(plan, workflow);
    if (artifactDenial !== undefined) {
      if (workflow.steps[cursor]!.status === "pending") {
        workflow = startStep(workflow, cursor, now);
        workflow = failStep(workflow, cursor, { logs: [`unauthorized: ${artifactDenial}`] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      return finish(workflow, "unauthorized", `unauthorized:${artifactDenial}`, attempted);
    }
    // The grant's Project scope must cover a project-migrate step's target.
    const projectDenial = projectScopeDenial(grant, plan, params);
    if (projectDenial !== undefined) {
      if (workflow.steps[cursor]!.status === "pending") {
        workflow = startStep(workflow, cursor, now);
        workflow = failStep(workflow, cursor, { logs: [`unauthorized: ${projectDenial}`] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      return finish(workflow, "unauthorized", `unauthorized:${projectDenial}`, attempted);
    }
    // A Home-scoped grant may only drive a cli-update against that exact Home.
    const homeDenial = homeScopeDenial(grant, plan, ports);
    if (homeDenial !== undefined) {
      if (workflow.steps[cursor]!.status === "pending") {
        workflow = startStep(workflow, cursor, now);
        workflow = failStep(workflow, cursor, { logs: [`unauthorized: ${homeDenial}`] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      return finish(workflow, "unauthorized", `unauthorized:${homeDenial}`, attempted);
    }
    // A cli-update must be bound to a concrete frozen version before a grant
    // use is consumed: an unversioned update would activate a moving `latest`.
    const updateVersionDenial = cliUpdateVersionDenial(plan, params);
    if (updateVersionDenial !== undefined) {
      if (workflow.steps[cursor]!.status === "pending") {
        workflow = startStep(workflow, cursor, now);
        workflow = failStep(workflow, cursor, { logs: [`unauthorized: ${updateVersionDenial}`] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      return finish(workflow, "unauthorized", `unauthorized:${updateVersionDenial}`, attempted);
    }

    // Irreversible steps require a fully confirmed prefix.
    if (effectiveIrreversibility === "irreversible") {
      const index = workflow.plan.findIndex((entry) => entry.id === cursor);
      const priorConfirmed = workflow.plan
        .slice(0, index)
        .every((entry) => workflow.steps[entry.id]!.status === "succeeded");
      if (!priorConfirmed) {
        if (workflow.steps[cursor]!.status === "pending") {
          workflow = startStep(workflow, cursor, now);
          workflow = failStep(workflow, cursor, { logs: ["prerequisite-not-confirmed"] }, now);
          store.saveReleaseWorkflow(taskId, workflow);
        }
        return finish(workflow, "failed", "prerequisite-not-confirmed", attempted);
      }
    }

    // Submit exactly once this pass. The running state is persisted before the
    // grant use is recorded, so a crash between the two cannot strand a use
    // without the matching attempt. A re-attempt of a running-without-identity
    // step whose use was already committed (useAlreadyConsumed) is free; one
    // whose use was lost to the crash consumes it now, healing the split.
    if (!wasRunning) {
      workflow = startStep(workflow, cursor, now);
      store.saveReleaseWorkflow(taskId, workflow);
    }
    if ((!wasRunning || recheckGrantUses) && !useAlreadyConsumed) {
      // One use per authorized (re)submission, recorded with a durable attempt
      // identity so a resume recognizes it instead of charging again. The CAS
      // retry means a concurrent consumer of the last slot makes this run fail
      // closed (unauthorized) rather than overspending the grant.
      const attempt = workflow.steps[cursor]!.attempts;
      const reservationKey = attemptReservationKey(workflowId, cursor, attempt);
      const { exhausted } = consumeGrantUse(store, taskId, grant, grantNow, reservationKey);
      if (exhausted) {
        workflow = failStep(workflow, cursor, { logs: ["unauthorized: grant-uses-exhausted"] }, now);
        store.saveReleaseWorkflow(taskId, workflow);
        return finish(workflow, "unauthorized", "unauthorized:grant-uses-exhausted", attempted);
      }
    }
    attempted.push(cursor);
    let effect: ReleaseStepEffect;
    try {
      effect = await ports.executeStep({
        step: plan,
        idempotencyKey: plan.idempotencyKey,
        source: workflow.source,
        params
      });
    } catch (error) {
      // A crash during executeStep may have produced the external effect.
      // For irreversible steps, mark as unknown and stop so the effect is
      // never re-submitted blindly. For reversible steps, mark as failed.
      // The exception is re-thrown so the caller sees the crash; the workflow
      // state is already persisted for recovery on the next turn.
      const message = error instanceof Error ? error.message : String(error);
      const crashNow = clock();
      if (effectiveIrreversibility === "irreversible") {
        workflow = markStepUnknown(workflow, cursor, {
          logs: [`executeStep crashed: ${message}`]
        }, crashNow);
        store.saveReleaseWorkflow(taskId, workflow);
      } else {
        workflow = failStep(workflow, cursor, {
          logs: [`executeStep crashed: ${message}`]
        }, crashNow);
        store.saveReleaseWorkflow(taskId, workflow);
      }
      throw error;
    }
    const effectNow = clock();
    if (effect.outcome === "succeeded") {
      workflow = completeStep(workflow, cursor, {
        externalId: effect.externalId,
        logs: effect.logs
      }, effectNow);
      store.saveReleaseWorkflow(taskId, workflow);
      continue;
    }
    if (effect.outcome === "failed") {
      workflow = failStep(workflow, cursor, {
        logs: [
          ...(effect.logs ?? []),
          ...(effect.error === undefined ? [] : [`error: ${effect.error}`])
        ],
        ...(effect.externalIdentity === undefined ? {} : { externalIdentity: effect.externalIdentity })
      }, effectNow);
      store.saveReleaseWorkflow(taskId, workflow);
      return finish(workflow, "failed", `failed:${cursor}`, attempted);
    }
    // Timeout: the request may or may not have landed.
    if (effect.externalIdentity === undefined) {
      // Without an identity the effect cannot be re-queried authoritatively,
      // but it may have landed. Mark the step as unknown (unconfirmed) rather
      // than failed: a failed step is re-submitted on the next run, which
      // could duplicate an effect that actually landed. An unknown step is
      // queried (or left for operator resolution) instead of re-submitted.
      workflow = markStepUnknown(workflow, cursor, {
        logs: [...(effect.logs ?? []), "timeout without external identity"]
      }, effectNow);
      store.saveReleaseWorkflow(taskId, workflow);
      return finish(workflow, "unknown", `unknown:${cursor}`, attempted);
    }
    workflow = markStepUnknown(workflow, cursor, {
      externalIdentity: effect.externalIdentity,
      logs: effect.logs
    }, effectNow);
    store.saveReleaseWorkflow(taskId, workflow);
    return finish(workflow, "unknown", `unknown:${cursor}`, attempted);
  }
  // The budget ran out mid-workflow: success only if nothing remains.
  const remaining = resumeCursor(workflow);
  if (remaining === null) {
    return finish(workflow, "succeeded", undefined, attempted);
  }
  return finish(workflow, "budget-exhausted", `budget-exhausted:${remaining}`, attempted);
}

/**
 * The durable attempt identity for one step submission. The same key is
 * recorded on the grant when the use is consumed and looked up on resume, so a
 * crash between the two is recognized rather than charged twice.
 */
function attemptReservationKey(workflowId: string, stepId: string, attempt: number): string {
  return `${workflowId}/${stepId}#${attempt}`;
}

/**
 * Whether a persisted running step's grant use is recognized as already
 * committed. Only the exact attempt reservation key (workflow/step/attempt)
 * counts: a grant with uses from a different workflow, step, or attempt must
 * not be treated as "this attempt already paid", or maxUses could be bypassed
 * by starting a second workflow against the same grant.
 */
function grantUseRecognized(
  grant: CapabilityGrant,
  workflowId: string,
  stepId: string,
  attempt: number
): boolean {
  const reservations = grant.useReservations;
  if (Array.isArray(reservations)) {
    return reservations.includes(attemptReservationKey(workflowId, stepId, attempt));
  }
  return false;
}

/**
 * Records one grant use after a successful authorization decision. The engine
 * calls this between checkGrant and the external submission; a grant bounded
 * by maxUses therefore fails closed on the attempt that would exceed it.
 *
 * The save is a compare-and-swap: the store rejects a stale equal increment,
 * so a concurrent consumer that read the grant earlier cannot also spend the
 * last slot. On conflict the fresh grant is re-read and the use retried; if the
 * fresh grant is exhausted (a concurrent consumer won the slot) the caller is
 * told to fail closed rather than submit. If our own reservation landed before
 * an error (a crash after the save), the error is surfaced without a retry or a
 * second charge.
 */
const GRANT_USE_CAS_ATTEMPTS = 8;

export function consumeGrantUse(
  store: ReleaseWorkflowEngineStore,
  taskId: string,
  grant: CapabilityGrant,
  now: Date,
  reservationKey: string
): { exhausted: boolean } {
  let current = grant;
  for (let attempt = 0; attempt < GRANT_USE_CAS_ATTEMPTS; attempt += 1) {
    let next: CapabilityGrant;
    try {
      next = recordGrantUse(current, now, reservationKey);
    } catch {
      // recordGrantUse fails closed on exhaustion. A concurrent consumer may
      // have spent the last slot: report exhausted so the caller returns
      // unauthorized instead of submitting.
      return { exhausted: true };
    }
    try {
      store.saveCapabilityGrant(taskId, next);
      return { exhausted: false };
    } catch (error) {
      const fresh = store.getCapabilityGrant(taskId, grant.id);
      if (fresh === null) throw error;
      // Our own use landed before the error (a crash after the save): do not
      // retry or double-charge; surface the original failure.
      if (grantUseReservations(fresh).includes(reservationKey)) {
        throw error;
      }
      // The grant did not move: a genuine failure, not a CAS race.
      if (fresh.usesUsed === current.usesUsed) {
        throw error;
      }
      // A concurrent consumer advanced the grant: retry against fresh state.
      current = fresh;
    }
  }
  throw new Error(`Grant use CAS retries exhausted for ${grant.id}.`);
}

/**
 * Resolves `$externalId:<plan-id>` references in step params against the
 * workflow's confirmed evidence. A merge step can thus consume the PR number
 * a prior step produced without the operator knowing it in advance.
 */
function resolveParams(
  workflow: ReleaseWorkflow,
  plan: ReleaseStepPlan
): Readonly<Record<string, string>> {
  const params: Record<string, string> = { ...(plan.params ?? {}) };
  for (const [name, value] of Object.entries(params)) {
    const match = /^\$externalId:([A-Za-z0-9_-]+)$/.exec(value);
    if (match === null) continue;
    const referenced = workflow.steps[match[1]!]?.externalId;
    if (referenced === undefined) {
      throw new Error(
        `Release step ${plan.id} param ${name} references an unconfirmed step: ${match[1]}.`
      );
    }
    params[name] = referenced;
  }
  return Object.freeze(params);
}

function grantAction(plan: ReleaseStepPlan): string {
  // The release step catalog IS the grant action catalog: a grant lists the
  // step kinds it authorizes (e.g. --action npm-publish --action version-tag).
  return plan.kind;
}

/**
 * A grant scoped to specific repositories only authorizes a workflow whose
 * exact source repository is one of them. A grant without a repository
 * selector is unscoped at this layer (its Task binding is the boundary).
 */
function repositoryScopeDenial(
  grant: CapabilityGrant,
  workflow: ReleaseWorkflow
): string | undefined {
  const repositories = grant.scope.repositories;
  if (repositories === undefined || repositories.length === 0) return undefined;
  const source = workflow.source.repository;
  const covered = repositories.some(
    (repo) => repo.owner === source.owner && repo.name === source.name
  );
  return covered ? undefined : "grant-scope-repository-not-allowed";
}

function requirePlan(workflow: ReleaseWorkflow, stepId: string): ReleaseStepPlan {
  const plan = workflow.plan.find((entry) => entry.id === stepId);
  if (plan === undefined) {
    throw new Error(`Release workflow step is not in the plan: ${stepId}.`);
  }
  return plan;
}

/**
 * The effective irreversibility of a step is the higher of the plan's
 * explicit declaration and the kind's inherent irreversibility. A grant
 * cannot authorize an inherently irreversible step with a lower ceiling.
 */
function effectiveStepIrreversibility(plan: ReleaseStepPlan): CapabilityGrantIrreversibility {
  const inherent = INHERENT_IRREVERSIBILITY[plan.kind] ?? "none";
  const declared = plan.irreversibility ?? "none";
  return IRREVERSIBILITY_RANK[inherent] >= IRREVERSIBILITY_RANK[declared] ? inherent : declared;
}

/**
 * A grant scoped to specific packages only authorizes a publish or smoke step
 * whose target package is one of them. The canonical effect target is
 * `params.package` when given, otherwise the package the adapter derives from
 * the exact source repository (`@<owner>/<name>`). Omitting the package does
 * not bypass the scope: it must be named or derivable, and it must be listed.
 * A grant without a package selector is unscoped at this layer (its Task
 * binding is the boundary).
 */
function packageScopeDenial(
  grant: CapabilityGrant,
  plan: ReleaseStepPlan,
  params: Readonly<Record<string, string>>,
  workflow: ReleaseWorkflow
): string | undefined {
  const packages = grant.scope.packages;
  if (packages === undefined || packages.length === 0) return undefined;
  if (plan.kind !== "npm-publish" && plan.kind !== "fresh-install-smoke") return undefined;
  const target = params.package
    ?? `@${workflow.source.repository.owner}/${workflow.source.repository.name}`;
  if (target === undefined) return "grant-scope-package-required";
  return packages.includes(target) ? undefined : "grant-scope-package-not-allowed";
}

/**
 * A cli-update is an irreversible global binary/Home change. It must be bound
 * to a concrete frozen version: without params.version the adapter would stage
 * and activate whatever `latest` resolves to, which can move between the plan
 * and the activation. The step is denied before the grant use is consumed.
 */
function cliUpdateVersionDenial(
  plan: ReleaseStepPlan,
  params: Readonly<Record<string, string>>
): string | undefined {
  if (plan.kind !== "cli-update") return undefined;
  const version = params.version;
  if (version === undefined || !isConcreteVersion(version)) {
    return "cli-update-version-required";
  }
  return undefined;
}

/**
 * A repo-scoped grant binds a version-tag to the workflow's exact source
 * checkout. The step must name that checkout (params.repositoryPath); the
 * adapter attests the path's origin remote against the bound source — host,
 * owner, and repository — before any local tag or push. Rejecting the path
 * outright would make a repo-scoped version-tag impossible, so the engine
 * requires it instead and leaves the trust decision to the adapter's remote
 * attestation. A grant without a repository selector is unscoped at this layer.
 */
function versionTagCheckoutDenial(
  grant: CapabilityGrant,
  plan: ReleaseStepPlan,
  params: Readonly<Record<string, string>>
): string | undefined {
  if (plan.kind !== "version-tag") return undefined;
  const repositories = grant.scope.repositories;
  if (repositories === undefined || repositories.length === 0) return undefined;
  const checkoutPath = params.repositoryPath;
  if (checkoutPath === undefined || checkoutPath.trim().length === 0) {
    return "grant-scope-repository-path-required";
  }
  return undefined;
}

/**
 * Every npm-publish step must bind the tarball to a frozen, content-addressed
 * source artifact. Without it the adapter cannot prove the published package
 * is the granted one, and — because the workflow source is immutable — the
 * step is unrecoverable: each resume would consume another grant use before
 * the adapter failed. Reject before any use is deducted, regardless of the
 * grant's package scope.
 */
function publishArtifactDenial(
  plan: ReleaseStepPlan,
  workflow: ReleaseWorkflow
): string | undefined {
  if (plan.kind !== "npm-publish") return undefined;
  if (workflow.source.artifact === undefined) return "artifact-required";
  return undefined;
}

/**
 * A grant scoped to specific Projects only authorizes a project-migrate step
 * whose target Project is one of them. A grant without a Project selector is
 * unscoped at this layer (its Task binding is the boundary).
 */
function projectScopeDenial(
  grant: CapabilityGrant,
  plan: ReleaseStepPlan,
  params: Readonly<Record<string, string>>
): string | undefined {
  const projectIds = grant.scope.projectIds;
  if (projectIds === undefined || projectIds.length === 0) return undefined;
  if (plan.kind !== "project-migrate") return undefined;
  const target = params.project;
  if (target === undefined) return "grant-scope-project-required";
  return projectIds.includes(target) ? undefined : "grant-scope-project-not-allowed";
}

/**
 * A grant scoped to a specific Home only authorizes a cli-update or
 * controller-replace step against that exact Home. The adapter Home is read
 * from the ports; when it cannot be determined, the check fails closed rather
 * than guessing. A grant without a Home selector is unscoped at this layer
 * (its Task binding is the boundary).
 */
function homeScopeDenial(
  grant: CapabilityGrant,
  plan: ReleaseStepPlan,
  ports: ReleaseWorkflowPorts
): string | undefined {
  const homePath = grant.scope.homePath;
  if (homePath === undefined) return undefined;
  if (plan.kind !== "cli-update" && plan.kind !== "controller-replace") return undefined;
  const adapterHome = ports.home;
  if (adapterHome === undefined) return "grant-scope-home-unverified";
  return adapterHome === homePath ? undefined : "grant-scope-home-not-allowed";
}

function finish(
  workflow: ReleaseWorkflow,
  outcome: ReleaseWorkflowRunOutcome,
  stopReason: string | undefined,
  attempted: readonly string[]
): ReleaseWorkflowRunResult {
  return {
    workflow,
    status: workflowStatus(workflow),
    outcome,
    ...(stopReason === undefined ? {} : { stopReason }),
    attempted: Object.freeze([...attempted])
  };
}
