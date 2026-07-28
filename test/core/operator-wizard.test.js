import assert from "node:assert/strict";
import test from "node:test";

import { resolveOperatorWizardArguments } from "../../dist/cli/operatorWizard.js";

const role = {
  name: "operator",
  activeAgentId: "codex",
  agentBindings: {
    codex: {
      agentId: "codex",
      adapterId: "codex",
      config: { adapterId: "codex", model: "gpt-5.6-sol", effort: "high" }
    },
    claude: {
      agentId: "claude",
      adapterId: "claude",
      config: { adapterId: "claude", model: "claude-opus" }
    }
  }
};

const sessions = [
  {
    ref: "op-claude",
    agentId: "claude",
    adapterId: "claude",
    displayTitle: "Review archive workflow",
    state: "current",
    createdAt: "2026-07-28T01:00:00.000Z",
    updatedAt: "2026-07-28T02:00:00.000Z"
  },
  {
    ref: "op-codex",
    agentId: "codex",
    adapterId: "codex",
    displayTitle: "Design Operator history",
    state: "history",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T01:00:00.000Z"
  }
];

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

test("Operator new selects one bound Agent and defaults to the active binding", async () => {
  const terminal = io([""]);
  const result = await resolveOperatorWizardArguments(
    ["operator", "new"],
    role,
    sessions,
    terminal,
    new Date("2026-07-28T02:05:00.000Z")
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["operator", "new", "--agent", "codex"]
  });
  assert.match(terminal.writes[0], /Select Operator Agent/);
  assert.match(terminal.writes[0], /Codex/);
  assert.match(terminal.writes[0], /Claude/);
});

test("Operator resume selects readable history without exposing native IDs", async () => {
  const terminal = io(["2"]);
  const result = await resolveOperatorWizardArguments(
    ["operator", "resume"],
    role,
    sessions,
    terminal,
    new Date("2026-07-28T02:05:00.000Z")
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["operator", "resume", "op-codex"]
  });
  assert.match(terminal.writes[0], /Resume an Operator session/);
  assert.match(terminal.writes[0], /5m ago/);
  assert.match(terminal.writes[0], /Review archive workflow/);
  assert.doesNotMatch(terminal.writes[0], /native/i);
});

test("Operator resume offers the existing new-session path without adding another command domain", async () => {
  const terminal = io(["3", "2"]);
  const result = await resolveOperatorWizardArguments(
    ["operator", "resume"],
    role,
    sessions,
    terminal,
    new Date("2026-07-28T02:05:00.000Z")
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: ["operator", "new", "--agent", "claude"]
  });
  assert.match(terminal.writes[0], /Start a new session/);
});

test("Operator wizard stays inert outside an interactive human terminal", async () => {
  assert.deepEqual(
    await resolveOperatorWizardArguments(
      ["operator", "resume"],
      role,
      sessions,
      io([], { interactive: false }),
      new Date()
    ),
    { kind: "unchanged", args: ["operator", "resume"] }
  );
  assert.deepEqual(
    await resolveOperatorWizardArguments(
      ["operator", "new"],
      role,
      sessions,
      io([], { json: true }),
      new Date()
    ),
    { kind: "unchanged", args: ["operator", "new"] }
  );
});
