import { renderTable } from "../output/table.js";
import type { CommandNode } from "./commandCatalog.js";
import {
  getSelectionCandidates,
  type CandidateSet,
  type SelectionCandidate
} from "./interactionCandidates.js";
import {
  findInteractionPolicy,
  type ArgumentSelector,
  type InteractionPolicy
} from "./interactionPolicy.js";
import type { SelectionPorts } from "./selectionPorts.js";

export type SelectionIo = Readonly<{
  interactive: boolean;
  json: boolean;
  width: number;
  write(value: string): void;
  question(prompt: string): Promise<string | undefined>;
}>;

export type ArgumentResolution =
  | Readonly<{ kind: "unchanged"; args: string[] }>
  | Readonly<{ kind: "resolved"; args: string[] }>
  | Readonly<{ kind: "cancelled"; args: string[] }>;

export async function resolveInteractiveArguments(
  args: readonly string[],
  node: CommandNode,
  ports: SelectionPorts,
  io: SelectionIo
): Promise<ArgumentResolution> {
  const resolved = [...args];
  if (!io.interactive || !allowsInteractiveSelection(args, io.json)) {
    return { kind: "unchanged", args: resolved };
  }
  const policy = findInteractionPolicy(node);
  if (hasUnknownOption(resolved, node) || !interactionPrerequisitesReady(resolved, node, policy)) {
    return { kind: "unchanged", args: resolved };
  }

  let changed = false;
  let selectedActionTarget = false;
  if (policy !== undefined) {
    for (const selector of policy.selectors) {
      const slot = missingSlot(resolved, selector, node);
      if (slot === undefined) continue;
      const candidates = await getSelectionCandidates(selector, ports, resolved);
      if (candidates === null) continue;
      const selected = await selectCandidate(candidates, io);
      if (selected === undefined) return { kind: "cancelled", args: resolved };
      if (slot.kind === "argument") {
        resolved.splice(slot.index, 0, selected.value);
      } else if (slot.optionPresent) {
        resolved.splice(slot.index + 1, 0, selected.value);
      } else {
        resolved.push(slot.option, selected.value);
      }
      changed = true;
      selectedActionTarget ||= selector.actionTarget;
    }
  }

  const enumResult = await resolveCatalogEnums(resolved, node, io);
  if (enumResult === "cancelled") return { kind: "cancelled", args: resolved };
  changed ||= enumResult === "resolved";

  if (selectedActionTarget && policy?.confirmation !== undefined) {
    const target = resolved[policy.confirmation.targetArgumentIndex] ?? "";
    const answer = (await io.question(
      `${policy.confirmation.action} ${target}? [y/N]: `
    ))?.trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      return { kind: "cancelled", args: resolved };
    }
  }
  return changed
    ? { kind: "resolved", args: resolved }
    : { kind: "unchanged", args: resolved };
}

export function allowsInteractiveSelection(
  args: readonly string[],
  globalJson: boolean
): boolean {
  return !globalJson && !args.includes("--json")
    && !(args[0] === "config" && args[1] === "completion" && args[2] === "candidates");
}

type MissingSlot =
  | Readonly<{ kind: "argument"; index: number }>
  | Readonly<{ kind: "option"; option: string; index: number; optionPresent: boolean }>;

function missingSlot(
  args: readonly string[],
  selector: ArgumentSelector,
  node: CommandNode
): MissingSlot | undefined {
  if (selector.argumentIndex !== undefined) {
    const value = args[selector.argumentIndex];
    return value === undefined || value.startsWith("--")
      ? { kind: "argument", index: selector.argumentIndex }
      : undefined;
  }
  const option = selector.option;
  if (option === undefined) return undefined;
  const index = args.indexOf(option);
  if (index < 0) {
    return selector.requiredOption === true
      ? { kind: "option", option, index: args.length, optionPresent: false }
      : undefined;
  }
  const value = args[index + 1];
  if (value !== undefined && !value.startsWith("--")) return undefined;
  if (!node.options.includes(option)) return undefined;
  return { kind: "option", option, index, optionPresent: true };
}

function hasUnknownOption(args: readonly string[], node: CommandNode): boolean {
  const known = new Set([...node.options, "--json"]);
  return args.some((argument) => argument.startsWith("-") && !known.has(argument));
}

function interactionPrerequisitesReady(
  args: readonly string[],
  node: CommandNode,
  policy: InteractionPolicy | undefined
): boolean {
  const usage = node.usage[0] ?? "";
  const required = usage.replaceAll(/\[[^\]]*\]/g, "").trim().split(/\s+/);
  const tail = required.slice(node.path.length);
  let position = 0;
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index] ?? "";
    if (token.startsWith("--")) {
      const optionIndex = args.indexOf(token);
      const next = tail[index + 1];
      const selectable = policy?.selectors.some((selector) => selector.option === token) === true
        || Object.hasOwn(node.optionValues, token);
      if (optionIndex < 0 && !selectable) return false;
      if (next?.startsWith("<") === true) {
        const value = args[optionIndex + 1];
        if ((value === undefined || value.startsWith("--")) && !selectable) return false;
        index += 1;
      }
      continue;
    }
    if (!token.startsWith("<") || !token.endsWith(">")) continue;
    const absoluteIndex = node.path.length - 1 + position;
    const value = args[absoluteIndex];
    const selectable = policy?.selectors.some((selector) => selector.argumentIndex === absoluteIndex) === true
      || Object.hasOwn(node.argumentValues, position);
    if ((value === undefined || value.startsWith("--")) && !selectable) return false;
    position += 1;
  }

  for (const option of node.options) {
    const optionIndex = args.indexOf(option);
    if (optionIndex < 0) continue;
    if (policy?.trailingOptions?.[option] === "flag") continue;
    const value = args[optionIndex + 1];
    const selectable = policy?.selectors.some((selector) => selector.option === option) === true
      || Object.hasOwn(node.optionValues, option);
    if ((value === undefined || value.startsWith("--")) && !selectable) return false;
  }
  return true;
}

async function resolveCatalogEnums(
  args: string[],
  node: CommandNode,
  io: SelectionIo
): Promise<"unchanged" | "resolved" | "cancelled"> {
  let changed = false;
  const argumentBase = node.path.length - 1;
  for (const [relativeText, choices] of Object.entries(node.argumentValues)) {
    const index = argumentBase + Number(relativeText);
    const value = args[index];
    if (value !== undefined && !value.startsWith("--")) continue;
    const selected = await selectValues(`Select value`, choices, io);
    if (selected === undefined) return "cancelled";
    args.splice(index, 0, selected);
    changed = true;
  }
  for (const [option, choices] of Object.entries(node.optionValues)) {
    const index = args.indexOf(option);
    if (index < 0) continue;
    const value = args[index + 1];
    if (value !== undefined && !value.startsWith("--")) continue;
    const selected = await selectValues(`Select ${option.slice(2)}`, choices, io);
    if (selected === undefined) return "cancelled";
    args.splice(index + 1, 0, selected);
    changed = true;
  }
  return changed ? "resolved" : "unchanged";
}

async function selectValues(
  title: string,
  values: readonly string[],
  io: SelectionIo
): Promise<string | undefined> {
  return (await selectCandidate({
    entityLabel: "value",
    title,
    columns: [{ header: "Value", minWidth: 5, maxWidth: 32 }],
    candidates: values.map((value) => ({ value, cells: [value] })),
    emptyMessage: "No values are available.",
    overflowHint: "Pass the value explicitly."
  }, io))?.value;
}

async function selectCandidate(
  set: CandidateSet,
  io: SelectionIo
): Promise<SelectionCandidate | undefined> {
  if (set.candidates.length === 0) {
    io.write(`○ ${set.emptyMessage}\n`);
    return undefined;
  }
  io.write(`${renderTable(
    set.title,
    [{ header: "#", minWidth: 1, maxWidth: 4 }, ...set.columns],
    set.candidates.map((candidate, index) => [String(index + 1), ...candidate.cells]),
    io.width
  )}\n\n`);
  const answer = (await io.question(
    `Choose ${set.entityLabel} [1-${set.candidates.length}/value, q]: `
  ))?.trim();
  if (answer === undefined || answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
    return undefined;
  }
  if (answer.length === 0) {
    return set.candidates.find((candidate) => candidate.value === set.defaultValue)
      ?? set.candidates[0];
  }
  const numeric = Number(answer);
  if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= set.candidates.length) {
    return set.candidates[numeric - 1];
  }
  return set.candidates.find((candidate) => candidate.value === answer);
}
