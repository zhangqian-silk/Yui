import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const INPUT_DOCS = [
  "ARCHITECTURE.md",
  "README.md",
  "i18n/README.zh-CN.md",
  "skills/taskmux-leader/SKILL.md",
  "skills/taskmux-operator/SKILL.md"
];

const PUBLIC_INPUT_COMMANDS = [
  "taskmux task input request",
  "taskmux task input list",
  "taskmux task input show",
  "taskmux task input answer",
  "taskmux task input cancel"
];

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

test("input-request documentation exposes one five-command public surface", () => {
  for (const path of INPUT_DOCS) {
    const document = read(path);
    for (const command of PUBLIC_INPUT_COMMANDS) {
      assert.equal(document.includes(command), true, `${path} must document ${command}`);
    }
    assert.doesNotMatch(document, /\btaskmux\s+inbox\b/i, `${path} must not document a separate Inbox command`);
    assert.doesNotMatch(
      document,
      /\btaskmux\s+task\s+input\s+(?:draft|submit|supersede|resume)\b/i,
      `${path} must not document an extra input-request command`
    );
  }
});

test("architecture keeps the task-owned inbox and foreground-operator boundaries explicit", () => {
  const architecture = read("ARCHITECTURE.md");
  const leaderSkill = read("skills/taskmux-leader/SKILL.md");
  const operatorSkill = read("skills/taskmux-operator/SKILL.md");

  assert.match(architecture, /Global Inbox[\s\S]*task-owned/i);
  assert.match(architecture, /role.*Agent.*adapter.*session root.*native session.*AgentRun/i);
  assert.match(architecture, /pointer-only/i);
  assert.match(architecture, /receipt[\s\S]*transport acceptance/i);
  assert.match(architecture, /user-required[\s\S]*never time out/i);
  assert.match(architecture, /continuous confirmed-offline[\s\S]*persisted recommendation/i);
  assert.match(architecture, /online[\s\S]*unknown[\s\S]*not.*time out/i);
  assert.match(architecture, /independent[\s\S]*configuration[\s\S]*session/i);
  assert.match(architecture, /one active Agent/i);
  assert.match(leaderSkill, /exact Leader origin tuple/i);
  assert.match(operatorSkill, /foreground[\s\S]*GlobalRoleSessionSet/i);
});
