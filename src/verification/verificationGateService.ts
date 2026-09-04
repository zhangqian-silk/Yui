import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CheckResult } from "../integration/checkResult.js";
import type { DurableJob, DurableJobStep } from "../job/durableJob.js";
import type { Project } from "../repository/project.js";
import {
  completeGateArtifact,
  createGateArtifact,
  gateArtifactRef,
  isReusableGateArtifact,
  parseGateArtifactRef,
  recordGateArtifactReuse,
  validateGateArtifact,
  verifyGateArtifactLogs,
  type GateArtifact,
  type GateArtifactIdentity,
  type GateArtifactLevel,
  type GateArtifactStorePort
} from "./gateArtifact.js";
import {
  findGateArtifact,
  importGateArtifactSteps,
  loadGateArtifact,
  saveGateArtifact,
  touchGateArtifact,
  type GateArtifactStepInput
} from "./gateArtifactStore.js";
import {
  planL1JobSteps,
  resolveProjectVerificationPlan,
  resolveToolchain,
  selectL1Checks,
  toolchainDigest,
  verificationPlanDigest,
  verificationStepCommand,
  type ResolvedToolchain,
  type VerificationMode,
  type VerificationPlan
} from "./verificationPlan.js";

/**
 * Issue 08: the VerificationGate service.
 *
 * One place owns the gate lifecycle: identity tuple computation, reuse
 * lookup, artifact recording from a DurableJob or an in-process run, Review
 * verification, and exact artifact reuse. Integration, the queue, Review, and
 * release consume through these functions; unconfigured Projects keep the
 * existing explicit check path untouched.
 */

export type ResolvedVerificationGate = Readonly<{
  plan: VerificationPlan;
  mode: VerificationMode;
  toolchain: ResolvedToolchain;
  planDigest: string;
  toolchainDigest: string;
}>;

/** Resolve a Project's active plan and the runtime toolchain it gates under. */
export function resolveVerificationGate(
  project: Project,
  _environment: NodeJS.ProcessEnv = process.env
): ResolvedVerificationGate | undefined {
  const plan = resolveProjectVerificationPlan(project);
  if (plan === undefined) return undefined;
  const toolchain = resolveToolchain();
  return Object.freeze({
    plan,
    mode: plan.mode,
    toolchain,
    planDigest: verificationPlanDigest(plan),
    toolchainDigest: toolchainDigest(plan, toolchain)
  });
}

export function gateIdentityForCandidate(input: Readonly<{
  projectId: string;
  gate: ResolvedVerificationGate;
  level: GateArtifactLevel;
  commit: string;
  targetRef?: string;
  baseHead?: string;
}>): GateArtifactIdentity {
  const boundary = input.level === "L2"
    ? {
        targetRef: input.targetRef ?? "master",
        baseHead: input.baseHead ?? input.commit
      }
    : undefined;
  return Object.freeze({
    projectId: input.projectId,
    level: input.level,
    commit: input.commit,
    planDigest: input.gate.planDigest,
    toolchainDigest: input.gate.toolchainDigest,
    ...(boundary === undefined ? {} : { boundary })
  });
}

/**
 * Look up a reusable artifact for an identity tuple. Only a complete,
 * successful artifact whose logs still verify is reusable; an incomplete
 * artifact from a crashed gate is never returned.
 */
export async function lookupReusableGateArtifact(
  store: GateArtifactStorePort,
  identity: GateArtifactIdentity
): Promise<GateArtifact | null> {
  const artifact = findGateArtifact(store, identity);
  if (artifact === null || !isReusableGateArtifact(artifact)) return null;
  const logs = store.getGateArtifactLogs(artifact.key);
  const verification = verifyGateArtifactLogs(artifact, logs);
  return verification.ok ? artifact : null;
}

/**
 * Record a GateArtifact from a terminal check DurableJob. The job's step
 * logs are copied into the artifact store and bound to their digests, so the
 * artifact is self-contained evidence after the job's own logs are cleaned.
 */
export async function recordGateArtifactFromJob(
  store: GateArtifactStorePort,
  home: string,
  identity: GateArtifactIdentity,
  plan: VerificationPlan,
  job: DurableJob,
  now: Date
): Promise<GateArtifact> {
  const steps: GateArtifactStepInput[] = (job.result?.steps ?? []).map((result) => {
    const planned = job.steps.find((step) => step.name === result.name);
    return {
      name: result.name,
      command: planned?.command ?? result.name,
      ...(planned?.argv === undefined ? {} : { argv: planned.argv }),
      outcome: !result.timedOut && result.signal === null && result.exitCode === 0
        ? "passed" as const
        : "failed" as const,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      sourceLogPath: join(
        resolve(home),
        job.artifactsLocator,
        "logs",
        result.logPath
      ),
      logName: result.logPath
    };
  });
  return recordGateArtifact(store, identity, plan, steps, job.result?.outcome === "succeeded", now);
}

/** One in-process step outcome (L1 or the jobless L2 fallback). */
export type GateStepOutcome = Readonly<{
  name: string;
  command: string;
  argv?: readonly string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  sourceLogPath: string;
  logName: string;
}>;

export async function recordGateArtifactFromStepOutcomes(
  store: GateArtifactStorePort,
  identity: GateArtifactIdentity,
  plan: VerificationPlan,
  outcomes: readonly GateStepOutcome[],
  succeeded: boolean,
  now: Date
): Promise<GateArtifact> {
  const steps: GateArtifactStepInput[] = outcomes.map((outcome) => ({
    name: outcome.name,
    command: outcome.command,
    ...(outcome.argv === undefined ? {} : { argv: outcome.argv }),
    outcome: !outcome.timedOut && outcome.signal === null && outcome.exitCode === 0
      ? "passed" as const
      : "failed" as const,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    sourceLogPath: outcome.sourceLogPath,
    logName: outcome.logName
  }));
  return recordGateArtifact(store, identity, plan, steps, succeeded, now);
}

async function recordGateArtifact(
  store: GateArtifactStorePort,
  identity: GateArtifactIdentity,
  plan: VerificationPlan,
  steps: readonly GateArtifactStepInput[],
  succeeded: boolean,
  now: Date
): Promise<GateArtifact> {
  const created = createGateArtifact(identity, {
    planId: plan.id,
    planVersion: plan.version,
    generator: "yui"
  }, now);
  const { steps: importedSteps, logs } = await importGateArtifactSteps(steps);
  let artifact = completeGateArtifact(
    created,
    importedSteps,
    succeeded ? "succeeded" : "failed",
    now
  );
  // Preserve shadow/reuse counters when re-recording the same identity tuple
  // (e.g. record mode always re-runs the gate but must not lose the potential
  // reuse observations from earlier runs).
  const existing = findGateArtifact(store, identity);
  if (existing !== null) {
    if (isReusableGateArtifact(existing) && !succeeded) {
      // A failed re-run must not downgrade a proven successful artifact.
      touchGateArtifact(store, existing);
      return existing;
    }
    artifact = validateGateArtifact({
      ...artifact,
      potentialReuseCount: existing.potentialReuseCount,
      reuseCount: existing.reuseCount,
      createdAt: existing.createdAt
    });
  }
  saveGateArtifact(store, artifact, logs);
  return artifact;
}

const GATE_STEP_TIMEOUT_MS = 30 * 60_000;
const SIGKILL_GRACE_MS = 2_000;

/**
 * Run structured gate steps in-process (L1 targeted checks and the jobless
 * L2 fallback). Each step gets its own log file; argv steps run without a
 * shell. This is the local form of the gate; the DurableJob form is the
 * Controller-owned one used by production Integration.
 */
export async function runGateStepsInProcess(
  workspace: string,
  steps: readonly DurableJobStep[],
  environment: Readonly<Record<string, string>>,
  logsDirectory: string,
  _head: string
): Promise<readonly GateStepOutcome[]> {
  await rm(logsDirectory, { recursive: true, force: true });
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  const outcomes: GateStepOutcome[] = [];
  for (const [index, step] of steps.entries()) {
    const logName = `${String(index + 1).padStart(3, "0")}-${sanitizeLogName(step.name)}.log`;
    const absoluteLogPath = join(logsDirectory, logName);
    const outcome = await runOneStep(step, workspace, environment, absoluteLogPath, logName);
    outcomes.push(outcome);
    if (outcome.exitCode !== 0 || outcome.signal !== null || outcome.timedOut) break;
  }
  return Object.freeze(outcomes);

  async function runOneStep(
    step: DurableJobStep,
    cwd: string,
    env: Readonly<Record<string, string>>,
    absoluteLogPath: string,
    logName: string
  ): Promise<GateStepOutcome> {
    const startedAt = Date.now();
    const output = await open(absoluteLogPath, "w", 0o600);
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    const stepCwd = step.cwd ?? cwd;
    const stepEnv = step.env === undefined ? env : { ...env, ...step.env };
    try {
      if (step.argv !== undefined) {
        const [file, ...args] = step.argv;
        child = spawn(file, args, {
          cwd: stepCwd,
          env: stepEnv,
          stdio: ["ignore", output.fd, output.fd],
          detached: true
        });
      } else {
        child = spawn("/bin/sh", ["-lc", step.command], {
          cwd: stepCwd,
          env: stepEnv,
          stdio: ["ignore", output.fd, output.fd],
          detached: true
        });
      }
    } catch (error) {
      await output.close();
      return {
        name: step.name,
        command: step.command,
        ...(step.argv === undefined ? {} : { argv: step.argv }),
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        sourceLogPath: absoluteLogPath,
        logName
      };
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        const pid = child.pid;
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // The process group may already be gone.
        }
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // The process group may already be gone.
          }
        }, SIGKILL_GRACE_MS).unref();
      }
    }, GATE_STEP_TIMEOUT_MS);
    timeout.unref();
    const completion = await new Promise<{ code: number | null; signal: string | null }>((settle) => {
      child.once("error", () => settle({ code: null, signal: null }));
      child.once("close", (code, signal) => settle({ code, signal: signal ?? null }));
    });
    clearTimeout(timeout);
    await output.close();
    return {
      name: step.name,
      command: step.command,
      ...(step.argv === undefined ? {} : { argv: step.argv }),
      exitCode: completion.code,
      signal: completion.signal,
      timedOut,
      durationMs: Date.now() - startedAt,
      sourceLogPath: absoluteLogPath,
      logName
    };
  }
}

function sanitizeLogName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");
}

/**
 * Map a terminal gate DurableJob to the attempt's CheckResult shape.
 * Bootstrap steps are classified explicitly (`[bootstrap]` prefix) so an
 * environment/registry failure is never recorded as a Candidate test
 * failure; the Integration gate has not started when bootstrap fails.
 */
export function checkResultsFromGateJob(job: DurableJob, home: string): CheckResult[] {
  const results = new Map((job.result?.steps ?? []).map((step) => [step.name, step]));
  const checks: CheckResult[] = [];
  for (const step of job.steps) {
    const result = results.get(step.name);
    if (result === undefined) {
      checks.push({
        name: step.name,
        outcome: "skipped"
      });
      continue;
    }
    const logPath = `${job.artifactsLocator}/logs/${result.logPath}`;
    const bootstrap = step.name.startsWith("bootstrap-");
    const passed = !result.timedOut && result.signal === null && result.exitCode === 0;
    const reason = result.timedOut
      ? "Command timed out after 1800 seconds."
      : result.signal !== null
        ? `Command terminated by ${result.signal}.`
        : result.exitCode !== 0
          ? `Command exited with code ${result.exitCode}.`
          : undefined;
    checks.push({
      name: step.name,
      outcome: passed ? "passed" : "failed",
      ...(reason === undefined
        ? {}
        : { details: bootstrap ? `[bootstrap] ${reason}` : reason }),
      logPath
    });
  }
  if (
    checks.length > 0
    && !checks.some((check) => check.outcome === "failed")
    && job.result?.outcome !== "succeeded"
  ) {
    // Fail closed: a job that ended without proving the gate (cancelled,
    // timed-out, unknown) must never pass the Integration gate.
    const firstName = checks[0]!.name;
    const isBootstrap = firstName.startsWith("bootstrap-");
    checks[0] = {
      name: firstName,
      outcome: "failed",
      details: job.result?.outcome === "unknown-needs-attention"
        ? `[bootstrap] Check job unknown-needs-attention: ${job.result.unknownReason ?? "runner outcome is unproven"}.`
        : `${isBootstrap ? "[bootstrap] " : ""}Check job ended ${job.result?.outcome ?? job.status} without proving the checks.`
    };
  }
  return checks;
}

/** Map an artifact to the attempt's CheckResult shape. The reuse-ref entry
 * is only included when the artifact was actually reused (not freshly
 * recorded), so a fresh run never claims "Reused exact-SHA". */
export function checkResultsFromGateArtifact(
  artifact: GateArtifact,
  reused = false
): CheckResult[] {
  const checks: CheckResult[] = artifact.steps.map((step) => ({
    name: step.name,
    outcome: step.outcome,
    ...(step.logPath === undefined ? {} : { logPath: step.logPath })
  }));
  if (reused) {
    checks.push({
      name: gateArtifactRef(artifact.key),
      outcome: "passed",
      details: `Reused exact-SHA ${artifact.level} gate artifact (commit ${artifact.commit}).`
    });
  }
  return checks;
}

export type GateArtifactVerification = Readonly<{
  ok: boolean;
  reason?: string;
  artifact?: GateArtifact;
}>;

/**
 * Verify a gate artifact for Review consumption: the record exists, is
 * complete and successful, binds the expected commit (when given), and every
 * step log still matches its digest. A failed verification is a verification
 * gap: the Reviewer runs a targeted check for it instead of trusting prose.
 */
export async function verifyGateArtifactForReview(
  store: GateArtifactStorePort,
  projectId: string,
  key: string,
  expected: Readonly<{ commit?: string }> = {}
): Promise<GateArtifactVerification> {
  const artifact = loadGateArtifact(store, projectId, key);
  if (artifact === null) {
    return { ok: false, reason: `Gate artifact not found: ${key}.` };
  }
  if (!isReusableGateArtifact(artifact)) {
    return {
      ok: false,
      reason: `Gate artifact is not complete/successful: ${artifact.status}/${artifact.outcome}.`
    };
  }
  if (expected.commit !== undefined && artifact.commit !== expected.commit) {
    return {
      ok: false,
      reason: `Gate artifact commit ${artifact.commit} does not match ${expected.commit}.`
    };
  }
  const logs = store.getGateArtifactLogs(artifact.key);
  const verification = verifyGateArtifactLogs(artifact, logs);
  if (!verification.ok) {
    const parts = [
      ...verification.missing.map((name) => `missing log: ${name}`),
      ...verification.corrupted.map((name) => `corrupted log: ${name}`)
    ];
    return {
      ok: false,
      reason: `Gate artifact logs failed verification: ${parts.join("; ")}.`
    };
  }
  return { ok: true, artifact };
}

/**
 * Enforce mode (rollout step 4): reject ad-hoc full-suite shell checks that
 * duplicate the plan's L2 steps for a configured Project. Explicit targeted
 * diagnostic checks (anything that is not an L2 step command) stay allowed.
 */
export function assertNoAdHocFullSuiteChecks(
  plan: VerificationPlan,
  checkCommands: readonly string[]
): void {
  const l2Commands = new Set(plan.l2.steps.map((step) => verificationStepCommand(step)));
  for (const command of checkCommands) {
    if (l2Commands.has(command)) {
      throw new Error(
        `Ad-hoc full-suite check is rejected for plan-enabled Project `
        + `${plan.id}: use the VerificationPlan L2 gate (or pass a targeted `
        + `diagnostic command that is not an L2 step): ${command}`
      );
    }
  }
}

/**
 * Run an L1 gate for a change: select the affected categories' checks, run
 * them in-process, and record the L1 artifact. Reuse mode returns an existing
 * successful artifact for the same tuple.
 */
export async function runL1Gate(input: Readonly<{
  store: GateArtifactStorePort;
  projectId: string;
  gate: ResolvedVerificationGate;
  commit: string;
  changedPaths: readonly string[];
  workspace: string;
  environment: Readonly<Record<string, string>>;
  logsDirectory: string;
  now: Date;
}>): Promise<{ artifact: GateArtifact; reused: boolean; checks: CheckResult[] }> {
  const identity = gateIdentityForCandidate({
    projectId: input.projectId,
    gate: input.gate,
    level: "L1",
    commit: input.commit
  });
  if (input.gate.mode !== "record") {
    const existing = await lookupReusableGateArtifact(input.store, identity);
    if (existing !== null) {
      const reused = recordGateArtifactReuse(existing, input.now);
      touchGateArtifact(input.store, reused);
      return {
        artifact: reused,
        reused: true,
        checks: checkResultsFromGateArtifact(reused, true)
      };
    }
  }
  const selected = selectL1Checks(input.gate.plan, input.changedPaths);
  const outcomes = await runGateStepsInProcess(
    input.workspace,
    planL1JobSteps(selected),
    input.environment,
    input.logsDirectory,
    input.commit
  );
  const succeeded = outcomes.length > 0
    && outcomes.every((outcome) => outcome.exitCode === 0 && outcome.signal === null && !outcome.timedOut);
  const artifact = await recordGateArtifactFromStepOutcomes(
    input.store,
    identity,
    input.gate.plan,
    outcomes,
    succeeded,
    input.now
  );
  return {
    artifact,
    reused: false,
    checks: checkResultsFromGateArtifact(artifact, false)
  };
}

/** Stable digest of a log file, for ad-hoc evidence binding. */
export function digestLogContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export { gateArtifactRef, parseGateArtifactRef };
export type { GateArtifact, GateArtifactIdentity, GateArtifactLevel };
