export type CommandNodeKind = "group" | "leaf" | "hybrid";

export type CommandNode = {
  name: string;
  path: readonly string[];
  summary: string;
  kind: CommandNodeKind;
  usage: readonly string[];
  children: readonly CommandNode[];
  hidden: boolean;
  options: readonly string[];
  values: readonly string[];
};

type NodeInput = {
  name: string;
  summary: string;
  usage?: string | readonly string[];
  children?: readonly NodeInput[];
  executable?: boolean;
  hidden?: boolean;
  options?: readonly string[];
  values?: readonly string[];
};

function buildNode(input: NodeInput, parentPath: readonly string[] = []): CommandNode {
  const path = [...parentPath, input.name];
  const children = (input.children ?? []).map((child) => buildNode(child, path));
  const executable = input.executable ?? children.length === 0;
  const usage = input.usage === undefined
    ? [`${path.join(" ")}${children.length > 0 && !executable ? " <command>" : ""}`]
    : typeof input.usage === "string" ? [input.usage] : [...input.usage];

  return Object.freeze({
    name: input.name,
    path: Object.freeze(path),
    summary: input.summary,
    kind: children.length === 0 ? "leaf" : executable ? "hybrid" : "group",
    usage: Object.freeze(usage),
    children: Object.freeze(children),
    hidden: input.hidden ?? false,
    options: Object.freeze([...(input.options ?? [])]),
    values: Object.freeze([...(input.values ?? [])])
  });
}

const taskChildren: readonly NodeInput[] = [
  { name: "create", summary: "Create a task.", usage: "taskmux task create <title> [--template feature|bug|review] [--agent <agent>] [--workspace <path>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD]", options: ["--template", "--agent", "--workspace", "--description", "--priority", "--tag", "--due"], values: ["feature", "bug", "review", "low", "medium", "high", "urgent"] },
  { name: "update", summary: "Update task metadata.", usage: "taskmux task update <task-id> [--title <title>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD] [--clear-description] [--clear-priority] [--clear-tags] [--clear-due]", options: ["--title", "--description", "--priority", "--tag", "--due", "--clear-description", "--clear-priority", "--clear-tags", "--clear-due"] },
  { name: "list", summary: "List tasks.", usage: "taskmux task list [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>]", options: ["--archived", "--tag", "--priority", "--search"] },
  { name: "board", summary: "Show the task board.", usage: "taskmux task board [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>] [--with-roles]", options: ["--archived", "--tag", "--priority", "--search", "--with-roles"] },
  { name: "show", summary: "Show task metadata.", usage: "taskmux task show <task-id>" },
  { name: "current", summary: "Show or select the current task.", usage: "taskmux task current [<task-id>]" },
  { name: "last", summary: "Show the last-read task." },
  { name: "clone", summary: "Clone a task and its roles.", usage: "taskmux task clone <task-id> [--title <title>]", options: ["--title"] },
  { name: "archive", summary: "Archive a task.", usage: "taskmux task archive <task-id> [--reason <body>] [--summary <body>]", options: ["--reason", "--summary"] },
  { name: "unarchive", summary: "Unarchive a task.", usage: "taskmux task unarchive <task-id>" },
  { name: "open", summary: "Open a concise task overview.", usage: "taskmux task open <task-id>" },
  { name: "context", summary: "Render durable task context.", usage: "taskmux task context <task-id> [--format text|json] [--include-transcripts]", options: ["--format", "--include-transcripts"] },
  { name: "delete", summary: "Move a task to trash.", usage: "taskmux task delete <task-id>" },
  { name: "restore", summary: "Restore a task from trash.", usage: "taskmux task restore <task-id>" },
  { name: "shell", summary: "Open the interactive task shell.", usage: "taskmux task shell <task-id>" },
  { name: "assign", summary: "Assign or bind one task role.", usage: "taskmux task assign <task-id> <role> [--agent <agent>] [--workspace <path>] [--as <task-role>]", options: ["--agent", "--workspace", "--as"] },
  { name: "bind", summary: "Bind a global role to a task.", usage: "taskmux task bind <task-id> <role> [--as <task-role>] [--workspace <path>]", options: ["--as", "--workspace"] },
  { name: "assign-many", summary: "Assign multiple task roles.", usage: "taskmux task assign-many <task-id> --role <role> ... [--agent <agent>] [--workspace <path>]", options: ["--role", "--agent", "--workspace"] },
  { name: "roles", summary: "List roles assigned to a task.", usage: "taskmux task roles <task-id>" },
  { name: "enter", summary: "Enter a task role session.", usage: "taskmux task enter <task-id> <role>" },
  { name: "tail", summary: "Capture recent task role output.", usage: "taskmux task tail <task-id> <role>" },
  { name: "detail", summary: "Show task role details.", usage: "taskmux task detail <task-id> <role>" },
  { name: "status", summary: "Show task role runtime status.", usage: "taskmux task status <task-id> <role>" },
  { name: "refresh", summary: "Refresh task role runtime state.", usage: "taskmux task refresh <task-id>" },
  { name: "transcript", summary: "Capture or export a task role transcript.", executable: true, usage: "taskmux task transcript <task-id> <role>", children: [
    { name: "export", summary: "Export a stored transcript.", usage: "taskmux task transcript export <task-id> <role> [--format text|json|markdown] [--output <file>]", options: ["--format", "--output"] }
  ] },
  { name: "activity", summary: "Show task activity.", usage: "taskmux task activity <task-id>" },
  { name: "timeline", summary: "Show the task timeline.", usage: "taskmux task timeline <task-id>" },
  { name: "detach", summary: "Detach from a task role.", usage: "taskmux task detach <task-id> <role>" },
  { name: "stop", summary: "Stop a task role session.", usage: "taskmux task stop <task-id> <role>" },
  { name: "kill", summary: "Kill a task role session.", usage: "taskmux task kill <task-id> <role>" },
  { name: "restart", summary: "Restart a task role session.", usage: "taskmux task restart <task-id> <role>" },
  { name: "cleanup", summary: "Clean stale task role state.", usage: "taskmux task cleanup <task-id>" },
  { name: "comment", summary: "Add a task comment.", usage: "taskmux task comment <task-id> <body>" },
  { name: "comments", summary: "List task comments.", usage: "taskmux task comments <task-id>" },
  { name: "events", summary: "List task events.", usage: "taskmux task events <task-id>" },
  { name: "wake", summary: "Queue a task wakeup.", usage: "taskmux task wake <task-id> --reason <reason>", options: ["--reason"] },
  { name: "dispatch", summary: "Dispatch an agent run.", usage: "taskmux task dispatch <task-id> <role> --mode new|resume [--work-item <id>] [--topic <topic> ...] --input <body>", options: ["--mode", "--work-item", "--topic", "--input"] },
  { name: "yield", summary: "Yield an agent run result.", usage: "taskmux task yield <task-id> <role> --summary <body>", options: ["--summary"] },
  { name: "role", summary: "Manage roles within a task.", children: [
    { name: "child", summary: "Create a descriptive child role.", usage: "taskmux task role child <task-id> <role> [--parent <role>] --description <body> [--responsibility <body> ...] [--constraint <body> ...] --expected-output <body>", options: ["--parent", "--description", "--responsibility", "--constraint", "--expected-output"] },
    { name: "update", summary: "Update a task role.", usage: "taskmux task role update <task-id> <role> [--agent <agent>] [--workspace <path>]", options: ["--agent", "--workspace"] },
    { name: "rename", summary: "Rename a task role.", usage: "taskmux task role rename <task-id> <role> <new-role>" },
    { name: "remove", summary: "Remove a task role.", usage: "taskmux task role remove <task-id> <role>" }
  ] },
  { name: "topic", summary: "Manage task topics.", children: [
    { name: "create", summary: "Create a task topic.", usage: "taskmux task topic create <task-id> --id <id> --name <name> --description <body>", options: ["--id", "--name", "--description"] },
    { name: "list", summary: "List task topics.", usage: "taskmux task topic list <task-id>" },
    { name: "summarize", summary: "Store a topic summary.", usage: "taskmux task topic summarize <task-id> --topic <topic> --summary <body>", options: ["--topic", "--summary"] }
  ] },
  { name: "input", summary: "Manage controlled task input.", children: [
    { name: "draft", summary: "Draft task input.", usage: "taskmux task input draft <task-id> <body>" },
    { name: "submit", summary: "Submit drafted task input.", usage: "taskmux task input submit <task-id>" }
  ] },
  { name: "cycle", summary: "Manage task cycles.", children: [
    { name: "create", summary: "Create a task cycle.", usage: "taskmux task cycle create <task-id> --cause <cause> --summary <body> [--topic <topic> ...]", options: ["--cause", "--summary", "--topic"] },
    { name: "end", summary: "End a task cycle.", usage: "taskmux task cycle end <task-id> <cycle-id> --summary <body>", options: ["--summary"] }
  ] },
  { name: "work-item", summary: "Manage finite work items.", children: [
    { name: "create", summary: "Create a work item.", usage: "taskmux task work-item create <task-id> --title <title> [--cycle <cycle>] [--assignee <role>] [--topic <topic> ...]", options: ["--title", "--cycle", "--assignee", "--topic"] },
    { name: "update", summary: "Update a work item.", usage: "taskmux task work-item update <task-id> <work-item-id> --status <status> [--outcome <body>]", options: ["--status", "--outcome"] }
  ] },
  { name: "session", summary: "Manage native agent session IDs.", children: [
    { name: "record", summary: "Record a native session ID.", usage: "taskmux task session record <task-id> <role> --native-id <id>", options: ["--native-id"] },
    { name: "replace", summary: "Replace a native session ID.", usage: "taskmux task session replace <task-id> <role> --native-id <id> --reason <reason>", options: ["--native-id", "--reason"] }
  ] },
  { name: "schedule", summary: "Manage task scheduling.", children: [
    { name: "set", summary: "Set a task schedule.", usage: "taskmux task schedule set <task-id> --inactivity-minutes <minutes> --cooldown-minutes <minutes> [--review-at <iso>] [--every-minutes <minutes> --next-at <iso>]", options: ["--inactivity-minutes", "--cooldown-minutes", "--review-at", "--every-minutes", "--next-at"] }
  ] },
  { name: "brief", summary: "Manage the current task brief.", children: [
    { name: "update", summary: "Update the task brief.", usage: "taskmux task brief update <task-id> --objective <body> [--boundary <body> ...] --focus <body> --leader-summary <body>", options: ["--objective", "--boundary", "--focus", "--leader-summary"] }
  ] },
  { name: "milestone", summary: "Manage task milestones.", children: [
    { name: "add", summary: "Add a task milestone.", usage: "taskmux task milestone add <task-id> --title <title> --summary <body> [--topic <topic> ...]", options: ["--title", "--summary", "--topic"] }
  ] },
  { name: "decision", summary: "Manage durable task decisions.", children: [
    { name: "record", summary: "Record a task decision.", usage: "taskmux task decision record <task-id> --title <title> --rationale <body> [--topic <topic> ...]", options: ["--title", "--rationale", "--topic"] },
    { name: "supersede", summary: "Supersede a task decision.", usage: "taskmux task decision supersede <task-id> <decision-id> --reason <body>", options: ["--reason"] }
  ] },
  { name: "worktree", summary: "Manage task role worktrees.", children: [
    { name: "create", summary: "Create a role worktree.", usage: "taskmux task worktree create <task-id> <role> --path <path> --branch <branch> [--base <ref>]", options: ["--path", "--branch", "--base"] }
  ] }
];

export const ROOT_COMMAND = buildNode({
  name: "taskmux",
  summary: "Local task board for native agent CLI sessions backed by tmux.",
  usage: "taskmux [command]",
  children: [
    { name: "help", summary: "Show root or scoped command help.", usage: "taskmux help [command ...]" },
    { name: "version", summary: "Print the installed TaskMux version." },
    { name: "update", summary: "Install the latest published TaskMux package globally." },
    { name: "completion", summary: "Generate or manage shell completion.", executable: true, usage: ["taskmux completion bash|zsh|fish", "taskmux completion install", "taskmux completion uninstall"], values: ["bash", "zsh", "fish"], children: [
      { name: "install", summary: "Interactively install or repair one shell completion." },
      { name: "uninstall", summary: "Interactively remove one managed shell completion." }
    ] },
    { name: "doctor", summary: "Check local TaskMux dependencies and state." },
    { name: "setup", summary: "Initialize TaskMux and configure an agent.", usage: "taskmux setup [tmux]" },
    { name: "backup", summary: "Create a TaskMux state backup." },
    { name: "export", summary: "Export TaskMux state.", usage: "taskmux export --output <file>", options: ["--output"] },
    { name: "import", summary: "Import TaskMux state.", usage: "taskmux import <file>" },
    { name: "prune", summary: "Remove selected trash or backups.", usage: "taskmux prune [--trash] [--backups] [--keep-backups <count>]", options: ["--trash", "--backups", "--keep-backups"] },
    { name: "operator", summary: "Enter the persistent Operator session." },
    { name: "controller", summary: "Manage the local TaskMux Controller.", children: [
      { name: "start", summary: "Start the Controller." },
      { name: "status", summary: "Show Controller status.", usage: "taskmux controller status [--json]", options: ["--json"] },
      { name: "stop", summary: "Stop the Controller." },
      { name: "scan", summary: "Run a Controller scheduler scan." },
      { name: "serve", summary: "Run the internal Controller server.", hidden: true }
    ] },
    { name: "config", summary: "View and change TaskMux configuration.", children: [
      { name: "show", summary: "Show current configuration." },
      { name: "set", summary: "Set a configuration value.", children: [
        { name: "default-agent", summary: "Set the default agent.", usage: "taskmux config set default-agent <agent-id>" },
        { name: "default-workspace", summary: "Set the default workspace.", usage: "taskmux config set default-workspace <path>" },
        { name: "completion", summary: "Set one completion installation record.", usage: "taskmux config set completion <bash|zsh|fish> <script-path> <activation-path>" }
      ] },
      { name: "unset", summary: "Clear a configuration value.", children: [
        { name: "default-agent", summary: "Clear the default agent." },
        { name: "default-workspace", summary: "Clear the default workspace." },
        { name: "completion", summary: "Clear one completion installation record.", usage: "taskmux config unset completion <bash|zsh|fish>" }
      ] }
    ] },
    { name: "agent", summary: "Manage configured native agent CLIs.", children: [
      { name: "add", summary: "Add an agent.", usage: "taskmux agent add <agent-id> --command <command> [--arg <arg> ...] [--env KEY=value ...]", options: ["--command", "--arg", "--env"] },
      { name: "list", summary: "List agents." },
      { name: "show", summary: "Show an agent.", usage: "taskmux agent show <agent-id>" },
      { name: "remove", summary: "Remove an agent.", usage: "taskmux agent remove <agent-id>" }
    ] },
    { name: "role", summary: "Manage reusable global roles.", children: [
      { name: "add", summary: "Add a global role.", usage: "taskmux role add <role> --agent <agent-id> [--workspace <path>] [--description <body>] [--responsibility <body> ...] [--constraint <body> ...] [--expected-output <body>] [--system-prompt <body>] [--skill <skill> ...]", options: ["--agent", "--workspace", "--description", "--responsibility", "--constraint", "--expected-output", "--system-prompt", "--skill"] },
      { name: "list", summary: "List global roles." },
      { name: "show", summary: "Show a global role.", usage: "taskmux role show <role>" },
      { name: "update", summary: "Update a global role.", usage: "taskmux role update <role> [--agent <agent-id>] [--workspace <path>]", options: ["--agent", "--workspace"] },
      { name: "remove", summary: "Remove a global role.", usage: "taskmux role remove <role>" },
      { name: "enter", summary: "Enter a global role session.", usage: "taskmux role enter <role>" }
    ] },
    { name: "task", summary: "Manage tasks, task roles, and durable task context.", children: taskChildren }
  ]
});

export function visibleChildren(node: CommandNode): readonly CommandNode[] {
  return node.children.filter((child) => !child.hidden);
}

export function findChild(node: CommandNode, name: string): CommandNode | undefined {
  return node.children.find((child) => child.name === name);
}

export function validateCommandCatalog(root: CommandNode): void {
  const visit = (node: CommandNode): void => {
    if (node.summary.trim().length === 0) {
      throw new Error(`Command summary is required: ${node.path.join(" ")}`);
    }
    if (node.usage.length === 0) {
      throw new Error(`Command usage is required: ${node.path.join(" ")}`);
    }
    const names = new Set<string>();
    for (const child of node.children) {
      if (names.has(child.name)) {
        throw new Error(`Duplicate command path: ${child.path.join(" ")}`);
      }
      names.add(child.name);
      visit(child);
    }
  };
  visit(root);
}

export function listPublicCommandPaths(root: CommandNode = ROOT_COMMAND): string[] {
  const paths: string[] = [];
  const visit = (node: CommandNode): void => {
    if (!node.hidden && node !== root) {
      paths.push(node.path.slice(1).join(" "));
    }
    node.children.filter((child) => !child.hidden).forEach(visit);
  };
  visit(root);
  return paths;
}

validateCommandCatalog(ROOT_COMMAND);
