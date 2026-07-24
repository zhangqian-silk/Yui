import assert from "node:assert/strict";
import test from "node:test";

import {
  TmuxManager,
  yuiTmuxSessionName,
  yuiTmuxServerName
} from "../../dist/tmux/tmuxManager.js";

function tmuxCommand(args) {
  assert.equal(args[0], "-L");
  assert.equal(args[1], yuiTmuxServerName("/tmp/yui-home"));
  return args[2];
}

test("Role pane inventory reads the dedicated Yui tmux server in one command", () => {
  const calls = [];
  const taskSession = yuiTmuxSessionName("/tmp/yui-home", "task-1");
  const operatorSession = yuiTmuxSessionName("/tmp/yui-home", "operator");
  const separator = "\\037";
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      assert.equal(tmuxCommand(args), "list-panes");
      return [
        [taskSession, "leader", "0", "101", "codex"].join(separator),
        [taskSession, "worker", "1", "", "node"].join(separator),
        [operatorSession, "operator", "0", "303", "claude"].join(separator)
      ].join("\n");
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.deepEqual(manager.inspectRolePaneInventory(), [
    {
      taskId: "task-1",
      roleName: "leader",
      target: `${taskSession}:leader`,
      dead: false,
      pid: 101,
      currentCommand: "codex"
    },
    {
      taskId: "task-1",
      roleName: "worker",
      target: `${taskSession}:worker`,
      dead: true,
      currentCommand: "node"
    },
    {
      taskId: "operator",
      roleName: "operator",
      target: `${operatorSession}:operator`,
      dead: false,
      pid: 303,
      currentCommand: "claude"
    }
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "tmux-test");
  assert.deepEqual(calls[0].args.slice(2, 5), ["list-panes", "-a", "-F"]);
  assert.match(calls[0].args[5], /#\{session_name\}/);
  assert.match(calls[0].args[5], /#\{window_name\}/);
  assert.equal(calls.some(({ args }) => args.includes("capture-pane")), false);
});

test("Role pane inventory ignores sessions outside the Yui home namespace", () => {
  const taskSession = yuiTmuxSessionName("/tmp/yui-home", "task-1");
  const separator = "\u001f";
  const manager = new TmuxManager("tmux-test", {
    run(_command, args) {
      assert.equal(tmuxCommand(args), "list-panes");
      return [
        [taskSession, "leader", "0", "101", "codex"].join(separator),
        ["unmanaged-session", "shell", "0", "202", "zsh"].join(separator)
      ].join("\n");
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.deepEqual(
    manager.inspectRolePaneInventory().map(({ taskId, roleName }) => ({ taskId, roleName })),
    [{ taskId: "task-1", roleName: "leader" }]
  );
});
