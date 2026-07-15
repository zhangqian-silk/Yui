import { CYCLE_CAUSES } from "../cycle/cycle.js";
import { supportedAgentAdapterIds } from "../agent/adapterCatalog.js";
import {
  ROLE_AGENT_FILE_OPTIONS,
  ROLE_AGENT_SCRIPTED_OPTIONS,
  ROLE_EXPECT_UPDATED_AT_OPTION,
  roleAgentOptionUsage
} from "./roleOptionCatalog.js";

export type CommandNodeKind = "group" | "leaf" | "hybrid";
export type CompletionProviderId = "role-agent";

export type CommandValue = {
  name: string;
  summary: string;
};

export type CommandSection = {
  id: string;
  title: string;
  entries: readonly string[];
};

export type CommandNode = {
  name: string;
  path: readonly string[];
  summary: string;
  kind: CommandNodeKind;
  usage: readonly string[];
  sections: readonly CommandSection[];
  children: readonly CommandNode[];
  hidden: boolean;
  options: readonly string[];
  hiddenOptions: readonly string[];
  values: readonly CommandValue[];
  optionValues: Readonly<Record<string, readonly string[]>>;
  argumentValues: Readonly<Record<number, readonly string[]>>;
  fileOptions: readonly string[];
  workspaceMapOptions: readonly string[];
  fileArguments: readonly number[];
  executableOptions: readonly string[];
  completionProvider?: CompletionProviderId;
  completionUsesDefaultAgent: boolean;
  commandPathArguments: boolean;
  acceptsArguments: boolean;
};

type NodeInput = {
  name: string;
  summary: string;
  usage?: string | readonly string[];
  sections?: readonly CommandSection[];
  children?: readonly NodeInput[];
  executable?: boolean;
  hidden?: boolean;
  options?: readonly string[];
  hiddenOptions?: readonly string[];
  values?: readonly (string | CommandValue)[];
  optionValues?: Readonly<Record<string, readonly string[]>>;
  argumentValues?: Readonly<Record<number, readonly string[]>>;
  fileOptions?: readonly string[];
  workspaceMapOptions?: readonly string[];
  fileArguments?: readonly number[];
  executableOptions?: readonly string[];
  completionProvider?: CompletionProviderId;
  completionUsesDefaultAgent?: boolean;
  commandPathArguments?: boolean;
  acceptsArguments?: boolean;
};

function buildNode(input: NodeInput, parentPath: readonly string[] = []): CommandNode {
  const path = [...parentPath, input.name];
  const children = (input.children ?? []).map((child) => buildNode(child, path));
  const executable = input.executable ?? children.length === 0;
  const optionValues = Object.fromEntries(
    Object.entries(input.optionValues ?? {}).map(([option, values]) => [option, Object.freeze([...values])])
  );
  const argumentValues = Object.fromEntries(
    Object.entries(input.argumentValues ?? {}).map(([position, values]) => [position, Object.freeze([...values])])
  );
  const usage = input.usage === undefined
    ? [`${path.join(" ")}${children.length > 0 && !executable ? " <command>" : ""}`]
    : typeof input.usage === "string" ? [input.usage] : [...input.usage];

  return Object.freeze({
    name: input.name,
    path: Object.freeze(path),
    summary: input.summary,
    kind: children.length === 0 ? "leaf" : executable ? "hybrid" : "group",
    usage: Object.freeze(usage),
    sections: Object.freeze((input.sections ?? []).map((section) => Object.freeze({
      id: section.id,
      title: section.title,
      entries: Object.freeze([...section.entries])
    }))),
    children: Object.freeze(children),
    hidden: input.hidden ?? false,
    options: Object.freeze([...(input.options ?? [])]),
    hiddenOptions: Object.freeze([...(input.hiddenOptions ?? [])]),
    values: Object.freeze((input.values ?? []).map((value) => Object.freeze(
      typeof value === "string" ? { name: value, summary: value } : { ...value }
    ))),
    optionValues: Object.freeze(optionValues),
    argumentValues: Object.freeze(argumentValues),
    fileOptions: Object.freeze([...(input.fileOptions ?? [])]),
    workspaceMapOptions: Object.freeze([...(input.workspaceMapOptions ?? [])]),
    fileArguments: Object.freeze([...(input.fileArguments ?? [])]),
    executableOptions: Object.freeze([...(input.executableOptions ?? [])]),
    ...(input.completionProvider === undefined ? {} : { completionProvider: input.completionProvider }),
    completionUsesDefaultAgent: input.completionUsesDefaultAgent ?? false,
    commandPathArguments: input.commandPathArguments ?? false,
    acceptsArguments: input.acceptsArguments ?? executable
  });
}

const taskChildren: readonly NodeInput[] = [
  { name: "create", summary: "Create a task.", usage: "taskmux task create <title> [--template feature|bug|review] [--agent <agent>] [--workspace <path>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD]", options: ["--template", "--agent", "--workspace", "--description", "--priority", "--tag", "--due"], optionValues: { "--template": ["feature", "bug", "review"], "--priority": ["low", "medium", "high", "urgent"] }, fileOptions: ["--workspace"] },
  { name: "update", summary: "Update task metadata.", usage: "taskmux task update <task-id> [--title <title>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD] [--clear-description] [--clear-priority] [--clear-tags] [--clear-due]", options: ["--title", "--description", "--priority", "--tag", "--due", "--clear-description", "--clear-priority", "--clear-tags", "--clear-due"], optionValues: { "--priority": ["low", "medium", "high", "urgent"] } },
  { name: "list", summary: "List tasks.", usage: "taskmux task list [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>]", options: ["--archived", "--tag", "--priority", "--search"], optionValues: { "--archived": ["true", "false"], "--priority": ["low", "medium", "high", "urgent"] } },
  { name: "board", summary: "Show the task board.", usage: "taskmux task board [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>] [--with-roles]", options: ["--archived", "--tag", "--priority", "--search", "--with-roles"], optionValues: { "--archived": ["true", "false"], "--priority": ["low", "medium", "high", "urgent"] } },
  { name: "show", summary: "Show task metadata.", usage: "taskmux task show <task-id>" },
  { name: "current", summary: "Show or select the current task.", usage: "taskmux task current [<task-id>]" },
  { name: "last", summary: "Show the last-read task." },
  { name: "clone", summary: "Clone a task and its roles.", usage: "taskmux task clone <task-id> [--title <title>]", options: ["--title"] },
  { name: "archive", summary: "Archive a task.", usage: "taskmux task archive <task-id> [--reason <body>] [--summary <body>]", options: ["--reason", "--summary"] },
  { name: "unarchive", summary: "Unarchive a task.", usage: "taskmux task unarchive <task-id>" },
  { name: "open", summary: "Open a concise task overview.", usage: "taskmux task open <task-id>" },
  { name: "context", summary: "Render durable task context.", usage: "taskmux task context <task-id> [--format text|json] [--include-transcripts]", options: ["--format", "--include-transcripts"], optionValues: { "--format": ["text", "json"] } },
  { name: "delete", summary: "Move a task to trash.", usage: "taskmux task delete <task-id>" },
  { name: "restore", summary: "Restore a task from trash.", usage: "taskmux task restore <task-id>" },
  { name: "shell", summary: "Open the interactive task shell.", usage: "taskmux task shell <task-id>" },
  { name: "assign", summary: "Assign one configured Agent to a task role; Agent is interactively selected when omitted.", usage: `taskmux task assign <task-id> <role> [--agent <agent-id>] [--workspace <path>] [--as <task-role>] ${roleAgentOptionUsage()} [--system-prompt <body>]`, options: ["--agent", "--workspace", "--as", ...ROLE_AGENT_SCRIPTED_OPTIONS, "--system-prompt"], fileOptions: ["--workspace", ...ROLE_AGENT_FILE_OPTIONS], completionProvider: "role-agent", completionUsesDefaultAgent: true },
  { name: "bind", summary: "Bind a global role to a task.", usage: "taskmux task bind <task-id> <role> [--as <task-role>] [--workspace <path>]", options: ["--as", "--workspace"], fileOptions: ["--workspace"] },
  { name: "assign-many", summary: "Assign multiple task roles with one Agent configuration; Agent is interactively selected when omitted.", usage: `taskmux task assign-many <task-id> --role <role> ... [--agent <agent-id>] [--workspace <path>] ${roleAgentOptionUsage()} [--system-prompt <body>]`, options: ["--role", "--agent", "--workspace", ...ROLE_AGENT_SCRIPTED_OPTIONS, "--system-prompt"], fileOptions: ["--workspace", ...ROLE_AGENT_FILE_OPTIONS], completionProvider: "role-agent", completionUsesDefaultAgent: true },
  { name: "roles", summary: "List roles assigned to a task.", usage: "taskmux task roles <task-id>" },
  { name: "enter", summary: "Enter a task role session.", usage: "taskmux task enter <task-id> <role>" },
  { name: "tail", summary: "Capture recent task role output.", usage: "taskmux task tail <task-id> <role>" },
  { name: "detail", summary: "Show task role details.", usage: "taskmux task detail <task-id> <role>" },
  { name: "status", summary: "Show task role runtime status.", usage: "taskmux task status <task-id> <role>" },
  { name: "refresh", summary: "Refresh task role runtime state.", usage: "taskmux task refresh <task-id>" },
  { name: "transcript", summary: "Capture or export a task role transcript.", executable: true, usage: "taskmux task transcript <task-id> <role>", sections: [{ id: "export", title: "Export", entries: ["export"] }], children: [
    { name: "export", summary: "Export a stored transcript.", usage: "taskmux task transcript export <task-id> <role> [--format text|json|markdown] [--output <file>]", options: ["--format", "--output"], optionValues: { "--format": ["text", "json", "markdown"] }, fileOptions: ["--output"] }
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
  { name: "dispatch", summary: "Dispatch an agent run.", usage: "taskmux task dispatch <task-id> <role> --mode new|resume [--work-item <id>] [--topic <topic> ...] [--confirm-permission-broadening] --input <body>", options: ["--mode", "--work-item", "--topic", "--confirm-permission-broadening", "--input"], optionValues: { "--mode": ["new", "resume"] } },
  { name: "yield", summary: "Yield an agent run result.", usage: "taskmux task yield <task-id> <role> --summary <body>", options: ["--summary"] },
  { name: "role", summary: "Manage roles within a task.", sections: [{ id: "manage", title: "Manage", entries: ["child", "update", "rename", "remove"] }], children: [
    { name: "child", summary: "Create a descriptive child role.", usage: "taskmux task role child <task-id> <role> [--parent <role>] --description <body> [--responsibility <body> ...] [--constraint <body> ...] --expected-output <body>", options: ["--parent", "--description", "--responsibility", "--constraint", "--expected-output"] },
    { name: "update", summary: "Update a task role or one of its Agent bindings.", usage: `taskmux task role update <task-id> <role> [--agent <agent-id>] [--active-agent <agent-id>] [--workspace <path>] ${roleAgentOptionUsage()} [--system-prompt <body>]`, options: ["--agent", "--active-agent", "--workspace", ...ROLE_AGENT_SCRIPTED_OPTIONS, "--system-prompt"], hiddenOptions: [ROLE_EXPECT_UPDATED_AT_OPTION], fileOptions: ["--workspace", ...ROLE_AGENT_FILE_OPTIONS], completionProvider: "role-agent" },
    { name: "rename", summary: "Rename a task role.", usage: "taskmux task role rename <task-id> <role> <new-role>" },
    { name: "remove", summary: "Remove a task role.", usage: "taskmux task role remove <task-id> <role>" }
  ] },
  { name: "topic", summary: "Manage task topics.", sections: [
    { id: "inspect", title: "Inspect", entries: ["list"] },
    { id: "manage", title: "Manage", entries: ["create", "summarize"] }
  ], children: [
    { name: "create", summary: "Create a task topic.", usage: "taskmux task topic create <task-id> --id <id> --name <name> --description <body>", options: ["--id", "--name", "--description"] },
    { name: "list", summary: "List task topics.", usage: "taskmux task topic list <task-id>" },
    { name: "summarize", summary: "Store a topic summary.", usage: "taskmux task topic summarize <task-id> --topic <topic> --summary <body>", options: ["--topic", "--summary"] }
  ] },
  { name: "input", summary: "Manage durable task-owned input requests.", sections: [
    { id: "inspect", title: "Inspect", entries: ["list", "show"] },
    { id: "respond", title: "Respond", entries: ["answer"] },
    { id: "leader", title: "Leader", entries: ["request", "cancel"] },
    { id: "legacy", title: "Legacy drafts", entries: ["draft", "submit"] }
  ], children: [
    { name: "request", summary: "Request human input from the active Leader session.", usage: "taskmux task input request <task-id> --question <text> [--choice <key=label> ...] [--blocks <type:id> ...] [--policy human-only|timeout] [--recommend <choice-key> --recommendation-reason <text> --timeout <duration>]", options: ["--question", "--choice", "--blocks", "--policy", "--recommend", "--recommendation-reason", "--timeout"], optionValues: { "--policy": ["human-only", "timeout"] } },
    { name: "list", summary: "List global or task-scoped input requests.", usage: "taskmux task input list [<task-id>] [--all]", options: ["--all"] },
    { name: "show", summary: "Show one input request.", usage: "taskmux task input show <request-id> [--task <task-id>]", options: ["--task"] },
    { name: "answer", summary: "Answer one open input request.", usage: "taskmux task input answer <request-id> [--task <task-id>] (--choice <choice-key> | --text <text>)", options: ["--task", "--choice", "--text"] },
    { name: "cancel", summary: "Cancel the current Leader's open input request.", usage: "taskmux task input cancel <task-id> <request-id> --reason <text>", options: ["--reason"] },
    { name: "draft", summary: "Draft task input.", usage: "taskmux task input draft <task-id> <body>" },
    { name: "submit", summary: "Submit drafted task input.", usage: "taskmux task input submit <task-id>" }
  ] },
  { name: "cycle", summary: "Manage task cycles.", sections: [{ id: "manage", title: "Manage", entries: ["create", "end"] }], children: [
    { name: "create", summary: "Create a task cycle.", usage: "taskmux task cycle create <task-id> --cause <cause> --summary <body> [--topic <topic> ...]", options: ["--cause", "--summary", "--topic"], optionValues: { "--cause": CYCLE_CAUSES } },
    { name: "end", summary: "End a task cycle.", usage: "taskmux task cycle end <task-id> <cycle-id> --summary <body>", options: ["--summary"] }
  ] },
  { name: "work-item", summary: "Manage finite work items.", sections: [{ id: "manage", title: "Manage", entries: ["create", "update"] }], children: [
    { name: "create", summary: "Create a work item.", usage: "taskmux task work-item create <task-id> --title <title> [--cycle <cycle>] [--assignee <role>] [--topic <topic> ...]", options: ["--title", "--cycle", "--assignee", "--topic"] },
    { name: "update", summary: "Update a work item.", usage: "taskmux task work-item update <task-id> <work-item-id> --status <status> [--outcome <body>]", options: ["--status", "--outcome"], optionValues: { "--status": ["pending", "running", "completed", "failed", "cancelled", "superseded"] } }
  ] },
  { name: "session", summary: "Manage native agent session IDs.", sections: [{ id: "manage", title: "Manage", entries: ["record", "replace"] }], children: [
    { name: "record", summary: "Record a native session ID.", usage: "taskmux task session record <task-id> <role> --native-id <id>", options: ["--native-id"] },
    { name: "replace", summary: "Replace a native session ID.", usage: "taskmux task session replace <task-id> <role> --native-id <id> --reason <reason>", options: ["--native-id", "--reason"] }
  ] },
  { name: "schedule", summary: "Manage task scheduling.", sections: [{ id: "manage", title: "Manage", entries: ["set"] }], children: [
    { name: "set", summary: "Set a task schedule.", usage: "taskmux task schedule set <task-id> --inactivity-minutes <minutes> --cooldown-minutes <minutes> [--review-at <iso>] [--every-minutes <minutes> --next-at <iso>]", options: ["--inactivity-minutes", "--cooldown-minutes", "--review-at", "--every-minutes", "--next-at"] }
  ] },
  { name: "brief", summary: "Manage the current task brief.", sections: [{ id: "manage", title: "Manage", entries: ["update"] }], children: [
    { name: "update", summary: "Update the task brief.", usage: "taskmux task brief update <task-id> --objective <body> [--boundary <body> ...] --focus <body> --leader-summary <body>", options: ["--objective", "--boundary", "--focus", "--leader-summary"] }
  ] },
  { name: "milestone", summary: "Manage task milestones.", sections: [{ id: "manage", title: "Manage", entries: ["add"] }], children: [
    { name: "add", summary: "Add a task milestone.", usage: "taskmux task milestone add <task-id> --title <title> --summary <body> [--topic <topic> ...]", options: ["--title", "--summary", "--topic"] }
  ] },
  { name: "decision", summary: "Manage durable task decisions.", sections: [{ id: "manage", title: "Manage", entries: ["record", "supersede"] }], children: [
    { name: "record", summary: "Record a task decision.", usage: "taskmux task decision record <task-id> --title <title> --rationale <body> [--topic <topic> ...]", options: ["--title", "--rationale", "--topic"] },
    { name: "supersede", summary: "Supersede a task decision.", usage: "taskmux task decision supersede <task-id> <decision-id> --reason <body>", options: ["--reason"] }
  ] },
  { name: "worktree", summary: "Manage task role worktrees.", sections: [{ id: "manage", title: "Manage", entries: ["create", "remove"] }], children: [
    { name: "create", summary: "Create a role worktree.", usage: "taskmux task worktree create <task-id> <role> --path <path> --branch <branch> [--base <ref>]", options: ["--path", "--branch", "--base"], fileOptions: ["--path"] },
    { name: "remove", summary: "Remove a managed role worktree.", usage: "taskmux task worktree remove <task-id> <role>" }
  ] }
];

export const ROOT_COMMAND = buildNode({
  name: "taskmux",
  summary: "Local task board for native agent CLI sessions backed by tmux.",
  usage: "taskmux [command]",
  sections: [
    { id: "workflow", title: "Workflow", entries: ["task", "operator"] },
    { id: "configuration", title: "Configuration", entries: ["setup", "config", "agent", "role", "completion"] },
    { id: "operations", title: "Operations", entries: ["controller", "doctor", "maintenance"] },
    { id: "data", title: "Data", entries: ["backup", "restore", "export", "import", "prune"] },
    { id: "support", title: "Support", entries: ["update", "version", "help"] }
  ],
  children: [
    { name: "help", summary: "Show root or scoped command help.", usage: "taskmux help [command ...]", commandPathArguments: true },
    { name: "version", summary: "Print the installed TaskMux version." },
    { name: "update", summary: "Install the latest published TaskMux package globally." },
    { name: "completion", summary: "Generate or manage shell completion.", usage: ["taskmux completion bash|zsh|fish", "taskmux completion install", "taskmux completion uninstall"], sections: [
      { id: "generate", title: "Generate", entries: ["bash", "zsh", "fish"] },
      { id: "manage", title: "Manage", entries: ["install", "uninstall"] },
      { id: "internal", title: "Internal", entries: ["candidates"] }
    ], children: [
      { name: "bash", summary: "Generate Bash completion." },
      { name: "zsh", summary: "Generate Zsh completion." },
      { name: "fish", summary: "Generate Fish completion." },
      { name: "install", summary: "Interactively install or repair one shell completion." },
      { name: "uninstall", summary: "Interactively remove one managed shell completion." },
      { name: "candidates", summary: "Resolve internal dynamic completion candidates.", hidden: true }
    ] },
    { name: "doctor", summary: "Check local TaskMux dependencies and state." },
    { name: "setup", summary: "Initialize TaskMux and configure an agent.", executable: true, acceptsArguments: false, usage: "taskmux setup [tmux]", sections: [{ id: "mode", title: "Mode", entries: ["tmux"] }], children: [
      { name: "tmux", summary: "Install tmux before setup." }
    ] },
    { name: "backup", summary: "Create a TaskMux state backup." },
    { name: "restore", summary: "Restore one physical TaskMux backup.", usage: "taskmux restore <backup-id> [--force]", options: ["--force"] },
    { name: "export", summary: "Export portable TaskMux semantic state.", usage: "taskmux export --output <file>", options: ["--output"], fileOptions: ["--output"] },
    { name: "import", summary: "Import portable TaskMux semantic state.", usage: "taskmux import <file> --workspace-map <source-binding-id>=<target-binding-id|absolute-workspace-path> ...", options: ["--workspace-map"], workspaceMapOptions: ["--workspace-map"], fileArguments: [0] },
    { name: "prune", summary: "Remove selected expired physical state.", usage: "taskmux prune [--trash] [--backups] [--transactions] [--keep-backups <count>] [--keep-trash-days <days>] [--dry-run]", options: ["--trash", "--backups", "--transactions", "--keep-backups", "--keep-trash-days", "--dry-run"] },
    { name: "operator", summary: "Enter the persistent Operator session." },
    { name: "controller", summary: "Manage the local TaskMux Controller.", sections: [
      { id: "lifecycle", title: "Lifecycle", entries: ["start", "status", "stop"] },
      { id: "operations", title: "Operations", entries: ["scan"] },
      { id: "internal", title: "Internal", entries: ["serve"] }
    ], children: [
      { name: "start", summary: "Start the Controller." },
      { name: "status", summary: "Show Controller status.", usage: "taskmux controller status [--json]", options: ["--json"] },
      { name: "stop", summary: "Stop the Controller." },
      { name: "scan", summary: "Run a Controller scheduler scan." },
      { name: "serve", summary: "Run the internal Controller server.", hidden: true }
    ] },
    { name: "maintenance", summary: "Run explicit local maintenance.", sections: [
      { id: "git", title: "Git", entries: ["git"] }
    ], children: [
      { name: "git", summary: "Maintain durable Git lifecycle effects.", sections: [
        { id: "recover", title: "Recover", entries: ["recover"] }
      ], children: [
        { name: "recover", summary: "Resume interrupted, effect-started Git lifecycle effects.", usage: "taskmux maintenance git recover" }
      ] }
    ] },
    { name: "config", summary: "View and change TaskMux configuration.", sections: [
      { id: "inspect", title: "Inspect", entries: ["show"] },
      { id: "modify", title: "Modify", entries: ["set", "unset"] }
    ], children: [
      { name: "show", summary: "Show current configuration." },
      { name: "set", summary: "Set a configuration value.", sections: [
        { id: "defaults", title: "Defaults", entries: ["default-agent", "default-workspace"] },
        { id: "completion", title: "Completion", entries: ["completion"] }
      ], children: [
        { name: "default-agent", summary: "Set the default agent.", usage: "taskmux config set default-agent <agent-id>" },
        { name: "default-workspace", summary: "Set the default workspace.", usage: "taskmux config set default-workspace <path>", fileArguments: [0] },
        { name: "completion", summary: "Set one completion installation record.", usage: "taskmux config set completion <bash|zsh|fish> <script-path> <activation-path>", argumentValues: { 0: ["bash", "zsh", "fish"] }, fileArguments: [1, 2] }
      ] },
      { name: "unset", summary: "Clear a configuration value.", sections: [
        { id: "defaults", title: "Defaults", entries: ["default-agent", "default-workspace"] },
        { id: "completion", title: "Completion", entries: ["completion"] }
      ], children: [
        { name: "default-agent", summary: "Clear the default agent." },
        { name: "default-workspace", summary: "Clear the default workspace." },
        { name: "completion", summary: "Clear one completion installation record.", usage: "taskmux config unset completion <bash|zsh|fish>", argumentValues: { 0: ["bash", "zsh", "fish"] } }
      ] }
    ] },
    { name: "agent", summary: "Manage configured native agent CLIs.", sections: [
      { id: "inspect", title: "Inspect", entries: ["list", "show"] },
      { id: "manage", title: "Manage", entries: ["add", "update", "remove"] }
    ], children: [
      { name: "add", summary: "Add an agent.", usage: "taskmux agent add <agent-id> [--adapter <adapter-id>] --command <command> [--arg <arg> ...] [--env TARGET=PROCESS_NAME ...]", options: ["--adapter", "--command", "--arg", "--env"], optionValues: { "--adapter": supportedAgentAdapterIds() }, executableOptions: ["--command"] },
      { name: "list", summary: "List agents." },
      { name: "show", summary: "Show an agent.", usage: "taskmux agent show <agent-id>" },
      { name: "update", summary: "Update an unreferenced Agent, or refresh only a referenced Agent probe pin.", usage: "taskmux agent update <agent-id> [--adapter <adapter-id>] [--command <command>] [--arg <arg> ... | --clear-args] [--env TARGET=PROCESS_NAME ... | --clear-env] [--refresh-probe]", options: ["--adapter", "--command", "--arg", "--clear-args", "--env", "--clear-env", "--refresh-probe"], optionValues: { "--adapter": supportedAgentAdapterIds() }, executableOptions: ["--command"] },
      { name: "remove", summary: "Remove an agent.", usage: "taskmux agent remove <agent-id>" }
    ] },
    { name: "role", summary: "Manage reusable global roles.", sections: [
      { id: "inspect", title: "Inspect", entries: ["list", "show"] },
      { id: "manage", title: "Manage", entries: ["add", "update", "remove"] },
      { id: "sessions", title: "Sessions", entries: ["enter", "session"] }
    ], children: [
      { name: "add", summary: "Add a global role; Agent is interactively selected when omitted.", usage: `taskmux role add <role> [--agent <agent-id>] [--workspace <path>] ${roleAgentOptionUsage()} [--description <body>] [--responsibility <body> ...] [--constraint <body> ...] [--expected-output <body>] [--system-prompt <body>] [--skill <skill> ...]`, options: ["--agent", "--workspace", ...ROLE_AGENT_SCRIPTED_OPTIONS, "--description", "--responsibility", "--constraint", "--expected-output", "--system-prompt", "--skill"], fileOptions: ["--workspace", ...ROLE_AGENT_FILE_OPTIONS], completionProvider: "role-agent", completionUsesDefaultAgent: true },
      { name: "list", summary: "List global roles." },
      { name: "show", summary: "Show a global role.", usage: "taskmux role show <role>" },
      { name: "update", summary: "Update a global role or one of its Agent bindings.", usage: `taskmux role update <role> [--agent <agent-id>] [--active-agent <agent-id>] [--workspace <path>] ${roleAgentOptionUsage()} [--system-prompt <body>]`, options: ["--agent", "--active-agent", "--workspace", ...ROLE_AGENT_SCRIPTED_OPTIONS, "--system-prompt"], hiddenOptions: [ROLE_EXPECT_UPDATED_AT_OPTION], fileOptions: ["--workspace", ...ROLE_AGENT_FILE_OPTIONS], completionProvider: "role-agent" },
      { name: "remove", summary: "Remove a global role.", usage: "taskmux role remove <role>" },
      { name: "enter", summary: "Enter a global role session.", usage: "taskmux role enter <role>" },
      { name: "session", summary: "Manage a GlobalRole native session ID.", sections: [
        { id: "manage", title: "Manage", entries: ["record", "replace"] }
      ], children: [
        { name: "record", summary: "Record a GlobalRole native session ID.", usage: "taskmux role session record <role> --native-id <id>", options: ["--native-id"] },
        { name: "replace", summary: "Replace a GlobalRole native session ID.", usage: "taskmux role session replace <role> --native-id <id> --reason <reason>", options: ["--native-id", "--reason"] }
      ] }
    ] },
    { name: "task", summary: "Manage tasks, task roles, and durable task context.", sections: [
      { id: "workflow", title: "Workflow", entries: ["create", "update", "clone", "archive", "unarchive", "delete", "restore"] },
      { id: "inspect", title: "Inspect", entries: ["list", "board", "show", "current", "last", "open", "context", "activity", "timeline", "comments", "events"] },
      { id: "roles-sessions", title: "Roles and sessions", entries: ["shell", "assign", "bind", "assign-many", "roles", "enter", "tail", "detail", "status", "refresh", "transcript", "detach", "stop", "kill", "restart", "cleanup"] },
      { id: "collaboration", title: "Collaboration", entries: ["comment", "wake", "dispatch", "yield"] },
      { id: "resources", title: "Resources", entries: ["role", "topic", "input", "cycle", "work-item", "session", "schedule", "brief", "milestone", "decision", "worktree"] }
    ], children: taskChildren }
  ]
});

export function visibleChildren(node: CommandNode): readonly CommandNode[] {
  const childrenByName = new Map(node.children.map((child) => [child.name, child]));
  return node.sections.flatMap((section) => section.entries.flatMap((entry) => {
    const child = childrenByName.get(entry);
    return child === undefined || child.hidden ? [] : [child];
  }));
}

export type VisibleCommandSection = {
  id: string;
  title: string;
  entries: readonly (CommandNode | CommandValue)[];
};

export function visibleCommandSections(node: CommandNode): readonly VisibleCommandSection[] {
  const childrenByName = new Map(node.children.map((child) => [child.name, child]));
  const valuesByName = new Map(node.values.map((value) => [value.name, value]));
  return node.sections.flatMap((section) => {
    const entries = section.entries.flatMap((entry) => {
      const child = childrenByName.get(entry);
      if (child !== undefined) {
        return child.hidden ? [] : [child];
      }
      const value = valuesByName.get(entry);
      return value === undefined ? [] : [value];
    });
    return entries.length === 0 ? [] : [{ id: section.id, title: section.title, entries }];
  });
}

export function orderedImmediateTokens(node: CommandNode): readonly string[] {
  return visibleCommandSections(node).flatMap((section) => section.entries.map((entry) => entry.name));
}

export function findChild(node: CommandNode, name: string): CommandNode | undefined {
  return node.children.find((child) => child.name === name);
}

export function validateCommandCatalog(root: CommandNode): void {
  const reservedAliases = new Set(["-h", "--help", "-help", "-v", "--version"]);
  const commandPathProviders: CommandNode[] = [];
  const visit = (node: CommandNode): void => {
    if (node.summary.trim().length === 0) {
      throw new Error(`Command summary is required: ${node.path.join(" ")}`);
    }
    if (node.usage.length === 0) {
      throw new Error(`Command usage is required: ${node.path.join(" ")}`);
    }
    if (node.commandPathArguments) {
      commandPathProviders.push(node);
      const ownsOtherCompletionMetadata = node.kind !== "leaf"
        || node.hidden
        || node.children.length > 0
        || node.values.length > 0
        || node.sections.length > 0
        || node.options.length > 0
        || (node.hiddenOptions?.length ?? 0) > 0
        || Object.keys(node.optionValues).length > 0
        || Object.keys(node.argumentValues).length > 0
        || node.fileOptions.length > 0
        || node.fileArguments.length > 0
        || node.executableOptions.length > 0;
      if (ownsOtherCompletionMetadata) {
        throw new Error(`Command-path provider must be a visible metadata-free leaf: ${node.path.join(" ")}`);
      }
    }
    const names = new Set<string>();
    for (const child of node.children) {
      if (names.has(child.name)) {
        throw new Error(`Duplicate command path: ${child.path.join(" ")}`);
      }
      if (reservedAliases.has(child.name)) {
        throw new Error(`Reserved alias token is not allowed: ${child.path.join(" ")}`);
      }
      names.add(child.name);
    }

    const immediateTokens = new Set(names);
    for (const value of node.values) {
      const valueName = typeof value === "string" ? value : value.name;
      const valueSummary = typeof value === "string" ? value : value.summary;
      if (valueName.trim().length === 0) {
        throw new Error(`Command value name is required: ${node.path.join(" ")}`);
      }
      if (valueSummary.trim().length === 0) {
        throw new Error(`Command value summary is required: ${[...node.path, valueName].join(" ")}`);
      }
      if (immediateTokens.has(valueName)) {
        throw new Error(`Duplicate command token: ${[...node.path, valueName].join(" ")}`);
      }
      if (reservedAliases.has(valueName)) {
        throw new Error(`Reserved alias token is not allowed: ${[...node.path, valueName].join(" ")}`);
      }
      immediateTokens.add(valueName);
    }

    const optionNames = new Set<string>();
    for (const option of [...node.options, ...(node.hiddenOptions ?? [])]) {
      if (reservedAliases.has(option)) {
        throw new Error(`Reserved alias token is not allowed: ${[...node.path, option].join(" ")}`);
      }
      if (optionNames.has(option) || immediateTokens.has(option)) {
        throw new Error(`Duplicate command token: ${[...node.path, option].join(" ")}`);
      }
      optionNames.add(option);
    }

    const sectionIds = new Set<string>();
    const sectionEntries = new Set<string>();
    for (const section of node.sections) {
      if (sectionIds.has(section.id)) {
        throw new Error(`Duplicate command section: ${[...node.path, section.id].join(" ")}`);
      }
      if (section.id.trim().length === 0 || section.title.trim().length === 0) {
        throw new Error(`Command section id and title are required: ${node.path.join(" ")}`);
      }
      sectionIds.add(section.id);
      for (const entry of section.entries) {
        if (!immediateTokens.has(entry)) {
          throw new Error(`Unknown section entry: ${[...node.path, entry].join(" ")}`);
        }
        if (sectionEntries.has(entry)) {
          throw new Error(`Duplicate section entry: ${[...node.path, entry].join(" ")}`);
        }
        sectionEntries.add(entry);
      }
    }
    for (const token of immediateTokens) {
      if (!sectionEntries.has(token)) {
        throw new Error(`Missing from command sections: ${[...node.path, token].join(" ")}`);
      }
    }

    for (const [option, values] of Object.entries(node.optionValues)) {
      if (!optionNames.has(option)) {
        throw new Error(`Option values reference unknown option: ${[...node.path, option].join(" ")}`);
      }
      if (new Set(values).size !== values.length) {
        throw new Error(`Duplicate option value: ${[...node.path, option].join(" ")}`);
      }
      if (values.some((value) => value.trim().length === 0)) {
        throw new Error(`Empty option value is not allowed: ${[...node.path, option].join(" ")}`);
      }
    }
    const argumentValuePositions = new Set<number>();
    for (const [positionText, values] of Object.entries(node.argumentValues)) {
      const position = Number(positionText);
      if (!Number.isInteger(position) || position < 0) {
        throw new Error(`Argument value positions must be non-negative integers: ${node.path.join(" ")}`);
      }
      argumentValuePositions.add(position);
      if (new Set(values).size !== values.length) {
        throw new Error(`Duplicate argument value: ${node.path.join(" ")} argument ${position}`);
      }
      if (values.some((value) => value.trim().length === 0)) {
        throw new Error(`Empty argument value is not allowed: ${node.path.join(" ")} argument ${position}`);
      }
    }
    if (new Set(node.fileOptions).size !== node.fileOptions.length) {
      throw new Error(`Duplicate file completion option: ${node.path.join(" ")}`);
    }
    for (const option of node.fileOptions) {
      if (!optionNames.has(option)) {
        throw new Error(`File completion references unknown option: ${[...node.path, option].join(" ")}`);
      }
    }
    if (new Set(node.executableOptions).size !== node.executableOptions.length) {
      throw new Error(`Duplicate executable completion option: ${node.path.join(" ")}`);
    }
    for (const option of node.executableOptions) {
      if (!optionNames.has(option)) {
        throw new Error(`Executable completion references unknown option: ${[...node.path, option].join(" ")}`);
      }
    }
    for (const option of optionNames) {
      const owners = Number(Object.hasOwn(node.optionValues, option))
        + Number(node.fileOptions.includes(option))
        + Number(node.executableOptions.includes(option));
      if (owners > 1) {
        throw new Error(`Multiple completion owners for option: ${[...node.path, option].join(" ")}`);
      }
    }
    if (new Set(node.fileArguments).size !== node.fileArguments.length || node.fileArguments.some((index) => !Number.isInteger(index) || index < 0)) {
      throw new Error(`File argument positions must be unique non-negative integers: ${node.path.join(" ")}`);
    }
    for (const position of node.fileArguments) {
      if (argumentValuePositions.has(position)) {
        throw new Error(`Multiple completion owners for argument ${position}: ${node.path.join(" ")}`);
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  if (commandPathProviders.length > 1) {
    throw new Error(`Multiple command-path providers are not allowed: ${root.path.join(" ")}`);
  }
  const commandPathProvider = commandPathProviders[0];
  if (commandPathProvider !== undefined && commandPathProvider.path.length !== root.path.length + 1) {
    throw new Error(`Command-path provider must be a root command: ${commandPathProvider.path.join(" ")}`);
  }
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
