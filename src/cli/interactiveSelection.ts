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
  if (!io.interactive || !allowsInteractiveSelection(args, io.json)) {
    return { kind: "unchanged", args: resolved };
  }

  let changed = false;
  let selectedActionTarget = false;
  if (catalogEnumsCanResolve(resolved, node, policy)) {
    const enumResolution = await resolveCatalogEnums(resolved, node, io);
    if (enumResolution === "cancelled") {
      return { kind: "cancelled", args: resolved };
    }
    changed ||= enumResolution === "resolved";
  }

  if (policy !== undefined && interactionPolicyIsReady(resolved, policy)) {
    const selectableOptions = new Set(policy.selectors.flatMap((selector) => selector.option === undefined ? [] : [selector.option]));
    for (const selector of policy.selectors) {
      if (selector.unlessOption !== undefined && resolved.includes(selector.unlessOption)) {
        continue;
      }
      const missingSlot = missingSelectorSlot(resolved, selector, policy.trailingOptions, selectableOptions);
      if (missingSlot === null) {
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
      if (missingSlot.kind === "argument") {
        resolved.splice(missingSlot.index, 0, selected.value);
      } else if (missingSlot.optionPresent) {
        resolved.splice(missingSlot.index + 1, 0, selected.value);
      } else {
        resolved.push(missingSlot.option, selected.value);
      }
      changed = true;
      selectedActionTarget ||= selector.actionTarget;
    }
  }

  if (selectedActionTarget && policy?.confirmation !== undefined) {
    const target = resolved[policy.confirmation.targetArgumentIndex] ?? "";
    const answer = (await io.question(`${policy.confirmation.action} ${target}? [y/N]: `))?.trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      return { kind: "cancelled", args: resolved };
    }
  }

  return changed ? { kind: "resolved", args: resolved } : { kind: "unchanged", args: resolved };
}

function catalogEnumsCanResolve(
  args: readonly string[],
  node: CommandNode,
  policy: InteractionPolicy | undefined
): boolean {
  if (policy !== undefined) {
    const selectableOptions = new Set([
      ...Object.keys(node.optionValues),
      ...policy.selectors.flatMap((selector) => selector.option === undefined ? [] : [selector.option])
    ]);
    if (!trailingOptionsAreReady(args, policy, selectableOptions)) {
      return false;
    }
    if (!suppressedSelectorArgumentsAreReady(args, policy)) {
      return false;
    }
    if (!optionPrerequisitesAreReady(args, policy)) {
      return false;
    }
    const requiredArgumentsReady = policy.requiredArguments?.every((index) => {
      const value = args[index];
      return value !== undefined && !value.startsWith("--");
    }) ?? true;
    const requiredOptionsReady = policy.requiredOptions?.every((option) => {
      const index = args.indexOf(option);
      const value = index < 0 ? undefined : args[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        return true;
      }
      return Object.hasOwn(node.optionValues, option) && index >= 0;
    }) ?? true;
    const anyOptionsReady = policy.requiredAnyOptions === undefined
      || policy.requiredAnyOptions.some((option) => args.includes(option));
    return requiredArgumentsReady && requiredOptionsReady && anyOptionsReady;
  }

  const usage = node.usage[0] ?? "";
  const requiredTail = usage.replaceAll(/\[[^\]]*\]/g, "").trim().split(/\s+/).slice(node.path.length);
  let position = 0;
  for (const token of requiredTail) {
    if (!token.startsWith("<") || !token.endsWith(">")) {
      continue;
    }
    const argumentIndex = node.path.length - 1 + position;
    const value = args[argumentIndex];
    if ((value === undefined || value.startsWith("--")) && !Object.hasOwn(node.argumentValues, position)) {
      return false;
    }
    position += 1;
  }
  return true;
}

function interactionPolicyIsReady(args: readonly string[], policy: InteractionPolicy): boolean {
  const selectableOptions = new Set(
    policy.selectors.flatMap((selector) => selector.option === undefined ? [] : [selector.option])
  );
  if (!trailingOptionsAreReady(args, policy, selectableOptions)) {
    return false;
  }
  if (!suppressedSelectorArgumentsAreReady(args, policy)) {
    return false;
  }
  if (!optionPrerequisitesAreReady(args, policy)) {
    return false;
  }
  const requiredArgumentsReady = policy.requiredArguments?.every((index) => {
    const value = args[index];
    return value !== undefined && !value.startsWith("--");
  }) ?? true;
  const requiredOptionsReady = policy.requiredOptions?.every((option) => {
    const index = args.indexOf(option);
    const value = index < 0 ? undefined : args[index + 1];
    return value !== undefined && !value.startsWith("--");
  }) ?? true;
  const anyOptionsReady = policy.requiredAnyOptions === undefined
    || policy.requiredAnyOptions.some((option) => args.includes(option));
  return requiredArgumentsReady && requiredOptionsReady && anyOptionsReady;
}

function trailingOptionsAreReady(
  args: readonly string[],
  policy: InteractionPolicy,
  selectableOptions: ReadonlySet<string>
): boolean {
  for (let index = policy.commandPath.length; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (!value.startsWith("--")) {
      continue;
    }
    const optionKind = policy.trailingOptions?.[value];
    if (optionKind === undefined) {
      return false;
    }
    if (optionKind === "flag") {
      continue;
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      if (!selectableOptions.has(value)) {
        return false;
      }
      continue;
    }
    index += 1;
  }
  return true;
}

function optionPrerequisitesAreReady(
  args: readonly string[],
  policy: InteractionPolicy
): boolean {
  return (policy.optionPrerequisites ?? []).every((prerequisite) => {
    const optionIndex = args.indexOf(prerequisite.option);
    const optionValue = optionIndex < 0 ? undefined : args[optionIndex + 1];
    if (optionIndex < 0) {
      return true;
    }
    const applies = optionValue === undefined || optionValue.startsWith("--")
      ? prerequisite.requireWhenSelecting
      : prerequisite.values.includes(optionValue);
    if (!applies) {
      return true;
    }
    return prerequisite.requiredOptions.every((requiredOption) => {
      const requiredIndex = args.indexOf(requiredOption);
      const requiredValue = requiredIndex < 0 ? undefined : args[requiredIndex + 1];
      return requiredValue !== undefined && !requiredValue.startsWith("--");
    });
  });
}

function suppressedSelectorArgumentsAreReady(
  args: readonly string[],
  policy: InteractionPolicy
): boolean {
  return policy.selectors.every((selector) =>
    selector.argumentIndex === undefined
    || selector.unlessOption === undefined
    || !args.includes(selector.unlessOption)
    || positionalArgumentIsPresent(args, policy, selector.argumentIndex)
  );
}

function positionalArgumentIsPresent(
  args: readonly string[],
  policy: InteractionPolicy,
  argumentIndex: number
): boolean {
  const targetPosition = argumentIndex - policy.commandPath.length;
  let position = 0;

  for (let index = policy.commandPath.length; index < args.length; index += 1) {
    const value = args[index] ?? "";
    const optionKind = policy.trailingOptions?.[value];
    if (optionKind !== undefined) {
      if (optionKind === "value" && args[index + 1] !== undefined && !args[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }
    if (value.startsWith("--")) {
      return false;
    }
    if (position === targetPosition) {
      return true;
    }
    position += 1;
  }

  return false;
}

function missingSelectorSlot(
  args: readonly string[],
  selector: import("./interactionPolicy.js").ArgumentSelector,
  trailingOptions: InteractionPolicy["trailingOptions"],
  selectableOptions: ReadonlySet<string>
): { kind: "argument"; index: number } | { kind: "option"; option: string; index: number; optionPresent: boolean } | null {
  if (selector.argumentIndex !== undefined) {
    return selectorSlotIsMissing(args, selector.argumentIndex, trailingOptions, selectableOptions)
      ? { kind: "argument", index: selector.argumentIndex }
      : null;
  }

  const option = selector.option;
  if (option === undefined) {
    return null;
  }
  const occurrences = args.flatMap((value, index) => value === option ? [index] : []);
  if (occurrences.length === 0) {
    return selector.requiredOption === true ? { kind: "option", option, index: args.length, optionPresent: false } : null;
  }
  if (occurrences.length !== 1) {
    return null;
  }
  const index = occurrences[0];
  const value = args[index + 1];
  return value === undefined || value.startsWith("--")
    ? { kind: "option", option, index, optionPresent: true }
    : null;
}

async function resolveCatalogEnums(
  args: string[],
  node: CommandNode,
  io: SelectionIo
): Promise<"unchanged" | "resolved" | "cancelled"> {
  let changed = false;

  for (const [positionText, values] of Object.entries(node.argumentValues)) {
    const argumentIndex = node.path.length - 1 + Number.parseInt(positionText, 10);
    if (args[argumentIndex] !== undefined) {
      continue;
    }
    const selected = await selectCandidate(enumCandidateSet(`argument ${Number.parseInt(positionText, 10) + 1}`, values), io);
    if (selected === undefined) {
      return "cancelled";
    }
    args.splice(argumentIndex, 0, selected.value);
    changed = true;
  }

  for (const [option, values] of Object.entries(node.optionValues)) {
    const missingOccurrences = args.flatMap((value, index) => {
      if (value !== option) {
        return [];
      }
      const optionValue = args[index + 1];
      return optionValue === undefined || optionValue.startsWith("--") ? [index] : [];
    });
    if (missingOccurrences.length !== 1) {
      continue;
    }
    const selected = await selectCandidate(enumCandidateSet(option.slice(2), values), io);
    if (selected === undefined) {
      return "cancelled";
    }
    args.splice(missingOccurrences[0] + 1, 0, selected.value);
    changed = true;
  }

  return changed ? "resolved" : "unchanged";
}

function enumCandidateSet(label: string, values: readonly string[]): CandidateSet {
  return {
    entityLabel: label,
    title: `Select ${label}`,
    columns: [{ header: "Value", minWidth: 5, maxWidth: 40 }],
    candidates: values.map((value) => ({ value, cells: [value] })),
    emptyMessage: `No values are available for ${label}.`,
    overflowHint: ""
  };
}

function selectorSlotIsMissing(
  args: readonly string[],
  argumentIndex: number,
  trailingOptions: InteractionPolicy["trailingOptions"],
  selectableOptions: ReadonlySet<string> = new Set()
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
        if (selectableOptions.has(option)) {
          continue;
        }
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
  const pageSize = 20;
  const contextualDefault = candidates.find((candidate) => candidate.value === set.defaultValue);
  let filter = "";
  let visible = candidates;
  let pageIndex = contextualDefault === undefined ? 0 : Math.floor(candidates.indexOf(contextualDefault) / pageSize);
  const columns = [
    { header: "#", minWidth: 1, maxWidth: 3 },
    ...set.columns
  ];

  while (true) {
    const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
    pageIndex = Math.min(pageIndex, pageCount - 1);
    const pageStart = pageIndex * pageSize;
    const page = visible.slice(pageStart, pageStart + pageSize);
    const defaultCandidate = visible.find((candidate) => candidate.value === set.defaultValue)
      ?? (visible.length === 1 ? visible[0] : undefined);
    const rangeStart = visible.length === 0 ? 0 : pageStart + 1;
    const rangeEnd = pageStart + page.length;
    const plural = `${set.entityLabel[0]?.toUpperCase() ?? ""}${set.entityLabel.slice(1)}s`;
    io.write(`${plural} — ${rangeStart}-${rangeEnd} of ${visible.length}${filter.length > 0 ? ` (filtered from ${candidates.length})` : ""}\n`);
    if (defaultCandidate !== undefined) {
      io.write(`Default: ${defaultCandidate.value}\n`);
    }
    io.write(`${renderTable(
      set.title,
      columns,
      page.map((candidate, index) => [String(index + 1), ...candidate.cells]),
      io.width
    )}\n`);

    const answer = (await io.question(
      `Choose ${set.entityLabel}${defaultCandidate === undefined ? " [skip]" : ` [${defaultCandidate.value}]`} (n/p, /filter, or skip): `
    ))?.trim();
    if (answer === undefined || answer.length === 0 && defaultCandidate === undefined || answer === "skip" || answer === "q") {
      return undefined;
    }
    if (answer.length === 0) {
      return defaultCandidate;
    }
    if (answer === "n") {
      if (pageIndex + 1 < pageCount) {
        pageIndex += 1;
      } else {
        io.write("Already on the last page.\n");
      }
      continue;
    }
    if (answer === "p") {
      if (pageIndex > 0) {
        pageIndex -= 1;
      } else {
        io.write("Already on the first page.\n");
      }
      continue;
    }
    if (answer.startsWith("/")) {
      filter = answer.slice(1).toLocaleLowerCase();
      visible = filter.length === 0
        ? candidates
        : candidates.filter((candidate) =>
          [candidate.value, ...candidate.cells].some((value) => value.toLocaleLowerCase().includes(filter))
        );
      pageIndex = 0;
      if (visible.length === 0) {
        io.write(`No ${set.entityLabel}s match /${answer.slice(1)}. Use / to clear the filter.\n`);
      }
      continue;
    }
    const selected = /^\d+$/.test(answer)
      ? page[Number.parseInt(answer, 10) - 1]
      : visible.find((candidate) => candidate.value === answer);
    if (selected !== undefined) {
      return selected;
    }
    io.write(`Unknown ${set.entityLabel}: ${answer}. Choose a listed number or exact value.\n`);
  }
}
