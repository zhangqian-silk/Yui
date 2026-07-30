import { requireText } from "../domain/validation.js";

export type CheckOutcome = "passed" | "failed" | "skipped";

export type CheckResult = Readonly<{
  name: string;
  outcome: CheckOutcome;
  details?: string;
  logPath?: string;
}>;

export function normalizeCheckResult(check: CheckResult): CheckResult {
  if (!["passed", "failed", "skipped"].includes(check.outcome)) {
    throw new Error(`Check outcome is invalid: ${String(check.outcome)}.`);
  }
  return {
    name: requireText(check.name, "Check name"),
    outcome: check.outcome,
    ...(check.details === undefined
      ? {}
      : { details: requireText(check.details, "Check details") }),
    ...(check.logPath === undefined
      ? {}
      : { logPath: requireRelativePath(check.logPath, "Check log path") })
  };
}

function requireRelativePath(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (
    /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(normalized)
    || normalized.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(`${label} must be relative.`);
  }
  return normalized.replaceAll("\\", "/");
}
