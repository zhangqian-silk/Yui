import { createHash } from "node:crypto";
import type { DurableJobStep } from "../../job/durableJob.js";
import type { HistoricalVerificationPlan as VerificationPlan, HistoricalVerificationStep as VerificationStep } from "./verificationPlanV1.js";

/** Frozen pre-fix encoding used only to recognize valid historical Jobs.
 * Never use corrected execution semantics to reinterpret a released migration,
 * and never use these helpers to create executable work or reusable evidence.
 */
export function historicalVerificationPlanDigest(plan: VerificationPlan): string {
  return createHash("sha256").update(JSON.stringify(canonicalize({
    id: plan.id, version: plan.version, toolchain: plan.toolchain,
    bootstrap: plan.bootstrap, l1: plan.l1, l2: plan.l2,
    ...(plan.l3 === undefined ? {} : { l3: plan.l3 })
  }))).digest("hex");
}

export function historicalGateJobSteps(plan: VerificationPlan): DurableJobStep[] {
  const encode = (step: VerificationStep, name: string): DurableJobStep => ({
    name,
    command: step.shell === true ? step.argv.join(" ") : step.argv.map(value =>
      /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
    ).join(" "),
    argv: step.argv,
    ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
    ...(step.env === undefined ? {} : { env: step.env })
  });
  return [
    ...plan.bootstrap.map((step, index) => encode(step, `bootstrap-${index + 1}`)),
    ...plan.l2.steps.map((step, index) => encode(step, `gate-${index + 1}`))
  ];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}
