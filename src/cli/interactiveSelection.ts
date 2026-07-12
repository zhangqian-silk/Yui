import { renderTable } from "../output/table.js";
import type { TaskStore } from "../storage/taskStore.js";
import { usageError } from "../errors/cliError.js";
import {
  getSelectionCandidates,
  type CandidateContext,
  type CandidateSet,
  type SelectionCandidate
} from "./interactionCandidates.js";
import { findInteractionPolicy, type InteractionPolicy } from "./interactionPolicy.js";
import type { CommandNode } from "./commandCatalog.js";

export type SelectionIo = {
  interactive: boolean;
  json: boolean;
  width: number;
  write(value: string): void;
  question(prompt: string): Promise<string | undefined>;
};

export type ArgumentResolution =
  | { kind: "unchanged"; args: string[] }
  | { kind: "resolved"; args: string[] }
  | { kind: "cancelled"; args: string[] };

export async function resolveInteractiveArguments(
  args: readonly string[],
  node: CommandNode,
  store: TaskStore,
  io: SelectionIo,
  context: CandidateContext = {}
): Promise<ArgumentResolution> {
  const resolved = [...args];
  const policy = findInteractionPolicy(node);
  if (!io.interactive || !allowsInteractiveSelection(args, io.json) || policy === undefined) {
    return { kind: "unchanged", args: resolved };
  }

  let changed = false;
  let selectedActionTarget = false;
  for (const selector of policy.selectors) {
    if (!selectorSlotIsMissing(resolved, selector.argumentIndex, policy.trailingOptions)) {
      continue;
    }
    const candidates = getSelectionCandidates(selector, store, resolved, context);
    if (candidates === null) {
      return { kind: changed ? "resolved" : "unchanged", args: resolved };
    }
    const selected = await selectCandidate(candidates, io);
    if (selected === undefined) {
      return { kind: "cancelled", args: resolved };
    }
    resolved.splice(selector.argumentIndex, 0, selected.value);
    changed = true;
    selectedActionTarget ||= selector.actionTarget;
  }

  if (selectedActionTarget && policy.confirmation !== undefined) {
    const target = resolved[policy.confirmation.targetArgumentIndex] ?? "";
    const answer = (await io.question(`${policy.confirmation.action} ${target}? [y/N]: `))?.trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      return { kind: "cancelled", args: resolved };
    }
  }

  return changed ? { kind: "resolved", args: resolved } : { kind: "unchanged", args: resolved };
}

function selectorSlotIsMissing(
  args: readonly string[],
  argumentIndex: number,
  trailingOptions: InteractionPolicy["trailingOptions"]
): boolean {
  const value = args[argumentIndex];
  if (value === undefined) {
    return true;
  }
  if (!value.startsWith("--") || trailingOptions === undefined) {
    return false;
  }

  for (let index = argumentIndex; index < args.length; index += 1) {
    const option = args[index] ?? "";
    const kind = trailingOptions[option];
    if (kind === undefined) {
      return false;
    }
    if (kind === "value") {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        return false;
      }
      index += 1;
    }
  }
  return true;
}

export function allowsInteractiveSelection(args: readonly string[], globalJson: boolean): boolean {
  if (globalJson) {
    return false;
  }
  return !args.some((argument, index) => argument === "--format" && args[index + 1] === "json");
}

async function selectCandidate(set: CandidateSet, io: SelectionIo): Promise<SelectionCandidate | undefined> {
  const candidates = set.candidates;
  if (candidates.length === 0) {
    throw usageError(set.emptyMessage);
  }
  if (candidates.length > 20) {
    throw usageError(
      `${candidates.length} ${set.entityLabel}s are available; interactive selection is limited to 20. ${set.overflowHint}`
    );
  }
  const defaultCandidate = candidates.find((candidate) => candidate.value === set.defaultValue)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  const columns = [
    { header: "#", minWidth: 1, maxWidth: 3 },
    ...set.columns
  ];
  io.write(`${renderTable(
    set.title,
    columns,
    candidates.map((candidate, index) => [String(index + 1), ...candidate.cells]),
    io.width
  )}\n`);

  while (true) {
    const answer = (await io.question(
      `Choose ${set.entityLabel}${defaultCandidate === undefined ? " [skip]" : ` [${defaultCandidate.value}]`} (or skip): `
    ))?.trim();
    if (answer === undefined || answer.length === 0 && defaultCandidate === undefined || answer === "skip" || answer === "q") {
      return undefined;
    }
    if (answer.length === 0) {
      return defaultCandidate;
    }
    const selected = /^\d+$/.test(answer)
      ? candidates[Number.parseInt(answer, 10) - 1]
      : candidates.find((candidate) => candidate.value === answer);
    if (selected !== undefined) {
      return selected;
    }
    io.write(`Unknown ${set.entityLabel}: ${answer}. Choose a listed number or exact value.\n`);
  }
}
