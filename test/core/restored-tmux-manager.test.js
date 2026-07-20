import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  TmuxDeliveryPump,
  TmuxManager,
  TmuxReadinessProbeRequiredError,
  TmuxReadinessTimeoutError
} from "../../dist/tmux/tmuxManager.js";

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

test("restored tmux attach owns the terminal after an exclusive handoff", () => {
  const input = new TtyInput();
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args, options) {
      calls.push({ command, args, options, inputEvents: [...input.events] });
      return "";
    }
  }, {
    taskmuxHome: "/tmp/taskmux-home",
    terminalInput: input,
    closeInteractiveInput: () => input.events.push("close")
  });

  manager.attachRole("task-1", "leader");

  assert.deepEqual(input.events, ["close", "raw:false", "pause"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "attach-session");
  assert.equal(calls[0].options.inheritStdio, true);
  assert.deepEqual(calls[0].inputEvents, input.events);
});

test("sendRoleInputOnce probes readiness and applies a pane receipt in one tmux command", () => {
  const calls = [];
  let deliveries = 0;
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (args[0] === "display-message") return "0|321|codex\n";
      if (args[0] === "capture-pane") return "native composer ready\n";
      if (args[0] === "if-shell") {
        deliveries += 1;
        const branch = deliveries === 1 ? args.at(-1) : args.at(-2);
        return `${branch.match(/__TASKMUX_DELIVERY_(?:SENT|PRESENT)_[a-f0-9]+__/)[0]}\n`;
      }
      return "";
    }
  }, {
    taskmuxHome: "/tmp/taskmux-home",
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

  assert.equal(calls.filter((call) => call.args[0] === "display-message").length, 2);
  const sends = calls.filter((call) => call.args[0] === "if-shell");
  assert.equal(sends.length, 2);
  for (const send of sends) {
    assert.match(send.args.join(" "), /@taskmux_delivery_[a-f0-9]{64}/);
    assert.match(send.args.at(-1), /set-option.*send-keys -l.*send-keys.*Enter/s);
    assert.equal(calls.filter((call) => call.args[0] === "send-keys").length, 0);
  }
});

test("sendRoleInputOnce times out without injecting input when the pane is not ready", () => {
  const calls = [];
  let timestamp = 0;
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (args[0] === "display-message") return "0|321|node\n";
      if (args[0] === "capture-pane") return "starting\n";
      return "";
    }
  }, {
    taskmuxHome: "/tmp/taskmux-home",
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
  assert.ok(calls.filter((call) => call.args[0] === "display-message").length >= 2);
  assert.equal(calls.some((call) => call.args[0] === "if-shell"), false);
  assert.equal(calls.some((call) => call.args[0] === "send-keys"), false);
});

test("an existing pane receipt bypasses readiness while the Agent is busy", () => {
  const calls = [];
  let readinessProbes = 0;
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (args[0] === "show-options") return "1\n";
      throw new Error(`unexpected tmux command: ${args[0]}`);
    }
  }, { taskmuxHome: "/tmp/taskmux-home" });

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
  assert.deepEqual(calls.map((call) => call.args[0]), ["show-options"]);
});

test("one manager accepts distinct Codex and Claude readiness probes per delivery", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (args[0] === "display-message") {
        return args[args.indexOf("-t") + 1].endsWith(":leader")
          ? "0|101|node\n"
          : "0|202|claude\n";
      }
      if (args[0] === "capture-pane") {
        return args[args.indexOf("-t") + 1].endsWith(":leader")
          ? "Codex composer ready\n"
          : "Claude prompt ready\n";
      }
      if (args[0] === "if-shell") {
        return `${args.at(-1).match(/__TASKMUX_DELIVERY_SENT_[a-f0-9]+__/)[0]}\n`;
      }
      return "";
    }
  }, { taskmuxHome: "/tmp/taskmux-home" });

  assert.equal(manager.sendRoleInputOnce(
    "task-1", "leader", "codex-job", "lead",
    ({ currentCommand, content }) => currentCommand === "node" && content.includes("Codex composer")
  ), "sent");
  assert.equal(manager.sendRoleInputOnce(
    "task-1", "worker", "claude-job", "work",
    ({ currentCommand, content }) => currentCommand === "claude" && content.includes("Claude prompt")
  ), "sent");
  assert.equal(calls.filter((call) => call.args[0] === "if-shell").length, 2);
});

test("automated delivery refuses a live pane without an Agent-specific readiness probe", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      return "";
    }
  }, { taskmuxHome: "/tmp/taskmux-home" });

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
