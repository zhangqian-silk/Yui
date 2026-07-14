import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TmuxManager, taskmuxTmuxTarget } from "../dist/tmux/tmuxManager.js";

const target = {
  taskId: "task-1",
  roleName: "leader",
  agentId: "codex",
  adapterId: "codex",
  sessionRoot: "/tmp",
  nativeSessionId: "leader-native-1",
  agentRunId: "leader-run-1"
};
const deliveryId = `input-resolution-${"a".repeat(64)}`;

function bindingFor(value) {
  return createHash("sha256").update(JSON.stringify([
    value.taskId,
    value.roleName,
    value.agentId,
    value.adapterId,
    value.sessionRoot,
    value.nativeSessionId,
    value.agentRunId
  ])).digest("hex");
}

function receiptFor(value) {
  return createHash("sha256")
    .update(`taskmux-leader-input:${value}`)
    .digest("hex");
}

test("exact Leader input binds the full tuple and receipt in one tmux if-shell queue", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-exact-input-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const manager = new TmuxManager("tmux", {
    run(command, args, options) {
      calls.push({ command, args, options });
      return args[0] === "if-shell"
        ? `__TASKMUX_EXACT_INPUT_APPLIED_${receiptFor(deliveryId)}__\n`
        : "";
    }
  }, home);

  manager.bindExactRoleInputTarget(target);
  manager.sendExactRoleInputOnce(target, deliveryId, "resume exact Leader");

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    "set-option",
    "-w",
    "-t",
    taskmuxTmuxTarget(home, "task-1", "leader"),
    "@taskmux_exact_role_input_binding",
    bindingFor(target)
  ]);

  const send = calls[1].args;
  assert.equal(send[0], "if-shell");
  assert.equal(send[1], "-t");
  assert.equal(send[2], taskmuxTmuxTarget(home, "task-1", "leader"));
  assert.equal(send[3], "-F");
  assert.match(send[4], new RegExp(`@taskmux_exact_role_input_binding[^}]*},${bindingFor(target)}`));
  assert.match(send[4], new RegExp(`@taskmux_leader_input_${receiptFor(deliveryId)}`));
  assert.match(send[5], new RegExp(`set-option -w -t ${JSON.stringify(taskmuxTmuxTarget(home, "task-1", "leader"))}`));
  assert.match(send[5], /send-keys -l/);
  assert.match(send[5], /send-keys -t .* Enter/);
  assert.match(send[6], /display-message -p/);
  assert.match(send[6], new RegExp(`__TASKMUX_EXACT_INPUT_RECEIPT_${receiptFor(deliveryId)}__`));
  assert.match(send[6], new RegExp(`__TASKMUX_EXACT_INPUT_FENCED_${receiptFor(deliveryId)}__`));
});
