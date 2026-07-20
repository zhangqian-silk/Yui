import type { CommandNode } from "./commandCatalog.js";

export type CandidateProviderName =
  | "configured-agents"
  | "global-roles"
  | "jobs"
  | "repositories"
  | "runs"
  | "task-roles"
  | "tasks"
  | "work-items";

export type SelectableEntity =
  | "agent"
  | "global-role"
  | "job"
  | "repository"
  | "run"
  | "task"
  | "task-role"
  | "work-item";

export type TrailingOptionKind = "flag" | "value" | "option-like-value";

export type ArgumentSelector = Readonly<{
  argumentIndex?: number;
  option?: string;
  requiredOption?: boolean;
  entity: SelectableEntity;
  provider: CandidateProviderName;
  dependsOn?: number;
  actionTarget: boolean;
}>;

export type InteractionPolicy = Readonly<{
  commandPath: readonly string[];
  selectors: readonly ArgumentSelector[];
  trailingOptions?: Readonly<Record<string, TrailingOptionKind>>;
  confirmation?: Readonly<{
    action: string;
    targetArgumentIndex: number;
  }>;
}>;

const taskTarget = (command: string, argumentIndex = 2): InteractionPolicy => ({
  commandPath: ["task", command],
  selectors: [{
    argumentIndex,
    entity: "task",
    provider: "tasks",
    actionTarget: true
  }]
});

export const INTERACTION_POLICIES: readonly InteractionPolicy[] = Object.freeze([
  ...["show", "update", "remove"].map((command): InteractionPolicy => ({
    commandPath: ["agent", command],
    selectors: [{
      argumentIndex: 2,
      entity: "agent",
      provider: "configured-agents",
      actionTarget: true
    }],
    ...(command === "remove"
      ? { confirmation: { action: "Remove Agent", targetArgumentIndex: 2 } }
      : {})
  })),
  {
    commandPath: ["role", "add"],
    selectors: [{
      option: "--agent",
      requiredOption: true,
      entity: "agent",
      provider: "configured-agents",
      actionTarget: false
    }],
    trailingOptions: {
      "--agent": "value", "--workspace": "value", "--description": "value",
      "--responsibility": "value", "--constraint": "value", "--expected-output": "value",
      "--system-prompt": "value", "--skill": "value"
    }
  },
  ...["show", "update", "remove", "enter"].map((command): InteractionPolicy => ({
    commandPath: ["role", command],
    selectors: [{
      argumentIndex: 2,
      entity: "global-role",
      provider: "global-roles",
      actionTarget: true
    }],
    ...(command === "remove"
      ? { confirmation: { action: "Remove Role", targetArgumentIndex: 2 } }
      : {})
  })),
  {
    commandPath: ["role", "bind"],
    selectors: [
      { argumentIndex: 2, entity: "global-role", provider: "global-roles", actionTarget: true },
      { argumentIndex: 3, entity: "agent", provider: "configured-agents", actionTarget: false }
    ]
  },
  ...["record", "replace"].map((command): InteractionPolicy => ({
    commandPath: ["role", "session", command],
    selectors: [{
      argumentIndex: 3,
      entity: "global-role",
      provider: "global-roles",
      actionTarget: true
    }],
    trailingOptions: command === "replace"
      ? { "--native-id": "value", "--reason": "value" }
      : { "--native-id": "value" }
  })),
  taskTarget("show"),
  taskTarget("activate"),
  {
    ...taskTarget("archive"),
    confirmation: { action: "Archive task", targetArgumentIndex: 2 }
  },
  taskTarget("reconcile"),
  {
    commandPath: ["operator", "submit"],
    selectors: [{
      option: "--task",
      entity: "task",
      provider: "tasks",
      actionTarget: false
    }],
    trailingOptions: { "--task": "value" }
  },
  {
    commandPath: ["task", "create"],
    selectors: [{
      option: "--repository",
      entity: "repository",
      provider: "repositories",
      actionTarget: false
    }],
    trailingOptions: { "--repository": "value", "--base": "value" }
  },
  ...["send", "list"].map((command): InteractionPolicy => ({
    commandPath: ["task", "message", command],
    selectors: [{
      argumentIndex: 3,
      entity: "task",
      provider: "tasks",
      actionTarget: true
    }]
  })),
  {
    commandPath: ["task", "role", "add"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { option: "--agent", entity: "agent", provider: "configured-agents", actionTarget: false }
    ],
    trailingOptions: { "--agent": "value" }
  },
  {
    commandPath: ["task", "role", "list"],
    selectors: [{ argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true }]
  },
  {
    commandPath: ["task", "role", "bind"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      {
        argumentIndex: 4,
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 3,
        actionTarget: true
      },
      { argumentIndex: 5, entity: "agent", provider: "configured-agents", actionTarget: false }
    ]
  },
  {
    commandPath: ["task", "role", "enter"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      {
        argumentIndex: 4,
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 3,
        actionTarget: true
      }
    ]
  },
  {
    commandPath: ["task", "work", "create"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      {
        option: "--role",
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 3,
        actionTarget: false
      }
    ],
    trailingOptions: { "--role": "value" }
  },
  {
    commandPath: ["task", "work", "list"],
    selectors: [{ argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true }]
  },
  {
    commandPath: ["task", "work", "update"],
    selectors: [{ argumentIndex: 3, entity: "work-item", provider: "work-items", actionTarget: true }],
    trailingOptions: { "--summary": "value" }
  },
  {
    commandPath: ["task", "work", "dispatch"],
    selectors: [{ argumentIndex: 3, entity: "work-item", provider: "work-items", actionTarget: true }],
    trailingOptions: { "--input": "value" }
  },
  {
    commandPath: ["task", "run", "list"],
    selectors: [{ argumentIndex: 3, entity: "work-item", provider: "work-items", actionTarget: true }]
  },
  ...["retry", "yield"].map((command): InteractionPolicy => ({
    commandPath: ["task", "run", command],
    selectors: [{ argumentIndex: 3, entity: "run", provider: "runs", actionTarget: true }],
    ...(command === "yield" ? { trailingOptions: { "--summary": "value" as const } } : {})
  })),
  {
    commandPath: ["task", "enter"],
    selectors: [{ argumentIndex: 2, entity: "task", provider: "tasks", actionTarget: true }]
  },
  {
    commandPath: ["jobs", "retry"],
    selectors: [{ argumentIndex: 2, entity: "job", provider: "jobs", actionTarget: true }]
  }
]);

export function findInteractionPolicy(
  node: CommandNode | undefined
): InteractionPolicy | undefined {
  if (node === undefined) return undefined;
  const path = node.path.slice(1);
  return INTERACTION_POLICIES.find((policy) =>
    policy.commandPath.length === path.length
    && policy.commandPath.every((segment, index) => segment === path[index])
  );
}

export function validateInteractionPolicies(
  policies: readonly InteractionPolicy[] = INTERACTION_POLICIES
): void {
  const paths = new Set<string>();
  for (const policy of policies) {
    const path = policy.commandPath.join(" ");
    if (paths.has(path)) throw new Error(`Duplicate interaction policy: ${path}`);
    paths.add(path);
    for (const selector of policy.selectors) {
      if ((selector.argumentIndex === undefined) === (selector.option === undefined)) {
        throw new Error(`Interaction selector must declare exactly one slot: ${path}`);
      }
    }
  }
}

validateInteractionPolicies();
