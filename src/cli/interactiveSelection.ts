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

type ParsedOptionOccurrence = {
  index: number;
  value?: string;
  valueIndex?: number;
};

type ParsedInteractionArguments = {
  valid: boolean;
  positionals: { index: number; value: string }[];
  options: Map<string, ParsedOptionOccurrence[]>;
};

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
      if (selector.unlessOption !== undefined && hasStructuralOption(resolved, policy, selector.unlessOption)) {
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
    const parsed = parseInteractionArguments(args, policy);
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
    const requiredArgumentsReady = policy.requiredArguments?.every((index) =>
      positionalAt(parsed, policy, index) !== undefined
    ) ?? true;
    const requiredOptionsReady = policy.requiredOptions?.every((option) => {
      const occurrence = parsed.options.get(option)?.[0];
      if (occurrence?.value !== undefined) {
        return true;
      }
      return Object.hasOwn(node.optionValues, option) && occurrence !== undefined;
    }) ?? true;
    const anyOptionsReady = policy.requiredAnyOptions === undefined
      || policy.requiredAnyOptions.some((option) => parsed.options.has(option));
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
  const parsed = parseInteractionArguments(args, policy);
  const requiredArgumentsReady = policy.requiredArguments?.every((index) =>
    positionalAt(parsed, policy, index) !== undefined
  ) ?? true;
  const requiredOptionsReady = policy.requiredOptions?.every((option) => {
    return parsed.options.get(option)?.some((occurrence) => occurrence.value !== undefined) === true;
  }) ?? true;
  const anyOptionsReady = policy.requiredAnyOptions === undefined
    || policy.requiredAnyOptions.some((option) => parsed.options.has(option));
  return requiredArgumentsReady && requiredOptionsReady && anyOptionsReady;
}

function trailingOptionsAreReady(
  args: readonly string[],
  policy: InteractionPolicy,
  selectableOptions: ReadonlySet<string>
): boolean {
  const parsed = parseInteractionArguments(args, policy);
  return parsed.valid && [...parsed.options].every(([option, occurrences]) =>
    occurrences.every((occurrence) => optionOccurrenceIsComplete(
      option,
      occurrence,
      policy.trailingOptions,
      selectableOptions
    ))
  );
}

function optionPrerequisitesAreReady(
  args: readonly string[],
  policy: InteractionPolicy
): boolean {
  const parsed = parseInteractionArguments(args, policy);
  return (policy.optionPrerequisites ?? []).every((prerequisite) => {
    const occurrence = parsed.options.get(prerequisite.option)?.[0];
    if (occurrence === undefined) {
      return true;
    }
    const applies = occurrence.value === undefined
      ? prerequisite.requireWhenSelecting
      : prerequisite.values.includes(occurrence.value);
    if (!applies) {
      return true;
    }
    return prerequisite.requiredOptions.every((requiredOption) => {
      return parsed.options.get(requiredOption)?.some((candidate) => candidate.value !== undefined) === true;
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
    || !hasStructuralOption(args, policy, selector.unlessOption)
    || positionalArgumentIsPresent(args, policy, selector.argumentIndex)
  );
}

function positionalArgumentIsPresent(
  args: readonly string[],
  policy: InteractionPolicy,
  argumentIndex: number
): boolean {
  return positionalAt(parseInteractionArguments(args, policy), policy, argumentIndex) !== undefined;
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
  const occurrences = parseInteractionArguments(args, {
    commandPath: [], trailingOptions
  }).options.get(option)?.map(({ index }) => index) ?? [];
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
    const parsed = policyForNode(node);
    const missingOccurrences = parseInteractionArguments(args, parsed).options.get(option)
      ?.filter((occurrence) => occurrence.value === undefined)
      .map((occurrence) => occurrence.index) ?? [];
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
  const policy = { commandPath: args.slice(0, argumentIndex), selectors: [], trailingOptions };
  const parsed = parseInteractionArguments(args, policy);
  return parsed.valid && parsed.positionals.length === 0 &&
    [...parsed.options].every(([option, occurrences]) =>
      occurrences.every((occurrence) => optionOccurrenceIsComplete(
        option,
        occurrence,
        trailingOptions,
        selectableOptions
      ))
    );
}

function optionOccurrenceIsComplete(
  option: string,
  occurrence: ParsedOptionOccurrence,
  trailingOptions: InteractionPolicy["trailingOptions"],
  selectableOptions: ReadonlySet<string>
): boolean {
  return trailingOptions?.[option] === "flag" ||
    occurrence.value !== undefined ||
    selectableOptions.has(option);
}

function policyForNode(node: CommandNode): InteractionPolicy {
  return findInteractionPolicy(node) ?? {
    commandPath: node.path.slice(1),
    selectors: [],
    trailingOptions: Object.fromEntries([
      ...node.options,
      ...node.hiddenOptions
    ].map((option) => [option, Object.hasOwn(node.optionValues, option) ? "value" : "flag"]))
  };
}

function hasStructuralOption(args: readonly string[], policy: InteractionPolicy, option: string): boolean {
  return parseInteractionArguments(args, policy).options.has(option);
}

function positionalAt(
  parsed: ParsedInteractionArguments,
  policy: InteractionPolicy,
  absoluteIndex: number
): string | undefined {
  return parsed.positionals[absoluteIndex - policy.commandPath.length]?.value;
}

function parseInteractionArguments(
  args: readonly string[],
  policy: Pick<InteractionPolicy, "commandPath" | "trailingOptions">
): ParsedInteractionArguments {
  const positionals: { index: number; value: string }[] = [];
  const options = new Map<string, ParsedOptionOccurrence[]>();
  let valid = true;
  for (let index = policy.commandPath.length; index < args.length; index += 1) {
    const token = args[index] ?? "";
    const arity = policy.trailingOptions?.[token];
    if (arity === undefined) {
      if (token.startsWith("--")) valid = false;
      else positionals.push({ index, value: token });
      continue;
    }
    const occurrence: ParsedOptionOccurrence = { index };
    if (arity !== "flag") {
      const candidate = args[index + 1];
      if (candidate !== undefined && (arity === "option-like-value" || !candidate.startsWith("--"))) {
        occurrence.value = candidate;
        occurrence.valueIndex = index + 1;
        index += 1;
      }
    }
    const current = options.get(token) ?? [];
    current.push(occurrence);
    options.set(token, current);
  }
  return { valid, positionals, options };
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
