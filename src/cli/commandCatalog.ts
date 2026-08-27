import { supportedAgentAdapterIds } from "../agent/adapterCatalog.js";
import {
  CONFIG_DEFINITIONS,
  CONFIG_DOMAINS,
  configDefinitionsForDomain,
  type ConfigDomain
} from "../config/configCatalog.js";

export type CommandNodeKind = "group" | "leaf" | "hybrid";
export type CompletionProviderId = "role-agent";

export type CommandValue = Readonly<{
  name: string;
  summary: string;
  takesEffect?: string;
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
  examples: readonly string[];
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
  examples?: string | readonly string[];
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
  const examples = input.examples === undefined
    ? usage
    : typeof input.examples === "string" ? [input.examples] : [...input.examples];
  return Object.freeze({
    name: input.name,
    path: Object.freeze(path),
    summary: input.summary,
    kind: children.length === 0 ? "leaf" : executable ? "hybrid" : "group",
    usage: Object.freeze(usage),
    examples: Object.freeze(examples),
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

const CONFIG_KEY_VALUES: readonly CommandValue[] = CONFIG_DEFINITIONS.map((definition) => ({
  name: definition.key,
  summary: definition.summary,
  takesEffect: definition.takesEffect
}));

const CONFIG_DOMAIN_SUMMARIES: Readonly<Record<ConfigDomain, string>> = {
  system: "Configure Home-wide defaults and human-facing presentation.",
  runtime: "Configure Controller recovery, concurrency, health, launch, delivery, and Provider retry policy.",
  workflow: "Configure Leader convergence, context, and optional review policy.",
  resources: "Configure resource garbage collection and quarantine policy.",
  tools: "Configure tmux and optional diagnostic telemetry."
};

function durableConfigDomainNode(domain: ConfigDomain): NodeInput {
  const definitions = configDefinitionsForDomain(domain);
  const keys = definitions.map(({ key }) => key);
  const values = CONFIG_KEY_VALUES.filter(({ name }) => keys.includes(name));
  const options = domain === "workflow"
    ? [
        "--soft-tokens", "--hard-tokens", "--role", "--trigger", "--finding-ledger",
        "--delta-recheck", "--delta-recheck-max-lines", "--delta-recheck-max-files"
      ]
    : domain === "runtime"
      ? ["--quiet-after-seconds", "--diagnostic-after-seconds", "--stall-after-seconds"]
      : [];
  return {
    name: domain,
    summary: CONFIG_DOMAIN_SUMMARIES[domain],
    examples: [
      `yui config ${domain} show`,
      `yui config ${domain} set ${keys[0]} <value>`,
      `yui config ${domain} clear ${keys[0]}`
    ],
    sections: [{ id: "manage", title: "Commands", entries: ["show", "set", "clear"] }],
    children: [
      { name: "show", summary: `Show effective ${domain} configuration.` },
      {
        name: "set",
        summary: `Set one ${domain} configuration key.`,
        usage: `yui config ${domain} set <key> <value...>`,
        sections: [{ id: "keys", title: "Configuration keys", entries: keys }],
        values,
        options,
        optionValues: domain === "workflow"
          ? {
              "--trigger": ["always", "leader", "final"],
              "--finding-ledger": ["shadow", "enforce"],
              "--delta-recheck": ["enabled", "disabled"]
            }
          : {}
      },
      {
        name: "clear",
        summary: `Reset one ${domain} configuration key to its default.`,
        usage: `yui config ${domain} clear <key>`,
        sections: [{ id: "keys", title: "Configuration keys", entries: keys }],
        values
      }
    ]
  };
}

const agentChildren: readonly NodeInput[] = [
  {
    name: "add",
    summary: "Add a configured native Agent CLI.",
    usage: "yui config agent add <id> [--adapter <adapter>] --command <command> [--arg <arg> ...] [--env TARGET=PROCESS_NAME ...]",
    options: ["--adapter", "--command", "--arg", "--env"],
    optionValues: { "--adapter": supportedAgentAdapterIds() },
    executableOptions: ["--command"]
  },
  { name: "list", summary: "List configured Agents." },
  { name: "show", summary: "Show one configured Agent.", usage: "yui config agent show <id>" },
  {
    name: "capabilities",
    summary: "Probe one Agent CLI for runtime configuration options.",
    usage: "yui config agent capabilities <id>"
  },
  {
    name: "update",
    summary: "Update a configured Agent.",
    usage: "yui config agent update <id> [--adapter <adapter>] [--command <command>] [--arg <arg> ... | --clear-args] [--env TARGET=PROCESS_NAME ... | --clear-env]",
    options: ["--adapter", "--command", "--arg", "--clear-args", "--env", "--clear-env"],
    optionValues: { "--adapter": supportedAgentAdapterIds() },
    executableOptions: ["--command"]
  },
  { name: "remove", summary: "Remove a configured Agent.", usage: "yui config agent remove <id>" }
];

const roleProfileOptions = [
  "--description", "--responsibility", "--constraint",
  "--expected-output", "--system-prompt", "--skill"
] as const;
const roleAgentOptions = [
  "--model", "--effort", "--permission-strategy", "--sandbox", "--approval", "--permission-mode",
  "--allowed-tool", "--disallowed-tool", "--search"
] as const;
const roleProfileClearOptions = [
  "--clear-description", "--clear-responsibilities", "--clear-constraints",
  "--clear-expected-output", "--clear-system-prompt", "--clear-skills"
] as const;
const roleAgentClearOptions = [
  "--clear-model", "--clear-effort", "--clear-allowed-tools", "--clear-disallowed-tools",
  "--clear-search", "--clear-agent-config"
] as const;
const agentProfileOptions = [
  "--description", "--instructions", "--skill", "--model", "--effort"
] as const;
const agentProfileClearOptions = [
  "--clear-description", "--clear-instructions", "--clear-skills",
  "--clear-model", "--clear-effort"
] as const;
const roleAgentOptionValues = {
  "--sandbox": ["read-only", "workspace-write", "danger-full-access"],
  "--approval": ["untrusted", "on-request", "never"],
  "--permission-strategy": ["default", "bypass", "configured"],
  "--search": ["true"]
} as const;

const roleChildren: readonly NodeInput[] = [
  {
    name: "add",
    summary: "Add a reusable global Role.",
    usage: "yui config role add <name> --agent <id> [Role and Agent settings]",
    options: ["--agent", "--workspace", ...roleProfileOptions, ...roleAgentOptions],
    optionValues: roleAgentOptionValues,
    fileOptions: ["--workspace"]
  },
  { name: "list", summary: "List global Roles." },
  { name: "show", summary: "Show one global Role.", usage: "yui config role show <name>" },
  {
    name: "update",
    summary: "Update a global Role.",
    usage: "yui config role update <name> [profile options] [clear options]",
    options: ["--agent", "--workspace", ...roleProfileOptions, ...roleAgentOptions,
      ...roleProfileClearOptions, ...roleAgentClearOptions],
    optionValues: roleAgentOptionValues,
    fileOptions: ["--workspace"]
  },
  { name: "remove", summary: "Remove a global Role.", usage: "yui config role remove <name>" },
  { name: "bind", summary: "Bind and activate an Agent for a global Role.", usage: "yui config role bind <role> <agent-id>" },
  { name: "unbind", summary: "Unbind a dormant Agent from a global Role.", usage: "yui config role unbind <role> <agent-id>" }
];

const globalSessionChildren: readonly NodeInput[] = [
  { name: "enter", summary: "Enter a global Role's native session.", usage: "yui session enter <role>" },
  {
    name: "context",
    summary: "Load the exact authorized global Role context.",
    usage: "yui session context <role>"
  },
  {
    name: "record",
    summary: "Record the active Agent's native session ID.",
    usage: "yui session record <role> --native-id <id>",
    options: ["--native-id"]
  },
  {
    name: "replace",
    summary: "Explicitly replace the active Agent's native session ID.",
    usage: "yui session replace <role> --native-id <id> --reason <text>",
    options: ["--native-id", "--reason"]
  },
  {
    name: "stop",
    summary: "Stop all idle managed Sessions and the Controller before an offline update.",
    usage: "yui session stop --all",
    options: ["--all"]
  },
  {
    name: "reconcile",
    summary: "Reconcile durable Session owners with native sessions.",
    usage: "yui session reconcile [--report] [--cleanup]",
    options: ["--report", "--cleanup"]
  }
];

const profileChildren: readonly NodeInput[] = [
  {
    name: "add",
    summary: "Add a reusable Agent Profile.",
    usage: "yui config profile add <id> [--access <read|write>] [Profile settings]",
    options: ["--access", ...agentProfileOptions],
    optionValues: { "--access": ["read", "write"] }
  },
  { name: "list", summary: "List Agent Profiles." },
  { name: "show", summary: "Show one Agent Profile.", usage: "yui config profile show <id>" },
  {
    name: "update",
    summary: "Update an Agent Profile.",
    usage: "yui config profile update <id> [--access <read|write>] [Profile settings]",
    options: ["--access", ...agentProfileOptions, ...agentProfileClearOptions],
    optionValues: { "--access": ["read", "write"] }
  },
  { name: "remove", summary: "Remove a custom Agent Profile.", usage: "yui config profile remove <id>" },
  { name: "reset", summary: "Reset all built-in Agent Profiles." }
];

const completionChildren: readonly NodeInput[] = [
  { name: "bash", summary: "Interactively configure Bash completion." },
  { name: "zsh", summary: "Interactively configure Zsh completion." },
  { name: "fish", summary: "Interactively configure Fish completion." },
  {
    name: "candidates",
    summary: "Resolve internal dynamic completion candidates.",
    usage: "yui config completion candidates <prefix> -- <words...>",
    hidden: true
  }
];

const taskChildren: readonly NodeInput[] = [
  {
    name: "create",
    summary: "Create a Draft Task.",
    usage: "yui task create <title> [--type <project-defined-type>] [--project <project> ...] [--base <project>=<ref> ...]",
    options: ["--type", "--project", "--base"],
    optionValues: { "--type": ["feature", "bugfix"] }
  },
  {
    name: "project",
    summary: "Manage Projects bound to a Task.",
    sections: [{ id: "manage", title: "Commands", entries: ["list", "add"] }],
    children: [
      {
        name: "list",
        summary: "List the Projects bound to a Task.",
        usage: "yui task project list <task>"
      },
      {
        name: "add",
        summary: "Add a Project to a Task.",
        usage: "yui task project add <task> <project> [--base <ref>] [--directory <name>]",
        options: ["--base", "--directory"]
      }
    ]
  },
  {
    name: "update",
    summary: "Update Task metadata.",
    usage: "yui task update <id> [--title <text>] [--type <project-defined-type>|--clear-type] [--description <text>|--clear-description] [--priority <low|medium|high|urgent>|--clear-priority] [--tags <comma-separated>|--clear-tags] [--due-at <RFC3339>|--clear-due-at]",
    options: [
      "--title", "--type", "--description", "--priority", "--tags", "--due-at",
      "--clear-type",
      "--clear-description", "--clear-priority", "--clear-tags", "--clear-due-at",
    ],
    optionValues: {
      "--priority": ["low", "medium", "high", "urgent"],
      "--type": ["feature", "bugfix"]
    }
  },
  { name: "activate", summary: "Activate a Draft Task.", usage: "yui task activate <id>" },
  {
    name: "complete",
    summary: "Complete an active Task and stop automatic wakeups.",
    usage: "yui task complete <id> (--summary <text>|--summary-file <path|->) [--refresh-remote] [--accept-published-tree <publication-id>]",
    options: ["--summary", "--summary-file", "--refresh-remote", "--accept-published-tree"],
    fileOptions: ["--summary-file"]
  },
  {
    name: "base",
    summary: "Inspect Task Project baseline freshness.",
    sections: [{ id: "manage", title: "Commands", entries: ["status"] }],
    children: [
      {
        name: "status",
        summary: "Classify Task Project bases against local or refreshed remote refs.",
        usage: "yui task base status <task> [--refresh]",
        options: ["--refresh"]
      }
    ]
  },
  { name: "reopen", summary: "Reopen a completed Task.", usage: "yui task reopen <id>" },
  {
    name: "retire",
    summary: "Retire a stale Task while preserving its historical evidence.",
    usage: "yui task retire <task> (--summary <text>|--summary-file <path|->) [--replacement <task>]",
    options: ["--summary", "--summary-file", "--replacement"],
    fileOptions: ["--summary-file"]
  },
  {
    name: "list",
    summary: "List unarchived Task overviews.",
    usage: "yui task list [--all] [--verbose]",
    options: ["--all", "--verbose"]
  },
  { name: "show", summary: "Show a Task.", usage: "yui task show <id>" },
  {
    name: "context",
    summary: "Show consolidated working context for a Task.",
    usage: "yui task context <task>"
  },
  {
    name: "next-action",
    summary: "Project the durable Task records into one protocol-level next action.",
    usage: "yui task next-action <task> [--json]",
    options: ["--json"]
  },
  {
    name: "archive",
    summary: "Archive a Task after confirming the main worktree outcome.",
    usage: "yui task archive <id> (--integrated|--abandon)",
    options: ["--integrated", "--abandon"]
  },
  { name: "reconcile", summary: "Run one immediate Controller reconciliation.", usage: "yui task reconcile <id>" },
  {
    name: "rebuild",
    summary: "Rebuild a legacy Task workspace under its canonical identity.",
    usage: "yui task rebuild <task> [--latest]",
    options: ["--latest"]
  },
  {
    name: "upstream",
    summary: "Integrate upstream changes into an Active Task workspace.",
    sections: [{ id: "manage", title: "Commands", entries: ["integrate"] }],
    children: [
      {
        name: "integrate",
        summary: "Merge the remote development head into the Task workspace.",
        usage: "yui task upstream integrate <task> [--latest] [--project <project>]",
        options: ["--latest", "--project"]
      }
    ]
  },
  {
    name: "history",
    summary: "Inspect and archive legacy Task refs in the Home repository.",
    sections: [{ id: "manage", title: "Commands", entries: ["list", "archive"] }],
    children: [
      {
        name: "list",
        summary: "List legacy Task refs and their live owners.",
        usage: "yui task history list [task]"
      },
      {
        name: "archive",
        summary: "Archive legacy Task refs without a live owner.",
        usage: "yui task history archive [task]"
      }
    ]
  },
  {
    name: "replace",
    summary: "Create a draft successor for a terminal Task.",
    usage: "yui task replace <task> [--title <text>]",
    options: ["--title"]
  },
  {
    name: "message",
    summary: "Manage durable Task messages.",
    sections: [{ id: "manage", title: "Commands", entries: ["send", "list", "retire"] }],
    children: [
      {
        name: "send",
        summary: "Send a Task message.",
        usage: "yui task message send <id> (<body>|--body-file <path|->) [--wake-policy leader|none] [--delivery-mode followup|steer]",
        options: ["--body-file", "--wake-policy", "--delivery-mode"],
        optionValues: {
          "--wake-policy": ["leader", "none"],
          "--delivery-mode": ["followup", "steer"]
        },
        fileOptions: ["--body-file"]
      },
      {
        name: "list",
        summary: "List Task messages.",
        usage: "yui task message list <id> [--after <timestamp>] [--limit <n>]",
        options: ["--after", "--limit"]
      },
      {
        name: "retire",
        summary: "Retire an incorrect historical Task Message without deleting its audit record.",
        usage: "yui task message retire <task>/<message> --reason <text>",
        options: ["--reason"]
      }
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
        usage: "yui task input show (<task>/<input> | <input> --task <task>)",
        options: ["--task"]
      },
      {
        name: "answer",
        summary: "Answer one open input request.",
        usage: "yui task input answer (<task>/<input> | <input> --task <task>) (--choice <key> | --text <text>)",
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
    name: "grant",
    summary: "Manage capability grants for a Task. Issue and revoke require the authenticated global Operator session.",
    sections: [{ id: "manage", title: "Commands", entries: ["issue", "show", "list", "revoke"] }],
    children: [
      {
        name: "issue",
        summary: "Issue a capability grant to a Task. Requires the authenticated global Operator session; the granter is bound to it.",
        usage: "yui task grant issue <task> --action <name> (repeatable) [--scope-project <id>...] [--scope-repo <owner/name>...] [--scope-package <name>...] [--scope-home <path>] [--param <name=v1,v2>...] [--expires-at <iso-8601>] [--max-uses <int>] [--irreversibility-ceiling <none|reversible|irreversible>]",
        options: ["--action", "--scope-project", "--scope-repo", "--scope-package", "--scope-home", "--param", "--expires-at", "--max-uses", "--irreversibility-ceiling"]
      },
      {
        name: "show",
        summary: "Show one capability grant.",
        usage: "yui task grant show <task> <grant-id>"
      },
      {
        name: "list",
        summary: "List capability grants for a Task.",
        usage: "yui task grant list <task>"
      },
      {
        name: "revoke",
        summary: "Revoke a capability grant. Requires the authenticated global Operator session; the revoker is bound to it.",
        usage: "yui task grant revoke <task> <grant-id>",
        options: []
      }
    ]
  },
  {
    name: "workflow",
    summary: "Manage release workflows for a Task.",
    sections: [{ id: "manage", title: "Commands", entries: ["create", "show", "list", "run", "resume", "status"] }],
    children: [
      {
        name: "create",
        summary: "Create a release workflow for a Task.",
        usage: "yui task workflow create <task> --grant <grant-id> --source-repo <owner/name> --source-commit <sha> [--source-artifact <name@integrity>] --step <id>:<kind> (repeatable) [--step-irreversibility <id>=<level> (repeatable)] [--step-param <id>:<key>=<value> (repeatable)]",
        options: ["--grant", "--source-repo", "--source-commit", "--source-artifact", "--step", "--step-irreversibility", "--step-param"]
      },
      {
        name: "show",
        summary: "Show one release workflow.",
        usage: "yui task workflow show <task> <workflow-id>"
      },
      {
        name: "list",
        summary: "List release workflows for a Task.",
        usage: "yui task workflow list <task>"
      },
      {
        name: "run",
        summary: "Run a release workflow from its resume cursor.",
        usage: "yui task workflow run <task> <workflow-id> [--grant <grant-id>] [--max-steps <int>]",
        options: ["--grant", "--max-steps"]
      },
      {
        name: "resume",
        summary: "Resume a release workflow from its first unconfirmed step.",
        usage: "yui task workflow resume <task> <workflow-id> [--grant <grant-id>] [--max-steps <int>]",
        options: ["--grant", "--max-steps"]
      },
      {
        name: "status",
        summary: "Show a release workflow and its step states.",
        usage: "yui task workflow status <task> <workflow-id>"
      }
    ]
  },
  {
    name: "publication",
    summary: "Record external PR/MR publication evidence for a Task.",
    sections: [{ id: "manage", title: "Commands", entries: ["add", "list", "show"] }],
    children: [
      {
        name: "add",
        summary: "Record an external PR/MR and its publication state.",
        usage: "yui task publication add <task> --project <project> --provider <github|gitlab> --repository <owner/name> --kind <pull-request|merge-request> --id <external-id> [--url <url>] [--title <text>] [--source-branch <branch>] [--target-branch <branch>] [--local-commit <sha>] [--remote-commit <sha>] [--state <open|merged|closed>] [--reported|--verified] [--evidence <text>] [--supersede <publication-id>] [--merged-at <iso-timestamp>]",
        options: ["--project", "--provider", "--repository", "--kind", "--id", "--url", "--title", "--source-branch", "--target-branch", "--local-commit", "--remote-commit", "--state", "--reported", "--verified", "--evidence", "--supersede", "--merged-at"]
      },
      {
        name: "list",
        summary: "List external publication evidence for a Task.",
        usage: "yui task publication list <task>"
      },
      {
        name: "show",
        summary: "Show one external publication reference.",
        usage: "yui task publication show (<task>/<publication-id> | <task> <publication-id>)"
      }
    ]
  },
  {
    name: "role",
    summary: "Manage Roles within a Task.",
    sections: [{ id: "manage", title: "Commands", entries: [
      "add", "list", "status", "show", "update", "remove", "bind", "unbind", "reset",
      "view", "takeover", "release"
    ] }],
    children: [
      {
        name: "add",
        summary: "Add a Role to a Task.",
        usage: "yui task role add <task> <name> [--profile <id>] [--agent <id>] [Role and Agent settings]",
        options: ["--profile", "--agent", ...roleProfileOptions, ...roleAgentOptions],
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
        options: ["--profile", "--agent", ...roleProfileOptions, ...roleAgentOptions,
          ...roleProfileClearOptions, ...roleAgentClearOptions],
        optionValues: roleAgentOptionValues
      },
      { name: "remove", summary: "Remove a Task Role.", usage: "yui task role remove <task> <role>" },
      { name: "bind", summary: "Bind and activate an Agent for a Task Role.", usage: "yui task role bind <task> <role> <agent-id>" },
      { name: "unbind", summary: "Unbind a dormant Agent from a Task Role.", usage: "yui task role unbind <task> <role> <agent-id>" },
      {
        name: "reset",
        summary: "Fail current work, forget the native Session, and request verified cleanup.",
        usage: "yui task role reset <task> <role> --reason <text>",
        options: ["--reason"]
      },
      {
        name: "view",
        summary: "Attach read-only to a managed Provider presentation surface.",
        usage: "yui task role view <task> <role>"
      },
      {
        name: "takeover",
        summary: "Acquire Provider writer authority and enter the PTY input gateway.",
        usage: "yui task role takeover <task> <role>"
      },
      {
        name: "release",
        summary: "Return stranded human Provider authority to the Controller.",
        usage: "yui task role release <task> <role>"
      }
    ]
  },
  {
    name: "work",
    summary: "Manage finite Task work items.",
    sections: [{
      id: "manage",
      title: "Commands",
      entries: [
        "create", "list", "show", "update", "scope", "dispatch", "isolate", "capture", "cleanup",
        "review", "group", "accept", "reject", "retire"
      ]
    }],
    children: [
      {
        name: "create",
        summary: "Create a work item.",
        usage: "yui task work create <task> <title> [--project <project> ...] [--base-ref <project>=<ref> ...] [--objective <text>] [--accept <criterion> ...] [--after <work> ...] [--role <name>]",
        options: ["--project", "--base-ref", "--objective", "--accept", "--after", "--role"]
      },
      { name: "list", summary: "List work items for a Task.", usage: "yui task work list <task>" },
      { name: "show", summary: "Show one Work Item.", usage: "yui task work show <work>" },
      {
        name: "update",
        summary: "Update a work item's state.",
        usage: "yui task work update <task>/<work> <todo|running|done|failed> [--summary <text>]",
        options: ["--summary"],
        argumentValues: {
          1: ["todo", "running", "done", "failed"]
        }
      },
      {
        name: "scope",
        summary: "Expand the Projects a WorkItem may modify.",
        usage: "yui task work scope <task>/<work> [--project <project> ...]",
        options: ["--project"]
      },
      {
        name: "dispatch",
        summary: "Dispatch a work item to its Role.",
        usage: "yui task work dispatch <task>/<work> [--input <text>] [--strategy fixed:<count>|adaptive:<max>] [--lane-role <role> ...] [--mode <single|parallel-diverse|ensemble-replicated|adversarial|adaptive-exploration>] [--max-rounds <count>] [--stage-max-attempts <count>] [--stage-max-tokens <count>] [--stage-max-tool-calls <count>] [--stage-max-seconds <count>] [--stage-quorum <count>] [--stage-straggler-seconds <count>] [--stage-min-marginal-value <0-100>]",
        options: ["--input", "--strategy", "--lane-role", "--mode", "--max-rounds", "--stage-max-attempts", "--stage-max-tokens", "--stage-max-tool-calls", "--stage-max-seconds", "--stage-quorum", "--stage-straggler-seconds", "--stage-min-marginal-value"],
        optionValues: {
          "--mode": ["single", "parallel-diverse", "ensemble-replicated", "adversarial", "adaptive-exploration"]
        }
      },
      {
        name: "group",
        summary: "Resolve a Worker ExecutionGroup after its Lanes finish.",
        executable: true,
        sections: [{ id: "manage", title: "Commands", entries: ["resolve"] }],
        children: [{
          name: "resolve",
          summary: "Select Lane outputs and resolve the Worker group.",
          usage: "yui task work group resolve <task>/<work> --decision <accept|reject|retry|blocked> --summary <text> [--lane <lane-id> ...] [--early-stop <marginal-value-percent>]",
          options: ["--decision", "--summary", "--lane", "--early-stop"],
          optionValues: { "--decision": ["accept", "reject", "retry", "blocked"] }
        }]
      },
      {
        name: "isolate",
        summary: "Create a WorkItem-owned isolated worktree.",
        usage: "yui task work isolate <task>/<work>"
      },
      {
        name: "capture",
        summary: "Capture a terminal isolated WorkItem result as a ChangeSet.",
        usage: "yui task work capture <task>/<work>"
      },
      {
        name: "cleanup",
        summary: "Release an idle WorkItem runtime or remove its final clean worktree.",
        usage: "yui task work cleanup <task>/<work> (--runtime-only|--integrated|--abandon)",
        options: ["--runtime-only", "--integrated", "--abandon"]
      },
      {
        name: "review",
        summary: "Ask the configured reviewer to inspect a WorkItem candidate.",
        usage: "yui task work review <task>/<work>",
        executable: true,
        sections: [
          { id: "retry", title: "Task-final recovery", entries: ["retry"] },
          { id: "workspace", title: "Review workspace", entries: ["cleanup", "preserve"] }
        ],
        children: [
          {
            name: "retry",
            summary: "Retry a failed Task-final ReviewRound that has no Reviewer Run.",
            usage: "yui task work review retry <task>/<review-round>"
          },
          {
            name: "cleanup",
            summary: "Remove only a clean terminal ReviewRound worktree.",
            usage: "yui task work review cleanup <task>/<review-round>"
          },
          {
            name: "preserve",
            summary: "Record that a terminal ReviewRound worktree is retained for diagnosis.",
            usage: "yui task work review preserve <task>/<review-round>"
          }
        ]
      },
      {
        name: "accept",
        summary: "Accept a successful, validated, integrated Work Item.",
        usage: "yui task work accept <task>/<work> --summary <text>",
        options: ["--summary"]
      },
      {
        name: "reject",
        summary: "Reject an awaiting Work Item so it can be retried.",
        usage: "yui task work reject <task>/<work> --summary <text>",
        options: ["--summary"]
      },
      {
        name: "retire",
        summary: "Retire a WorkItem and settle its exact Runs.",
        usage: "yui task work retire <work> --summary <text> [--replacement <work>]",
        options: ["--summary", "--replacement"]
      }
    ]
  },
  {
    name: "run",
    summary: "Inspect and control Task Role Agent Runs.",
    sections: [{ id: "manage", title: "Commands", entries: ["list", "show", "retry", "settle", "recover", "yield", "context", "checkpoint", "retire"] }],
    children: [
      { name: "list", summary: "List Runs for a work item.", usage: "yui task run list <task>/<work>" },
      {
        name: "show",
        summary: "Show one Run with its canonical recovery fence and exact recovery actions.",
        usage: "yui task run show <task>/<run> [--json]"
      },
      {
        name: "retry",
        summary: "Retry a failed execution Run or request a fresh Round for an exact failed final Review Run.",
        usage: "yui task run retry <task>/<run>"
      },
      {
        name: "settle",
        summary: "Close an obsolete stranded final Review Run without requesting a retry Round.",
        usage: "yui task run settle <task>/<run>"
      },
      {
        name: "recover",
        summary: "Record one exact Leader-controlled Run recovery decision.",
        usage: "yui task run recover <task>/<run> --action <diagnose|retry|replace-session|terminate> (--expected-progress-at <timestamp>|--from-next-action <fingerprint>) --provider-acceptance <accepted|rejected|ambiguous> --reason <text>",
        options: ["--action", "--expected-progress-at", "--progress-at", "--from-next-action", "--provider-acceptance", "--reason", "--role", "--agent-id", "--adapter-id", "--native-session-id", "--launch-id"]
      },
      {
        name: "yield",
        summary: "Complete an active Run and wake the Leader.",
        usage: "yui task run yield <task>/<run> (--summary <text>|--summary-file <path|->)",
        options: ["--summary", "--summary-file"],
        fileOptions: ["--summary-file"]
      },
      {
        name: "context",
        summary: "Load the exact authorized Run context.",
        usage: "yui task run context <task>/<run> [--json]",
        executable: true,
        hidden: true,
        sections: [{ id: "load", title: "Commands", entries: ["expand", "delta"] }],
        children: [
          {
            name: "expand",
            summary: "Expand one authorized Run context reference.",
            usage: "yui task run context expand <task>/<run> <ref-id> [--store <store>] [--mode full]",
            options: ["--store", "--mode"]
          },
          {
            name: "delta",
            summary: "Load authorized Run context changes after a cursor.",
            usage: "yui task run context delta <task>/<run> --after <cursor>",
            options: ["--after"]
          }
        ]
      },
      {
        name: "checkpoint",
        summary: "Record durable progress for a long-running Agent Run.",
        usage: "yui task run checkpoint <run> (--note <text>|--note-file <path|->)",
        options: ["--note", "--note-file"],
        fileOptions: ["--note-file"],
        hidden: true
      },
      {
        name: "retire",
        summary: "Retire an incorrect historical Agent Run without deleting its audit record.",
        usage: "yui task run retire <task>/<run> --reason <text>",
        options: ["--reason"]
      }
    ]
  },
  {
    name: "review",
    summary: "Control Task-final ReviewRounds.",
    sections: [{ id: "manage", title: "Commands", entries: ["request", "rebind", "force-fresh", "group", "retry", "finding"] }],
    children: [
      {
        name: "request",
        summary: "Request one Task-local final ReviewRound from a Global Role.",
        usage: "yui task review request <task> --role <global-role> [--strategy fixed:<count>|adaptive:<max>] [--lane-role <role> ...] [--delta-recheck]",
        options: ["--role", "--strategy", "--lane-role", "--delta-recheck"]
      },
      {
        name: "rebind",
        summary: "Explicitly rebind a frozen Task-final contract after a verified immutable release handover.",
        usage: "yui task review rebind <task> --from-control <digest> --to-control <digest> --from-release <release-id> --to-release <release-id>",
        options: ["--from-control", "--to-control", "--from-release", "--to-release"]
      },
      {
        name: "force-fresh",
        summary: "Replace one exact terminal non-semantic Task-final Review with a distinct full Round.",
        usage: "yui task review force-fresh <task>/<review-round>"
      },
      {
        name: "group",
        summary: "Resolve a Reviewer ExecutionGroup after its Lanes finish.",
        executable: true,
        sections: [{ id: "manage", title: "Commands", entries: ["resolve"] }],
        children: [{
          name: "resolve",
          summary: "Select Reviewer Lane evidence and resolve the group.",
          usage: "yui task review group resolve <task>/<review-round> --decision <accept|reject|blocked> --summary <text> [--lane <lane-id> ...]",
          options: ["--decision", "--summary", "--lane"],
          optionValues: { "--decision": ["accept", "reject", "blocked"] }
        }]
      },
      {
        name: "retry",
        summary: "Retry a failed Task-final ReviewRound without a Reviewer Run.",
        usage: "yui task review retry <task>/<review-round>"
      },
      {
        name: "finding",
        summary: "Inspect and disposition the cross-Round Review finding ledger.",
        executable: true,
        sections: [{ id: "manage", title: "Commands", entries: ["list", "dispose", "repair-wave", "extract"] }],
        children: [
          {
            name: "list",
            summary: "List the Task's review findings with disposition and repair lineage.",
            usage: "yui task review finding list <task>"
          },
          {
            name: "dispose",
            summary: "Record one Leader disposition for a review finding.",
            usage: "yui task review finding dispose <task>/<finding> --disposition <fixed-pending-review|verified-fixed|accepted-risk|not-actionable|superseded> [--work-item <id>] [--commit <sha>] [--verification <text>] [--note <text>] [--superseded-by <stable-key>]",
            options: ["--disposition", "--work-item", "--commit", "--verification", "--note", "--superseded-by"],
            optionValues: {
              "--disposition": ["fixed-pending-review", "verified-fixed", "accepted-risk", "not-actionable", "superseded"]
            }
          },
          {
            name: "repair-wave",
            summary: "Consolidate open P1/P2 findings, or explicitly plan parallel repair groups.",
            usage: "yui task review finding repair-wave <task> [--strategy <consolidated|parallel>] [--create]",
            options: ["--strategy", "--create"],
            optionValues: { "--strategy": ["consolidated", "parallel"] }
          },
          {
            name: "extract",
            summary: "Reconcile findings from one completed ReviewRound into the ledger.",
            usage: "yui task review finding extract <task>/<review-round>"
          }
        ]
      }
    ]
  },
  {
    name: "integration",
    summary: "Safely integrate ChangeSets with Leader-owned conflict decisions.",
    sections: [{ id: "manage", title: "Commands", entries: ["start", "continue", "resolve", "abort", "supersede", "list", "show", "cleanup", "queue"] }],
    children: [
      {
        name: "start",
        summary: "Build, validate, and CAS-commit an integration candidate.",
        usage: "yui task integration start <task> [--project <project>] --change-set <id> [--change-set <id> ...] [--target <ref>] [--check <command> ...]",
        options: ["--project", "--change-set", "--target", "--check"]
      },
      {
        name: "continue",
        summary: "Continue a Leader-approved manual resolution.",
        usage: "yui task integration continue <task>/<integration>"
      },
      {
        name: "resolve",
        summary: "Record the Leader's semantic conflict decision.",
        usage: "yui task integration resolve <task>/<integration> --option <manual-resolution|reject> --rationale <text>",
        options: ["--option", "--rationale"],
        optionValues: { "--option": ["manual-resolution", "reject"] }
      },
      {
        name: "abort",
        summary: "Abandon a running or blocked Integration Attempt.",
        usage: "yui task integration abort <task>/<integration> --reason <text>",
        options: ["--reason"]
      },
      {
        name: "supersede",
        summary: "Mark a committed Integration as obsolete, retaining its evidence.",
        usage: "yui task integration supersede <task>/<integration> --reason <text>",
        options: ["--reason"]
      },
      { name: "list", summary: "List Integration Attempts.", usage: "yui task integration list <task>" },
      { name: "show", summary: "Show one Integration Attempt.", usage: "yui task integration show <task>/<integration>" },
      { name: "cleanup", summary: "Remove a terminal Integration worktree and branch.", usage: "yui task integration cleanup <task>/<integration>" },
      {
        name: "queue",
        summary: "Manage the serialized integration queue.",
        sections: [{ id: "queue", title: "Commands", entries: ["enqueue", "list", "show", "process", "supersede", "requeue", "reconcile"] }],
        children: [
          { name: "enqueue", summary: "Enqueue a ChangeSet for serialized integration.", usage: "yui task integration queue enqueue <task> --project <project> --change-set <id> [--target <ref>] [--check <command> ...]", options: ["--project", "--change-set", "--target", "--check"] },
          { name: "list", summary: "List integration queue entries.", usage: "yui task integration queue list <task> [--project <project>]", options: ["--project"] },
          { name: "show", summary: "Show one integration queue entry.", usage: "yui task integration queue show <task>/<entry>" },
          { name: "process", summary: "Process queued integration entries.", usage: "yui task integration queue process <task> [--project <project>] [--limit <n>]", options: ["--project", "--limit"] },
          { name: "supersede", summary: "Supersede a queued entry.", usage: "yui task integration queue supersede <task>/<entry> --reason <text>", options: ["--reason"] },
          { name: "requeue", summary: "Requeue a conflicted entry.", usage: "yui task integration queue requeue <task>/<entry>" },
          { name: "reconcile", summary: "Reconcile a blocked entry.", usage: "yui task integration queue reconcile <task>/<entry>" }
        ]
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
        usage: "yui task brief update <task> [--objective <text>] [--boundary <text> ...] [--approach <text>] [--focus <text>] [--leader-summary <text>]",
        options: ["--objective", "--boundary", "--approach", "--focus", "--leader-summary"]
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
      {
        name: "list",
        summary: "List Task events.",
        usage: "yui task event list <task> [--after <timestamp>] [--limit <n>]",
        options: ["--after", "--limit"]
      },
      { name: "show", summary: "Show one Task event.", usage: "yui task event show <task> <event>" }
    ]
  },
  {
    name: "continuation",
    summary: "Inspect native Provider child continuations and their durability mode.",
    sections: [{ id: "manage", title: "Commands", entries: ["list"] }],
    children: [
      {
        name: "list",
        summary: "List native child continuations for a Task.",
        usage: "yui task continuation list <task> [--json]",
        options: ["--json"]
      }
    ]
  },
  {
    name: "wake",
    summary: "Inspect the durable Leader wake ledger and its delta content.",
    sections: [{ id: "manage", title: "Commands", entries: ["list", "show"] }],
    children: [
      { name: "list", summary: "List recorded Leader wakes.", usage: "yui task wake list <task>" },
      { name: "show", summary: "Show one wake and its delta content.", usage: "yui task wake show <task> <wake>" }
    ]
  },
  {
    name: "overlap",
    summary: "Show read-only cross-Task overlap diagnostics.",
    usage: "yui task overlap [--project <project>] [--base <sha>] [--task <task> ...]",
    options: ["--project", "--base", "--task"]
  },
  {
    name: "change-set",
    summary: "Inspect ChangeSets captured from WorkItem Candidates.",
    sections: [{ id: "inspect", title: "Commands", entries: ["show"] }],
    children: [
      { name: "show", summary: "Show one ChangeSet.", usage: "yui task change-set show <task>/<change-set>" }
    ]
  },
];

export const ROOT_COMMAND = buildNode({
  name: "yui",
  summary: "Coordinate durable, isolated Agent work.",
  usage: "yui [--json] <command>",
  examples: ["yui setup", "yui operator enter", "yui config show", "yui task list"],
  sections: [
    { id: "general", title: "General", entries: [
      "help", "version", "update", "upgrade", "setup", "doctor"
    ] },
    { id: "workflow", title: "Workflow", entries: ["operator", "project", "task"] },
    { id: "configuration", title: "Configuration", entries: ["config"] },
    { id: "operations", title: "Operations", entries: ["web", "controller", "session", "execution", "job", "jobs", "telemetry", "release"] },
    { id: "resources", title: "Resources", entries: ["resources"] },
    { id: "internal", title: "Internal", entries: ["internal"] }
  ],
  children: [
    { name: "help", summary: "Show root or scoped command help.", usage: "yui help [command ...]", commandPathArguments: true },
    { name: "version", summary: "Print the installed Yui version." },
    { name: "update", summary: "Install the latest published Yui package globally." },
    {
      name: "upgrade",
      summary: "Migrate this Home's storage to the current schema.",
      usage: "yui upgrade [--dry-run]",
      options: ["--dry-run"]
    },
    {
      name: "setup",
      summary: "Initialize the minimum Operator and Leader configuration required to execute Tasks.",
      examples: "yui setup"
    },
    { name: "doctor", summary: "Check Yui dependencies and file state." },
    {
      name: "web",
      summary: "Serve the local Task and Agent control room.",
      usage: "yui web [--host <loopback>] [--port <port>]",
      options: ["--host", "--port"]
    },
    {
      name: "controller",
      summary: "Inspect and recover local Controller runtime resources.",
      sections: [{
        id: "lifecycle",
        title: "Commands",
        entries: ["status", "cleanup", "identity", "live-identity", "stop", "restart"]
      }],
      children: [
        {
          name: "status",
          summary: "Show Controller and Agent runtime resources.",
          usage: "yui controller status [--all] [--verbose]",
          options: ["--all", "--verbose"]
        },
        {
          name: "cleanup",
          summary: "Interactively clean confirmed unused runtime resources.",
          usage: "yui controller cleanup [--all]",
          options: ["--all"]
        },
        {
          name: "identity",
          summary: "Read the stable runtime identity receipt (build, backend, worker).",
          hidden: true
        },
        {
          name: "live-identity",
          summary: "Read the authenticated live Controller launch identity.",
          hidden: true
        },
        { name: "stop", summary: "Stop the Controller." },
        { name: "restart", summary: "Restart internal services without stopping tmux sessions." }
      ]
    },
    {
      name: "execution",
      summary: "Read-only execution history audit.",
      sections: [{
        id: "reports",
        title: "Commands",
        entries: ["audit"]
      }],
      children: [
        {
          name: "audit",
          summary: "Report Runs, wakes, Sessions, Reviews, Integrations, and telemetry volume.",
          usage: "yui execution audit [--task <id>] [--since <iso>] [--until <iso>]",
          options: ["--task", "--since", "--until"]
        }
      ]
    },
    {
      name: "release",
      summary: "Install and activate immutable local runtime releases.",
      sections: [{
        id: "commands",
        title: "Commands",
        entries: ["install", "list", "activate"]
      }],
      children: [
        {
          name: "install",
          summary: "Install a runtime package as an immutable release.",
          usage: "yui release install <source-dir>"
        },
        { name: "list", summary: "List installed releases and the active pointer." },
        {
          name: "activate",
          summary: "Activate a release via atomic Controller handover.",
          usage: "yui release activate [release-id]"
        }
      ]
    },
    {
      name: "resources",
      summary: "Inspect and garbage-collect managed worktrees, deployments, and runtime artifacts.",
      sections: [{ id: "gc", title: "Commands", entries: ["gc"] }],
      children: [
        {
          name: "gc",
          summary: "Plan or apply resource garbage collection.",
          usage: "yui resources gc [--dry-run|--apply|--purge|--restore] [--quarantine-ttl-hours <hours>]",
          options: ["--dry-run", "--apply", "--purge", "--restore", "--quarantine-ttl-hours"]
        }
      ]
    },
    {
      name: "config",
      summary: "Inspect, understand, and update all persistent Yui configuration.",
      examples: [
        "yui config show",
        "yui config describe runtime",
        "yui config workflow show",
        "yui config agent list",
        "yui config role show operator",
        "yui config profile list",
        "yui config completion"
      ],
      sections: [
        { id: "inspect", title: "Inspect", entries: ["show", "describe"] },
        { id: "domains", title: "Configuration domains", entries: [
          ...CONFIG_DOMAINS, "agent", "role", "profile", "completion"
        ] }
      ],
      children: [
        {
          name: "show",
          summary: "Show the complete effective Yui configuration.",
          examples: ["yui config show", "yui --json config show"]
        },
        {
          name: "describe",
          summary: "Explain configuration effects, defaults, choices, and activation behavior.",
          usage: `yui config describe [${[...CONFIG_DOMAINS, "agent", "role", "profile", "completion"].join("|")}]`,
          examples: ["yui config describe", "yui --json config describe role"],
          argumentValues: { 0: [...CONFIG_DOMAINS, "agent", "role", "profile", "completion"] }
        },
        ...CONFIG_DOMAINS.map(durableConfigDomainNode),
        {
          name: "agent",
          summary: "Manage configured native Agent CLIs; launch-setting changes require affected Sessions to be stopped.",
          examples: ["yui config agent list", "yui config agent capabilities codex"],
          sections: [
            { id: "inspect", title: "Inspect", entries: ["list", "show", "capabilities"] },
            { id: "manage", title: "Manage", entries: ["add", "update", "remove"] }
          ],
          children: agentChildren
        },
        {
          name: "profile",
          summary: "Manage reusable Agent Profiles; updates affect future copies and do not rewrite existing Task Roles.",
          examples: ["yui config profile list", "yui config profile show implementer"],
          sections: [
            { id: "inspect", title: "Inspect", entries: ["list", "show"] },
            { id: "manage", title: "Manage", entries: ["add", "update", "remove", "reset"] }
          ],
          children: profileChildren
        },
        {
          name: "role",
          summary: "Manage reusable global Roles and desired Agent launch configuration for the next compatible Session.",
          examples: ["yui config role list", "yui config role show operator"],
          sections: [
            { id: "inspect", title: "Inspect", entries: ["list", "show"] },
            { id: "manage", title: "Manage", entries: ["add", "update", "remove", "bind", "unbind"] }
          ],
          children: roleChildren
        },
        {
          name: "completion",
          summary: "Interactively configure shell completion after confirming generated files and startup-file changes.",
          executable: true,
          acceptsArguments: false,
          usage: ["yui config completion", "yui config completion <bash|zsh|fish>"],
          examples: ["yui config completion", "yui config completion zsh"],
          sections: [
            { id: "shells", title: "Shells", entries: ["bash", "zsh", "fish"] },
            { id: "internal", title: "Internal", entries: ["candidates"] }
          ],
          children: completionChildren
        }
      ]
    },
    {
      name: "operator",
      summary: "Use the persistent Operator Actor.",
      sections: [{
        id: "workflow",
        title: "Commands",
        entries: ["enter", "status", "new", "list", "resume", "submit"]
      }],
      children: [
        { name: "enter", summary: "Enter the Operator's native session." },
        { name: "status", summary: "Show the unique active writer and retained conversation history." },
        {
          name: "new",
          summary: "Start a new Operator session.",
          usage: "yui operator new [--agent <id>]",
          options: ["--agent"]
        },
        { name: "list", summary: "List Operator session history." },
        {
          name: "resume",
          summary: "Resume a previous Operator session.",
          usage: "yui operator resume [<ref> | --last]",
          options: ["--last"]
        },
        {
          name: "submit",
          summary: "Submit work through the Operator.",
          usage: "yui operator submit (<body>|--body-file <path|->) [--task <id>]",
          options: ["--task", "--body-file"],
          fileOptions: ["--body-file"]
        }
      ]
    },
    {
      name: "project",
      summary: "Manage Projects, stable checkouts, branches, and Yui knowledge.",
      sections: [
        { id: "manage", title: "Commands", entries: ["add", "clone", "refresh", "diagnose", "migrate", "update", "discover", "list", "show", "knowledge"] },
        { id: "lifecycle", title: "Lifecycle (Operator authority)", entries: ["reset", "replace", "retire", "delete"] }
      ],
      children: [
        {
          name: "add",
          summary: "Bind a Project to a stable Git checkout.",
          usage: "yui project add <name> <path> [--alias <name> ...] [--remote <url>] [--stable <ref>] [--development <ref>]",
          options: ["--alias", "--remote", "--stable", "--development"],
          fileArguments: [1]
        },
        {
          name: "clone",
          summary: "Clone and bind a Project after user confirmation.",
          usage: "yui project clone <name> <remote> [--alias <name> ...] [--stable <ref>] [--development <ref>]",
          options: ["--alias", "--stable", "--development"]
        },
        {
          name: "refresh",
          summary: "Fast-forward a clean stable checkout from its configured remote.",
          usage: "yui project refresh <project>"
        },
        {
          name: "diagnose",
          summary: "Show canonical HEAD vs remote head without mutating the checkout.",
          usage: "yui project diagnose <project>"
        },
        {
          name: "migrate",
          summary: "Move an external Project into a Home-managed repository.",
          usage: "yui project migrate <project> [--preflight]",
          options: ["--preflight"]
        },
        {
          name: "reset",
          summary: "Hard-reset a canonical checkout to its verified remote baseline (Operator authority).",
          usage: "yui project reset <project> [--discard-local]",
          options: ["--discard-local"]
        },
        {
          name: "replace",
          summary: "Re-clone a Home-managed checkout from its remote, preserving Yui refs (Operator authority).",
          usage: "yui project replace <project> --discard-local",
          options: ["--discard-local"]
        },
        {
          name: "retire",
          summary: "Soft-deprecate a Project; record and evidence are retained (Operator authority).",
          usage: "yui project retire <project> --reason <text>",
          options: ["--reason"]
        },
        {
          name: "delete",
          summary: "Remove a retired Project's catalog record and optionally its checkout (Operator authority).",
          usage: "yui project delete <project> [--checkout] --confirm <project-id>",
          options: ["--checkout", "--confirm"]
        },
        {
          name: "update",
          summary: "Update a bound Project's aliases, remote, or branch refs.",
          usage: "yui project update <project> [--alias <name> ...|--clear-aliases] [--remote <url>|--clear-remote] [--stable <ref>] [--development <ref>]",
          options: [
            "--alias", "--clear-aliases", "--remote", "--clear-remote",
            "--stable", "--development"
          ]
        },
        {
          name: "discover",
          summary: "Find Git projects directly under the configured workspace.",
          usage: "yui project discover [name]"
        },
        { name: "list", summary: "List bound Projects." },
        { name: "show", summary: "Show one Project.", usage: "yui project show <project>" },
        {
          name: "knowledge",
          summary: "Manage durable Project knowledge stored by Yui.",
          sections: [
            {
              id: "manage",
              title: "Commands",
              entries: ["add", "retire", "list", "show", "propose", "proposals", "accept", "reject"]
            }
          ],
          children: [
            {
              name: "add",
              summary: "Add Project knowledge (Operator authority).",
              usage: "yui project knowledge add <project> <title> --body <text>",
              options: ["--body"]
            },
            {
              name: "retire",
              summary: "Retire Project knowledge without deleting its record (Operator authority).",
              usage: "yui project knowledge retire <project> <knowledge>"
            },
            {
              name: "list",
              summary: "List Project knowledge.",
              usage: "yui project knowledge list <project> [--all]",
              options: ["--all"]
            },
            {
              name: "show",
              summary: "Read one Project knowledge entry.",
              usage: "yui project knowledge show <project> <knowledge>"
            },
            {
              name: "propose",
              summary: "Propose a Task conclusion for promotion into Project knowledge.",
              usage: "yui project knowledge propose <project> --title <text> --body <text> --task <task>"
                + " [--decision <id>] [--milestone <id>] [--commit <sha>] [--scope <text>]"
                + " [--expires-when <text>] [--supersedes <knowledge-id>]",
              options: ["--title", "--body", "--task", "--decision", "--milestone", "--commit", "--scope", "--expires-when", "--supersedes"]
            },
            {
              name: "proposals",
              summary: "List or show Knowledge promotion proposals.",
              sections: [{ id: "manage", title: "Commands", entries: ["list", "show"] }],
              children: [
                {
                  name: "list",
                  summary: "List Knowledge promotion proposals (pending by default).",
                  usage: "yui project knowledge proposals list <project> [--status pending|accepted|rejected] [--all]",
                  options: ["--status", "--all"]
                },
                {
                  name: "show",
                  summary: "Show one Knowledge promotion proposal.",
                  usage: "yui project knowledge proposals show <project> <proposal>"
                }
              ]
            },
            {
              name: "accept",
              summary: "Accept a Knowledge promotion proposal (Operator authority).",
              usage: "yui project knowledge accept <project> <proposal> [--update <knowledge-id>]",
              options: ["--update"]
            },
            {
              name: "reject",
              summary: "Reject a Knowledge promotion proposal (Operator authority).",
              usage: "yui project knowledge reject <project> <proposal> --reason <text>",
              options: ["--reason"]
            }
          ]
        }
      ]
    },
    {
      name: "session",
      summary: "Enter, stop, and reconcile managed Role sessions.",
      examples: [
        "yui session context operator --json",
        "yui session enter operator",
        "yui session stop --all",
        "yui session reconcile --report"
      ],
      sections: [
        { id: "global", title: "Global Role sessions", entries: ["context", "enter", "record", "replace"] },
        { id: "maintenance", title: "Maintenance", entries: ["stop"] },
        { id: "recovery", title: "Recovery", entries: ["reconcile"] }
      ],
      children: globalSessionChildren
    },
    {
      name: "task",
      summary: "Manage Tasks, WorkItems, Agent Runs, and integration.",
      sections: [
        { id: "lifecycle", title: "Lifecycle", entries: ["create", "project", "base", "update", "activate", "complete", "reopen", "retire", "list", "show", "context", "next-action", "archive", "rebuild", "history", "replace", "reconcile", "upstream"] },
        { id: "collaboration", title: "Collaboration", entries: ["message", "input", "grant", "workflow", "publication", "work", "run", "review", "integration", "role", "overlap", "change-set"] },
        { id: "knowledge", title: "Task Knowledge", entries: ["brief", "decision", "milestone", "event", "continuation", "wake"] }
      ],
      children: taskChildren
    },
    {
      name: "job",
      summary: "Start, inspect, cancel, or acknowledge a Controller-managed DurableJob.",
      sections: [{ id: "manage", title: "Commands", entries: ["start", "get", "cancel", "acknowledge"] }],
      children: [
        { name: "start", summary: "Start a DurableJob for build, test, package, or Integration checks.", usage: "yui job start --task <id> --project <project> --head <sha> --workspace <dir> --step <name>=<command> [--step ...] [--owner task|work-item:<id>|integration-attempt:<id>] [--env <k=v>...]" },
        { name: "get", summary: "Show a DurableJob record and its terminal result.", usage: "yui job get --task <id> --job <job-id>" },
        { name: "cancel", summary: "Request cancellation of a running or queued DurableJob.", usage: "yui job cancel --task <id> --job <job-id>" },
        { name: "acknowledge", summary: "Acknowledge an unknown-needs-attention DurableJob so Task lifecycle gates can proceed.", usage: "yui job acknowledge --task <id> --job <job-id>" }
      ]
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
      name: "telemetry",
      summary: "Inspect and compact the bounded provider-progress sidecar.",
      sections: [{ id: "manage", title: "Commands", entries: ["status", "prune", "compact", "read"] }],
      children: [
        { name: "status", summary: "Show sidecar health, row counts, and retention settings.", usage: "yui telemetry status" },
        { name: "prune", summary: "Apply terminal retention and active-Run caps.", usage: "yui telemetry prune [--task <id>] [--keep <n>] [--dry-run]" },
        { name: "compact", summary: "Fold legacy semantic progress events into a staged Home's sidecar.", usage: "yui telemetry compact --from <home> --staged <dir> [--keep <n>] [--dry-run]" },
        { name: "read", summary: "Page through retained progress rows or read a Run aggregate.", usage: "yui telemetry read --task <id> [--run <id>] [--aggregate] [--limit <n>] [--offset <n>]" }
      ]
    },
    {
      name: "internal",
      summary: "Internal Yui callbacks.",
      hidden: true,
      sections: [{
        id: "callbacks",
        title: "Callbacks",
        entries: ["session-notify", "runtime-hook", "agent-host", "session-cli-refresh"]
      }],
      children: [
        {
          name: "agent-host",
          summary: "Run the persistent structured Provider host.",
          usage: "yui internal agent-host <launch-id> <ticket>"
        },
        {
          name: "session-notify",
          summary: "Record a structured native session notification.",
          usage: "yui internal session-notify <payload>"
        },
        {
          name: "runtime-hook",
          summary: "Record a managed Agent Driver observation from stdin.",
          usage: "yui internal runtime-hook"
        },
        {
          name: "session-cli-refresh",
          summary: "Refresh legacy managed Session CLI wrappers after an update.",
          usage: "yui internal session-cli-refresh"
        }
      ]
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
    const entries: (CommandNode | CommandValue)[] = section.entries.flatMap(
      (entry): (CommandNode | CommandValue)[] => {
        const child = children.get(entry);
        if (child !== undefined) return child.hidden ? [] : [child];
        const value = values.get(entry);
        return value === undefined ? [] : [value];
      }
    );
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

export type CommandDescription = Readonly<{
  path: string;
  summary: string;
  usage: readonly string[];
  examples: readonly string[];
  options: readonly string[];
  optionValues: Readonly<Record<string, readonly string[]>>;
  argumentValues: Readonly<Record<number, readonly string[]>>;
  values: readonly CommandValue[];
  children: readonly CommandDescription[];
}>;

/** Structured help projection consumed by `config describe --json` and Operator. */
export function describeCommandTree(node: CommandNode): CommandDescription {
  return {
    path: node.path.slice(1).join(" "),
    summary: node.summary,
    usage: node.usage,
    examples: node.examples,
    options: node.options,
    optionValues: node.optionValues,
    argumentValues: node.argumentValues,
    values: node.values,
    children: visibleChildren(node).map(describeCommandTree)
  };
}

export function validateCommandCatalog(root: CommandNode): void {
  const reservedAliases = new Set(["-h", "--help", "-help", "-v", "--version"]);
  const commandPathProviders: CommandNode[] = [];
  const visit = (node: CommandNode): void => {
    if (node.summary.trim().length === 0) throw new Error(`Command summary is required: ${node.path.join(" ")}`);
    if (node.usage.length === 0) throw new Error(`Command usage is required: ${node.path.join(" ")}`);
    if (node.examples.length === 0 || node.examples.some((example) => example.trim().length === 0)) {
      throw new Error(`Command examples are required: ${node.path.join(" ")}`);
    }
    const canonicalPath = node.path.join(" ");
    for (const example of node.examples) {
      const normalized = example.replace(/^yui --json(?=\s|$)/, "yui");
      if (normalized !== canonicalPath && !normalized.startsWith(`${canonicalPath} `)) {
        throw new Error(`Command example does not match its path: ${canonicalPath}: ${example}`);
      }
    }
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
    if (new Set(node.workspaceMapOptions).size !== node.workspaceMapOptions.length) {
      throw new Error(`Duplicate workspace-map completion option: ${node.path.join(" ")}`);
    }
    for (const option of node.workspaceMapOptions) {
      if (!options.has(option)) throw new Error(`Workspace-map completion references unknown option: ${[...node.path, option].join(" ")}`);
    }
    for (const option of options) {
      const owners = Number(Object.hasOwn(node.optionValues, option))
        + Number(node.fileOptions.includes(option))
        + Number(node.executableOptions.includes(option))
        + Number(node.workspaceMapOptions.includes(option));
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
