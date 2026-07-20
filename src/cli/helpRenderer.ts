import { visibleCommandSections, type CommandNode } from "./commandCatalog.js";

export function renderCommandHelp(node: CommandNode, version: string): string {
  const title = node.path.length === 1
    ? `TaskMux ${version}`
    : `TaskMux ${node.path.slice(1).join(" ")}`;
  const lines = [title, ""];
  if (node.summary.length > 0) lines.push(node.summary, "");
  lines.push("Usage:", ...node.usage.map((usage) => `  ${usage}`));

  for (const section of visibleCommandSections(node)) {
    const width = Math.max(...section.entries.map((entry) => entry.name.length));
    lines.push(
      "",
      `${section.title}:`,
      ...section.entries.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.summary}`)
    );
  }

  if (node.options.length > 0) {
    const width = Math.max(...node.options.map((option) => option.length));
    lines.push(
      "",
      "Options:",
      ...node.options.map((option) => `  ${option.padEnd(width)}  ${describeOption(option)}`)
    );
  }
  return `${lines.join("\n")}\n`;
}

function describeOption(option: string): string {
  const descriptions: Readonly<Record<string, string>> = {
    "--agent": "Select an Agent.",
    "--base": "Set the base Git reference.",
    "--input": "Set dispatch input.",
    "--json": "Emit machine-readable JSON.",
    "--repository": "Select a repository.",
    "--role": "Select a Task role.",
    "--summary": "Set summary text.",
    "--task": "Select a Task."
  };
  return descriptions[option] ?? `Set ${option.slice(2).replaceAll("-", " ")}.`;
}
