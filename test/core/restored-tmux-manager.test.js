import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  TmuxDeliveryPump,
  TmuxManager,
  TmuxReadinessProbeRequiredError,
  TmuxReadinessTimeoutError,
  yuiTmuxSessionName,
  yuiTmuxServerName
} from "../../dist/tmux/tmuxManager.js";

function tmuxCommand(args) {
  assert.equal(args[0], "-L");
  assert.match(args[1], /^yui-[a-f0-9]{24}$/);
  return args[2] === "-T" ? args[4] : args[2];
}

test("tmux server names are stable for one canonical YUI_HOME and isolated across homes", () => {
  const server = yuiTmuxServerName("/tmp/team/../yui-home");

  assert.equal(server, yuiTmuxServerName("/tmp/yui-home"));
  assert.notEqual(server, yuiTmuxServerName("/tmp/other-yui-home"));
  assert.match(server, /^yui-[a-f0-9]{24}$/);
  assert.ok(server.length <= 32);
});

test("all tmux lifecycle operations use the dedicated YUI_HOME server", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      const operation = tmuxCommand(args);
      if (operation === "list-windows") return "";
      if (operation === "capture-pane") return "pane output\n";
      return "";
    }
  }, {
    yuiHome: "/tmp/yui-home",
    terminalInput: new TtyInput()
  });

  manager.ensureRoleWindow("task-1", { name: "worker", workspace: "/tmp/work" }, {
    command: "codex", args: [], env: {}
  });
  manager.attachRole("task-1", "worker");
  manager.captureRole("task-1", "worker");
  manager.detachRole("task-1");
  manager.stopRole("task-1", "worker");
  manager.killRole("task-1", "worker");
  manager.renameRole("task-1", "worker", "reviewer");
  assert.equal(manager.stopTask("task-1"), true);

  const freshManager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "has-session") throw new Error("absent");
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });
  freshManager.ensureRoleWindow("task-2", { name: "leader", workspace: "/tmp/work" }, {
    command: "codex", args: [], env: {}
  });

  const operations = calls.map(({ args }) => tmuxCommand(args));
  assert.ok(operations.includes("new-window"));
  assert.ok(operations.includes("new-session"));
  assert.ok(operations.includes("attach-session"));
  assert.ok(operations.includes("capture-pane"));
  assert.ok(operations.includes("detach-client"));
  assert.ok(operations.includes("send-keys"));
  assert.ok(operations.includes("kill-window"));
  assert.ok(operations.includes("rename-window"));
  assert.ok(operations.includes("kill-session"));
  assert.equal(new Set(calls.map(({ args }) => args[1])).size, 1);
});

class TtyInput extends PassThrough {
  isTTY = true;
  isRaw = true;
  events = [];

  setRawMode(enabled) {
    this.isRaw = enabled;
    this.events.push(`raw:${enabled}`);
  }

  pause() {
    this.events.push("pause");
    return super.pause();
  }
}

test("restored tmux attach uses client-local native terminal scrollback", () => {
  const input = new TtyInput();
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args, options) {
      calls.push({ command, args, options, inputEvents: [...input.events] });
      return "";
    }
  }, {
    yuiHome: "/tmp/yui-home",
    terminalInput: input,
    closeInteractiveInput: () => input.events.push("close")
  });

  manager.attachRole("task-1", "leader");

  assert.deepEqual(input.events, ["close", "raw:false", "pause"]);
  const session = yuiTmuxSessionName("/tmp/yui-home", "task-1");
  assert.deepEqual(calls.slice(0, 2).map(({ args }) => args.slice(2)), [
    ["set-option", "-t", session, "status", "off"],
    ["set-option", "-t", session, "mouse", "off"]
  ]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].args[2], "-T");
  assert.match(calls[2].args[3], /(?:^|,)256,RGB(?:,|$)/);
  assert.deepEqual(calls[2].args.slice(-3), [
    "attach-session", "-t", `${session}:leader`
  ]);
  assert.equal(calls[2].options.inheritStdio, true);
  assert.equal(calls[2].options.environment.TERM, "ansi");
  assert.deepEqual(calls[2].inputEvents, input.events);
});

test("sendRoleInputOnce probes readiness and applies a pane receipt in one tmux command", () => {
  const calls = [];
  let deliveries = 0;
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message") return "0|321|codex\n";
      if (tmuxCommand(args) === "capture-pane") return "native composer ready\n";
      if (tmuxCommand(args) === "if-shell") {
        deliveries += 1;
        const branch = deliveries === 1 ? args.at(-1) : args.at(-2);
        return `${branch.match(/__YUI_DELIVERY_(?:SENT|PRESENT)_[a-f0-9]+__/)[0]}\n`;
      }
      return "";
    }
  }, {
    yuiHome: "/tmp/yui-home",
    readinessTimeoutMs: 20,
    readinessPollMs: 1
  });

  const codexReady = ({ dead, currentCommand, content }) =>
    !dead && currentCommand === "codex" && content.includes("composer ready");
  assert.equal(
    manager.sendRoleInputOnce("task-1", "leader", "job-42", "hello\nworld", codexReady),
    "sent"
  );
  assert.equal(
    manager.sendRoleInputOnce("task-1", "leader", "job-42", "hello\nworld", codexReady),
    "already-sent"
  );

  assert.equal(calls.filter((call) => tmuxCommand(call.args) === "display-message").length, 2);
  const sends = calls.filter((call) => tmuxCommand(call.args) === "if-shell");
  assert.equal(sends.length, 2);
  for (const send of sends) {
    assert.match(send.args.join(" "), /@yui_delivery_[a-f0-9]{64}/);
    assert.match(send.args.at(-1), /set-option.*send-keys -l.*send-keys.*Enter/s);
    assert.match(send.args.at(-1), /send-keys -l.*run-shell 'sleep 0\.05'.*send-keys.*Enter/s);
    assert.equal(calls.filter((call) => tmuxCommand(call.args) === "send-keys").length, 0);
  }
});

test("sendRoleInputOnce times out without injecting input when the pane is not ready", () => {
  const calls = [];
  let timestamp = 0;
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message") return "0|321|node\n";
      if (tmuxCommand(args) === "capture-pane") return "starting\n";
      return "";
    }
  }, {
    yuiHome: "/tmp/yui-home",
    readinessTimeoutMs: 3,
    readinessPollMs: 1,
    now: () => timestamp++,
    sleep: () => {}
  });

  assert.throws(
    () => manager.sendRoleInputOnce(
      "task-1",
      "leader",
      "job-42",
      "do work",
      ({ currentCommand }) => currentCommand === "codex"
    ),
    TmuxReadinessTimeoutError
  );
  assert.ok(calls.filter((call) => tmuxCommand(call.args) === "display-message").length >= 2);
  assert.equal(calls.some((call) => tmuxCommand(call.args) === "if-shell"), false);
  assert.equal(calls.some((call) => tmuxCommand(call.args) === "send-keys"), false);
});

test("best-effort delivery returns immediately when the Operator composer is busy", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message") return "0|321|node\n";
      if (tmuxCommand(args) === "capture-pane") return "Operator is working\n";
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.equal(manager.sendRoleInputOnceIfReady(
    "operator",
    "operator",
    "input-request:input-1",
    "Question",
    ({ content }) => content.includes("composer ready")
  ), "not-ready");
  assert.deepEqual(calls.map((call) => tmuxCommand(call.args)), [
    "show-options", "display-message", "capture-pane"
  ]);
  assert.equal(calls.some((call) => tmuxCommand(call.args) === "if-shell"), false);
});

test("best-effort delivery sends after one readiness snapshot without entering a wait loop", () => {
  const calls = [];
  let readinessProbes = 0;
  let timestamp = 0;
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message") return "0|321|codex\n";
      if (tmuxCommand(args) === "capture-pane") return "composer ready\n";
      if (tmuxCommand(args) === "if-shell") {
        return `${args.at(-1).match(/__YUI_DELIVERY_SENT_[a-f0-9]+__/)[0]}\n`;
      }
      return "";
    }
  }, {
    yuiHome: "/tmp/yui-home",
    readinessTimeoutMs: 3,
    readinessPollMs: 1,
    now: () => timestamp++,
    sleep: () => {}
  });

  assert.equal(manager.sendRoleInputOnceIfReady(
    "operator",
    "operator",
    "input-request:input-1",
    "Question",
    () => {
      readinessProbes += 1;
      return readinessProbes === 1;
    }
  ), "sent");
  assert.equal(readinessProbes, 1);
  assert.equal(calls.filter((call) => tmuxCommand(call.args) === "display-message").length, 1);
  assert.equal(calls.filter((call) => tmuxCommand(call.args) === "capture-pane").length, 1);
  assert.equal(calls.filter((call) => tmuxCommand(call.args) === "if-shell").length, 1);
});

test("an existing pane receipt bypasses readiness while the Agent is busy", () => {
  const calls = [];
  let readinessProbes = 0;
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "show-options") return "1\n";
      throw new Error(`unexpected tmux command: ${tmuxCommand(args)}`);
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.equal(manager.sendRoleInputOnce(
    "task-1",
    "worker",
    "agent-run:run-1",
    "continue",
    () => {
      readinessProbes += 1;
      return false;
    }
  ), "already-sent");
  assert.equal(readinessProbes, 0);
  assert.deepEqual(calls.map((call) => tmuxCommand(call.args)), ["show-options"]);
});

test("one manager accepts distinct Codex and Claude readiness probes per delivery", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message") {
        return args[args.indexOf("-t") + 1].endsWith(":leader")
          ? "0|101|node\n"
          : "0|202|claude\n";
      }
      if (tmuxCommand(args) === "capture-pane") {
        return args[args.indexOf("-t") + 1].endsWith(":leader")
          ? "Codex composer ready\n"
          : "Claude prompt ready\n";
      }
      if (tmuxCommand(args) === "if-shell") {
        return `${args.at(-1).match(/__YUI_DELIVERY_SENT_[a-f0-9]+__/)[0]}\n`;
      }
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.equal(manager.sendRoleInputOnce(
    "task-1", "leader", "codex-job", "lead",
    ({ currentCommand, content }) => currentCommand === "node" && content.includes("Codex composer")
  ), "sent");
  assert.equal(manager.sendRoleInputOnce(
    "task-1", "worker", "claude-job", "work",
    ({ currentCommand, content }) => currentCommand === "claude" && content.includes("Claude prompt")
  ), "sent");
  assert.equal(calls.filter((call) => tmuxCommand(call.args) === "if-shell").length, 2);
});

test("automated delivery refuses a live pane without an Agent-specific readiness probe", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.throws(
    () => manager.sendRoleInputOnce("task-1", "leader", "job-42", "do work"),
    TmuxReadinessProbeRequiredError
  );
  assert.deepEqual(calls, []);
});

test("delivery pump preserves FIFO and keeps a failed head for retry", () => {
  const attempts = [];
  let failFirst = true;
  const pump = new TmuxDeliveryPump({
    sendRoleInputOnce(taskId, roleName, receiptId, input) {
      attempts.push([taskId, roleName, receiptId, input]);
      if (failFirst) {
        failFirst = false;
        throw new Error("not ready");
      }
      return "sent";
    }
  });

  const ready = () => true;
  pump.enqueue({
    taskId: "task-1", roleName: "leader", receiptId: "one", input: "first", readinessProbe: ready
  });
  pump.enqueue({
    taskId: "task-1", roleName: "leader", receiptId: "two", input: "second", readinessProbe: ready
  });
  assert.throws(() => pump.pump(), /not ready/);
  assert.equal(pump.pending, 2);

  assert.deepEqual(pump.pump(1), [{ receiptId: "one", outcome: "sent" }]);
  assert.equal(pump.pending, 1);
  assert.deepEqual(pump.pump(), [{ receiptId: "two", outcome: "sent" }]);
  assert.equal(pump.pending, 0);
  assert.deepEqual(attempts.map((attempt) => attempt[2]), ["one", "one", "two"]);
});
