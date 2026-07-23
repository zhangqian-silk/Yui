import { supportedAgentAdapterIds } from "../agent/adapterCatalog.js";

export type CommandNodeKind = "group" | "leaf" | "hybrid";
export type CompletionProviderId = "role-agent";

export type CommandValue = Readonly<{
  name: string;
  summary: string;
}>;

export type CommandSection = Readonly<{
  id: string;
  title: string;
  entries: readonly string[];
}>;

export type CommandNode = Readonly<{
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
}>;

type NodeInput = Readonly<{
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
}>;

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
    sections: Object.freeze((input.sections ?? []).map((section) => Object.freeze({
      ...section,
      entries: Object.freeze([...section.entries])
    }))),
    children: Object.freeze(children),
    hidden: input.hidden ?? false,
    options: Object.freeze([...(input.options ?? [])]),
    hiddenOptions: Object.freeze([...(input.hiddenOptions ?? [])]),
    values: Object.freeze((input.values ?? []).map((value) => Object.freeze(
      typeof value === "string" ? { name: value, summary: value } : { ...value }
    ))),
    optionValues: freezeRecord(input.optionValues),
    argumentValues: freezeRecord(input.argumentValues),
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

function freezeRecord<T extends string | number>(
  record: Readonly<Record<T, readonly string[]>> | undefined
): Readonly<Record<T, readonly string[]>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(record ?? {}).map(([key, values]) => [key, Object.freeze([...(values as readonly string[])])])
  )) as Readonly<Record<T, readonly string[]>>;
}

const agentChildren: readonly NodeInput[] = [
  {
    name: "add",
    summary: "Add a configured native Agent CLI.",
    usage: "yui agent add <id> [--adapter <adapter>] --command <command> [--arg <arg> ...] [--env TARGET=PROCESS_NAME ...]",
    options: ["--adapter", "--command", "--arg", "--env"],
    optionValues: { "--adapter": supportedAgentAdapterIds() },
    executableOptions: ["--command"]
  },
  { name: "list", summary: "List configured Agents." },
  { name: "show", summary: "Show one configured Agent.", usage: "yui agent show <id>" },
  {
    name: "update",
    summary: "Update a configured Agent.",
    usage: "yui agent update <id> [--adapter <adapter>] [--command <command>] [--arg <arg> ... | --clear-args] [--env TARGET=PROCESS_NAME ... | --clear-env]",
    options: ["--adapter", "--command", "--arg", "--clear-args", "--env", "--clear-env"],
    optionValues: { "--adapter": supportedAgentAdapterIds() },
    executableOptions: ["--command"]
  },
  { name: "remove", summary: "Remove a configured Agent.", usage: "yui agent remove <id>" }
];

const roleProfileOptions = [
  "--description", "--responsibility", "--constraint",
  "--expected-output", "--system-prompt", "--skill"
] as const;
const roleAgentOptions = [
  "--model", "--effort", "--sandbox", "--approval", "--permission-mode", "--search"
] as const;
const roleProfileClearOptions = [
  "--clear-description", "--clear-responsibilities", "--clear-constraints",
  "--clear-expected-output", "--clear-system-prompt", "--clear-skills"
] as const;
const roleAgentClearOptions = [
  "--clear-model", "--clear-effort", "--clear-sandbox", "--clear-approval",
  "--clear-permission-mode", "--clear-search", "--clear-agent-config"
] as const;
const roleAgentOptionValues = {
  "--sandbox": ["read-only", "workspace-write", "danger-full-access"],
  "--approval": ["untrusted", "on-request", "never"],
  "--search": ["true"]
} as const;

const roleChildren: readonly NodeInput[] = [
  {
    name: "add",
    summary: "Add a reusable global Role.",
    usage: "yui role add <name> --agent <id> [Role and Agent settings]",
    options: ["--agent", "--workspace", ...roleProfileOptions, ...roleAgentOptions],
    optionValues: roleAgentOptionValues,
    fileOptions: ["--workspace"]
  },
  { name: "list", summary: "List global Roles." },
  { name: "show", summary: "Show one global Role.", usage: "yui role show <name>" },
  {
    name: "update",
    summary: "Update a global Role.",
    usage: "yui role update <name> [profile options] [clear options]",
    options: ["--agent", "--workspace", ...roleProfileOptions, ...roleAgentOptions,
      ...roleProfileClearOptions, ...roleAgentClearOptions],
    optionValues: roleAgentOptionValues,
    fileOptions: ["--workspace"]
  },
  { name: "remove", summary: "Remove a global Role.", usage: "yui role remove <name>" },
  { name: "bind", summary: "Bind and activate an Agent for a global Role.", usage: "yui role bind <role> <agent-id>" },
  { name: "enter", summary: "Enter a global Role's native session.", usage: "yui role enter <role>" },
  {
    name: "session",
    summary: "Manage native session IDs for a global Role.",
    sections: [{ id: "manage", title: "Commands", entries: ["record", "replace"] }],
    children: [
      {
        name: "record",
        summary: "Record the active Agent's native session ID.",
        usage: "yui role session record <role> --native-id <id>",
        options: ["--native-id"]
      },
      {
        name: "replace",
        summary: "Explicitly replace the active Agent's native session ID.",
        usage: "yui role session replace <role> --native-id <id> --reason <text>",
        options: ["--native-id", "--reason"]
      }
    ]
  }
];

const taskChildren: readonly NodeInput[] = [
  {
    name: "create",
    summary: "Create a Draft Task.",
    usage: "yui task create <title> [--repository <id>] [--base <ref>]",
    options: ["--repository", "--base"]
  },
  {
    name: "update",
    summary: "Update Task metadata.",
    usage: "yui task update <id> [--title <text>] [--description <text>|--clear-description] [--priority <low|medium|high|urgent>|--clear-priority] [--tags <comma-separated>|--clear-tags] [--due-at <RFC3339>|--clear-due-at]",
    options: [
      "--title", "--description", "--priority", "--tags", "--due-at",
      "--clear-description", "--clear-priority", "--clear-tags", "--clear-due-at"
    ],
    optionValues: { "--priority": ["low", "medium", "high", "urgent"] }
  },
  { name: "activate", summary: "Activate a Draft Task.", usage: "yui task activate <id>" },
  {
    name: "complete",
    summary: "Complete an active Task and stop automatic wakeups.",
    usage: "yui task complete <id> --summary <text>",
    options: ["--summary"]
  },
  { name: "reopen", summary: "Reopen a completed Task.", usage: "yui task reopen <id>" },
  { name: "list", summary: "List Tasks." },
  { name: "show", summary: "Show a Task.", usage: "yui task show <id>" },
  {
    name: "context",
    summary: "Show consolidated working context for a Task.",
    usage: "yui task context <task>"
  },
  { name: "archive", summary: "Archive a Task.", usage: "yui task archive <id>" },
  { name: "reconcile", summary: "Run one immediate Controller reconciliation.", usage: "yui task reconcile <id>" },
  {
    name: "message",
    summary: "Manage durable Task messages.",
    sections: [{ id: "manage", title: "Commands", entries: ["send", "list"] }],
    children: [
      { name: "send", summary: "Send a Task message.", usage: "yui task message send <id> <body>" },
      { name: "list", summary: "List Task messages.", usage: "yui task message list <id>" }
    ]
  },
  {
    name: "input",
    summary: "Manage durable Task-owned input requests.",
    sections: [{ id: "manage", title: "Commands", entries: ["request", "list", "show", "answer", "cancel"] }],
    children: [
      {
        name: "request",
        summary: "Pause the active Leader Run and request user input.",
        usage: "yui task input request <task> --question <text> [--choice <key=label> ...] [--blocks <work-item:id|run:id> ...] [--recommend <key> --timeout-seconds <seconds>]",
        options: ["--question", "--choice", "--blocks", "--recommend", "--timeout-seconds"]
      },
      {
        name: "list",
        summary: "List the global Inbox or one Task's input requests.",
        usage: "yui task input list [task] [--all]",
        options: ["--all"]
      },
      {
        name: "show",
        summary: "Show one input request.",
        usage: "yui task input show <input> [--task <task>]",
        options: ["--task"]
      },
      {
        name: "answer",
        summary: "Answer one open input request.",
        usage: "yui task input answer <input> [--task <task>] (--choice <key> | --text <text>)",
        options: ["--task", "--choice", "--text"]
      },
      {
        name: "cancel",
        summary: "Cancel an open request from its originating Leader.",
        usage: "yui task input cancel <task> <input> --reason <text>",
        options: ["--reason"]
      }
    ]
  },
  {
    name: "role",
    summary: "Manage Roles within a Task.",
    sections: [{ id: "manage", title: "Commands", entries: [
      "add", "list", "status", "show", "update", "remove", "bind", "enter"
    ] }],
    children: [
      {
        name: "add",
        summary: "Add a Role to a Task.",
        usage: "yui task role add <task> <name> [--agent <id>] [Role and Agent settings]",
        options: ["--agent", ...roleProfileOptions, ...roleAgentOptions],
        optionValues: roleAgentOptionValues
      },
      { name: "list", summary: "List Task Roles.", usage: "yui task role list <task>" },
      {
        name: "status",
        summary: "Show persisted and live runtime state for one Task Role.",
        usage: "yui task role status <task> <role>"
      },
      { name: "show", summary: "Show one Task Role.", usage: "yui task role show <task> <role>" },
      {
        name: "update",
        summary: "Update a Task Role.",
        usage: "yui task role update <task> <role> [Role and Agent settings]",
        options: ["--agent", ...roleProfileOptions, ...roleAgentOptions,
          ...roleProfileClearOptions, ...roleAgentClearOptions],
        optionValues: roleAgentOptionValues
      },
      { name: "remove", summary: "Remove a Task Role.", usage: "yui task role remove <task> <role>" },
      { name: "bind", summary: "Bind and activate an Agent for a Task Role.", usage: "yui task role bind <task> <role> <agent-id>" },
      { name: "enter", summary: "Enter a Task Role's native session.", usage: "yui task role enter <task> <role>" }
    ]
  },
  {
    name: "work",
    summary: "Manage finite Task work items.",
    sections: [{ id: "manage", title: "Commands", entries: ["create", "list", "update", "dispatch"] }],
    children: [
      {
        name: "create",
        summary: "Create a work item.",
        usage: "yui task work create <task> <title> [--role <name>]",
        options: ["--role"]
      },
      { name: "list", summary: "List work items for a Task.", usage: "yui task work list <task>" },
      {
        name: "update",
        summary: "Update a work item's state.",
        usage: "yui task work update <id> <todo|running|done|failed> [--summary <text>]",
        options: ["--summary"],
        argumentValues: { 1: ["todo", "running", "done", "failed"] }
      },
      {
        name: "dispatch",
        summary: "Dispatch a work item to its Role.",
        usage: "yui task work dispatch <id> [--input <text>]",
        options: ["--input"]
      }
    ]
  },
  {
    name: "run",
    summary: "Inspect and control Agent Runs.",
    sections: [{ id: "manage", title: "Commands", entries: ["list", "retry", "yield"] }],
    children: [
      { name: "list", summary: "List Runs for a work item.", usage: "yui task run list <work>" },
      { name: "retry", summary: "Retry a failed Run.", usage: "yui task run retry <run>" },
      {
        name: "yield",
        summary: "Complete an active Run and wake the Leader.",
        usage: "yui task run yield <run> --summary <text>",
        options: ["--summary"]
      }
    ]
  },
  {
    name: "brief",
    summary: "Manage the Task Brief, the authoritative summary of current task state.",
    sections: [{ id: "manage", title: "Commands", entries: ["show", "update"] }],
    children: [
      { name: "show", summary: "Show the Task Brief.", usage: "yui task brief show <task>" },
      {
        name: "update",
        summary: "Create or update the Task Brief.",
        usage: "yui task brief update <task> [--objective <text>] [--boundary <text> ...] [--focus <text>] [--leader-summary <text>]",
        options: ["--objective", "--boundary", "--focus", "--leader-summary"]
      }
    ]
  },
  {
    name: "decision",
    summary: "Record and supersede durable Task decisions.",
    sections: [{ id: "manage", title: "Commands", entries: ["record", "list", "show", "supersede"] }],
    children: [
      {
        name: "record",
        summary: "Record a new active Decision.",
        usage: "yui task decision record <task> --title <text> --rationale <text>",
        options: ["--title", "--rationale"]
      },
      {
        name: "list",
        summary: "List Decisions for a Task.",
        usage: "yui task decision list <task> [--status active|superseded]",
        options: ["--status"],
        optionValues: { "--status": ["active", "superseded"] }
      },
      { name: "show", summary: "Show one Decision.", usage: "yui task decision show <task> <decision>" },
      {
        name: "supersede",
        summary: "Mark a Decision as superseded.",
        usage: "yui task decision supersede <task> <decision> --reason <text>",
        options: ["--reason"]
      }
    ]
  },
  {
    name: "milestone",
    summary: "Append immutable Milestone records for completed progress.",
    sections: [{ id: "manage", title: "Commands", entries: ["add", "list", "show"] }],
    children: [
      {
        name: "add",
        summary: "Append a Milestone to a Task.",
        usage: "yui task milestone add <task> --title <text> --summary <text>",
        options: ["--title", "--summary"]
      },
      { name: "list", summary: "List Milestones for a Task.", usage: "yui task milestone list <task>" },
      { name: "show", summary: "Show one Milestone.", usage: "yui task milestone show <task> <milestone>" }
    ]
  },
  {
    name: "event",
    summary: "Inspect the durable Task event history.",
    sections: [{ id: "manage", title: "Commands", entries: ["list", "show"] }],
    children: [
      { name: "list", summary: "List Task events.", usage: "yui task event list <task>" },
      { name: "show", summary: "Show one Task event.", usage: "yui task event show <task> <event>" }
    ]
  },
  { name: "enter", summary: "Enter a Task Role, defaulting to Leader.", usage: "yui task enter <task> [role]" }
];

export const ROOT_COMMAND = buildNode({
  name: "yui",
  summary: "Coordinate native Agent CLI sessions through tmux.",
  usage: "yui [--json] <command>",
  sections: [
    { id: "general", title: "General", entries: ["help", "version", "update", "setup", "doctor", "completion"] },
    { id: "workflow", title: "Workflow", entries: ["operator", "repository", "task"] },
    { id: "configuration", title: "Configuration", entries: ["config", "agent", "role"] },
    { id: "operations", title: "Operations", entries: ["controller", "jobs"] },
    { id: "internal", title: "Internal", entries: ["internal"] }
  ],
  children: [
    { name: "help", summary: "Show root or scoped command help.", usage: "yui help [command ...]", commandPathArguments: true },
    { name: "version", summary: "Print the installed Yui version." },
    { name: "update", summary: "Install the latest published Yui package globally." },
    { name: "setup", summary: "Initialize or update Yui configuration." },
    { name: "doctor", summary: "Check Yui dependencies and file state." },
    {
      name: "completion",
      summary: "Interactively configure shell completion.",
      executable: true,
      acceptsArguments: false,
      usage: ["yui completion", "yui completion <bash|zsh|fish>"],
      sections: [
        { id: "shells", title: "Shells", entries: ["bash", "zsh", "fish"] },
        { id: "internal", title: "Internal", entries: ["candidates"] }
      ],
      children: [
        { name: "bash", summary: "Interactively configure Bash completion." },
        { name: "zsh", summary: "Interactively configure Zsh completion." },
        { name: "fish", summary: "Interactively configure Fish completion." },
        {
          name: "candidates",
          summary: "Resolve internal dynamic completion candidates.",
          usage: "yui completion candidates <prefix> -- <words...>",
          hidden: true
        }
      ]
    },
    {
      name: "controller",
      summary: "Inspect, stop, or restart the local Controller.",
      sections: [{ id: "lifecycle", title: "Commands", entries: ["status", "stop", "restart"] }],
      children: [
        { name: "status", summary: "Show Controller status." },
        { name: "stop", summary: "Stop the Controller." },
        { name: "restart", summary: "Restart internal services without stopping tmux sessions." }
      ]
    },
    {
      name: "config",
      summary: "Inspect or update Yui configuration.",
      sections: [{ id: "manage", title: "Commands", entries: ["show", "set"] }],
      children: [
        { name: "show", summary: "Show effective Yui configuration." },
        {
          name: "set",
          summary: "Update Yui configuration.",
          usage: "yui config set --time-zone <IANA timezone>",
          options: ["--time-zone"]
        }
      ]
    },
    {
      name: "operator",
      summary: "Use the persistent Operator Role.",
      sections: [{ id: "workflow", title: "Commands", entries: ["enter", "submit"] }],
      children: [
        { name: "enter", summary: "Enter the Operator's native session." },
        {
          name: "submit",
          summary: "Submit work through the Operator.",
          usage: "yui operator submit <body> [--task <id>]",
          options: ["--task"]
        }
      ]
    },
    {
      name: "repository",
      summary: "Manage Git repositories available to Tasks.",
      sections: [{ id: "manage", title: "Commands", entries: ["add", "list"] }],
      children: [
        {
          name: "add",
          summary: "Register a Git repository.",
          usage: "yui repository add <name> <path> [--base <ref>]",
          options: ["--base"],
          fileArguments: [1]
        },
        { name: "list", summary: "List registered repositories." }
      ]
    },
    {
      name: "agent",
      summary: "Manage configured native Agent CLIs.",
      sections: [
        { id: "inspect", title: "Inspect", entries: ["list", "show"] },
        { id: "manage", title: "Manage", entries: ["add", "update", "remove"] }
      ],
      children: agentChildren
    },
    {
      name: "role",
      summary: "Manage reusable global Roles and their native sessions.",
      sections: [
        { id: "inspect", title: "Inspect", entries: ["list", "show"] },
        { id: "manage", title: "Manage", entries: ["add", "update", "remove", "bind"] },
        { id: "sessions", title: "Sessions", entries: ["enter", "session"] }
      ],
      children: roleChildren
    },
    {
      name: "task",
      summary: "Manage Tasks, Roles, work items, and Runs.",
      sections: [
        { id: "lifecycle", title: "Lifecycle", entries: ["create", "update", "activate", "complete", "reopen", "list", "show", "context", "archive", "reconcile"] },
        { id: "collaboration", title: "Collaboration", entries: ["message", "input", "role", "work", "run", "enter"] },
        { id: "knowledge", title: "Task Knowledge", entries: ["brief", "decision", "milestone", "event"] }
      ],
      children: taskChildren
    },
    {
      name: "jobs",
      summary: "Inspect scheduler wake and recovery records.",
      sections: [{ id: "manage", title: "Commands", entries: ["list", "retry"] }],
      children: [
        { name: "list", summary: "List scheduler wake and recovery records." },
        { name: "retry", summary: "Retry a failed Leader recovery.", usage: "yui jobs retry <id>" }
      ]
    },
    {
      name: "internal",
      summary: "Internal Yui callbacks.",
      hidden: true,
      sections: [{ id: "callbacks", title: "Callbacks", entries: ["session-notify"] }],
      children: [{
        name: "session-notify",
        summary: "Record a structured native session notification.",
        usage: "yui internal session-notify <payload>"
      }]
    }
  ]
});

export function visibleChildren(node: CommandNode): readonly CommandNode[] {
  const byName = new Map(node.children.map((child) => [child.name, child]));
  return node.sections.flatMap((section) => section.entries.flatMap((entry) => {
    const child = byName.get(entry);
    return child === undefined || child.hidden ? [] : [child];
  }));
}

export type VisibleCommandSection = Readonly<{
  id: string;
  title: string;
  entries: readonly (CommandNode | CommandValue)[];
}>;

export function visibleCommandSections(node: CommandNode): readonly VisibleCommandSection[] {
  const children = new Map(node.children.map((child) => [child.name, child]));
  const values = new Map(node.values.map((value) => [value.name, value]));
  return node.sections.flatMap((section) => {
    const entries = section.entries.flatMap((entry) => {
      const child = children.get(entry);
      if (child !== undefined) return child.hidden ? [] : [child];
      const value = values.get(entry);
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

export function findCommandNode(path: readonly string[]): CommandNode | undefined {
  let node = ROOT_COMMAND;
  for (const segment of path[0] === ROOT_COMMAND.name ? path.slice(1) : path) {
    const child = findChild(node, segment);
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
}

export const findCommand = findCommandNode;

export function validateCommandCatalog(root: CommandNode): void {
  const reservedAliases = new Set(["-h", "--help", "-help", "-v", "--version"]);
  const commandPathProviders: CommandNode[] = [];
  const visit = (node: CommandNode): void => {
    if (node.summary.trim().length === 0) throw new Error(`Command summary is required: ${node.path.join(" ")}`);
    if (node.usage.length === 0) throw new Error(`Command usage is required: ${node.path.join(" ")}`);
    if (node.commandPathArguments) {
      commandPathProviders.push(node);
      const ownsOtherCompletionMetadata = node.kind !== "leaf"
        || node.hidden
        || node.children.length > 0
        || node.values.length > 0
        || node.sections.length > 0
        || node.options.length > 0
        || node.hiddenOptions.length > 0
        || Object.keys(node.optionValues).length > 0
        || Object.keys(node.argumentValues).length > 0
        || node.fileOptions.length > 0
        || node.fileArguments.length > 0
        || node.executableOptions.length > 0;
      if (ownsOtherCompletionMetadata) {
        throw new Error(`Command-path provider must be a visible metadata-free leaf: ${node.path.join(" ")}`);
      }
    }

    const immediate = new Set<string>();
    for (const child of node.children) {
      if (immediate.has(child.name)) throw new Error(`Duplicate command path: ${child.path.join(" ")}`);
      if (reservedAliases.has(child.name)) throw new Error(`Reserved alias token is not allowed: ${child.path.join(" ")}`);
      immediate.add(child.name);
    }
    for (const value of node.values) {
      if (value.name.trim().length === 0) throw new Error(`Command value name is required: ${node.path.join(" ")}`);
      if (value.summary.trim().length === 0) throw new Error(`Command value summary is required: ${[...node.path, value.name].join(" ")}`);
      if (immediate.has(value.name)) throw new Error(`Duplicate command token: ${[...node.path, value.name].join(" ")}`);
      immediate.add(value.name);
    }

    const options = new Set<string>();
    for (const option of [...node.options, ...node.hiddenOptions]) {
      if (reservedAliases.has(option)) throw new Error(`Reserved alias token is not allowed: ${[...node.path, option].join(" ")}`);
      if (options.has(option) || immediate.has(option)) throw new Error(`Duplicate command token: ${[...node.path, option].join(" ")}`);
      options.add(option);
    }

    const sectionIds = new Set<string>();
    const sectionEntries = new Set<string>();
    for (const section of node.sections) {
      if (sectionIds.has(section.id)) throw new Error(`Duplicate command section: ${[...node.path, section.id].join(" ")}`);
      if (section.id.trim().length === 0 || section.title.trim().length === 0) {
        throw new Error(`Command section id and title are required: ${node.path.join(" ")}`);
      }
      sectionIds.add(section.id);
      for (const entry of section.entries) {
        if (!immediate.has(entry)) throw new Error(`Unknown section entry: ${[...node.path, entry].join(" ")}`);
        if (sectionEntries.has(entry)) throw new Error(`Duplicate section entry: ${[...node.path, entry].join(" ")}`);
        sectionEntries.add(entry);
      }
    }
    for (const token of immediate) {
      if (!sectionEntries.has(token)) throw new Error(`Missing from command sections: ${[...node.path, token].join(" ")}`);
    }

    for (const [option, values] of Object.entries(node.optionValues)) {
      if (!options.has(option)) throw new Error(`Option values reference unknown option: ${[...node.path, option].join(" ")}`);
      if (new Set(values).size !== values.length) throw new Error(`Duplicate option value: ${[...node.path, option].join(" ")}`);
    }
    const argumentValuePositions = new Set<number>();
    for (const [positionText, values] of Object.entries(node.argumentValues)) {
      const position = Number(positionText);
      if (!Number.isInteger(position) || position < 0) throw new Error(`Argument value positions must be non-negative integers: ${node.path.join(" ")}`);
      argumentValuePositions.add(position);
      if (new Set(values).size !== values.length) throw new Error(`Duplicate argument value: ${node.path.join(" ")} argument ${position}`);
    }
    if (new Set(node.fileOptions).size !== node.fileOptions.length) throw new Error(`Duplicate file completion option: ${node.path.join(" ")}`);
    for (const option of node.fileOptions) {
      if (!options.has(option)) throw new Error(`File completion references unknown option: ${[...node.path, option].join(" ")}`);
    }
    if (new Set(node.executableOptions).size !== node.executableOptions.length) throw new Error(`Duplicate executable completion option: ${node.path.join(" ")}`);
    for (const option of node.executableOptions) {
      if (!options.has(option)) throw new Error(`Executable completion references unknown option: ${[...node.path, option].join(" ")}`);
    }
    for (const option of options) {
      const owners = Number(Object.hasOwn(node.optionValues, option))
        + Number(node.fileOptions.includes(option))
        + Number(node.executableOptions.includes(option));
      if (owners > 1) throw new Error(`Multiple completion owners for option: ${[...node.path, option].join(" ")}`);
    }
    if (new Set(node.fileArguments).size !== node.fileArguments.length
      || node.fileArguments.some((index) => !Number.isInteger(index) || index < 0)) {
      throw new Error(`File argument positions must be unique non-negative integers: ${node.path.join(" ")}`);
    }
    for (const position of node.fileArguments) {
      if (argumentValuePositions.has(position)) throw new Error(`Multiple completion owners for argument ${position}: ${node.path.join(" ")}`);
    }
    node.children.forEach(visit);
  };
  visit(root);
  if (commandPathProviders.length > 1) throw new Error(`Multiple command-path providers are not allowed: ${root.path.join(" ")}`);
  const provider = commandPathProviders[0];
  if (provider !== undefined && provider.path.length !== root.path.length + 1) {
    throw new Error(`Command-path provider must be a root command: ${provider.path.join(" ")}`);
  }
}

export function listPublicCommandPaths(root: CommandNode = ROOT_COMMAND): string[] {
  const paths: string[] = [];
  const visit = (node: CommandNode): void => {
    if (!node.hidden && node !== root) paths.push(node.path.slice(1).join(" "));
    node.children.filter((child) => !child.hidden).forEach(visit);
  };
  visit(root);
  return paths;
}

validateCommandCatalog(ROOT_COMMAND);
