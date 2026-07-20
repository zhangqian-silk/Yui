import {
  ROOT_COMMAND,
  listPublicCommandPaths,
  orderedImmediateTokens,
  visibleChildren,
  type CommandNode
} from "./commandCatalog.js";

export type CliIdentity = "taskmux" | "taskmux-dev";

type Entry = Readonly<{
  path: string;
  immediate: readonly string[];
  options: readonly string[];
}>;

export function renderCompletion(
  shell: string | undefined,
  identity: CliIdentity = "taskmux"
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
      entries.push({
        path: node.path.slice(1).join(" "),
        immediate: orderedImmediateTokens(node),
        options: node.options
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
  const functionName = identity === "taskmux" ? "_taskmux" : "_taskmux_dev";
  return `${manifest("# taskmux command:")}
${functionName}() {
  local current path dynamic_candidate
  local -a candidates dynamic_candidates
  current="\${COMP_WORDS[COMP_CWORD]}"
  path=""
  if (( COMP_CWORD > 1 )); then
    path="\${COMP_WORDS[*]:1:COMP_CWORD-1}"
  fi
  while IFS= read -r dynamic_candidate; do
    [[ -n "$dynamic_candidate" ]] && dynamic_candidates+=("$dynamic_candidate")
  done < <(command ${identity} completion candidates "$current" -- "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)
  if (( \${#dynamic_candidates[@]} > 0 )); then
    candidates=("\${dynamic_candidates[@]}")
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
${manifest("# taskmux command:")}
local current path dynamic_output
local -a candidates
current="$words[CURRENT]"
path=""
if (( CURRENT > 2 )); then
  path="\${(j: :)words[2,CURRENT-1]}"
fi
dynamic_output="$(command ${identity} completion candidates "$current" -- "\${(@)words[2,CURRENT-1]}" 2>/dev/null)"
if [[ -n "$dynamic_output" ]]; then
  candidates=("\${(@f)dynamic_output}")
else
  case "$path" in
${entries.map((entry) => `    ${zshPattern(entry.path)}) candidates=(${[...entry.immediate, ...entry.options].map(shellQuote).join(" ")});;`).join("\n")}
    *) candidates=();;
  esac
fi
(( \${#candidates[@]} > 0 )) && compadd -- "$candidates[@]"
`;
}

function renderFish(entries: readonly Entry[], identity: CliIdentity): string {
  const lines = [
    manifest("# taskmux command:"),
    `function __${identity.replaceAll("-", "_")}_dynamic`,
    `  ${identity} completion candidates (commandline -ct) -- (commandline -opc | string split ' ' | tail -n +2) 2>/dev/null`,
    "end",
    `complete -c ${identity} -f -a '(__${identity.replaceAll("-", "_")}_dynamic)'`
  ];
  for (const entry of entries) {
    const candidates = [...entry.immediate, ...entry.options].join(" ");
    if (candidates.length === 0) continue;
    const condition = entry.path.length === 0
      ? "__fish_use_subcommand"
      : `__fish_seen_subcommand_from ${entry.path.split(" ").map(fishQuote).join(" ")}`;
    lines.push(`complete -c ${identity} -n '${condition}' -a '${escapeSingle(candidates)}'`);
  }
  return `${lines.join("\n")}\n`;
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
