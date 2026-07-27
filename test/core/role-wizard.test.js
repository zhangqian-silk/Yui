import assert from "node:assert/strict";
import test from "node:test";

import { resolveRoleWizardArguments } from "../../dist/cli/roleWizard.js";

const codex = {
  schemaVersion: 2,
  id: "codex",
  adapterId: "codex",
  command: "codex",
  baseArgs: [],
  environment: [],
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z"
};

const claude = { ...codex, id: "claude", adapterId: "claude", command: "claude" };

function role(input = {}) {
  return {
    schemaVersion: 2,
    name: "reviewer",
    activeAgentId: "codex",
    agentBindings: {
      codex: {
        agentId: "codex",
        adapterId: "codex",
        config: { adapterId: "codex", model: "gpt-5.6-sol" }
      },
      claude: {
        agentId: "claude",
        adapterId: "claude",
        config: { adapterId: "claude" }
      }
    },
    workspace: "/tmp/reviewer",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...input
  };
}

function ports(input = {}) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "agent.list") return [codex, claude];
      if (method === "agent.capabilities") return capabilityCatalog(params.agentId);
      if (method === "config.get") return { schemaVersion: 1, defaultAgent: "codex" };
      if (method === "task.list") return [
        { id: "task-1", title: "First task", status: "active" },
        { id: "task-2", title: "Second task", status: "draft" }
      ];
      if (method === "role.show") return input.globalRole ?? role();
      if (method === "task.role.show") return input.taskRole ?? { ...role(), taskId: "task-1", status: "idle" };
      throw new Error(`Unexpected call: ${method}`);
    }
  };
}

function capabilityCatalog(agentId) {
  const adapterId = agentId === "claude" ? "claude" : "codex";
  return {
    source: "live",
    attemptedAt: "2026-07-27T08:00:00.000Z",
    fetchedAt: "2026-07-27T08:00:00.000Z",
    catalog: {
      schemaVersion: 1,
      agentId,
      adapterId,
      models: adapterId === "codex"
        ? [
            {
              value: "gpt-5.6-sol",
              label: "GPT-5.6 Sol",
              isDefault: true,
              defaultEffort: "medium",
              efforts: [
                { value: "medium", label: "medium" },
                { value: "high", label: "high" }
              ]
            },
            {
              value: "gpt-5.6-terra",
              label: "GPT-5.6 Terra",
              isDefault: false,
              defaultEffort: "medium",
              efforts: [
                { value: "medium", label: "medium" },
                { value: "high", label: "high" }
              ]
            }
          ]
        : [{
            value: "default",
            label: "Default",
            isDefault: true,
            efforts: [
              { value: "medium", label: "medium" },
              { value: "high", label: "high" }
            ]
          }],
      fields: [
        {
          key: "permission.sandbox",
          choices: [
            { value: "read-only", label: "read-only" },
            { value: "workspace-write", label: "workspace-write" },
            { value: "danger-full-access", label: "danger-full-access" }
          ],
          allowCustom: false
        },
        {
          key: "permission.approval",
          choices: [
            { value: "untrusted", label: "untrusted" },
            { value: "on-request", label: "on-request" },
            { value: "never", label: "never" }
          ],
          allowCustom: false
        },
        {
          key: "search",
          choices: [{ value: "true", label: "true" }],
          allowCustom: false
        },
        {
          key: "permission.mode",
          choices: [
            { value: "acceptEdits", label: "acceptEdits" },
            { value: "plan", label: "plan" }
          ],
          allowCustom: true
        }
      ],
      warnings: []
    }
  };
}

function io(answers, input = {}) {
  const writes = [];
  const prompts = [];
  return {
    writes,
    prompts,
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

test("Role update uses a compact two-item top level and clears model plus effort through the runtime picker", async () => {
  const terminal = io(["2", "codex", "model", "default", "default"]);
  const result = await resolveRoleWizardArguments(
    ["role", "update", "reviewer"],
    ports(),
    terminal
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: [
      "role", "update", "reviewer", "--agent", "codex",
      "--clear-model", "--clear-effort"
    ]
  });
  assert.match(terminal.writes[0], /Role settings/);
  assert.match(terminal.writes[0], /Agent settings/);
  assert.doesNotMatch(terminal.writes[0], /Role profile|Clear overrides/);
});

test("Task Role Active Agent selection becomes task role bind and does not offer workspace", async () => {
  const terminal = io(["1", "active-agent", "claude"]);
  const result = await resolveRoleWizardArguments(
    ["task", "role", "update", "task-1", "reviewer"],
    ports(),
    terminal
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["task", "role", "bind", "task-1", "reviewer", "claude"]
  });
  assert.doesNotMatch(terminal.writes[0], /workspace/i);
  assert.doesNotMatch(terminal.writes[1], /Workspace/);
});

test("Task Role creation can copy a matching Global Role and shows its active Agent", async () => {
  const terminal = io(["1"]);
  const result = await resolveRoleWizardArguments(
    ["task", "role", "add", "task-1", "reviewer"],
    ports(),
    terminal
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["task", "role", "add", "task-1", "reviewer"]
  });
  assert.match(terminal.writes[0], /Copy existing Global Role/);
  assert.match(terminal.writes[0], /codex/);
});

test("Creating from an Agent clearly marks and selects the configured default", async () => {
  const terminal = io(["2", "", "1"]);
  const result = await resolveRoleWizardArguments(
    ["task", "role", "add", "task-1", "reviewer"],
    ports(),
    terminal
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["task", "role", "add", "task-1", "reviewer", "--agent", "codex"]
  });
  assert.match(terminal.writes[1], /Default/);
  assert.match(terminal.writes[1], /codex[\s\S]*yes/);
  assert.match(terminal.writes[2], /Create with CLI defaults/);
});

test("bare Role add asks for a name and can configure one Role field", async () => {
  const terminal = io(["reviewer", "", "2", "1", "description", "Reviews changes"]);
  const result = await resolveRoleWizardArguments(["role", "add"], ports(), terminal);

  assert.deepEqual(result, {
    kind: "resolved",
    args: [
      "role", "add", "reviewer", "--agent", "codex",
      "--description", "Reviews changes"
    ]
  });
  assert.match(terminal.prompts[0], /Role name/);
  assert.match(terminal.writes[2], /Role settings/);
  assert.match(terminal.writes[2], /Agent settings/);
});

test("Global Role add with explicit settings still resolves its required Agent", async () => {
  const terminal = io([""]);
  const result = await resolveRoleWizardArguments(
    ["role", "add", "reviewer", "--model", "gpt-5.6-sol"],
    ports(),
    terminal
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: [
      "role", "add", "reviewer", "--model", "gpt-5.6-sol", "--agent", "codex"
    ]
  });
});

test("bare Task Role add selects the Task before asking for the Role name", async () => {
  const terminal = io(["task-2", "reviewer", "1"]);
  const result = await resolveRoleWizardArguments(
    ["task", "role", "add"],
    ports(),
    terminal
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["task", "role", "add", "task-2", "reviewer"]
  });
  assert.match(terminal.writes[0], /First task/);
  assert.match(terminal.prompts[1], /Role name/);
});

test("Web search only offers enabled or CLI default, never a false override", async () => {
  const terminal = io(["2", "codex", "search", "3", "true"]);
  const result = await resolveRoleWizardArguments(
    ["role", "update", "reviewer"],
    ports(),
    terminal
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["role", "update", "reviewer", "--agent", "codex", "--search", "true"]
  });
  assert.match(terminal.writes.at(-1), /true/);
  assert.doesNotMatch(terminal.writes.at(-1), /false/);
});

test("Wizard is bypassed outside TTY and when update options are explicit", async () => {
  const nonTty = io([], { interactive: false });
  const explicit = io([]);

  assert.deepEqual(await resolveRoleWizardArguments(
    ["role", "update", "reviewer"], ports(), nonTty
  ), { kind: "unchanged", args: ["role", "update", "reviewer"] });
  assert.deepEqual(await resolveRoleWizardArguments(
    ["role", "update", "reviewer", "--model", "gpt-5.6-sol"], ports(), explicit
  ), {
    kind: "unchanged",
    args: ["role", "update", "reviewer", "--model", "gpt-5.6-sol"]
  });
  assert.deepEqual(nonTty.writes, []);
  assert.deepEqual(explicit.writes, []);
});
