/**
 * Standalone durable-job runner.
 *
 * Receives exactly one argument: the absolute path to a `spec.json` written
 * atomically by the Controller. The runner MUST NOT open yui.db or any
 * other control-plane file; its entire contract is the spec + the artifact
 * directory. The Controller supervises the runner through the artifact files
 * (heartbeat, checkpoint.json, exit.json) and the process identity.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeTextFileAtomically } from "../storage/durableFile.js";
import { readLinuxProcessStartIdentity } from "../controller/domainIdentity.js";
import type {
  DurableJobExit,
  DurableJobSpec,
  DurableJobStepResult
} from "./durableJob.js";

const DEFAULT_STEP_TIMEOUT_MS = 30 * 60_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const SIGKILL_GRACE_MS = 2_000;
const CANCEL_FENCE = "cancel";

/**
 * The bounded grace between SIGTERM and SIGKILL for a step that ignores the
 * termination request. Scales with the step timeout (capped) so even the
 * shortest timeout converges in tests while real checks get the full grace.
 */
function sigkillGraceMs(stepTimeoutMs: number): number {
  return Math.min(SIGKILL_GRACE_MS, Math.max(100, Math.floor(stepTimeoutMs / 2)));
}

export async function runDurableJobRunner(
  specPath: string
): Promise<void> {
  const spec = readSpec(specPath);
  const artifactDir = resolve(spec.artifactDir);
  const logsDir = join(artifactDir, "logs");
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  chmodSync(artifactDir, 0o700);

  const heartbeatPath = join(artifactDir, "heartbeat");
  const checkpointPath = join(artifactDir, "checkpoint.json");
  const exitPath = join(artifactDir, "exit.json");
  const cancelPath = join(artifactDir, CANCEL_FENCE);

  touchHeartbeat(heartbeatPath);
  const heartbeatTimer = setInterval(
    () => touchHeartbeat(heartbeatPath),
    HEARTBEAT_INTERVAL_MS
  );
  heartbeatTimer.unref();

  // f3: Durable startup handshake. Write ready.json with O_EXCL before any
  // step side effect. If the file already exists, another runner instance
  // already started — exit to prevent duplicate execution. The supervisor
  // reads this file to adopt a queued job after a Controller crash.
  //
  // rr4/finding-4: The runner writes its own OS startIdentity so the
  // supervisor can adopt without re-reading /proc (which could return a
  // reused PID's identity after the original runner exited).
  const readyPath = join(artifactDir, "ready.json");
  try {
    const readyFd = openSync(readyPath, "wx", 0o600);
    writeFileSync(readyFd, JSON.stringify({
      pid: process.pid,
      startIdentity: readLinuxProcessStartIdentity(process.pid) ?? String(process.pid),
      startedAt: new Date().toISOString()
    }, null, 2) + "\n");
    closeSync(readyFd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Another runner already started for this job. Exit cleanly.
      return;
    }
    throw error;
  }

  let cancelled = false;
  let currentChild: ReturnType<typeof spawn> | null = null;
  // f4: Kill the entire process group so background descendants cannot
  // survive the runner's terminal exit. Each step runs in its own group
  // (detached: true), and negative-pid kill targets the whole group.
  const killProcessGroup = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  // f2/rr5: The SIGTERM handler must stay installed and idempotent for the
  // runner's whole lifetime. A repeated SIGTERM (supervisor re-send, stale-
  // heartbeat escalation, or a second operator cancel) must NOT bypass the
  // graceful exit.json write: the first signal sets `cancelled` and kills the
  // step; subsequent signals during the drain are ignored so the runner can
  // finish writing exit.json before exiting. Using `process.on` (not `once`)
  // keeps the handler installed; the early return makes re-entry a no-op.
  const onSignal = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (currentChild !== null) {
      killProcessGroup(currentChild, "SIGTERM");
      // A child that ignores SIGTERM must not pin the runner: escalate so the
      // job still reaches its bounded terminal result.
      setTimeout(() => {
        if (currentChild !== null) killProcessGroup(currentChild, "SIGKILL");
      }, SIGKILL_GRACE_MS).unref();
    }
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const completedSteps: DurableJobStepResult[] = [];
  let outcome: DurableJobExit["outcome"] = "succeeded";
  let exitCode: number | null = 0;
  let signal: string | null = null;
  let failedStep: string | undefined;

  try {
    for (let index = 0; index < spec.steps.length; index += 1) {
      if (cancelled || existsSync(cancelPath)) {
        cancelled = true;
        outcome = "cancelled";
        exitCode = null;
        break;
      }
      touchHeartbeat(heartbeatPath);
      const step = spec.steps[index]!;
      const stepNumber = String(index + 1).padStart(3, "0");
      const logName = `${stepNumber}-${sanitizeLogName(step.name)}.log`;
      const logPath = join(logsDir, logName);
      const logFd = openSync(logPath, "w", 0o600);
      const stepTimeoutMs = step.timeoutMs ?? spec.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      const startedAt = Date.now();

      let timedOut = false;
      let child: ReturnType<typeof spawn>;
      try {
        // Issue 08: a structured argv step executes without a shell so its
        // tokens can never be reinterpreted; a legacy command step keeps the
        // shell form. A per-step cwd/env override applies to either form.
        const stepCwd = step.cwd ?? spec.workspace;
        const stepEnv = step.env === undefined
          ? spec.env
          : { ...spec.env, ...step.env };
        // f4: a new process group (detached) lets the runner kill the whole
        // step tree on timeout or cancel, for both argv and shell forms.
        if (step.argv !== undefined) {
          const [file, ...args] = step.argv;
          child = spawn(file, args, {
            cwd: stepCwd,
            env: stepEnv,
            stdio: ["ignore", logFd, logFd],
            detached: true
          });
        } else {
          child = spawn("/bin/sh", ["-lc", step.command], {
            cwd: stepCwd,
            env: stepEnv,
            stdio: ["ignore", logFd, logFd],
            detached: true
          });
        }
      } catch (error) {
        closeSync(logFd);
        completedSteps.push({
          name: step.name,
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          logPath: logName,
          head: spec.head
        });
        outcome = "failed";
        exitCode = null;
        failedStep = step.name;
        writeCheckpoint(checkpointPath, completedSteps);
        break;
      }
      currentChild = child;

      let sigkillTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, "SIGTERM");
        // A step that ignores SIGTERM must still converge: escalate to
        // SIGKILL after the bounded grace so exit.json is always written.
        sigkillTimer = setTimeout(() => {
          killProcessGroup(child, "SIGKILL");
        }, sigkillGraceMs(stepTimeoutMs));
        sigkillTimer.unref();
      }, stepTimeoutMs);
      timeout.unref();

      const result = await new Promise<{ code: number | null; signal: string | null }>((resolvePromise) => {
        child.once("error", () => {
          resolvePromise({ code: null, signal: null });
        });
        child.once("close", (code, sig) => {
          resolvePromise({ code, signal: sig ?? null });
        });
      });
      clearTimeout(timeout);
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
      closeSync(logFd);
      currentChild = null;

      const stepResult: DurableJobStepResult = {
        name: step.name,
        exitCode: result.code,
        signal: result.signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        logPath: logName,
        head: spec.head
      };
      completedSteps.push(stepResult);
      writeCheckpoint(checkpointPath, completedSteps);

      if (cancelled) {
        outcome = "cancelled";
        exitCode = null;
        break;
      }
      if (timedOut) {
        outcome = "timed-out";
        exitCode = result.code;
        signal = result.signal;
        failedStep = step.name;
        break;
      }
      if (result.code !== 0) {
        outcome = "failed";
        exitCode = result.code;
        signal = result.signal;
        failedStep = step.name;
        break;
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    // f2/rr5: Do NOT remove the signal handlers here. A repeated SIGTERM
    // between the step loop and the exit.json write must still hit the
    // idempotent handler (which ignores it) rather than the default handler
    // (which would kill the process before exit.json is written). The
    // handlers are removed after the exit.json write below.
  }

  const exit: DurableJobExit = {
    outcome,
    exitCode,
    signal,
    ...(failedStep === undefined ? {} : { failedStep }),
    steps: completedSteps,
    finishedAt: new Date().toISOString()
  };
  writeTextFileAtomically(exitPath, `${JSON.stringify(exit, null, 2)}\n`);

  // f2/rr5: exit.json is durable — the signal handlers are no longer needed.
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
}

function readSpec(specPath: string): DurableJobSpec {
  const resolved = resolve(specPath);
  const raw = readJsonFile(resolved);
  const spec = raw as Partial<DurableJobSpec>;
  if (typeof spec.jobId !== "string" || spec.jobId.length === 0) {
    throw new Error("DurableJob spec is missing jobId.");
  }
  if (typeof spec.taskId !== "string" || spec.taskId.length === 0) {
    throw new Error("DurableJob spec is missing taskId.");
  }
  if (typeof spec.workspace !== "string" || !spec.workspace.startsWith("/")) {
    throw new Error("DurableJob spec workspace must be an absolute path.");
  }
  if (typeof spec.artifactDir !== "string" || !spec.artifactDir.startsWith("/")) {
    throw new Error("DurableJob spec artifactDir must be an absolute path.");
  }
  if (typeof spec.head !== "string" || spec.head.length === 0) {
    throw new Error("DurableJob spec is missing head.");
  }
  if (typeof spec.env !== "object" || spec.env === null || Array.isArray(spec.env)) {
    throw new Error("DurableJob spec env must be a map.");
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    throw new Error("DurableJob spec must have at least one step.");
  }
  for (const step of spec.steps) {
    if (typeof step.name !== "string" || step.name.length === 0) {
      throw new Error("DurableJob spec step is missing name.");
    }
    if (typeof step.command !== "string" || step.command.length === 0) {
      throw new Error(`DurableJob spec step ${step.name} is missing command.`);
    }
    if (step.argv !== undefined) {
      if (!Array.isArray(step.argv) || step.argv.length === 0
        || step.argv.some((value: unknown) => typeof value !== "string" || (value as string).length === 0)) {
        throw new Error(`DurableJob spec step ${step.name} argv is invalid.`);
      }
    }
    if (step.cwd !== undefined
      && (typeof step.cwd !== "string" || !step.cwd.startsWith("/"))) {
      throw new Error(`DurableJob spec step ${step.name} cwd must be absolute.`);
    }
    if (step.env !== undefined
      && (typeof step.env !== "object" || step.env === null || Array.isArray(step.env))) {
      throw new Error(`DurableJob spec step ${step.name} env must be a map.`);
    }
    if (step.timeoutMs !== undefined
      && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1)) {
      throw new Error(`DurableJob spec step ${step.name} timeoutMs is invalid.`);
    }
  }
  return spec as DurableJobSpec;
}

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as unknown;
}

function touchHeartbeat(path: string): void {
  try {
    utimesSync(path, new Date(), new Date());
  } catch {
    try {
      const fd = openSync(path, "w", 0o600);
      closeSync(fd);
    } catch {
      // Best-effort liveness proof; the supervisor detects staleness.
    }
  }
}

function writeCheckpoint(
  path: string,
  completedSteps: readonly DurableJobStepResult[]
): void {
  const checkpoint = {
    completedSteps,
    updatedAt: new Date().toISOString()
  };
  writeTextFileAtomically(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function sanitizeLogName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 80) || "step";
}

function isEntrypoint(): boolean {
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  const specPath = process.argv[2];
  if (typeof specPath !== "string" || specPath.length === 0) {
    process.stderr.write("Usage: jobRunner.js <spec.json>\n");
    process.exitCode = 1;
  } else {
    void runDurableJobRunner(specPath).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`DurableJob runner failed: ${message}\n`);
      process.exitCode = 1;
    });
  }
}
