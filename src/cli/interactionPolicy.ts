import { findChild, ROOT_COMMAND, type CommandNode } from "./commandCatalog.js";

export type CandidateProviderName = "configured-agents" | "tasks" | "task-roles";
export type SelectableEntity = "agent" | "global-role" | "task" | "task-role";

export type ArgumentSelector = {
  argumentIndex: number;
  entity: SelectableEntity;
  provider: CandidateProviderName;
  dependsOn?: number;
  actionTarget: boolean;
};

export type InteractionPolicy = {
  commandPath: readonly string[];
  selectors: readonly ArgumentSelector[];
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
    for (const selector of policy.selectors) {
      if (positions.has(selector.argumentIndex)) {
        throw new Error(`Duplicate interaction selector argument index for ${key}: ${selector.argumentIndex}`);
      }
      if (selector.dependsOn !== undefined && !positions.has(selector.dependsOn)) {
        throw new Error(`Interaction selector dependency must reference an earlier selector for ${key}`);
      }
      if (!providerSupports(selector.provider, selector.entity)) {
        throw new Error(`Interaction provider ${selector.provider} is incompatible with ${selector.entity} for ${key}`);
      }
      positions.add(selector.argumentIndex);
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
    || provider === "tasks" && entity === "task"
    || provider === "task-roles" && entity === "task-role";
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
