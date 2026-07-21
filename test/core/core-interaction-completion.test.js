import assert from "node:assert/strict";
import test from "node:test";

import {
  findCommand,
  findCommandNode,
  listPublicCommandPaths
} from "../../dist/cli/commandCatalog.js";
import { renderCompletion } from "../../dist/cli/completion.js";
import { resolveCompletionCandidates } from "../../dist/cli/dynamicCompletion.js";
import { renderCommandHelp } from "../../dist/cli/helpRenderer.js";
import { getSelectionCandidates } from "../../dist/cli/interactionCandidates.js";
import { findInteractionPolicy } from "../../dist/cli/interactionPolicy.js";
import {
  allowsInteractiveSelection,
  resolveInteractiveArguments
} from "../../dist/cli/interactiveSelection.js";
import { orderRoleOptions } from "../../dist/cli/roleOptionCatalog.js";

const PUBLIC_PATHS = [
  "help",
  "version",
  "update",
  "setup",
  "doctor",
  "controller",
  "controller status",
  "controller stop",
  "controller restart",
  "operator",
  "operator enter",
  "operator submit",
  "repository",
  "repository add",
  "repository list",
  "agent",
  "agent add",
  "agent list",
  "agent show",
  "agent update",
  "agent remove",
  "role",
  "role add",
  "role list",
  "role show",
  "role update",
  "role remove",
  "role bind",
  "role enter",
  "role session",
  "role session record",
  "role session replace",
  "task",
  "task create",
  "task update",
  "task activate",
  "task complete",
  "task reopen",
  "task list",
  "task show",
  "task archive",
  "task reconcile",
  "task message",
  "task message send",
  "task message list",
  "task role",
  "task role add",
  "task role list",
  "task role show",
  "task role update",
  "task role remove",
  "task role bind",
  "task role enter",
  "task work",
  "task work create",
  "task work list",
  "task work update",
  "task work dispatch",
  "task run",
  "task run list",
  "task run retry",
  "task run yield",
  "task brief",
  "task brief show",
  "task brief update",
  "task decision",
  "task decision record",
  "task decision list",
  "task decision show",
  "task decision supersede",
  "task milestone",
  "task milestone add",
  "task milestone list",
  "task milestone show",
  "task event",
  "task event list",
  "task event show",
  "task enter",
  "jobs",
  "jobs list",
  "jobs retry",
  "completion",
  "completion bash",
  "completion zsh",
  "completion fish"
];

function selector(provider, entity, input = {}) {
  return {
    argumentIndex: 2,
    provider,
    entity,
    actionTarget: true,
    ...input
  };
}

function createPorts() {
  const events = [];
  const responses = {
    "agent.list": [
      { id: "codex", adapterId: "codex", command: "codex" },
      { id: "claude", adapterId: "claude", command: "claude" }
    ],
    "config.get": { defaultAgent: "claude" },
    "jobs.list": [
      { id: "job-alpha", type: "start-run", status: "failed" },
      { id: "job-beta", type: "wake-role", status: "pending" }
    ],
    "repository.list": [
      { id: "repo-alpha", name: "Alpha" },
      { id: "repo-beta", name: "Beta" }
    ],
    "task.list": [
      { id: "task-alpha", title: "Alpha", status: "active" },
      { id: "task-beta", title: "Beta", status: "active" }
    ]
  };
  return {
    events,
    setup: async () => ({}),
    doctor: async () => ({}),
    attach: async () => {},
    call: async (method, params) => {
      events.push({ method, params });
      if (method === "task.role.list") {
        return [
          { id: "reviewer", name: "Reviewer", kind: "worker" },
          { id: "leader", name: "Leader", kind: "leader" },
          { id: "builder", name: "Builder", kind: "worker" }
        ];
      }
      if (method === "task.work.list") {
        return params.taskId === "task-alpha"
          ? [{ id: "work-alpha", title: "Alpha work", taskId: params.taskId }]
          : [{ id: "work-beta", title: "Beta work", taskId: params.taskId }];
      }
      if (method === "task.run.list") {
        return params.workItemId === "work-alpha"
          ? [{ id: "run-alpha", workItemId: params.workItemId, status: "failed" }]
          : [{ id: "run-beta", workItemId: params.workItemId, status: "failed" }];
      }
      if (Object.hasOwn(responses, method)) return responses[method];
      throw new Error(`Unexpected call: ${method} ${JSON.stringify(params)}`);
    }
  };
}

function selectionIo(answers, input = {}) {
  const prompts = [];
  const writes = [];
  return {
    prompts,
    writes,
    interactive: input.interactive ?? true,
    json: input.json ?? false,
    width: 100,
    write: (value) => writes.push(value),
    question: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    }
  };
}

function values(set) {
  assert.notEqual(set, null);
  return set.candidates.map((candidate) => candidate.value);
}

test("interaction policies cover missing task, work, run, and job identifiers", () => {
  const expected = [
    [["task", "show"], 2, "tasks"],
    [["task", "activate"], 2, "tasks"],
    [["task", "update"], 2, "tasks"],
    [["task", "complete"], 2, "tasks"],
    [["task", "reopen"], 2, "tasks"],
    [["task", "archive"], 2, "tasks"],
    [["task", "reconcile"], 2, "tasks"],
    [["task", "work", "dispatch"], 3, "work-items"],
    [["task", "run", "list"], 3, "work-items"],
    [["task", "run", "retry"], 3, "runs"],
    [["task", "run", "yield"], 3, "runs"],
    [["jobs", "retry"], 2, "jobs"]
  ];

  for (const [path, argumentIndex, provider] of expected) {
    const node = findCommandNode(path);
    assert.ok(node, path.join(" "));
    assert.equal(findCommand(path), node, `alias differs for ${path.join(" ")}`);
    const policy = findInteractionPolicy(node);
    assert.ok(policy, path.join(" "));
    assert.ok(
      policy.selectors.some((candidate) =>
        candidate.argumentIndex === argumentIndex && candidate.provider === provider),
      `${path.join(" ")} does not select ${provider}`
    );
  }

  const archive = findInteractionPolicy(findCommandNode(["task", "archive"]));
  assert.deepEqual(archive.confirmation, {
    action: "Archive task",
    targetArgumentIndex: 2
  });
});

test("Task Role detail policies select task then Role and confirm removal", () => {
  for (const command of ["show", "update", "remove"]) {
    const policy = findInteractionPolicy(findCommandNode(["task", "role", command]));
    assert.ok(policy, command);
    assert.deepEqual(policy.selectors, [
      {
        argumentIndex: 3,
        entity: "task",
        provider: "tasks",
        actionTarget: true
      },
      {
        argumentIndex: 4,
        entity: "task-role",
        provider: "task-roles",
        dependsOn: 3,
        actionTarget: true
      }
    ]);
  }

  const remove = findInteractionPolicy(findCommandNode(["task", "role", "remove"]));
  assert.deepEqual(remove.confirmation, {
    action: "Remove Task Role",
    targetArgumentIndex: 4
  });
});

test("candidate providers read the current core entities through CoreCliPorts.call", async () => {
  const ports = createPorts();

  assert.deepEqual(values(await getSelectionCandidates(
    selector("tasks", "task"), ports, ["task", "show"]
  )), ["task-alpha", "task-beta"]);
  assert.deepEqual(values(await getSelectionCandidates(
    selector("repositories", "repository", { option: "--repository" }),
    ports,
    ["task", "create", "Title", "--repository"]
  )), ["repo-alpha", "repo-beta"]);
  const roles = values(await getSelectionCandidates(
    selector("task-roles", "task-role", { argumentIndex: 3, dependsOn: 2 }),
    ports,
    ["task", "enter", "task-alpha"]
  ));
  assert.equal(roles[0], "Leader");
  assert.deepEqual(new Set(roles.slice(1)), new Set(["Reviewer", "Builder"]));
  assert.deepEqual(values(await getSelectionCandidates(
    selector("work-items", "work-item", { argumentIndex: 3 }),
    ports,
    ["task", "work", "dispatch"]
  )), ["work-alpha", "work-beta"]);
  assert.deepEqual(values(await getSelectionCandidates(
    selector("runs", "run", { argumentIndex: 3 }),
    ports,
    ["task", "run", "retry"]
  )), ["run-alpha", "run-beta"]);
  assert.deepEqual(values(await getSelectionCandidates(
    selector("jobs", "job"), ports, ["jobs", "retry"]
  )), ["job-alpha", "job-beta"]);
  const agents = await getSelectionCandidates(
    selector("configured-agents", "agent", { option: "--agent" }),
    ports,
    ["task", "role", "add", "task-alpha", "worker", "--agent"]
  );
  assert.deepEqual(values(agents), ["codex", "claude"]);
  assert.equal(agents.defaultValue, "claude");
  assert.equal(agents.columns.at(-1).header, "Default");
  assert.equal(agents.candidates.find(({ value }) => value === "claude").cells.at(-1), "default");

  assert.ok(ports.events.some(({ method }) => method === "agent.list"));
  assert.ok(ports.events.some(({ method }) => method === "config.get"));
  assert.ok(ports.events.some(({ method }) => method === "repository.list"));
  assert.ok(ports.events.some(({ method }) => method === "task.role.list"));
  assert.ok(ports.events.some(({ method }) => method === "jobs.list"));
  assert.deepEqual(
    new Set(ports.events
      .filter(({ method }) => method === "task.work.list")
      .map(({ params }) => params.taskId)),
    new Set(["task-alpha", "task-beta"])
  );
  assert.deepEqual(
    new Set(ports.events
      .filter(({ method }) => method === "task.run.list")
      .map(({ params }) => params.workItemId)),
    new Set(["work-alpha", "work-beta"])
  );
});

test("an empty Agent selection chooses the configured default Agent", async () => {
  const node = findCommandNode(["task", "role", "add"]);
  assert.ok(node);
  const ports = createPorts();
  const io = selectionIo([""]);

  const result = await resolveInteractiveArguments(
    ["task", "role", "add", "task-alpha", "Reviewer", "--agent"], node, ports, io
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["task", "role", "add", "task-alpha", "Reviewer", "--agent", "claude"]
  });
  assert.match(io.writes.join(""), /Default/);
  assert.match(io.writes.join(""), /claude\s+claude\s+claude\s+default/);
});

test("Task Role detail selection resolves the task before its Role and confirms removal", async () => {
  for (const command of ["show", "update"]) {
    const node = findCommandNode(["task", "role", command]);
    assert.ok(node);
    const ports = createPorts();
    const io = selectionIo(["task-alpha", "Leader"]);
    const result = await resolveInteractiveArguments(
      ["task", "role", command], node, ports, io
    );
    assert.deepEqual(result, {
      kind: "resolved",
      args: ["task", "role", command, "task-alpha", "Leader"]
    });
    assert.ok(ports.events.some(({ method, params }) =>
      method === "task.role.list" && params.taskId === "task-alpha"));
  }

  const node = findCommandNode(["task", "role", "remove"]);
  assert.ok(node);
  const ports = createPorts();
  const io = selectionIo(["task-alpha", "Leader", "yes"]);
  const result = await resolveInteractiveArguments(
    ["task", "role", "remove"], node, ports, io
  );
  assert.deepEqual(result, {
    kind: "resolved",
    args: ["task", "role", "remove", "task-alpha", "Leader"]
  });
  assert.ok(io.prompts.includes("Remove Task Role Leader? [y/N]: "));

  const cancelled = await resolveInteractiveArguments(
    ["task", "role", "remove"], node, createPorts(),
    selectionIo(["task-alpha", "Leader", "no"])
  );
  assert.deepEqual(cancelled, {
    kind: "cancelled",
    args: ["task", "role", "remove", "task-alpha", "Leader"]
  });
});

test("Task lifecycle selectors filter candidates by valid source status", async () => {
  const ports = createPorts();
  ports.call = async (method) => method === "task.list" ? [
    { id: "draft", title: "Draft", status: "draft" },
    { id: "active", title: "Active", status: "active" },
    { id: "completed", title: "Completed", status: "completed" },
    { id: "archived", title: "Archived", status: "archived" }
  ] : [];

  for (const [command, expected] of [
    ["activate", ["draft"]],
    ["complete", ["active"]],
    ["reopen", ["completed"]]
  ]) {
    const policy = findInteractionPolicy(findCommandNode(["task", command]));
    assert.deepEqual(
      values(await getSelectionCandidates(policy.selectors[0], ports, ["task", command])),
      expected
    );
  }
});

test("role ordering keeps Operator then Leader before task-specific roles", () => {
  const mixed = [
    { id: "reviewer", name: "Reviewer", kind: "worker" },
    { id: "leader", name: "Leader", kind: "leader" },
    { id: "operator", name: "Operator", kind: "operator" },
    { id: "builder", name: "Builder", kind: "worker" }
  ];

  const ordered = orderRoleOptions(mixed);
  assert.deepEqual(ordered.slice(0, 2).map(({ kind }) => kind), ["operator", "leader"]);
  assert.deepEqual(
    new Set(ordered.slice(2).map(({ id }) => id)),
    new Set(["reviewer", "builder"])
  );
  assert.deepEqual(mixed.map(({ id }) => id), ["reviewer", "leader", "operator", "builder"]);
});

test("interactive resolution selects a missing archive target and confirms it", async () => {
  const node = findCommandNode(["task", "archive"]);
  assert.ok(node);

  const cancelledPorts = createPorts();
  const cancelledIo = selectionIo(["task-beta", "no"]);
  const cancelled = await resolveInteractiveArguments(
    ["task", "archive"], node, cancelledPorts, cancelledIo
  );
  assert.deepEqual(cancelled, {
    kind: "cancelled",
    args: ["task", "archive", "task-beta"]
  });
  assert.ok(cancelledIo.prompts.includes("Archive task task-beta? [y/N]: "));

  const acceptedPorts = createPorts();
  const acceptedIo = selectionIo(["task-alpha", "yes"]);
  const accepted = await resolveInteractiveArguments(
    ["task", "archive"], node, acceptedPorts, acceptedIo
  );
  assert.deepEqual(accepted, {
    kind: "resolved",
    args: ["task", "archive", "task-alpha"]
  });
});

test("JSON, non-TTY, unknown options, and explicit values bypass interaction", async () => {
  const node = findCommandNode(["task", "show"]);
  assert.ok(node);
  assert.equal(allowsInteractiveSelection(["task", "show"], true), false);

  for (const example of [
    { args: ["task", "show"], io: selectionIo([], { json: true }) },
    { args: ["task", "show"], io: selectionIo([], { interactive: false }) },
    { args: ["task", "show", "--unknown"], io: selectionIo([]) },
    { args: ["task", "show", "explicit-id"], io: selectionIo([]) }
  ]) {
    const ports = createPorts();
    const result = await resolveInteractiveArguments(example.args, node, ports, example.io);
    assert.deepEqual(result, { kind: "unchanged", args: example.args });
    assert.deepEqual(ports.events, []);
    assert.deepEqual(example.io.prompts, []);
  }
});

test("Bash, Zsh, and Fish completion are catalog-derived for the current surface", async () => {
  assert.deepEqual(new Set(listPublicCommandPaths()), new Set(PUBLIC_PATHS));

  const scripts = {
    bash: renderCompletion("bash"),
    zsh: renderCompletion("zsh"),
    fish: renderCompletion("fish")
  };
  assert.match(scripts.bash, /complete -F _taskmux taskmux/);
  assert.match(scripts.zsh, /^#compdef taskmux/m);
  assert.match(scripts.fish, /complete -c taskmux/);

  for (const [shell, script] of Object.entries(scripts)) {
    for (const path of PUBLIC_PATHS) {
      assert.ok(script.includes(path), `${shell} completion is missing ${path}`);
    }
    assert.match(script, /completion candidates/);
  }

  const internal = findCommandNode(["completion", "candidates"]);
  assert.ok(internal);
  assert.equal(internal.hidden, true);
  assert.equal(listPublicCommandPaths().includes("completion candidates"), false);
  const root = findCommandNode([]);
  assert.ok(root);
  const help = renderCommandHelp(root, "0.1.5");
  assert.match(help, /^\s{2}completion\s+/m);
  assert.doesNotMatch(help, /completion candidates/);
  const completionNode = findCommandNode(["completion"]);
  assert.ok(completionNode);
  const completionHelp = renderCommandHelp(completionNode, "0.1.5");
  assert.match(completionHelp, /^\s{2}bash\s+/m);
  assert.match(completionHelp, /^\s{2}zsh\s+/m);
  assert.match(completionHelp, /^\s{2}fish\s+/m);
  assert.doesNotMatch(completionHelp, /candidates/);
});

test("dynamic candidates apply an exact prefix filter", async () => {
  const ports = createPorts();
  ports.call = async (method, params) => {
    ports.events.push({ method, params });
    return [
      { id: "task-alpha", title: "Alpha", status: "active" },
      { id: "other-task-alpha", title: "Contains but does not start", status: "active" },
      { id: "task-beta", title: "Beta", status: "active" }
    ];
  };
  const candidates = await resolveCompletionCandidates({
    words: ["task", "show"],
    current: "task-a",
    ports
  });

  assert.deepEqual(candidates, ["task-alpha"]);
  assert.deepEqual(ports.events, [{ method: "task.list", params: {} }]);
});
