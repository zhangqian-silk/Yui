/**
 * DurableJob supervision: the Controller-side reconciliation ladder.
 *
 * The supervisor is pure logic over injected ports. It is invoked from the
 * Controller scheduler pass and on Controller startup. Each pass reconciles
 * only jobs that can still change under supervision:
 *
 *  queued  -> write spec, spawn detached runner, transition to running
 *  running -> harvest exit.json / liveness via pid+startIdentity /
 *             evidence ladder (exit.json -> checkpoint -> unknown) /
 *             stale heartbeat SIGTERM then SIGKILL escalation
 *  cancelRequestedAt -> write cancel fence + SIGTERM
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MailboxEntityRef } from "../coordination/workMailbox.js";
import {
  cancelQueuedDurableJob,
  completeDurableJob,
  isDurableJobTerminal,
  markDurableJobUnknown,
  markDurableJobWakeupNotified,
  rejectQueuedDurableJob,
  startDurableJob,
  touchDurableJobHeartbeat,
  type DurableJob,
  type DurableJobCheckpoint,
  type DurableJobExit,
  type DurableJobResult,
  type DurableJobSpec,
  type DurableJobStepResult
} from "../job/durableJob.js";
import { recordOperationEvidence } from "../kernel/operationFacts.js";
import { wakeReason } from "../scheduler/wakeReason.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import { readLinuxProcessStartIdentity } from "./domainIdentity.js";

const DEFAULT_STEP_TIMEOUT_MS = 30 * 60_000;
const HEARTBEAT_STALE_MS = 2 * 60_000;
const SIGKILL_GRACE_MS = 30_000;

export type JobSupervisorProcessPort = Readonly<{
  spawnJobRunner(specPath: string): {
    pid: number;
    startIdentity: string | undefined;
    /**
     * rr6/f1: Register a callback fired when the spawned runner exits. The
     * supervisor uses this to schedule a bounded follow-up pass that harvests
     * the terminal exit artifact while the Controller still lives, instead of
     * waiting for the long recovery interval. Best-effort: a port that cannot
     * observe runner exit may omit it, leaving the recovery interval as the
     * cross-restart fallback.
     */
    onExit?: (callback: () => void) => void;
  };
  processStartIdentity(pid: number): string | undefined;
  isProcessAlive(pid: number): boolean;
  signalIfOwned(pid: number, startIdentity: string, signal: NodeJS.Signals): void;
}>;

export type JobSupervisorArtifactPort = Readonly<{
  artifactDir(taskId: string, jobId: string): string;
  writeSpec(taskId: string, jobId: string, spec: DurableJobSpec): string;
  writeCancelFence(taskId: string, jobId: string): void;
  readExitJson(taskId: string, jobId: string): DurableJobExit | null;
  readCheckpoint(taskId: string, jobId: string): DurableJobCheckpoint | null;
  heartbeatMtime(taskId: string, jobId: string): number | null;
  writeStartMarker(taskId: string, jobId: string, marker: DurableJobStartMarker): void;
  readStartMarker(taskId: string, jobId: string): DurableJobStartMarker | null;
  readReadyFile(taskId: string, jobId: string): DurableJobReadyMarker | null;
}>;

/**
 * Durable record that a runner was spawned for a queued job. Written after
 * the spawn and before the running transition, so a Controller death in that
 * window never causes a second spawn on the next reconcile pass.
 */
export type DurableJobStartMarker = Readonly<{
  pid: number;
  startIdentity: string;
  spawnedAt: string;
}>;

/**
 * The runner's own durable startup handshake. Written by the runner (with
 * O_EXCL) before any step side effect, so a re-spawn after a Controller
 * crash can prove whether the original runner started executing.
 *
 * f4/rr4: The runner writes its own OS startIdentity so the supervisor can
 * adopt without re-reading /proc (which could return a reused PID's identity).
 */
export type DurableJobReadyMarker = Readonly<{
  pid: number;
  startIdentity: string;
  startedAt: string;
}>;

export type JobSupervisorStorePort = Readonly<{
  /**
   * Current-contract terminal transitions atomically persist
   * `wakeupNotified` and enqueue the Leader wakeup. Terminal history therefore
   * never needs a recovery scan; only queued/running jobs belong here.
   */
  listActiveDurableJobs(): readonly DurableJob[];
  transitionDurableJob(
    taskId: string,
    jobId: string,
    transition: (job: DurableJob) => DurableJob,
    now: Date,
    wakeup?: { reason: string; refs: readonly MailboxEntityRef[] }
  ): DurableJob | null;
}>;

export type DurableJobSupervisorOptions = Readonly<{
  store: JobSupervisorStorePort;
  process: JobSupervisorProcessPort;
  artifacts: JobSupervisorArtifactPort;
  /**
   * f7/rr5: Optional terminal channel. When a Job reaches a terminal state,
   * the supervisor delivers a terminal notice so the runtime inbox can wake
   * the Controller immediately instead of waiting for the next poll.
   */
  terminalEvents?: JobSupervisorTerminalPort;
  /**
   * rr6/f1: Optional bounded supervision wake. Invoked once after a runner is
   * spawned (so the next pass adopts the queued job to running) and once when
   * a spawned runner exits (so the next pass harvests the terminal artifact).
   * The composition root wires this to the Controller signal scheduler; the
   * long recovery interval stays the cross-restart fallback. The wake is
   * idempotent — a job that already terminalized or no longer exists makes
   * the follow-up pass a no-op — and event-driven, so it never pins a timer
   * while the Controller is idle.
   */
  wake?: (taskId: string) => void;
  onError?: (error: unknown) => void;
  authorizeStart: (job: DurableJob) => void;
}>;

/**
 * f7/rr5: The terminal notice delivered when a Job reaches a terminal state.
 * The composition root wires this to the runtime event inbox; the notice is
 * best-effort and must never block or fail the terminal transition itself.
 */
export type DurableJobTerminalNotice = Readonly<{
  taskId: string;
  jobId: string;
  status: DurableJob["status"];
  outcome: string;
}>;

export type JobSupervisorTerminalPort = Readonly<{
  deliverTerminalEvent(notice: DurableJobTerminalNotice): void;
}>;

export class DurableJobSupervisor {
  readonly #store: JobSupervisorStorePort;
  readonly #process: JobSupervisorProcessPort;
  readonly #artifacts: JobSupervisorArtifactPort;
  readonly #terminalEvents: JobSupervisorTerminalPort | undefined;
  readonly #wake: (taskId: string) => void;
  readonly #onError: (error: unknown) => void;
  readonly #authorizeStart: (job: DurableJob) => void;
  // f5: Composite key (taskId/jobId) because job IDs are Task-local — every
  // Task has a job-1, so a Task-local key would cross-kill healthy runners.
  readonly #sigkillAt = new Map<string, number>();

  constructor(options: DurableJobSupervisorOptions) {
    this.#store = options.store;
    this.#process = options.process;
    this.#artifacts = options.artifacts;
    this.#terminalEvents = options.terminalEvents;
    this.#wake = options.wake ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#authorizeStart = options.authorizeStart;
  }

  reconcile(now: Date): void {
    const jobs = this.#store.listActiveDurableJobs();
    for (const job of jobs) {
      try {
        this.#reconcileJob(job, now);
      } catch (error) {
        this.#onError(error instanceof Error
          ? error
          : new Error(`DurableJob supervision failed for ${job.id}: ${String(error)}`));
      }
    }
  }

  #reconcileJob(job: DurableJob, now: Date): void {
    if (job.status === "queued") {
      this.#reconcileQueued(job, now);
      return;
    }
    if (job.status === "running") {
      this.#superviseRunning(job, now);
      return;
    }
  }

  /** Composite key for the SIGKILL deadline map. */
  #sigkillKey(job: DurableJob): string {
    return `${job.taskId}/${job.id}`;
  }

  /** Adopt observed execution, preserve unknown, or start an unattempted request. */
  #reconcileQueued(job: DurableJob, now: Date): void {
    const marker = this.#artifacts.readStartMarker(job.taskId, job.id);
    const spawned = this.#spawnedProcessFromEvidence(job, marker);
    if (job.cancelRequestedAt !== undefined) {
      this.#artifacts.writeCancelFence(job.taskId, job.id);
      if (spawned !== null) {
        this.#process.signalIfOwned(spawned.pid, spawned.startIdentity, "SIGTERM");
      }
    }
    if (spawned !== null) {
      this.#adoptAndContinue(job, spawned, now);
      return;
    }
    if (job.operation.effect !== "none") {
      // A send intent was committed but no acceptance can be proved. Absence
      // of a file is not proof of no external effect. Never respawn unknown.
      const terminal = this.#store.transitionDurableJob(
        job.taskId, job.id,
        (current) => markDurableJobWakeupNotified(markDurableJobUnknown(
          current, "runner acceptance is unknown; inspect the original request",
          current.checkpoint?.completedSteps ?? [], now
        ), now),
        now, { reason: wakeReason("job-finished"), refs: wakeupRefs(job) }
      );
      this.#deliverTerminalEvent(terminal);
      return;
    }

    if (job.cancelRequestedAt !== undefined) {
      // No effect attempted. Cancellation and its wake commit atomically.
      const terminal = this.#store.transitionDurableJob(
        job.taskId,
        job.id,
        (current) => markDurableJobWakeupNotified(
          cancelQueuedDurableJob(current, now),
          now
        ),
        now,
        { reason: wakeReason("job-finished"), refs: wakeupRefs(job) }
      );
      this.#deliverTerminalEvent(terminal);
      return;
    }

    if (marker !== null) throw new Error("Job start marker contradicts its unattempted operation.");
    this.#startJob(job, now);
  }

  /**
   * Determine whether a runner was spawned for this job, based on durable
   * evidence. Returns the process identity if spawned, null otherwise.
   */
  #spawnedProcessFromEvidence(
    job: DurableJob,
    marker: DurableJobStartMarker | null
  ): { pid: number; startIdentity: string } | null {
    // f3/rr5: ready.json is the runner's own record of its actual OS start.
    // When both the start marker and ready.json exist, ready.json is
    // authoritative: the marker is the Controller's declared intent (written
    // around the spawn), while ready.json is written by the runner itself
    // before any side effect. A disagreement (PID reuse, spawn retry, stale
    // /proc read) is resolved in favor of ready.json.
    const ready = this.#artifacts.readReadyFile(job.taskId, job.id);
    if (ready !== null) {
      return { pid: ready.pid, startIdentity: ready.startIdentity };
    }
    if (marker !== null && marker.startIdentity !== "pending") {
      // Real start marker with a pid — the runner was spawned.
      return { pid: marker.pid, startIdentity: marker.startIdentity };
    }
    // Pending marker with no ready.json: spawn unconfirmed.
    return null;
  }

  /**
   * f3: Adopt a queued job to running, then harvest exit or handle a dead
   * process. A request with unobserved acceptance instead stays unknown.
   */
  #adoptAndContinue(
    job: DurableJob,
    process: { pid: number; startIdentity: string },
    now: Date
  ): void {
    this.#store.transitionDurableJob(
      job.taskId,
      job.id,
      (current) => startDurableJob(current, process, now),
      now
    );
    // The runner may already have finished while the Controller was down.
    const exit = this.#artifacts.readExitJson(job.taskId, job.id);
    if (exit !== null) {
      this.#harvestExit(job, exit, now);
      return;
    }
    const identity = this.#process.processStartIdentity(process.pid);
    const alive = identity !== undefined
      && identity === process.startIdentity
      && this.#process.isProcessAlive(process.pid);
    if (!alive) {
      this.#handleDeadProcess(job, now);
    }
  }

  #startJob(job: DurableJob, now: Date): void {
    try {
      this.#authorizeStart(job);
    } catch (error) {
      this.#rejectStart(job, error, now);
      return;
    }
    const spec: DurableJobSpec = {
      jobId: job.id,
      taskId: job.taskId,
      workspace: job.workspace,
      env: job.env,
      steps: job.steps,
      defaultStepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      artifactDir: this.#artifacts.artifactDir(job.taskId, job.id),
      head: job.head
    };
    const specPath = this.#artifacts.writeSpec(job.taskId, job.id, spec);
    let attempted: DurableJob | null;
    try {
      attempted = this.#store.transitionDurableJob(
        job.taskId, job.id,
        (current) => {
          if (current.status !== "queued" || current.operation.effect !== "none") {
            throw new Error("Job already attempted; inspect the original request.");
          }
          this.#authorizeStart(current);
          return {
            ...current,
            operation: recordOperationEvidence(current.operation, { effect: "possible" }),
            updatedAt: now.toISOString()
          };
        }, now
      );
    } catch (error) {
      this.#rejectStart(job, error, now);
      return;
    }
    if (attempted === null) return;
    // Both the request and possible-effect boundary precede spawn. A missing
    // acceptance after this point is unknown, never permission to respawn.
    this.#artifacts.writeStartMarker(job.taskId, job.id, {
      pid: 0,
      startIdentity: "pending",
      spawnedAt: now.toISOString()
    });
    const spawned = this.#process.spawnJobRunner(specPath);
    // Best-effort update with the real pid. If this fails (Controller death),
    // the runner's own ready.json is the fallback: the next reconcile reads
    // ready and adopts. The runner checks ready with O_EXCL and exits if it
    // already exists, preventing duplicate execution.
    this.#artifacts.writeStartMarker(job.taskId, job.id, {
      pid: spawned.pid,
      startIdentity: spawned.startIdentity ?? String(spawned.pid),
      spawnedAt: now.toISOString()
    });
    // rr6/f1: Bound the supervision latency without a busy loop. One follow-up
    // pass adopts the queued job to running (the real-pid marker path above),
    // and the runner-exit callback schedules the harvest pass while the
    // Controller lives. Both are idempotent no-ops if the job already
    // terminalized or no longer exists; the recovery interval stays the
    // cross-restart fallback. No new timer is pinned while the Controller is
    // idle — each wake is a single event-driven signal.
    spawned.onExit?.(() => this.#wake(job.taskId));
    this.#wake(job.taskId);
  }

  #rejectStart(job: DurableJob, error: unknown, now: Date): void {
    // Only an explicit domain refusal is a known failure. Storage/CAS/runtime
    // errors still propagate; never infer rejection from an unavailable read.
    if (!(error instanceof Error) || error.name !== "CoreJobError") throw error;
    const terminal = this.#store.transitionDurableJob(
      job.taskId, job.id,
      (current) => markDurableJobWakeupNotified(
        rejectQueuedDurableJob(current, error.message, now), now
      ),
      now, { reason: wakeReason("job-finished"), refs: wakeupRefs(job) }
    );
    this.#deliverTerminalEvent(terminal);
  }

  #superviseRunning(job: DurableJob, now: Date): void {
    // 1. Harvest exit.json if present.
    const exit = this.#artifacts.readExitJson(job.taskId, job.id);
    if (exit !== null) {
      this.#harvestExit(job, exit, now);
      return;
    }

    // 2. Cancel requested: write fence + SIGTERM.
    if (job.cancelRequestedAt !== undefined && job.process !== undefined) {
      this.#artifacts.writeCancelFence(job.taskId, job.id);
      this.#process.signalIfOwned(
        job.process.pid,
        job.process.startIdentity,
        "SIGTERM"
      );
    }

    // 3. Process liveness via pid + startIdentity.
    if (job.process !== undefined) {
      const identity = this.#process.processStartIdentity(job.process.pid);
      const alive = identity !== undefined
        && identity === job.process.startIdentity
        && this.#process.isProcessAlive(job.process.pid);
      if (!alive) {
        this.#handleDeadProcess(job, now);
        return;
      }
    }

    // 4. Heartbeat freshness.
    const heartbeatMtime = this.#artifacts.heartbeatMtime(job.taskId, job.id);
    if (heartbeatMtime !== null) {
      const staleMs = now.getTime() - heartbeatMtime;
      if (staleMs > HEARTBEAT_STALE_MS && job.process !== undefined) {
        this.#process.signalIfOwned(
          job.process.pid,
          job.process.startIdentity,
          "SIGTERM"
        );
        const existing = this.#sigkillAt.get(this.#sigkillKey(job));
        if (existing === undefined) {
          this.#sigkillAt.set(this.#sigkillKey(job), now.getTime() + SIGKILL_GRACE_MS);
        }
      }
      const recordHeartbeat = job.heartbeatAt !== undefined
        ? Date.parse(job.heartbeatAt)
        : 0;
      if (heartbeatMtime > recordHeartbeat) {
        this.#store.transitionDurableJob(
          job.taskId,
          job.id,
          (current) => touchDurableJobHeartbeat(current, new Date(heartbeatMtime)),
          now
        );
      }
    }

    // 5. SIGKILL escalation.
    const sigkillAt = this.#sigkillAt.get(this.#sigkillKey(job));
    if (sigkillAt !== undefined && now.getTime() >= sigkillAt && job.process !== undefined) {
      this.#process.signalIfOwned(
        job.process.pid,
        job.process.startIdentity,
        "SIGKILL"
      );
      this.#sigkillAt.delete(this.#sigkillKey(job));
    }
  }

  #harvestExit(job: DurableJob, exit: DurableJobExit, now: Date): void {
    // Persist the original receipt locator before interpreting its output.
    // A bad schema cannot erase evidence of an already executed runner.
    this.#store.transitionDurableJob(job.taskId, job.id, (current) => ({
      ...current,
      operation: recordOperationEvidence(current.operation, {
        effect: "confirmed",
        receiptRefs: [`${current.artifactsLocator}/exit.json`],
        partialResultRefs: Array.isArray(exit.steps)
          ? exit.steps.flatMap((step) => typeof step?.logPath === "string" && step.logPath.trim()
            ? [step.logPath] : []) : []
      }),
      updatedAt: now.toISOString()
    }), now);
    const result: DurableJobResult = {
      outcome: exit.outcome,
      exitCode: exit.exitCode,
      signal: exit.signal,
      ...(exit.failedStep === undefined ? {} : { failedStep: exit.failedStep }),
      evidenceSource: "exit-artifact",
      steps: exit.steps
    };
    // rr4/finding-7: The terminal transition and the Leader wakeup must be
    // atomic. Compose complete + wakeupNotified and pass the wakeup param so
    // the adapter enqueues the Leader mailbox entry in the same transaction.
    // A separate #notifyWakeup pass would lose the wakeup if the Controller
    // died between the terminal write and the flag flip.
    const terminal = this.#store.transitionDurableJob(
      job.taskId,
      job.id,
      (current) => {
        let completed: DurableJob;
        try {
          completed = completeDurableJob(current, result, now);
        } catch {
          completed = completeDurableJob(current, {
            outcome: "failed", exitCode: null, signal: null,
            unknownReason: "runner output is invalid; original receipt is retained",
            steps: []
          }, now);
        }
        return markDurableJobWakeupNotified(completed, now);
      },
      now,
      { reason: wakeReason("job-finished"), refs: wakeupRefs(job) }
    );
    this.#deliverTerminalEvent(terminal);
    this.#sigkillAt.delete(this.#sigkillKey(job));
  }

  #handleDeadProcess(job: DurableJob, now: Date): void {
    const checkpoint = this.#artifacts.readCheckpoint(job.taskId, job.id);
    const proven = checkpoint === null ? null : proveOutcomeFromCheckpoint(job, checkpoint);
    // rr4/finding-7: Same atomic wakeup composition as #harvestExit — the
    // terminal transition and the Leader wakeup commit together.
    if (proven !== null) {
      // The runner died without exit.json, but its step checkpoint covered
      // every planned step: the outcome is still provable from durable
      // evidence. No false pass — the checkpoint is the runner's own record.
      const terminal = this.#store.transitionDurableJob(
        job.taskId,
        job.id,
        (current) => markDurableJobWakeupNotified(
          completeDurableJob(current, { ...proven, evidenceSource: "checkpoint" }, now),
          now
        ),
        now,
        { reason: wakeReason("job-finished"), refs: wakeupRefs(job) }
      );
      this.#deliverTerminalEvent(terminal);
    } else {
      const completedSteps = checkpoint?.completedSteps ?? [];
      const terminal = this.#store.transitionDurableJob(
        job.taskId,
        job.id,
        (current) => markDurableJobWakeupNotified(
          markDurableJobUnknown(
            current,
            "runner process exited without writing exit.json",
            completedSteps,
            now
          ),
          now
        ),
        now,
        { reason: wakeReason("job-finished"), refs: wakeupRefs(job) }
      );
      this.#deliverTerminalEvent(terminal);
    }
    this.#sigkillAt.delete(this.#sigkillKey(job));
  }

  /**
   * f7/rr5: Deliver a terminal notice to the runtime inbox channel when a
   * Job reaches a terminal state. The notice is best-effort: the terminal
   * transition already committed, so a delivery failure must not fail the
   * reconcile pass. The composition root wires this to the runtime event
   * inbox so the Controller wakes immediately instead of waiting for the
   * next poll.
   */
  #deliverTerminalEvent(job: DurableJob | null): void {
    if (job === null || !isDurableJobTerminal(job.status)) return;
    this.#terminalEvents?.deliverTerminalEvent({
      taskId: job.taskId,
      jobId: job.id,
      status: job.status,
      outcome: job.result?.outcome ?? job.status
    });
  }

}

function wakeupRefs(job: DurableJob): readonly MailboxEntityRef[] {
  const refs: MailboxEntityRef[] = [{ type: "task", id: job.taskId }];
  if (job.owner.kind === "work-item") {
    refs.push({ type: "work-item", taskId: job.taskId, id: job.owner.workItemId });
  }
  return refs;
}

/**
 * Prove a terminal outcome from the step checkpoint when the runner died
 * without writing exit.json. Returns null (fail closed → unknown) unless the
 * checkpoint covers every planned step exactly, by name.
 */
function proveOutcomeFromCheckpoint(
  job: DurableJob,
  checkpoint: DurableJobCheckpoint
): Omit<DurableJobResult, "evidenceSource"> | null {
  const byName = new Map(checkpoint.completedSteps.map((step) => [step.name, step]));
  if (byName.size !== checkpoint.completedSteps.length) return null;
  if (byName.size !== job.steps.length) return null;
  const ordered: DurableJobStepResult[] = [];
  for (const planned of job.steps) {
    const step = byName.get(planned.name);
    if (step === undefined) return null;
    ordered.push(step);
  }
  const failing = ordered.find(
    (step) => step.timedOut || step.exitCode !== 0 || step.signal !== null
  );
  if (failing === undefined) {
    return { outcome: "succeeded", exitCode: 0, signal: null, steps: ordered };
  }
  if (failing.timedOut) {
    return {
      outcome: "timed-out",
      exitCode: failing.exitCode,
      signal: failing.signal,
      failedStep: failing.name,
      steps: ordered
    };
  }
  return {
    outcome: "failed",
    exitCode: failing.exitCode,
    signal: failing.signal,
    failedStep: failing.name,
    steps: ordered
  };
}

// ---------------------------------------------------------------------------
// Production ports
// ---------------------------------------------------------------------------

export function createLinuxProcessPort(): JobSupervisorProcessPort {
  return {
    spawnJobRunner(specPath: string) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../job/jobRunner.js", import.meta.url)), specPath],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      const startIdentity = readLinuxProcessStartIdentity(child.pid!);
      return {
        pid: child.pid!,
        startIdentity,
        // rr6/f1: Wake the supervisor when the runner exits so the Controller
        // harvests the terminal artifact immediately. The listener does not
        // re-ref the child (unref already detached the event-loop hold), so it
        // cannot pin the Controller; if the Controller dies first, the
        // recovery interval remains the fallback.
        onExit: (callback: () => void) => {
          child.on("exit", () => callback());
        }
      };
    },
    processStartIdentity(pid: number) {
      return readLinuxProcessStartIdentity(pid);
    },
    isProcessAlive(pid: number) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    },
    signalIfOwned(pid: number, startIdentity: string, signal: NodeJS.Signals) {
      if (readLinuxProcessStartIdentity(pid) !== startIdentity) return;
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
}

export function createFileArtifactPort(home: string): JobSupervisorArtifactPort {
  return {
    artifactDir(taskId: string, jobId: string) {
      return join(home, "artifacts", "jobs", taskId, jobId);
    },
    writeSpec(taskId: string, jobId: string, spec: DurableJobSpec) {
      const dir = join(home, "artifacts", "jobs", taskId, jobId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const specPath = join(dir, "spec.json");
      writeTextFileAtomically(specPath, `${JSON.stringify(spec, null, 2)}\n`);
      return specPath;
    },
    writeCancelFence(taskId: string, jobId: string) {
      const dir = join(home, "artifacts", "jobs", taskId, jobId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fencePath = join(dir, "cancel");
      if (!existsSync(fencePath)) {
        const fd = openSync(fencePath, "w", 0o600);
        closeSync(fd);
      }
    },
    readExitJson(taskId: string, jobId: string) {
      return readJsonFile<DurableJobExit>(
        join(home, "artifacts", "jobs", taskId, jobId, "exit.json")
      );
    },
    readCheckpoint(taskId: string, jobId: string) {
      return readJsonFile<DurableJobCheckpoint>(
        join(home, "artifacts", "jobs", taskId, jobId, "checkpoint.json")
      );
    },
    heartbeatMtime(taskId: string, jobId: string) {
      try {
        return statSync(join(home, "artifacts", "jobs", taskId, jobId, "heartbeat")).mtimeMs;
      } catch {
        return null;
      }
    },
    writeStartMarker(taskId: string, jobId: string, marker: DurableJobStartMarker) {
      const dir = join(home, "artifacts", "jobs", taskId, jobId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeTextFileAtomically(
        join(dir, "start.json"),
        `${JSON.stringify(marker, null, 2)}\n`
      );
    },
    readStartMarker(taskId: string, jobId: string) {
      return readJsonFile<DurableJobStartMarker>(
        join(home, "artifacts", "jobs", taskId, jobId, "start.json")
      );
    },
    readReadyFile(taskId: string, jobId: string) {
      return readJsonFile<DurableJobReadyMarker>(
        join(home, "artifacts", "jobs", taskId, jobId, "ready.json")
      );
    }
  };
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
