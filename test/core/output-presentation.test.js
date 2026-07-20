import assert from "node:assert/strict";
import { test } from "node:test";

import {
  paintTerminalOutput,
  renderCodeBlock,
  renderDetails,
  renderEmpty,
  renderError,
  renderInfo,
  renderPrompt,
  renderSection,
  renderSuccess,
  renderWarning,
  terminalSupportsColor,
  visibleWidth,
  withPromptAnswerSpacing
} from "../../dist/output/terminal.js";
import { renderTable } from "../../dist/output/table.js";

test("renders wide tables as quiet, borderless terminal content", () => {
  const output = renderTable(
    "Default agent candidates",
    [
      { header: "#", minWidth: 1, maxWidth: 3 },
      { header: "Agent", minWidth: 5, maxWidth: 14 },
      { header: "Status", minWidth: 7, maxWidth: 19 },
      { header: "Note", minWidth: 10, maxWidth: 52 }
    ],
    [
      ["1", "codex", "installed", "OpenAI Codex CLI"],
      ["2", "claude", "installed", "Anthropic Claude Code"]
    ],
    100
  );

  assert.equal(output, [
    "Default agent candidates",
    "",
    "  #  Agent   Status     Note",
    "  ─  ──────  ─────────  ─────────────────────",
    "  1  codex   installed  OpenAI Codex CLI",
    "  2  claude  installed  Anthropic Claude Code"
  ].join("\n"));
  assert.doesNotMatch(output, /[+|]/);
});

test("switches crowded tables to readable records without exceeding the terminal", () => {
  const output = renderTable(
    "Completion installation",
    [
      { header: "#", minWidth: 1, maxWidth: 3 },
      { header: "Shell", minWidth: 4, maxWidth: 6 },
      { header: "Status", minWidth: 12, maxWidth: 13 },
      { header: "Action", minWidth: 7, maxWidth: 7 },
      { header: "Script", minWidth: 8, maxWidth: 88 }
    ],
    [["2", "Zsh", "Not installed", "Install", "/home/张三/.zfunc/_taskmux"]],
    38
  );

  assert.equal(output, [
    "Completion installation",
    "",
    "  2  Zsh",
    "     Status  Not installed",
    "     Action  Install",
    "     Script  /home/张三/.zfunc/_taskmu",
    "             x"
  ].join("\n"));
  for (const line of output.split("\n")) {
    assert.ok(visibleWidth(line) <= 38, `${visibleWidth(line)}: ${line}`);
  }
});

test("wraps CJK and long unbroken values by terminal display width", () => {
  const output = renderTable(
    "Agents",
    [
      { header: "Agent", minWidth: 5, maxWidth: 8 },
      { header: "Workspace", minWidth: 10, maxWidth: 18 }
    ],
    [["编程助手", "/very/long/unbroken/workspace/path"]],
    32
  );

  for (const line of output.split("\n")) {
    assert.ok(visibleWidth(line) <= 32, `${visibleWidth(line)}: ${line}`);
  }
});

test("provides one reusable hierarchy for sections, details, code, prompts, and outcomes", () => {
  assert.equal(renderSection("Setup", "Configure TaskMux"), "Setup\n  Configure TaskMux");
  assert.equal(renderDetails([
    ["Script", "/tmp/_taskmux"],
    ["Activation", "/tmp/.zshrc"]
  ]), "  Script      /tmp/_taskmux\n  Activation  /tmp/.zshrc");
  assert.equal(renderCodeBlock("one\ntwo"), "  │ one\n  │ two");
  assert.equal(renderPrompt("Install using these paths?", "Y/n/customize"), "› Install using these paths? [Y/n/customize]: ");
  assert.equal(renderSuccess("TaskMux setup complete."), "✓ TaskMux setup complete.\n");
  assert.equal(renderInfo("The current shell is unchanged."), "› The current shell is unchanged.\n");
  assert.equal(renderWarning("Activation still required."), "! Activation still required.\n");
  assert.equal(renderError("Doctor checks failed."), "✕ Doctor checks failed.\n");
  assert.equal(renderEmpty("No tasks found."), "○ No tasks found.\n");
});

test("adds semantic color only for a capable interactive terminal", () => {
  assert.equal(terminalSupportsColor({ isTTY: true }, { TERM: "xterm-256color" }), true);
  assert.equal(terminalSupportsColor({ isTTY: false }, { TERM: "xterm-256color" }), false);
  assert.equal(terminalSupportsColor({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(terminalSupportsColor({ isTTY: true }, { TERM: "xterm-256color", NO_COLOR: "1" }), false);

  const plain = "Setup\n\n✓ Ready.\n! Review this.\n✕ Failed.\n› Next step.\n○ Nothing here.\n";
  assert.equal(paintTerminalOutput(plain, false), plain);
  const colored = paintTerminalOutput(plain, true);
  assert.match(colored, /\x1b\[1mSetup\x1b\[0m/);
  assert.match(colored, /\x1b\[32m✓\x1b\[0m Ready\./);
  assert.match(colored, /\x1b\[33m!\x1b\[0m Review this\./);
  assert.match(colored, /\x1b\[31m✕\x1b\[0m Failed\./);
  assert.match(colored, /\x1b\[36m›\x1b\[0m Next step\./);
  assert.match(colored, /\x1b\[2m○ Nothing here\.\x1b\[0m/);
  assert.equal(colored.replaceAll(/\x1b\[[0-9;]*m/g, ""), plain);
});

test("adds one visual blank line after every prompt answer", async () => {
  const echoedWrites = [];
  const echoed = withPromptAnswerSpacing(async () => "yes", (value) => echoedWrites.push(value), true);
  assert.equal(await echoed("question"), "yes");
  assert.deepEqual(echoedWrites, ["\n"]);

  const pipedWrites = [];
  const piped = withPromptAnswerSpacing(async () => "yes", (value) => pipedWrites.push(value), false);
  assert.equal(await piped("question"), "yes");
  assert.deepEqual(pipedWrites, ["\n\n"]);
});
