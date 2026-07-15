import { visibleCommandSections, type CommandNode } from "./commandCatalog.js";

export function renderCommandHelp(node: CommandNode, version: string): string {
  const title = node.path.length === 1 ? "TaskMux" : `TaskMux ${node.path.slice(1).join(" ")}`;
  const lines = node.name === "taskmux"
    ? [`TaskMux ${version}`, "", node.summary]
    : [title, "", node.summary];

  lines.push("", "Usage:", ...node.usage.map((usage) => `  ${usage}`));

  const sections = visibleCommandSections(node);
  for (const section of sections) {
    const width = Math.max(...section.entries.map((entry) => entry.name.length));
    lines.push("", `${section.title}:`, ...section.entries.map(
      (entry) => `  ${entry.name.padEnd(width)}  ${entry.summary}`
    ));
  }

  if (node.options.length > 0) {
    const optionWidth = Math.max(...node.options.map((option) => option.length));
    lines.push(
      "",
      "Options:",
      ...node.options.map((option) => `  ${option.padEnd(optionWidth)}  ${describeOption(option)}`)
    );
  }
  return `${lines.join("\n")}\n`;
}

function describeOption(option: string): string {
  const descriptions: Record<string, string> = {
    "--template": "Select a task template.",
    "--agent": "Select an agent.",
    "--workspace": "Set a workspace path.",
    "--description": "Set descriptive text.",
    "--priority": "Set task priority.",
    "--tag": "Add a task tag.",
    "--due": "Set a due date.",
    "--json": "Emit native JSON output.",
    "--output": "Write output to a file.",
    "--workspace-map": "Map a source binding to a target binding ID or absolute workspace path.",
    "--format": "Select the output format.",
    "--role": "Add a role.",
    "--topic": "Add or select a topic.",
    "--summary": "Set summary text.",
    "--reason": "Set reason text."
  };
  const known = descriptions[option];
  if (known !== undefined) {
    return known;
  }
  const name = option.slice(2).replaceAll("-", " ");
  if (name.startsWith("clear ")) {
    return `Clear ${name.slice("clear ".length)}.`;
  }
  if (name.startsWith("include ") || name.startsWith("with ")) {
    return `Include ${name.replace(/^(include|with) /, "")}.`;
  }
  return `Set ${name}.`;
}
