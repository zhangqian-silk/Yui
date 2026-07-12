import { findChild, ROOT_COMMAND, type CommandNode } from "./commandCatalog.js";

export type CandidateProviderName =
  | "configured-agents"
  | "global-roles-for-show"
  | "removable-global-roles"
  | "configured-global-roles"
  | "tasks"
  | "unarchived-tasks"
  | "archived-tasks"
  | "tasks-with-input-drafts"
  | "trashed-tasks"
  | "task-roles"
  | "task-roles-with-transcripts"
  | "task-roles-with-active-runs"
  | "task-roles-without-active-runs"
  | "removable-task-roles"
  | "worktree-task-roles"
  | "task-topics"
  | "active-cycles"
  | "open-work-items"
  | "work-items"
  | "dispatch-work-items"
  | "active-decisions";
export type SelectableEntity = "agent" | "global-role" | "task" | "task-role" | "topic" | "cycle" | "work-item" | "decision";

export type ArgumentSelector = {
  argumentIndex?: number;
  option?: string;
  requiredOption?: boolean;
  entity: SelectableEntity;
  provider: CandidateProviderName;
  dependsOn?: number;
  unlessOption?: string;
  actionTarget: boolean;
};

export type InteractionPolicy = {
  commandPath: readonly string[];
  selectors: readonly ArgumentSelector[];
  trailingOptions?: Readonly<Record<string, "flag" | "value">>;
  requiredArguments?: readonly number[];
  requiredOptions?: readonly string[];
  requiredAnyOptions?: readonly string[];
  optionPrerequisites?: readonly {
    option: string;
    values: readonly string[];
    requireWhenSelecting: boolean;
    requiredOptions: readonly string[];
  }[];
  confirmation?: {
    action: string;
    targetArgumentIndex: number;
  };
};

export const INTERACTION_POLICIES: readonly InteractionPolicy[] = [
  {
    commandPath: ["agent", "show"],
    selectors: [
      { argumentIndex: 2, entity: "agent", provider: "configured-agents", actionTarget: true }
    ]
  },
  {
    commandPath: ["agent", "remove"],
    selectors: [
      { argumentIndex: 2, entity: "agent", provider: "configured-agents", actionTarget: true }
    ],
    confirmation: { action: "Remove agent", targetArgumentIndex: 2 }
  },
  {
    commandPath: ["config", "set", "default-agent"],
    selectors: [
      { argumentIndex: 3, entity: "agent", provider: "configured-agents", actionTarget: true }
    ]
  },
  {
    commandPath: ["role", "show"],
    selectors: [
      { argumentIndex: 2, entity: "global-role", provider: "global-roles-for-show", actionTarget: true }
    ]
  },
  {
    commandPath: ["role", "remove"],
    selectors: [
      { argumentIndex: 2, entity: "global-role", provider: "removable-global-roles", actionTarget: true }
    ],
    confirmation: { action: "Remove role", targetArgumentIndex: 2 }
  },
  {
    commandPath: ["role", "enter"],
    selectors: [
      { argumentIndex: 2, entity: "global-role", provider: "configured-global-roles", actionTarget: true }
    ]
  },
  {
    commandPath: ["role", "add"],
    selectors: [
      { option: "--agent", requiredOption: true, entity: "agent", provider: "configured-agents", actionTarget: false }
    ],
    trailingOptions: {
      "--agent": "value", "--workspace": "value", "--description": "value", "--responsibility": "value",
      "--constraint": "value", "--expected-output": "value", "--system-prompt": "value", "--skill": "value"
    },
    requiredArguments: [2]
  },
  {
    commandPath: ["role", "update"],
    selectors: [
      { argumentIndex: 2, entity: "global-role", provider: "configured-global-roles", actionTarget: true },
      { option: "--agent", entity: "agent", provider: "configured-agents", actionTarget: false }
    ],
    trailingOptions: { "--agent": "value", "--workspace": "value" },
    requiredAnyOptions: ["--agent", "--workspace"]
  },
  ...[
    "show", "open", "context", "roles", "comments", "events", "activity", "timeline"
  ].map((command): InteractionPolicy => ({
    commandPath: ["task", command],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true }
    ],
    ...(command === "context"
      ? { trailingOptions: { "--format": "value", "--include-transcripts": "flag" } as const }
      : {})
  })),
  {
    commandPath: ["task", "topic", "list"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true }
    ]
  },
  {
    commandPath: ["task", "detail"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      {
        argumentIndex: 3,
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 2,
        actionTarget: true
      }
    ]
  },
  {
    commandPath: ["task", "enter"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      {
        argumentIndex: 3,
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 2,
        actionTarget: true
      }
    ]
  },
  ...["status", "tail", "transcript"].map((command): InteractionPolicy => ({
    commandPath: ["task", command],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      {
        argumentIndex: 3,
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 2,
        actionTarget: true
      }
    ]
  })),
  {
    commandPath: ["task", "transcript", "export"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      {
        argumentIndex: 4,
        entity: "task-role",
        provider: "task-roles-with-transcripts",
        dependsOn: 3,
        actionTarget: true
      }
    ],
    trailingOptions: { "--format": "value", "--output": "value" }
  },
  {
    commandPath: ["task", "delete"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true }
    ],
    confirmation: { action: "Delete task", targetArgumentIndex: 2 }
  },
  ...[
    ["clone", "tasks", { "--title": "value" }],
    ["update", "tasks", {
      "--title": "value", "--description": "value", "--priority": "value", "--tag": "value", "--due": "value",
      "--clear-description": "flag", "--clear-priority": "flag", "--clear-tags": "flag", "--clear-due": "flag"
    }],
    ["archive", "unarchived-tasks", { "--reason": "value", "--summary": "value" }],
    ["unarchive", "archived-tasks", {}],
    ["shell", "tasks", {}],
    ["refresh", "tasks", {}],
    ["cleanup", "tasks", {}]
  ].map(([command, provider, trailingOptions]): InteractionPolicy => ({
    commandPath: ["task", command as string],
    selectors: [{ argumentIndex: 2, entity: "task", provider: provider as CandidateProviderName, actionTarget: true }],
    trailingOptions: trailingOptions as Readonly<Record<string, "flag" | "value">>,
    ...(command === "update" ? { requiredAnyOptions: Object.keys(trailingOptions as object) } : {}),
    ...(command === "archive" ? { confirmation: { action: "Archive task", targetArgumentIndex: 2 } } : {})
  })),
  {
    commandPath: ["task", "wake"],
    selectors: [{ argumentIndex: 2, entity: "task", provider: "unarchived-tasks", actionTarget: true }],
    trailingOptions: { "--reason": "value" },
    requiredOptions: ["--reason"]
  },
  {
    commandPath: ["task", "assign"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 3, entity: "global-role", provider: "configured-global-roles", dependsOn: 2, unlessOption: "--agent", actionTarget: true },
      { option: "--agent", entity: "agent", provider: "configured-agents", actionTarget: false }
    ],
    trailingOptions: { "--agent": "value", "--workspace": "value", "--as": "value" }
  },
  {
    commandPath: ["task", "bind"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 3, entity: "global-role", provider: "configured-global-roles", dependsOn: 2, actionTarget: true }
    ],
    trailingOptions: { "--as": "value", "--workspace": "value" }
  },
  {
    commandPath: ["task", "assign-many"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      { option: "--agent", entity: "agent", provider: "configured-agents", actionTarget: false }
    ],
    trailingOptions: { "--role": "value", "--agent": "value", "--workspace": "value" },
    requiredOptions: ["--role"]
  },
  {
    commandPath: ["task", "role", "child"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { option: "--parent", entity: "task-role", provider: "task-roles", dependsOn: 3, actionTarget: false }
    ],
    trailingOptions: { "--parent": "value", "--description": "value", "--responsibility": "value", "--constraint": "value", "--expected-output": "value" },
    requiredArguments: [4],
    requiredOptions: ["--description", "--expected-output"]
  },
  {
    commandPath: ["task", "role", "update"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 4, entity: "task-role", provider: "task-roles", dependsOn: 3, actionTarget: true },
      { option: "--agent", entity: "agent", provider: "configured-agents", actionTarget: false }
    ],
    trailingOptions: { "--agent": "value", "--workspace": "value" },
    requiredAnyOptions: ["--agent", "--workspace"]
  },
  {
    commandPath: ["task", "role", "remove"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 4, entity: "task-role", provider: "removable-task-roles", dependsOn: 3, actionTarget: true }
    ],
    confirmation: { action: "Remove task role", targetArgumentIndex: 4 }
  },
  ...["detach", "stop", "kill", "restart"].map((command): InteractionPolicy => ({
    commandPath: ["task", command],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 3, entity: "task-role", provider: "task-roles", dependsOn: 2, actionTarget: true }
    ],
    ...(["stop", "kill", "restart"].includes(command)
      ? { confirmation: { action: `${command[0]?.toUpperCase()}${command.slice(1)} task role`, targetArgumentIndex: 3 } }
      : {})
  })),
  {
    commandPath: ["task", "restore"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "trashed-tasks", actionTarget: true }
    ]
  },
  {
    commandPath: ["task", "input", "submit"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks-with-input-drafts", actionTarget: true }
    ]
  },
  {
    commandPath: ["task", "cycle", "end"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 4, entity: "cycle", provider: "active-cycles", dependsOn: 3, actionTarget: true }
    ],
    trailingOptions: { "--summary": "value" },
    requiredOptions: ["--summary"],
    confirmation: { action: "End cycle", targetArgumentIndex: 4 }
  },
  {
    commandPath: ["task", "work-item", "update"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 4, entity: "work-item", provider: "work-items", dependsOn: 3, actionTarget: true }
    ],
    trailingOptions: { "--status": "value", "--outcome": "value" },
    requiredOptions: ["--status"],
    optionPrerequisites: [{
      option: "--status",
      values: ["completed", "failed", "cancelled", "superseded"],
      requireWhenSelecting: true,
      requiredOptions: ["--outcome"]
    }]
  },
  {
    commandPath: ["task", "decision", "supersede"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 4, entity: "decision", provider: "active-decisions", dependsOn: 3, actionTarget: true }
    ],
    trailingOptions: { "--reason": "value" },
    requiredOptions: ["--reason"],
    confirmation: { action: "Supersede decision", targetArgumentIndex: 4 }
  },
  {
    commandPath: ["task", "topic", "summarize"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { option: "--topic", requiredOption: true, entity: "topic", provider: "task-topics", dependsOn: 3, actionTarget: false }
    ],
    trailingOptions: { "--topic": "value", "--summary": "value" },
    requiredOptions: ["--summary"]
  },
  {
    commandPath: ["task", "topic", "create"],
    selectors: [{ argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true }],
    trailingOptions: { "--id": "value", "--name": "value", "--description": "value" },
    requiredOptions: ["--id", "--name", "--description"]
  },
  {
    commandPath: ["task", "cycle", "create"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { option: "--topic", entity: "topic", provider: "task-topics", dependsOn: 3, actionTarget: false }
    ],
    trailingOptions: { "--cause": "value", "--summary": "value", "--topic": "value" },
    requiredOptions: ["--cause", "--summary"]
  },
  {
    commandPath: ["task", "work-item", "create"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { option: "--cycle", entity: "cycle", provider: "active-cycles", dependsOn: 3, actionTarget: false },
      { option: "--assignee", entity: "task-role", provider: "task-roles", dependsOn: 3, actionTarget: false },
      { option: "--topic", entity: "topic", provider: "task-topics", dependsOn: 3, actionTarget: false }
    ],
    trailingOptions: { "--title": "value", "--cycle": "value", "--assignee": "value", "--topic": "value" },
    requiredOptions: ["--title"]
  },
  {
    commandPath: ["task", "session", "record"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 4, entity: "task-role", provider: "task-roles", dependsOn: 3, actionTarget: true }
    ],
    trailingOptions: { "--native-id": "value" },
    requiredOptions: ["--native-id"]
  },
  {
    commandPath: ["task", "session", "replace"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 4, entity: "task-role", provider: "task-roles", dependsOn: 3, actionTarget: true }
    ],
    trailingOptions: { "--native-id": "value", "--reason": "value" },
    requiredOptions: ["--native-id", "--reason"],
    confirmation: { action: "Replace task role session", targetArgumentIndex: 4 }
  },
  {
    commandPath: ["task", "dispatch"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 3, entity: "task-role", provider: "task-roles-without-active-runs", dependsOn: 2, actionTarget: true },
      { option: "--work-item", entity: "work-item", provider: "dispatch-work-items", dependsOn: 2, actionTarget: false },
      { option: "--topic", entity: "topic", provider: "task-topics", dependsOn: 2, actionTarget: false }
    ],
    trailingOptions: { "--mode": "value", "--work-item": "value", "--topic": "value", "--input": "value" },
    requiredOptions: ["--mode", "--input"]
  },
  {
    commandPath: ["task", "yield"],
    selectors: [
      { argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 3, entity: "task-role", provider: "task-roles-with-active-runs", dependsOn: 2, actionTarget: true }
    ],
    trailingOptions: { "--summary": "value" },
    requiredOptions: ["--summary"],
    confirmation: { action: "Yield task role", targetArgumentIndex: 3 }
  },
  ...[
    ["schedule", "set", { "--inactivity-minutes": "value", "--cooldown-minutes": "value", "--review-at": "value", "--every-minutes": "value", "--next-at": "value" }, ["--inactivity-minutes", "--cooldown-minutes"]],
    ["brief", "update", { "--objective": "value", "--boundary": "value", "--focus": "value", "--leader-summary": "value" }, ["--objective", "--focus", "--leader-summary"]],
    ["milestone", "add", { "--title": "value", "--summary": "value", "--topic": "value" }, ["--title", "--summary"]],
    ["decision", "record", { "--title": "value", "--rationale": "value", "--topic": "value" }, ["--title", "--rationale"]]
  ].map(([group, command, trailingOptions, requiredOptions]): InteractionPolicy => ({
    commandPath: ["task", group as string, command as string],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      ...(["milestone", "decision"].includes(group as string)
        ? [{ option: "--topic", entity: "topic" as const, provider: "task-topics" as const, dependsOn: 3, actionTarget: false }]
        : [])
    ],
    trailingOptions: trailingOptions as Readonly<Record<string, "value">>,
    requiredOptions: requiredOptions as readonly string[]
  })),
  {
    commandPath: ["task", "worktree", "create"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { argumentIndex: 4, entity: "task-role", provider: "worktree-task-roles", dependsOn: 3, actionTarget: true }
    ],
    trailingOptions: { "--path": "value", "--branch": "value", "--base": "value" },
    requiredOptions: ["--path", "--branch"]
  }
];

export function findInteractionPolicy(node: CommandNode): InteractionPolicy | undefined {
  const path = node.path.slice(1);
  return INTERACTION_POLICIES.find((policy) => samePath(policy.commandPath, path));
}

export function validateInteractionPolicies(
  policies: readonly InteractionPolicy[] = INTERACTION_POLICIES,
  root: CommandNode = ROOT_COMMAND
): void {
  const seen = new Set<string>();

  for (const policy of policies) {
    const key = policy.commandPath.join(" ");
    if (seen.has(key)) {
      throw new Error(`Duplicate interaction policy: ${key}`);
    }
    seen.add(key);

    const node = findPath(root, policy.commandPath);
    if (node === undefined || node.kind === "group") {
      throw new Error(`Interaction policy must reference an executable command: ${key}`);
    }

    const positions = new Set<number>();
    const slots = new Set<string>();
    for (const selector of policy.selectors) {
      if ((selector.argumentIndex === undefined) === (selector.option === undefined)) {
        throw new Error(`Interaction selector must define exactly one slot for ${key}`);
      }
      if (selector.option !== undefined && !node.options.includes(selector.option)) {
        throw new Error(`Interaction selector option is not catalog-owned for ${key}: ${selector.option}`);
      }
      if (selector.requiredOption === true && selector.option === undefined) {
        throw new Error(`A required interaction option must use an option slot for ${key}`);
      }
      if (selector.unlessOption !== undefined && !node.options.includes(selector.unlessOption)) {
        throw new Error(`Interaction selector guard option is not catalog-owned for ${key}: ${selector.unlessOption}`);
      }
      const slot = selector.option ?? `#${selector.argumentIndex}`;
      if (slots.has(slot)) {
        throw new Error(`Duplicate interaction selector slot for ${key}: ${slot}`);
      }
      slots.add(slot);
      if (selector.dependsOn !== undefined && !positions.has(selector.dependsOn)) {
        throw new Error(`Interaction selector dependency must reference an earlier selector for ${key}`);
      }
      if (!providerSupports(selector.provider, selector.entity)) {
        throw new Error(`Interaction provider ${selector.provider} is incompatible with ${selector.entity} for ${key}`);
      }
      if (selector.argumentIndex !== undefined) {
        positions.add(selector.argumentIndex);
      }
    }
    for (const option of policy.requiredOptions ?? []) {
      if (!node.options.includes(option)) {
        throw new Error(`Interaction required option is not catalog-owned for ${key}: ${option}`);
      }
    }
    for (const option of policy.requiredAnyOptions ?? []) {
      if (!node.options.includes(option)) {
        throw new Error(`Interaction any-required option is not catalog-owned for ${key}: ${option}`);
      }
    }
    for (const prerequisite of policy.optionPrerequisites ?? []) {
      const optionValues = node.optionValues[prerequisite.option];
      if (optionValues === undefined) {
        throw new Error(`Interaction option prerequisite must reference a catalog enum for ${key}: ${prerequisite.option}`);
      }
      for (const value of prerequisite.values) {
        if (!optionValues.includes(value)) {
          throw new Error(`Interaction option prerequisite value is not catalog-owned for ${key}: ${value}`);
        }
      }
      for (const requiredOption of prerequisite.requiredOptions) {
        if (!node.options.includes(requiredOption)) {
          throw new Error(`Interaction option prerequisite is not catalog-owned for ${key}: ${requiredOption}`);
        }
      }
    }
    for (const option of Object.keys(policy.trailingOptions ?? {})) {
      if (!node.options.includes(option)) {
        throw new Error(`Interaction trailing option is not catalog-owned for ${key}: ${option}`);
      }
    }
    if (
      policy.confirmation !== undefined &&
      !policy.selectors.some((selector) =>
        selector.argumentIndex === policy.confirmation?.targetArgumentIndex && selector.actionTarget)
    ) {
      throw new Error(`Interaction confirmation must reference an action target for ${key}`);
    }
  }
}

function providerSupports(provider: CandidateProviderName, entity: SelectableEntity): boolean {
  return provider === "configured-agents" && entity === "agent"
    || ["global-roles-for-show", "removable-global-roles", "configured-global-roles"].includes(provider)
      && entity === "global-role"
    || ["tasks", "unarchived-tasks", "archived-tasks", "tasks-with-input-drafts", "trashed-tasks"].includes(provider)
      && entity === "task"
    || ["task-roles", "task-roles-with-transcripts", "task-roles-with-active-runs", "task-roles-without-active-runs", "removable-task-roles", "worktree-task-roles"].includes(provider)
      && entity === "task-role"
    || provider === "task-topics" && entity === "topic"
    || provider === "active-cycles" && entity === "cycle"
    || ["open-work-items", "work-items", "dispatch-work-items"].includes(provider) && entity === "work-item"
    || provider === "active-decisions" && entity === "decision";
}

function findPath(root: CommandNode, path: readonly string[]): CommandNode | undefined {
  let node = root;
  for (const part of path) {
    const child = findChild(node, part);
    if (child === undefined) {
      return undefined;
    }
    node = child;
  }
  return node;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

validateInteractionPolicies();
