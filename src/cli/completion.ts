import {
  ROOT_COMMAND,
  listPublicCommandPaths,
  orderedImmediateTokens,
  visibleChildren,
  type CommandNode
} from "./commandCatalog.js";
import { findInteractionPolicy } from "./interactionPolicy.js";

export type CliIdentity = "yui" | "yui-dev";

type Entry = Readonly<{
  path: string;
  immediate: readonly string[];
  options: readonly string[];
  dynamicArguments: readonly number[];
  dynamicOptions: readonly string[];
}>;

export function renderCompletion(
  shell: string | undefined,
  identity: CliIdentity = "yui"
): string {
  const entries = collectEntries(ROOT_COMMAND);
  switch (shell) {
    case "bash": return renderBash(entries, identity);
    case "zsh": return renderZsh(entries, identity);
    case "fish": return renderFish(entries, identity);
    default: throw new Error("Completion shell must be one of bash, zsh, fish.");
  }
}

function collectEntries(root: CommandNode): Entry[] {
  const entries: Entry[] = [];
  const visit = (node: CommandNode): void => {
    if (!node.hidden && !node.commandPathArguments) {
      const policy = findInteractionPolicy(node);
      entries.push({
        path: node.path.slice(1).join(" "),
        immediate: orderedImmediateTokens(node),
        options: node.options,
        dynamicArguments: policy?.selectors.flatMap((selector) =>
          selector.argumentIndex === undefined ? [] : [selector.argumentIndex]) ?? [],
        dynamicOptions: policy?.selectors.flatMap((selector) =>
          selector.option === undefined ? [] : [selector.option]) ?? []
      });
    }
    visibleChildren(node).forEach(visit);
  };
  visit(root);
  return entries;
}

function manifest(prefix: string): string {
  return listPublicCommandPaths().map((path) => `${prefix} ${path}`).join("\n");
}

function renderBash(entries: readonly Entry[], identity: CliIdentity): string {
  const functionName = identity === "yui" ? "_yui" : "_yui_dev";
  return `${manifest("# yui command:")}
${functionName}() {
  local current path previous dynamic_candidate dynamic=false
  local -a candidates dynamic_candidates
  current="\${COMP_WORDS[COMP_CWORD]}"
  path=""
  if (( COMP_CWORD > 1 )); then
    path="\${COMP_WORDS[*]:1:COMP_CWORD-1}"
  fi
  previous="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ "$current" != -* ]]; then
    case "$COMP_CWORD:$path" in
${bashDynamicArgumentCases(entries)}
    esac
  fi
  if [[ "$dynamic" == false ]]; then
    case "$previous:$path" in
${bashDynamicOptionCases(entries)}
    esac
  fi
  if [[ "$dynamic" == true ]]; then
    while IFS= read -r dynamic_candidate; do
      [[ -n "$dynamic_candidate" ]] && dynamic_candidates+=("$dynamic_candidate")
    done < <(command ${identity} completion candidates "$current" -- "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)
    candidates=("\${dynamic_candidates[@]}")
  elif [[ "$current" == -* ]]; then
    case "$path" in
${bashStaticOptionCases(entries)}
      *) candidates=();;
    esac
  else
    case "$path" in
${entries.map((entry) => `      ${bashPattern(entry.path)}) candidates=(${[...entry.immediate, ...entry.options].map(shellQuote).join(" ")});;`).join("\n")}
      *) candidates=();;
    esac
  fi
  COMPREPLY=( $(compgen -W "\${candidates[*]}" -- "$current") )
}
complete -F ${functionName} ${identity}
`;
}

function renderZsh(entries: readonly Entry[], identity: CliIdentity): string {
  return `#compdef ${identity}
${manifest("# yui command:")}
local current command_path previous dynamic_output dynamic=false
local -a candidates
current="$words[CURRENT]"
command_path=""
if (( CURRENT > 2 )); then
  command_path="\${(j: :)words[2,CURRENT-1]}"
fi
previous="$words[CURRENT-1]"
if [[ "$current" != -* ]]; then
  case "$CURRENT:$command_path" in
${zshDynamicArgumentCases(entries)}
  esac
fi
if [[ "$dynamic" == false ]]; then
  case "$previous:$command_path" in
${zshDynamicOptionCases(entries)}
  esac
fi
if [[ "$dynamic" == true ]]; then
  dynamic_output="$(command ${identity} completion candidates "$current" -- "\${(@)words[2,CURRENT-1]}" 2>/dev/null)"
  candidates=("\${(@f)dynamic_output}")
elif [[ "$current" == -* ]]; then
  case "$command_path" in
${zshStaticOptionCases(entries)}
    *) candidates=();;
  esac
else
  case "$command_path" in
${entries.map((entry) => `    ${zshPattern(entry.path)}) candidates=(${[...entry.immediate, ...entry.options].map(shellQuote).join(" ")});;`).join("\n")}
    *) candidates=();;
  esac
fi
(( \${#candidates[@]} > 0 )) && compadd -- "$candidates[@]"
`;
}

function renderFish(entries: readonly Entry[], identity: CliIdentity): string {
  const prefix = `__${identity.replaceAll("-", "_")}`;
  const lines = [
    manifest("# yui command:"),
    `function ${prefix}_at_path`,
    "  set -l actual (commandline -opc)",
    "  set -e actual[1]",
    "  test (count $actual) -eq (count $argv); or return 1",
    "  for index in (seq (count $argv))",
    "    test \"$actual[$index]\" = \"$argv[$index]\"; or return 1",
    "  end",
    "end",
    `function ${prefix}_at_command_options`,
    "  string match -q -- '-*' (commandline -ct); or return 1",
    "  set -l actual (commandline -opc)",
    "  set -e actual[1]",
    "  test (count $actual) -ge (count $argv); or return 1",
    "  for index in (seq (count $argv))",
    "    test \"$actual[$index]\" = \"$argv[$index]\"; or return 1",
    "  end",
    "end",
    `function ${prefix}_needs_dynamic`,
    "  set -l mode $argv[1]",
    "  set -l expected $argv[2]",
    "  set -l expected_path $argv[3..-1]",
    "  set -l actual (commandline -opc)",
    "  set -e actual[1]",
    "  test (count $actual) -ge (count $expected_path); or return 1",
    "  for index in (seq (count $expected_path))",
    "    test \"$actual[$index]\" = \"$expected_path[$index]\"; or return 1",
    "  end",
    "  if test \"$mode\" = argument",
    "    string match -q -- '-*' (commandline -ct); and return 1",
    "    test (count $actual) -eq \"$expected\"",
    "  else",
    "    test \"$actual[-1]\" = \"$expected\"",
    "  end",
    "end",
    `function ${prefix}_dynamic`,
    "  set -l words (commandline -opc)",
    `  ${identity} completion candidates (commandline -ct) -- $words[2..-1] 2>/dev/null`,
    "end"
  ];
  for (const entry of entries) {
    for (const argument of entry.dynamicArguments) {
      const condition = `${prefix}_needs_dynamic argument ${argument} ${fishPath(entry.path)}`;
      lines.push(
        `complete -c ${identity} -f -n ${fishQuote(condition)} -a '(${prefix}_dynamic)'`
      );
    }
    for (const option of entry.dynamicOptions) {
      const condition = `${prefix}_needs_dynamic option ${option} ${fishPath(entry.path)}`;
      lines.push(
        `complete -c ${identity} -f -n ${fishQuote(condition)} -a '(${prefix}_dynamic)'`
      );
    }
  }
  for (const entry of entries) {
    if (entry.immediate.length > 0) {
      const condition = entry.path.length === 0
        ? "__fish_use_subcommand"
        : `${prefix}_at_path ${fishPath(entry.path)}${fishInitialDynamicExclusion(entry, prefix)}`;
      lines.push(
        `complete -c ${identity} -f -n ${fishQuote(condition)} -a '${escapeSingle(entry.immediate.join(" "))}'`
      );
    }
    if (entry.options.length > 0) {
      const path = fishPath(entry.path);
      const exact = `${prefix}_at_path ${path}${fishInitialDynamicExclusion(entry, prefix)}`;
      const condition = `begin; ${exact}; end; or ${prefix}_at_command_options ${path}`;
      lines.push(
        `complete -c ${identity} -f -n ${fishQuote(condition)} -a '${escapeSingle(entry.options.join(" "))}'`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function bashDynamicArgumentCases(entries: readonly Entry[]): string {
  return entries.flatMap((entry) => entry.dynamicArguments.map((argument) =>
    `    ${dynamicArgumentPattern(argument + 1, entry.path)}) dynamic=true;;`
  )).join("\n");
}

function zshDynamicArgumentCases(entries: readonly Entry[]): string {
  return entries.flatMap((entry) => entry.dynamicArguments.map((argument) =>
    `  ${dynamicArgumentPattern(argument + 2, entry.path)}) dynamic=true;;`
  )).join("\n");
}

function dynamicArgumentPattern(position: number, path: string): string {
  return `${position}:${shellQuote(path)}|${position}:${shellQuote(`${path} `)}*`;
}

function bashDynamicOptionCases(entries: readonly Entry[]): string {
  return entries.flatMap((entry) => entry.dynamicOptions.map((option) =>
    `      ${dynamicOptionPattern(option, entry.path)}) dynamic=true;;`
  )).join("\n");
}

function zshDynamicOptionCases(entries: readonly Entry[]): string {
  return entries.flatMap((entry) => entry.dynamicOptions.map((option) =>
    `    ${dynamicOptionPattern(option, entry.path)}) dynamic=true;;`
  )).join("\n");
}

function dynamicOptionPattern(option: string, path: string): string {
  return `${shellQuote(`${option}:${path}`)}|${shellQuote(`${option}:${path} `)}*`;
}

function bashStaticOptionCases(entries: readonly Entry[]): string {
  return staticOptionEntries(entries).map((entry) =>
    `      ${commandPrefixPattern(entry.path)}) candidates=(${entry.options.map(shellQuote).join(" ")});;`
  ).join("\n");
}

function zshStaticOptionCases(entries: readonly Entry[]): string {
  return staticOptionEntries(entries).map((entry) =>
    `    ${commandPrefixPattern(entry.path)}) candidates=(${entry.options.map(shellQuote).join(" ")});;`
  ).join("\n");
}

function staticOptionEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.options.length > 0)
    .sort((left, right) => right.path.split(" ").length - left.path.split(" ").length);
}

function commandPrefixPattern(path: string): string {
  return `${shellQuote(path)}|${shellQuote(`${path} `)}*`;
}

function fishInitialDynamicExclusion(entry: Entry, prefix: string): string {
  const initial = entry.dynamicArguments.filter((position) =>
    position === entry.path.split(" ").filter(Boolean).length);
  return initial.map((position) =>
    `; and not ${prefix}_needs_dynamic argument ${position} ${fishPath(entry.path)}`
  ).join("");
}

function fishPath(path: string): string {
  return path.split(" ").filter(Boolean).join(" ");
}

function bashPattern(path: string): string {
  return path.length === 0 ? '""' : shellQuote(path);
}

function zshPattern(path: string): string {
  return path.length === 0 ? '""' : shellQuote(path);
}

function shellQuote(value: string): string {
  return `'${escapeSingle(value)}'`;
}

function fishQuote(value: string): string {
  return `'${escapeSingle(value)}'`;
}

function escapeSingle(value: string): string {
  return value.replaceAll("'", "'\\''");
}
