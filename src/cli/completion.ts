import { ROOT_COMMAND, visibleChildren, type CommandNode } from "./commandCatalog.js";
import { usageError } from "../errors/cliError.js";

type CompletionEntry = {
  path: string;
  candidates: readonly string[];
  executable: boolean;
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
  const result: CompletionEntry[] = [];
  const visit = (node: CommandNode): void => {
    const children = visibleChildren(node);
    const path = node.path.slice(1).join(" ");
    const candidates = unique([
      ...children.map((child) => child.name),
      ...(node.kind === "leaf" || node.kind === "hybrid" ? node.options : []),
      ...(node.kind === "leaf" || node.kind === "hybrid" ? node.values : []),
      ...(node.kind === "group" || node.kind === "hybrid" ? ["help"] : []),
      "-h",
      "--help"
    ]);
    result.push({ path, candidates, executable: node.kind !== "group" });
    children.forEach(visit);
  };
  visit(root);
  return result;
}

function renderBash(entries: readonly CompletionEntry[], identity: CliIdentity): string {
  const functionName = completionFunctionName(identity);
  return `${functionName}() {
  local path candidates
  path=""
  if (( COMP_CWORD > 1 )); then
    path="\${COMP_WORDS[*]:1:COMP_CWORD-1}"
  fi
  case "$path" in
${renderCaseEntries(entries, "    ")}
    *) candidates="";;
  esac
  COMPREPLY=( $(compgen -W "$candidates" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F ${functionName} ${identity}
`;
}

function renderZsh(entries: readonly CompletionEntry[], identity: CliIdentity): string {
  return `#compdef ${identity}
local path candidates
path=""
if (( CURRENT > 2 )); then
  path="\${(j: :)words[2,CURRENT-1]}"
fi
case "$path" in
${renderCaseEntries(entries, "    ")}
  *) candidates="";;
esac
compadd -- \${=candidates}
`;
}

function renderFish(entries: readonly CompletionEntry[], identity: CliIdentity): string {
  const functionName = completionFunctionName(identity);
  const cases = orderCaseEntries(entries).map((entry) => {
    const pattern = entry.executable && entry.path.length > 0 ? `${entry.path}*` : entry.path;
    return `    case '${pattern}'\n      printf '%s\\n' ${entry.candidates.map(shellQuote).join(" ")}`;
  }).join("\n");
  return `function ${functionName}
  set -l path (commandline -opc | string join ' ' | string replace -r '^${identity} ?' '')
  switch "$path"
${cases}
  end
end
complete -c ${identity} -f -a '(${functionName})'
`;
}

function completionFunctionName(identity: CliIdentity): string {
  return identity === "taskmux" ? "_taskmux" : "_taskmux_dev";
}

function renderCaseEntries(entries: readonly CompletionEntry[], indent: string): string {
  return orderCaseEntries(entries).map((entry) => {
    const pattern = entry.executable && entry.path.length > 0
      ? `"${entry.path}"*`
      : `"${entry.path}"`;
    return `${indent}${pattern}) candidates="${entry.candidates.join(" ")}";;`;
  }).join("\n");
}

function orderCaseEntries(entries: readonly CompletionEntry[]): CompletionEntry[] {
  const exact = entries.filter((entry) => !entry.executable || entry.path.length === 0);
  const executable = entries
    .filter((entry) => entry.executable && entry.path.length > 0)
    .sort((left, right) => {
      const depth = right.path.split(" ").length - left.path.split(" ").length;
      return depth === 0 ? right.path.length - left.path.length : depth;
    });
  return [...exact, ...executable];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
