import {
  ROOT_COMMAND,
  orderedImmediateTokens,
  visibleChildren,
  type CommandNode
} from "./commandCatalog.js";
import { usageError } from "../errors/cliError.js";

type CompletionEntry = {
  path: string;
  depth: number;
  immediate: readonly string[];
  options: readonly string[];
  optionValues: Readonly<Record<string, readonly string[]>>;
  argumentValues: Readonly<Record<number, readonly string[]>>;
  fileOptions: readonly string[];
  fileArguments: readonly number[];
  executableOptions: readonly string[];
  acceptsArguments: boolean;
};

export type CliIdentity = "taskmux" | "taskmux-dev";

export function renderCompletion(shell: string | undefined, identity: CliIdentity = "taskmux"): string {
  const entries = collectEntries(ROOT_COMMAND);
  if (shell === "bash") {
    return renderBash(entries, identity);
  }
  if (shell === "zsh") {
    return renderZsh(entries, identity);
  }
  if (shell === "fish") {
    return renderFish(entries, identity);
  }
  throw usageError("Completion shell must be one of bash, zsh, fish.");
}

function collectEntries(root: CommandNode): CompletionEntry[] {
  const collected: CompletionEntry[] = [];
  const addNode = (node: CommandNode): void => {
    if (!node.commandPathArguments) {
      collected.push({
        path: node.path.slice(1).join(" "),
        depth: node.path.length - 1,
        immediate: orderedImmediateTokens(node),
        options: node.options,
        optionValues: node.optionValues,
        argumentValues: node.argumentValues,
        fileOptions: node.fileOptions,
        fileArguments: node.fileArguments,
        executableOptions: node.executableOptions,
        acceptsArguments: node.kind !== "group"
      });
    }
    visibleChildren(node).forEach(addNode);
  };
  addNode(root);

  const help = root.children.find((child) => child.commandPathArguments);
  if (help !== undefined) {
    const addHelpPath = (target: CommandNode): void => {
      const targetPath = target.path.slice(1).join(" ");
      const path = targetPath.length === 0 ? help.name : `${help.name} ${targetPath}`;
      collected.push({
        path,
        depth: path.split(" ").length,
        immediate: orderedImmediateTokens(target),
        options: [],
        optionValues: {},
        argumentValues: {},
        fileOptions: [],
        fileArguments: [],
        executableOptions: [],
        acceptsArguments: true
      });
      visibleChildren(target).forEach(addHelpPath);
    };
    addHelpPath(root);
  }

  return orderCaseEntries(collected);
}

function renderBash(entries: readonly CompletionEntry[], identity: CliIdentity): string {
  const functionName = completionFunctionName(identity);
  const containsFunction = `${functionName}_contains`;
  return `${functionName}() {
  local path current previous argument_index command_depth
  local -a immediate options value_keys value_lists argument_value_positions argument_value_lists file_options file_arguments executable_options candidates
  path=""
  current="\${COMP_WORDS[COMP_CWORD]}"
  previous=""
  if (( COMP_CWORD > 0 )); then
    previous="\${COMP_WORDS[COMP_CWORD-1]}"
  fi
  if (( COMP_CWORD > 1 )); then
    path="\${COMP_WORDS[*]:1:COMP_CWORD-1}"
  fi
  immediate=(); options=(); value_keys=(); value_lists=(); argument_value_positions=(); argument_value_lists=(); file_options=(); file_arguments=(); executable_options=(); candidates=()
  case "$path" in
${renderBashCases(entries)}
    *) return 0;;
  esac
  argument_index=$((COMP_CWORD-command_depth-1))
  if [[ "$current" == -* ]]; then
    candidates=("\${options[@]}")
  else
    local index
    for ((index=0; index<\${#value_keys[@]}; index+=1)); do
      if [[ "$previous" == "\${value_keys[index]}" ]]; then
        read -r -a candidates <<< "\${value_lists[index]}"
        break
      fi
    done
    if (( \${#candidates[@]} == 0 )); then
      for ((index=0; index<\${#argument_value_positions[@]}; index+=1)); do
        if [[ "$argument_index" == "\${argument_value_positions[index]}" ]]; then
          read -r -a candidates <<< "\${argument_value_lists[index]}"
          break
        fi
      done
    fi
    if (( \${#candidates[@]} == 0 && argument_index == 0 )); then
      candidates=("\${immediate[@]}")
    fi
  fi
  if (( \${#candidates[@]} > 0 )); then
    compopt -o nosort 2>/dev/null || true
    COMPREPLY=( $(compgen -W "\${candidates[*]}" -- "$current") )
    return 0
  fi
  if ${containsFunction} "$previous" "\${executable_options[@]}"; then
    local command
    local -a seen_commands=()
    COMPREPLY=()
    while IFS= read -r command; do
      if [[ -n "$command" ]] && type -P -- "$command" >/dev/null 2>&1 && ! ${containsFunction} "$command" "\${seen_commands[@]}"; then
        seen_commands+=("$command")
        COMPREPLY+=("$command")
      fi
    done < <(compgen -c -- "$current")
    compopt -o nosort 2>/dev/null || true
    return 0
  fi
  if ${containsFunction} "$previous" "\${file_options[@]}" || ${containsFunction} "$argument_index" "\${file_arguments[@]}"; then
    local file_candidate
    COMPREPLY=()
    while IFS= read -r file_candidate; do
      COMPREPLY+=("$file_candidate")
    done < <(compgen -f -- "$current")
    compopt -o filenames 2>/dev/null || true
  else
    COMPREPLY=()
  fi
  return 0
}
${containsFunction}() {
  local needle="$1" item
  shift
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}
complete -F ${functionName} ${identity}
`;
}

function renderBashCases(entries: readonly CompletionEntry[]): string {
  return entries.map((entry) => {
    const pattern = casePattern(entry, "bash");
    const assignments = [
      `command_depth=${entry.depth}`,
      `immediate=(${entry.immediate.map(shellQuote).join(" ")})`,
      `options=(${entry.options.map(shellQuote).join(" ")})`,
      `value_keys=(${Object.keys(entry.optionValues).map(shellQuote).join(" ")})`,
      `value_lists=(${Object.values(entry.optionValues).map((values) => shellQuote(values.join(" "))).join(" ")})`,
      `argument_value_positions=(${Object.keys(entry.argumentValues).join(" ")})`,
      `argument_value_lists=(${Object.values(entry.argumentValues).map((values) => shellQuote(values.join(" "))).join(" ")})`,
      `file_options=(${entry.fileOptions.map(shellQuote).join(" ")})`,
      `file_arguments=(${entry.fileArguments.join(" ")})`,
      `executable_options=(${entry.executableOptions.map(shellQuote).join(" ")})`
    ];
    return `    ${pattern}) ${assignments.join("; ")};;`;
  }).join("\n");
}

function renderZsh(entries: readonly CompletionEntry[], identity: CliIdentity): string {
  return `#compdef ${identity}
local path current previous argument_index command_depth
local -a immediate options value_keys value_lists argument_value_positions argument_value_lists file_options file_arguments executable_options candidates
path=""
current="$words[CURRENT]"
previous=""
if (( CURRENT > 1 )); then
  previous="$words[CURRENT-1]"
fi
if (( CURRENT > 2 )); then
  path="\${(j: :)words[2,CURRENT-1]}"
fi
case "$path" in
${renderZshCases(entries)}
  *) return 0;;
esac
argument_index=$((CURRENT-command_depth-2))
if [[ "$current" == -* ]]; then
  candidates=("\${options[@]}")
else
  local index
  for ((index=1; index<=\${#value_keys[@]}; index+=1)); do
    if [[ "$previous" == "$value_keys[index]" ]]; then
      candidates=(\${=value_lists[index]})
      break
    fi
  done
  if (( \${#candidates[@]} == 0 )); then
    for ((index=1; index<=\${#argument_value_positions[@]}; index+=1)); do
      if [[ "$argument_index" == "$argument_value_positions[index]" ]]; then
        candidates=(\${=argument_value_lists[index]})
        break
      fi
    done
  fi
  if (( \${#candidates[@]} == 0 && argument_index == 0 )); then
    candidates=("\${immediate[@]}")
  fi
fi
if (( \${#candidates[@]} > 0 )); then
  compadd -V taskmux-catalog -- "\${candidates[@]}"
  return 0
fi
if (( \${executable_options[(Ie)$previous]} )); then
  _command_names -e
  return 0
fi
if (( \${file_options[(Ie)$previous]} || \${file_arguments[(Ie)$argument_index]} )); then
  _files
fi
return 0
`;
}

function renderZshCases(entries: readonly CompletionEntry[]): string {
  return entries.map((entry) => {
    const pattern = casePattern(entry, "zsh");
    const assignments = [
      `command_depth=${entry.depth}`,
      `immediate=(${entry.immediate.map(shellQuote).join(" ")})`,
      `options=(${entry.options.map(shellQuote).join(" ")})`,
      `value_keys=(${Object.keys(entry.optionValues).map(shellQuote).join(" ")})`,
      `value_lists=(${Object.values(entry.optionValues).map((values) => shellQuote(values.join(" "))).join(" ")})`,
      `argument_value_positions=(${Object.keys(entry.argumentValues).join(" ")})`,
      `argument_value_lists=(${Object.values(entry.argumentValues).map((values) => shellQuote(values.join(" "))).join(" ")})`,
      `file_options=(${entry.fileOptions.map(shellQuote).join(" ")})`,
      `file_arguments=(${entry.fileArguments.join(" ")})`,
      `executable_options=(${entry.executableOptions.map(shellQuote).join(" ")})`
    ];
    return `  ${pattern}) ${assignments.join("; ")};;`;
  }).join("\n");
}

function renderFish(entries: readonly CompletionEntry[], identity: CliIdentity): string {
  const functionName = completionFunctionName(identity);
  const cases = entries.map((entry) => {
    const patterns = entry.acceptsArguments && entry.path.length > 0
      ? [entry.path, `${entry.path} *`]
      : [entry.path];
    return `    case ${patterns.map(shellQuote).join(" ")}
      set command_depth ${entry.depth}
      set immediate ${entry.immediate.map(shellQuote).join(" ")}
      set options ${entry.options.map(shellQuote).join(" ")}
      set value_keys ${Object.keys(entry.optionValues).map(shellQuote).join(" ")}
      set value_lists ${Object.values(entry.optionValues).map((values) => shellQuote(values.join(" "))).join(" ")}
      set argument_value_positions ${Object.keys(entry.argumentValues).join(" ")}
      set argument_value_lists ${Object.values(entry.argumentValues).map((values) => shellQuote(values.join(" "))).join(" ")}
      set file_options ${entry.fileOptions.map(shellQuote).join(" ")}
      set file_arguments ${entry.fileArguments.join(" ")}
      set executable_options ${entry.executableOptions.map(shellQuote).join(" ")}`;
  }).join("\n");
  return `function ${functionName}
  set -l prior (commandline -opc)
  set -l current (commandline -ct)
  set -l path (string join ' ' -- $prior | string replace -r -- '^${identity} ?' '')
  set -l previous $prior[-1]
  set -l command_depth 0
  set -l immediate
  set -l options
  set -l value_keys
  set -l value_lists
  set -l argument_value_positions
  set -l argument_value_lists
  set -l file_options
  set -l file_arguments
  set -l executable_options
  switch "$path"
${cases}
    case '*'
      return 0
  end
  set -l argument_index (math (count $prior) - $command_depth - 1)
  if string match -q -- '-*' "$current"
    if test (count $options) -gt 0
      printf '%s\\n' $options
    end
    return 0
  end
  if test (count $value_keys) -gt 0
    for index in (seq (count $value_keys))
      if test "$previous" = "$value_keys[$index]"
        string split ' ' -- "$value_lists[$index]"
        return 0
      end
    end
  end
  if test (count $argument_value_positions) -gt 0
    for index in (seq (count $argument_value_positions))
      if test "$argument_index" = "$argument_value_positions[$index]"
        string split ' ' -- "$argument_value_lists[$index]"
        return 0
      end
    end
  end
  if test $argument_index -eq 0; and test (count $immediate) -gt 0
    printf '%s\\n' $immediate
    return 0
  end
  if contains -- "$previous" $executable_options
    set -l seen_commands
    set -l tab (printf '\\t')
    for record in (__fish_complete_command)
      set -l command_name (string split -m 1 "$tab" -- "$record")[1]
      if command -sq -- "$command_name"; and not contains -- "$command_name" $seen_commands
        set -a seen_commands "$command_name"
        printf '%s\\n' "$record"
      end
    end
    return 0
  end
  if contains -- "$previous" $file_options; or contains -- "$argument_index" $file_arguments
    __fish_complete_path "$current"
  end
end
complete -c ${identity} -f -k -a '(${functionName})'
`;
}

function completionFunctionName(identity: CliIdentity): string {
  return identity === "taskmux" ? "_taskmux" : "_taskmux_dev";
}

function orderCaseEntries(entries: readonly CompletionEntry[]): CompletionEntry[] {
  return [...entries].sort((left, right) => {
    const depth = right.depth - left.depth;
    return depth === 0 ? right.path.length - left.path.length : depth;
  });
}

function casePattern(entry: CompletionEntry, shell: "bash" | "zsh"): string {
  const exact = shellQuote(entry.path);
  if (!entry.acceptsArguments || entry.path.length === 0) {
    return exact;
  }
  return `${exact}|${shellQuote(`${entry.path} `)}*`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
