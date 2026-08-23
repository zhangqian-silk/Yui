import { findCommandNode, type CommandNode } from "./commandCatalog.js";

export type CandidateProviderName =
  | "agent-profiles"
  | "change-sets"
  | "configured-agents"
  | "global-roles"
  | "input-requests"
  | "integration-attempts"
  | "jobs"
  | "projects"
  | "runs"
  | "task-decisions"
  | "task-events"
  | "task-milestones"
  | "task-roles"
  | "tasks"
  | "work-items";

export type SelectableEntity =
  | "agent"
  | "agent-profile"
  | "change-set"
  | "global-role"
  | "input-request"
  | "integration-attempt"
  | "job"
  | "project"
  | "run"
  | "task"
  | "decision"
  | "event"
  | "milestone"
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
  statuses?: readonly string[];
  adapterIds?: readonly string[];
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

const taskTarget = (
  command: string,
  argumentIndex = 2,
  statuses?: readonly string[]
): InteractionPolicy => ({
  commandPath: ["task", command],
  selectors: [{
    argumentIndex,
    entity: "task",
    provider: "tasks",
    actionTarget: true,
    ...(statuses === undefined ? {} : { statuses })
  }]
});

export const INTERACTION_POLICIES: readonly InteractionPolicy[] = Object.freeze([
  {
    commandPath: ["project", "refresh"],
    selectors: [{
      argumentIndex: 2,
      entity: "project",
      provider: "projects",
      actionTarget: true
    }]
  },
  {
    commandPath: ["project", "migrate"],
    selectors: [{
      argumentIndex: 2,
      entity: "project",
      provider: "projects",
      actionTarget: true
    }],
    trailingOptions: {
      "--preflight": "flag"
    }
  },
  {
    commandPath: ["project", "update"],
    selectors: [{
      argumentIndex: 2,
      entity: "project",
      provider: "projects",
      actionTarget: true
    }],
    trailingOptions: {
      "--alias": "value",
      "--clear-aliases": "flag",
      "--remote": "value",
      "--clear-remote": "flag",
      "--stable": "value",
      "--development": "value"
    }
  },
  ...["add", "retire", "list", "show"].map((command): InteractionPolicy => ({
    commandPath: ["project", "knowledge", command],
    selectors: [{
      argumentIndex: 3,
      entity: "project",
      provider: "projects",
      actionTarget: command !== "list"
    }],
    ...(command === "add"
      ? { trailingOptions: { "--body": "value" as const } }
      : command === "list"
        ? { trailingOptions: { "--all": "flag" as const } }
        : {})
  })),
  ...["show", "capabilities", "update", "remove"].map((command): InteractionPolicy => ({
    commandPath: ["config", "agent", command],
    selectors: [{
      argumentIndex: 3,
      entity: "agent",
      provider: "configured-agents",
      actionTarget: true
    }],
    ...(command === "remove"
      ? { confirmation: { action: "Remove Agent", targetArgumentIndex: 3 } }
      : {})
  })),
  {
    commandPath: ["config", "role", "add"],
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
      "--system-prompt": "value", "--skill": "value", "--model": "value",
      "--effort": "value", "--permission-strategy": "value", "--sandbox": "value", "--approval": "value",
      "--permission-mode": "value", "--allowed-tool": "value", "--disallowed-tool": "value",
      "--search": "value"
    }
  },
  ...["show", "update", "remove", "enter", "context"].map((command): InteractionPolicy => ({
    commandPath: command === "enter" || command === "context"
      ? ["session", command]
      : ["config", "role", command],
    selectors: [{
      argumentIndex: command === "enter" || command === "context" ? 2 : 3,
      entity: "global-role",
      provider: "global-roles",
      actionTarget: true
    }],
    ...(command === "remove"
      ? { confirmation: { action: "Remove Role", targetArgumentIndex: 3 } }
      : {})
  })),
  ...["bind", "unbind"].map((command): InteractionPolicy => ({
    commandPath: ["config", "role", command],
    selectors: [
      { argumentIndex: 3, entity: "global-role", provider: "global-roles", actionTarget: true },
      { argumentIndex: 4, entity: "agent", provider: "configured-agents", actionTarget: false }
    ]
  })),
  ...["record", "replace"].map((command): InteractionPolicy => ({
    commandPath: ["session", command],
    selectors: [{
      argumentIndex: 2,
      entity: "global-role",
      provider: "global-roles",
      actionTarget: true
    }],
    trailingOptions: command === "replace"
      ? { "--native-id": "value", "--reason": "value" }
      : { "--native-id": "value" }
  })),
  {
    commandPath: ["config", "profile", "add"],
    selectors: [],
    trailingOptions: {
      "--description": "value", "--instructions": "value",
      "--skill": "value", "--model": "value", "--effort": "value", "--access": "value"
    }
  },
  ...["show", "update", "remove"].map((command): InteractionPolicy => ({
    commandPath: ["config", "profile", command],
    selectors: [{
      argumentIndex: 3,
      entity: "agent-profile",
      provider: "agent-profiles",
      actionTarget: true
    }],
    ...(command === "update"
      ? {
          trailingOptions: {
            "--description": "option-like-value",
            "--instructions": "option-like-value", "--skill": "value",
            "--model": "option-like-value", "--effort": "option-like-value",
            "--access": "value"
          }
        }
      : {}),
    ...(command === "remove"
      ? { confirmation: { action: "Remove Agent Profile", targetArgumentIndex: 3 } }
      : {})
  })),
  taskTarget("show"),
  taskTarget("context"),
  {
    ...taskTarget("update"),
    trailingOptions: {
      "--title": "value",
      "--description": "value",
      "--priority": "value",
      "--tags": "value",
      "--due-at": "value",
      "--clear-description": "flag",
      "--clear-priority": "flag",
      "--clear-tags": "flag",
      "--clear-due-at": "flag"
    }
  },
  taskTarget("activate", 2, ["draft"]),
  {
    ...taskTarget("complete", 2, ["active"]),
    trailingOptions: { "--summary": "value" }
  },
  taskTarget("reopen", 2, ["completed"]),
  {
    ...taskTarget("retire", 2, ["draft", "active"]),
    trailingOptions: {
      "--summary": "value",
      "--summary-file": "value",
      "--replacement": "value"
    },
    confirmation: { action: "Retire task", targetArgumentIndex: 2 }
  },
  {
    commandPath: ["task", "list"],
    selectors: [],
    trailingOptions: { "--all": "flag", "--verbose": "flag" }
  },
  {
    ...taskTarget("archive", 2, ["completed", "retired"]),
    trailingOptions: { "--integrated": "flag", "--abandon": "flag" },
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
      option: "--project",
      entity: "project",
      provider: "projects",
      actionTarget: false
    }],
    trailingOptions: { "--project": "value", "--base": "value" }
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
    commandPath: ["task", "input", "request"],
    selectors: [{
      argumentIndex: 3,
      entity: "task",
      provider: "tasks",
      actionTarget: true,
      statuses: ["active"]
    }],
    trailingOptions: {
      "--question": "value",
      "--choice": "value",
      "--blocks": "value",
      "--recommend": "value",
      "--timeout-seconds": "value"
    }
  },
  {
    commandPath: ["task", "input", "show"],
    selectors: [
      { argumentIndex: 3, entity: "input-request", provider: "input-requests", actionTarget: true },
      { option: "--task", entity: "task", provider: "tasks", actionTarget: false }
    ],
    trailingOptions: { "--task": "value" }
  },
  {
    commandPath: ["task", "input", "answer"],
    selectors: [
      {
        argumentIndex: 3,
        entity: "input-request",
        provider: "input-requests",
        actionTarget: true,
        statuses: ["open"]
      },
      { option: "--task", entity: "task", provider: "tasks", actionTarget: false }
    ],
    trailingOptions: { "--task": "value", "--choice": "value", "--text": "value" }
  },
  {
    commandPath: ["task", "input", "cancel"],
    selectors: [
      {
        argumentIndex: 3,
        entity: "task",
        provider: "tasks",
        actionTarget: true,
        statuses: ["active"]
      },
      {
        argumentIndex: 4,
        entity: "input-request",
        provider: "input-requests",
        dependsOn: 3,
        actionTarget: true,
        statuses: ["open"]
      }
    ],
    trailingOptions: { "--reason": "value" }
  },
  {
    commandPath: ["task", "role", "add"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      { option: "--profile", entity: "agent-profile", provider: "agent-profiles", actionTarget: false },
      {
        option: "--agent",
        entity: "agent",
        provider: "configured-agents",
        actionTarget: false
      }
    ],
    trailingOptions: {
      "--profile": "value", "--agent": "value", "--description": "value", "--responsibility": "value",
      "--constraint": "value", "--expected-output": "value", "--system-prompt": "value",
      "--skill": "value", "--model": "value", "--effort": "value",
      "--permission-strategy": "value", "--sandbox": "value", "--approval": "value", "--permission-mode": "value",
      "--allowed-tool": "value", "--disallowed-tool": "value", "--search": "value"
    }
  },
  {
    commandPath: ["task", "role", "list"],
    selectors: [{ argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true }]
  },
  ...["show", "status", "update", "remove"].map((command): InteractionPolicy => ({
    commandPath: ["task", "role", command],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      {
        argumentIndex: 4,
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 3,
        actionTarget: true
      },
      ...(command === "update"
        ? [
            { option: "--profile", entity: "agent-profile", provider: "agent-profiles", actionTarget: false } as const,
            { option: "--agent", entity: "agent", provider: "configured-agents", actionTarget: false } as const
          ]
        : [])
    ],
    ...(command === "remove"
      ? { confirmation: { action: "Remove Task Role", targetArgumentIndex: 4 } }
      : {})
  })),
  ...["bind", "unbind"].map((command): InteractionPolicy => ({
    commandPath: ["task", "role", command],
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
  })),
  {
    commandPath: ["task", "role", "reset"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true, statuses: ["active"] },
      {
        argumentIndex: 4,
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 3,
        actionTarget: true
      }
    ],
    trailingOptions: { "--reason": "value" },
    confirmation: { action: "Reset Task Role Session", targetArgumentIndex: 4 }
  },
  ...["view", "takeover", "release"].map((command): InteractionPolicy => ({
    commandPath: ["task", "role", command],
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
  })),
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
    trailingOptions: {
      "--objective": "value", "--accept": "value", "--after": "value", "--role": "value"
    }
  },
  {
    commandPath: ["task", "work", "list"],
    selectors: [{ argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true }]
  },
  ...["show", "update", "dispatch", "isolate", "capture", "cleanup", "accept", "reject"]
    .map((command): InteractionPolicy => ({
      commandPath: ["task", "work", command],
      selectors: [{
        argumentIndex: 3,
        entity: "work-item",
        provider: "work-items",
        actionTarget: true
      }],
      ...(command === "update"
        ? { trailingOptions: { "--summary": "value" as const } }
        : command === "dispatch"
          ? { trailingOptions: { "--input": "value" as const } }
          : command === "cleanup"
            ? {
                trailingOptions: {
                  "--integrated": "flag" as const,
                  "--abandon": "flag" as const
                }
              }
            : ["accept", "reject"].includes(command)
              ? { trailingOptions: { "--summary": "value" as const } }
              : {})
    })),
  {
    commandPath: ["task", "work", "retire"],
    selectors: [
      {
        argumentIndex: 3,
        entity: "work-item",
        provider: "work-items",
        actionTarget: true
      },
      {
        option: "--replacement",
        entity: "work-item",
        provider: "work-items",
        dependsOn: 3,
        actionTarget: false
      }
    ],
    trailingOptions: { "--summary": "value", "--replacement": "value" },
    confirmation: { action: "Retire Work Item", targetArgumentIndex: 3 }
  },
  {
    commandPath: ["task", "run", "list"],
    selectors: [{ argumentIndex: 3, entity: "work-item", provider: "work-items", actionTarget: true }],
  },
  ...["retry", "yield"].map((command): InteractionPolicy => ({
    commandPath: ["task", "run", command],
    selectors: [{
      argumentIndex: 3,
      entity: "run",
      provider: "runs",
      actionTarget: true
    }],
    ...(command === "yield"
      ? { trailingOptions: { "--summary": "value" as const } }
      : {})
  })),
  {
    commandPath: ["task", "work", "group", "resolve"],
    selectors: [{
      argumentIndex: 4,
      entity: "work-item",
      provider: "work-items",
      actionTarget: true
    }],
    trailingOptions: {
      "--decision": "value",
      "--summary": "value",
      "--lane": "value"
    }
  },
  {
    commandPath: ["task", "review", "request"],
    selectors: [
      {
        argumentIndex: 3,
        entity: "task",
        provider: "tasks",
        actionTarget: true,
        statuses: ["active"]
      },
      {
        option: "--role",
        entity: "global-role",
        provider: "global-roles",
        actionTarget: false
      }
    ],
    trailingOptions: { "--role": "value", "--strategy": "value", "--lane-role": "value" }
  },
  {
    commandPath: ["task", "integration", "start"],
    selectors: [
      { argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true },
      {
        option: "--change-set",
        requiredOption: true,
        entity: "change-set",
        provider: "change-sets",
        dependsOn: 3,
        actionTarget: false
      }
    ],
    trailingOptions: { "--change-set": "value", "--target": "value", "--check": "value" }
  },
  {
    commandPath: ["task", "integration", "list"],
    selectors: [{ argumentIndex: 3, entity: "task", provider: "tasks", actionTarget: true }]
  },
  {
    commandPath: ["task", "integration", "cleanup"],
    selectors: [{
      argumentIndex: 3,
      entity: "integration-attempt",
      provider: "integration-attempts",
      actionTarget: true,
      statuses: ["committed", "failed"]
    }]
  },
  ...["show", "continue", "resolve", "abort"].map((command): InteractionPolicy => ({
    commandPath: ["task", "integration", command],
    selectors: [{
      argumentIndex: 3,
      entity: "integration-attempt",
      provider: "integration-attempts",
      actionTarget: true,
      ...(command === "continue" ? { statuses: ["blocked", "validating"] } : {}),
      ...(command === "resolve" ? { statuses: ["blocked"] } : {}),
      ...(command === "abort" ? { statuses: ["running", "blocked"] } : {})
    }],
    ...(command === "resolve"
        ? { trailingOptions: { "--option": "value" as const, "--rationale": "value" as const } }
        : command === "abort"
          ? { trailingOptions: { "--reason": "value" as const } }
        : {})
  })),
  {
    commandPath: ["jobs", "retry"],
    selectors: [{ argumentIndex: 2, entity: "job", provider: "jobs", actionTarget: true }]
  },
  ...([
    ["brief", "show"],
    ["brief", "update"],
    ["decision", "record"],
    ["decision", "list"],
    ["decision", "show"],
    ["decision", "supersede"],
    ["milestone", "add"],
    ["milestone", "list"],
    ["milestone", "show"],
    ["event", "list"],
    ["event", "show"]
  ] as const).map(([group, command]): InteractionPolicy => {
    const trailingOptions: Record<string, TrailingOptionKind> = {};
    if (group === "brief" && command === "update") {
      Object.assign(trailingOptions, { "--objective": "value", "--boundary": "value", "--focus": "value", "--leader-summary": "value" });
    } else if (group === "decision" && command === "record") {
      Object.assign(trailingOptions, { "--title": "value", "--rationale": "value" });
    } else if (group === "decision" && command === "list") {
      Object.assign(trailingOptions, { "--status": "value" });
    } else if (group === "decision" && command === "supersede") {
      Object.assign(trailingOptions, { "--reason": "value" });
    } else if (group === "milestone" && command === "add") {
      Object.assign(trailingOptions, { "--title": "value", "--summary": "value" });
    }
    const mutatesKnowledge = (group === "brief" && command === "update")
      || (group === "decision" && (command === "record" || command === "supersede"))
      || (group === "milestone" && command === "add");
    const selectors: ArgumentSelector[] = [{
      argumentIndex: 3,
      entity: "task",
      provider: "tasks",
      actionTarget: true,
      ...(mutatesKnowledge ? { statuses: ["draft", "active"] } : {})
    }];
    if (group === "decision" && (command === "show" || command === "supersede")) {
      selectors.push({
        argumentIndex: 4,
        entity: "decision",
        provider: "task-decisions",
        dependsOn: 3,
        actionTarget: true,
        ...(command === "supersede" ? { statuses: ["active"] } : {})
      });
    } else if (group === "milestone" && command === "show") {
      selectors.push({
        argumentIndex: 4,
        entity: "milestone",
        provider: "task-milestones",
        dependsOn: 3,
        actionTarget: true
      });
    } else if (group === "event" && command === "show") {
      selectors.push({
        argumentIndex: 4,
        entity: "event",
        provider: "task-events",
        dependsOn: 3,
        actionTarget: true
      });
    }
    return {
      commandPath: ["task", group, command],
      selectors,
      ...(Object.keys(trailingOptions).length > 0 ? { trailingOptions } : {})
    };
  })
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
    const node = findCommandNode(policy.commandPath);
    if (node === undefined || node.hidden) {
      throw new Error(`Interaction policy references an unknown command: ${path}`);
    }
    for (const selector of policy.selectors) {
      if ((selector.argumentIndex === undefined) === (selector.option === undefined)) {
        throw new Error(`Interaction selector must declare exactly one slot: ${path}`);
      }
      if (selector.argumentIndex !== undefined && (
        !Number.isInteger(selector.argumentIndex)
        || selector.argumentIndex < node.path.length - 1
      )) {
        throw new Error(`Interaction selector has an invalid argument index: ${path}`);
      }
      if (selector.option !== undefined && !node.options.includes(selector.option)) {
        throw new Error(`Interaction selector references an unknown option: ${path} ${selector.option}`);
      }
    }
    for (const option of Object.keys(policy.trailingOptions ?? {})) {
      if (!node.options.includes(option)) {
        throw new Error(`Interaction policy references an unknown trailing option: ${path} ${option}`);
      }
    }
    if (policy.confirmation !== undefined && !policy.selectors.some((selector) =>
      selector.argumentIndex === policy.confirmation?.targetArgumentIndex
      && selector.actionTarget)) {
      throw new Error(`Interaction confirmation has no action target selector: ${path}`);
    }
  }
}

validateInteractionPolicies();
