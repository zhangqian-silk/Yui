import { findChild, ROOT_COMMAND, visibleChildren, type CommandNode } from "./commandCatalog.js";
import { getSelectionCandidates } from "./interactionCandidates.js";
import { findInteractionPolicy, type ArgumentSelector } from "./interactionPolicy.js";
import type { SelectionPorts } from "./selectionPorts.js";

export type DynamicCompletionInput = Readonly<{
  words: readonly string[];
  current: string;
  ports: SelectionPorts;
}>;

export async function resolveCompletionCandidates(
  input: DynamicCompletionInput
): Promise<string[]> {
  const words = input.words[0] === "yui" || input.words[0] === "yui-dev"
    ? input.words.slice(1)
    : [...input.words];
  const { node, consumed } = resolveCommand(words);
  if (consumed === words.length && node.children.length > 0) {
    return prefix(visibleChildren(node).map((child) => child.name), input.current);
  }

  const previous = words.at(-1);
  if (previous !== undefined && Object.hasOwn(node.optionValues, previous)) {
    return prefix(node.optionValues[previous] ?? [], input.current);
  }
  if (input.current.startsWith("-")) {
    return prefix(node.options, input.current);
  }

  const argumentPosition = words.length;
  const policy = findInteractionPolicy(node);
  const selector = policy?.selectors.find((candidate) => selectorApplies(
    candidate,
    previous,
    argumentPosition
  ));
  if (selector !== undefined) {
    const set = await getSelectionCandidates(selector, input.ports, words);
    return prefix(set?.candidates.map((candidate) => candidate.value) ?? [], input.current);
  }

  const relative = argumentPosition - (node.path.length - 1);
  return prefix(node.argumentValues[relative] ?? [], input.current);
}

function selectorApplies(
  selector: ArgumentSelector,
  previous: string | undefined,
  argumentPosition: number
): boolean {
  if (selector.option !== undefined) return selector.option === previous;
  return selector.argumentIndex === argumentPosition;
}

function resolveCommand(words: readonly string[]): { node: CommandNode; consumed: number } {
  let node = ROOT_COMMAND;
  let consumed = 0;
  while (consumed < words.length && node.kind !== "leaf") {
    const child = findChild(node, words[consumed] ?? "");
    if (child === undefined) break;
    node = child;
    consumed += 1;
  }
  return { node, consumed };
}

function prefix(values: readonly string[], current: string): string[] {
  return [...new Set(values)].filter((value) => value.startsWith(current));
}
