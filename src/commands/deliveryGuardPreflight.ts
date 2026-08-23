import {
  resolveLeaderNextActionMode,
  resolveLeaderSemanticBudgetTurns
} from "../config/yuiConfig.js";
import { usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  detectDeliveryDuplicates,
  evaluateDeliveryGuard,
  evaluateSemanticBudget,
  formatDeliveryDuplicate,
  type DeliveryGuardIntent
} from "../task/deliveryGuard.js";

/**
 * Issue 07 (Leader convergence): shared mutation preflight. Runs the exact
 * duplicate guard and (optionally) the semantic-progress budget against the
 * configured `leader.nextActionMode`:
 *
 * - `display`: no interference (read-only projection only).
 * - `warn`: every match is returned as a warning line; the mutation proceeds.
 * - `enforce`: exact duplicates hard-block the mutation; suspected duplicates
 *   and an exhausted semantic-progress budget remain warnings for the Leader.
 *
 * The preflight is read-only and never writes records.
 */
export type DeliveryGuardPreflightOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  /** Evaluate the semantic-progress budget in addition to duplicates. */
  budget?: boolean;
}>;

export type DeliveryGuardPreflight = Readonly<{
  warnings: readonly string[];
}>;

export function runDeliveryGuardPreflight(
  store: TaskStore,
  taskId: string,
  intent: DeliveryGuardIntent,
  options: DeliveryGuardPreflightOptions = {}
): DeliveryGuardPreflight {
  const mode = resolveLeaderNextActionMode(
    store.getConfig().leaderNextActionMode
  );
  if (mode === "display") return { warnings: [] };
  const facts = store.readNextActionFacts(taskId);
  if (facts === null) return { warnings: [] };
  const outcome = evaluateDeliveryGuard(
    detectDeliveryDuplicates(facts, intent),
    mode
  );
  const warnings = outcome.warnings.map(formatDeliveryDuplicate);
  if (outcome.blocked !== null) {
    throw usageError(
      `${formatDeliveryDuplicate(outcome.blocked)} `
      + "Reuse the existing proof, or set leader.nextActionMode=warn to proceed with a warning."
    );
  }
  if (options.budget === true) {
    const budget = evaluateSemanticBudget(
      facts,
      resolveLeaderSemanticBudgetTurns(store.getConfig().leaderSemanticBudgetTurns)
    );
    if (budget.exhausted) {
      warnings.push(`Semantic progress budget: ${budget.reason}`);
    }
  }
  return { warnings };
}

/** Prepend guard warnings to a command's normal output. */
export function withGuardWarnings(
  preflight: DeliveryGuardPreflight,
  output: string
): string {
  if (preflight.warnings.length === 0) return output;
  return `${preflight.warnings.map((warning) => `Warning: ${warning}\n`).join("")}${output}`;
}
