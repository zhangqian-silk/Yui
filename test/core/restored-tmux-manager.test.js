import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { NodeCommandExecutor } from "../../dist/tmux/commandExecutor.js";
import { agentComposerReadinessProbe } from "../../dist/executor/executorRegistry.js";
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

test("Role launches clear inherited process environment and use only the complete launch plan", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "has-session") throw new Error("absent");
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });

  manager.ensureRoleWindow("task-1", { name: "worker", workspace: "/tmp/work" }, {
    command: "codex",
    args: ["--model", "gpt-5.6-sol"],
    env: {
      PATH: "/opt/agent/bin:/usr/bin",
      HOME: "/tmp/agent-home",
      CURRENT_AGENT_TOKEN: "secret"
    }
  });

  const launch = calls.find(({ args }) => args.includes("new-session"));
  assert.deepEqual(launch.args.slice(2, 8), [
    "start-server",
    ";",
    "set-option", "-g", "history-limit", "100000"
  ]);
  assert.ok(launch.args.indexOf("history-limit") < launch.args.indexOf("new-session"));
  const commandIndex = launch.args.indexOf("--");
  assert.deepEqual(launch.args.slice(commandIndex + 1), [
    "env",
    "-i",
    "--",
    "PATH=/opt/agent/bin:/usr/bin",
    "HOME=/tmp/agent-home",
    "CURRENT_AGENT_TOKEN=secret",
    "codex",
    "--model",
    "gpt-5.6-sol"
  ]);
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

test("restored tmux attach isolates the native session in tmux scrollback", () => {
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
    terminalType: "dumb",
    closeInteractiveInput: () => input.events.push("close")
  });

  manager.attachRole("task-1", "leader");

  assert.deepEqual(input.events, ["close", "raw:false", "pause"]);
  const session = yuiTmuxSessionName("/tmp/yui-home", "task-1");
  const clientSession = calls
    .find(({ args }) => tmuxCommand(args) === "new-session")
    .args.at(-1);
  assert.match(clientSession, /^yui-client-[a-f0-9]{24}$/);
  assert.deepEqual(calls.map(({ args }) => args.slice(2)), [
    [
      "list-clients", "-F",
      "#{session_name}\u001f#{session_group}\u001f#{client_readonly}"
    ],
    ["new-session", "-d", "-t", session, "-s", clientSession],
    ["set-option", "-t", clientSession, "status", "off"],
    ["set-option", "-t", clientSession, "mouse", "on"],
    [
      "set-hook", "-t", clientSession, "client-detached",
      `kill-session -t ${clientSession}`
    ],
    ["attach-session", "-t", `${clientSession}:leader`],
    ["kill-session", "-t", clientSession]
  ]);
  const attach = calls.find(({ args }) => tmuxCommand(args) === "attach-session");
  assert.equal(attach.options.inheritStdio, true);
  assert.deepEqual(attach.options.environment, { TERM: "xterm-256color" });
  assert.deepEqual(attach.inputEvents, input.events);
});

test("attaching an existing pane reports when its history cannot be enlarged live", () => {
  const warnings = [];
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(_command, args) {
      calls.push(args);
      if (tmuxCommand(args) === "display-message") return "2000\n";
      return "";
    }
  }, {
    yuiHome: "/tmp/yui-home",
    terminalInput: new TtyInput(),
    historyLimit: 100_000,
    onWarning(message) { warnings.push(message); }
  });

  manager.attachRole("task-1", "leader");

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /existing Role.*2,000-line tmux history/u);
  assert.match(warnings[0], /exit and re-enter.*100,000 lines/u);
  const attachedNotice = calls.find((args) => (
    tmuxCommand(args) === "set-hook" && args.includes("client-attached")
  ));
  assert.match(attachedNotice.at(-1), /display-message -d 10000.*2,000-line/u);
});

test("a real legacy pane stays limited while a re-entered Role receives the configured history", (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const yuiHome = join(tmpdir(), `yui-real-tmux-history-${process.pid}`);
  const server = yuiTmuxServerName(yuiHome);
  const taskId = "history-task";
  const session = yuiTmuxSessionName(yuiHome, taskId);
  const manager = new TmuxManager("tmux", new NodeCommandExecutor(), {
    yuiHome,
    historyLimit: 100_000
  });
  t.after(() => {
    manager.stopTask(taskId);
  });
  assert.equal(spawnSync(
    "tmux",
    [
      "-L", server,
      "-f", "/dev/null",
      "new-session", "-d", "-s", session, "-n", "leader", "/bin/sh"
    ],
    { stdio: "ignore" }
  ).status, 0);

  assert.equal(manager.ensureRoleWindow(taskId, {
    name: "leader",
    workspace: process.cwd()
  }), false);
  assert.deepEqual(manager.inspectRoleHistory(taskId, "leader"), {
    actual: 2_000,
    configured: 100_000,
    limited: true
  });

  assert.equal(manager.stopTask(taskId), true);
  manager.ensureRoleWindow(taskId, {
    name: "leader",
    workspace: process.cwd()
  }, {
    command: "/bin/sh",
    args: [],
    env: {}
  });
  assert.deepEqual(manager.inspectRoleHistory(taskId, "leader"), {
    actual: 100_000,
    configured: 100_000,
    limited: false
  });
});

test("a second interactive tmux client attaches read-only", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args, options) {
      calls.push({ command, args, options });
      return tmuxCommand(args) === "list-clients"
        ? `${yuiTmuxSessionName("/tmp/yui-home", "task-1")}\u001f\u001f0\n`
        : "";
    }
  }, {
    yuiHome: "/tmp/yui-home",
    terminalInput: new TtyInput()
  });

  manager.attachRole("task-1", "leader");

  const attach = calls.find(({ args }) => tmuxCommand(args) === "attach-session");
  const clientSession = calls
    .find(({ args }) => tmuxCommand(args) === "new-session")
    .args.at(-1);
  assert.deepEqual(attach.args.slice(-4), [
    "attach-session", "-r", "-t",
    `${clientSession}:leader`
  ]);
});

test("interactive clients use an isolated grouped session with native scrolling", () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });
  const taskSession = yuiTmuxSessionName("/tmp/yui-home", "task-1");

  const clientSession = manager.createInteractiveClientSession("task-1");
  manager.destroyInteractiveClientSession(clientSession);

  assert.match(clientSession, /^yui-client-[a-f0-9]{24}$/);
  assert.deepEqual(calls.map(({ args }) => args.slice(2)), [
    ["new-session", "-d", "-t", taskSession, "-s", clientSession],
    ["set-option", "-t", clientSession, "status", "off"],
    ["set-option", "-t", clientSession, "mouse", "on"],
    [
      "set-hook", "-t", clientSession, "client-detached",
      `kill-session -t ${clientSession}`
    ],
    ["kill-session", "-t", clientSession]
  ]);
});

test("stopping a real Task removes its detached interactive client sessions", (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const yuiHome = join(tmpdir(), `yui-real-tmux-stop-${process.pid}`);
  const manager = new TmuxManager("tmux", new NodeCommandExecutor(), { yuiHome });
  const taskId = "grouped-task";
  t.after(() => {
    manager.stopTask(taskId);
  });
  manager.ensureRoleWindow(taskId, {
    name: "leader",
    workspace: process.cwd()
  }, {
    command: "/bin/sh",
    args: [],
    env: {}
  });
  manager.createInteractiveClientSession(taskId);
  manager.createInteractiveClientSession(taskId);

  assert.equal(manager.stopTask(taskId), true);
  const sessions = spawnSync(
    "tmux",
    [
      "-L", yuiTmuxServerName(yuiHome),
      "list-sessions", "-F", "#{session_name}"
    ],
    { encoding: "utf8" }
  );
  assert.equal(sessions.stdout.trim(), "");
});

test("sendRoleInputOnce probes readiness and applies a pane receipt in one tmux command", () => {
  const calls = [];
  let deliveryAttempts = 0;
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message") return "0|321|codex\n";
      if (tmuxCommand(args) === "capture-pane") return "native composer ready\n";
      if (tmuxCommand(args) === "set-buffer") {
        deliveryAttempts += 1;
        const branch = deliveryAttempts === 1 ? args.at(-1) : args.at(-2);
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
  const deliveryBatches = calls.filter((call) => tmuxCommand(call.args) === "set-buffer");
  assert.equal(deliveryBatches.length, 2);
  assert.equal(
    deliveryBatches[0].args[deliveryBatches[0].args.indexOf("--") + 1],
    "hello\nworld"
  );
  for (const delivery of deliveryBatches) {
    assert.match(delivery.args.join(" "), /@yui_delivery_[a-f0-9]{64}/);
    assert.match(delivery.args.at(-2), /delete-buffer.*__YUI_DELIVERY_PRESENT_/s);
    assert.match(
      delivery.args.at(-1),
      /paste-buffer -dpr.*run-shell.*sleep 0\.05.*send-keys.*Enter.*set-option/s
    );
    assert.doesNotMatch(delivery.args.at(-1), /send-keys -l/s);
    assert.equal(calls.filter((call) => tmuxCommand(call.args) === "send-keys").length, 0);
  }
});

test("buffer delivery keeps shell-like input literal and receipt application atomic", () => {
  const calls = [];
  const input = String.raw`-- -w ; $HOME $(touch /tmp/nope) "quotes" \slashes` + "\nnext";
  const manager = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message") return "0|321|codex\n";
      if (tmuxCommand(args) === "capture-pane") return "composer ready\n";
      if (tmuxCommand(args) === "set-buffer") {
        return `${args.at(-1).match(/__YUI_DELIVERY_SENT_[a-f0-9]+__/)[0]}\n`;
      }
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.equal(manager.sendRoleInputOnce(
    "task-1",
    "leader",
    "receipt ; $HOME",
    input,
    () => true
  ), "sent");

  const setBuffer = calls.find((call) => tmuxCommand(call.args) === "set-buffer");
  assert.equal(setBuffer.args[setBuffer.args.indexOf("--") + 1], input);
  assert.doesNotMatch(setBuffer.args.at(-1), /\$HOME|touch|quotes|slashes|next/u);
  assert.match(
    setBuffer.args.at(-1),
    /paste-buffer -dpr.*run-shell.*sleep 0\.05.*send-keys.*Enter.*set-option/s
  );
});

test("async tmux delivery uses only the non-blocking executor path", async () => {
  const calls = [];
  const input = String.raw`literal ; $HOME "quotes"` + "\nnext";
  const manager = new TmuxManager("tmux-test", {
    run() {
      throw new Error("sync executor path must not be used");
    },
    async runAsync(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message") {
        if (args.includes(";")) {
          return [
            "__YUI_PANE_STATE__|0|321|2|38|0|codex|",
            "\u001b[1m›\u001b[0m \u001b[2mSummarize recent commits\u001b[0m",
            "",
            "gpt-5.6-sol medium · /tmp/workspace"
          ].join("\n");
        }
        return "0|321|codex\n";
      }
      if (tmuxCommand(args) === "capture-pane") return "composer ready\n";
      if (tmuxCommand(args) === "set-buffer") {
        return `${args.at(-1).match(/__YUI_DELIVERY_SENT_[a-f0-9]+__/)[0]}\n`;
      }
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.equal(await manager.sendRoleInputOnceIfReadyAsync(
    "task-1",
    "leader",
    "receipt-async",
    input,
    () => true
  ), "sent");

  assert.deepEqual(
    calls.map((call) => tmuxCommand(call.args)),
    ["display-message", "set-buffer"]
  );
  const setBuffer = calls.find((call) => tmuxCommand(call.args) === "set-buffer");
  assert.equal(setBuffer.args[setBuffer.args.indexOf("--") + 1], input);
  assert.match(
    setBuffer.args.at(-1),
    /paste-buffer -dpr.*run-shell.*sleep 0\.05.*send-keys.*Enter.*set-option/s
  );
  assert.doesNotMatch(setBuffer.args.at(-1), /\$HOME|quotes|next/u);
});

test("a busy async delivery uses one tmux client snapshot", async () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run() {
      throw new Error("sync executor path must not be used");
    },
    async runAsync(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message" && args.includes(";")) {
        return [
          "__YUI_PANE_STATE__|0|321|2|38|0|codex|",
          "• Working (2s • esc to interrupt)",
          "› Summarize recent commits",
          "gpt-5.6-sol medium · /tmp/workspace"
        ].join("\n");
      }
      throw new Error(`unexpected tmux command: ${tmuxCommand(args)}`);
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.equal(await manager.sendRoleInputOnceIfReadyAsync(
    "task-1",
    "leader",
    "receipt-busy",
    "input",
    () => false
  ), "not-ready");
  assert.deepEqual(calls.map((call) => tmuxCommand(call.args)), ["display-message"]);
});

test("a changed pane fence refuses delivery without recording a receipt", async () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run() {
      throw new Error("sync executor path must not be used");
    },
    async runAsync(command, args) {
      calls.push({ command, args });
      if (tmuxCommand(args) === "display-message" && args.includes(";")) {
        return [
          "__YUI_PANE_STATE__|0|321|2|38|7|codex|",
          "\u001b[1m›\u001b[0m \u001b[2mSummarize recent commits\u001b[0m",
          "gpt-5.6-sol medium · /tmp/workspace"
        ].join("\n");
      }
      if (tmuxCommand(args) === "set-buffer") {
        return `${args.at(-1).match(/__YUI_DELIVERY_NOT_READY_[a-f0-9]+__/)[0]}\n`;
      }
      throw new Error(`unexpected tmux command: ${tmuxCommand(args)}`);
    }
  }, { yuiHome: "/tmp/yui-home" });

  assert.equal(await manager.sendRoleInputOnceIfReadyAsync(
    "operator",
    "operator",
    "input-request:race",
    "Question",
    () => true
  ), "not-ready");
  const delivery = calls.at(-1);
  assert.match(delivery.args.at(-1), /#\{cursor_x\}/u);
  assert.match(delivery.args.at(-1), /#\{cursor_y\}/u);
  assert.match(delivery.args.at(-1), /#\{history_size\}/u);
  assert.match(delivery.args.at(-1), /__YUI_DELIVERY_NOT_READY_/u);
});

test("failed async delivery removes its staged tmux buffer", async () => {
  const calls = [];
  const manager = new TmuxManager("tmux-test", {
    run() {
      throw new Error("sync executor path must not be used");
    },
    async runAsync(command, args) {
      calls.push({ command, args });
      const operation = tmuxCommand(args);
      if (operation === "display-message" && args.includes(";")) {
        return [
          "__YUI_PANE_STATE__|0|321|2|38|0|codex|",
          "composer ready"
        ].join("\n");
      }
      if (operation === "capture-pane") return "composer ready\n";
      if (operation === "set-buffer") throw new Error("pane disappeared");
      return "";
    }
  }, { yuiHome: "/tmp/yui-home" });

  await assert.rejects(
    manager.sendRoleInputOnceIfReadyAsync(
      "task-1", "leader", "receipt-failed", "input", () => true
    ),
    /pane disappeared/u
  );
  assert.deepEqual(
    calls.slice(-2).map((call) => tmuxCommand(call.args)),
    ["set-buffer", "delete-buffer"]
  );
  assert.equal(calls.at(-2).args[4], calls.at(-1).args.at(-1));
});

test("real tmux delivery applies one receipt and one command", async (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const manager = new TmuxManager(
    "tmux",
    new NodeCommandExecutor(),
    { yuiHome: join(tmpdir(), `yui-real-tmux-${process.pid}`) }
  );
  const taskId = "receipt-task";
  const roleName = "worker";
  await manager.ensureRoleWindowAsync(taskId, {
    name: roleName,
    workspace: process.cwd()
  }, {
    command: "bash",
    args: ["--noprofile", "--norc"],
    env: {}
  });
  t.after(async () => {
    await manager.stopTaskAsync(taskId).catch(() => {});
  });

  const receiptId = "real-receipt";
  const input = "printf '__YUI_REAL_RECEIPT__\\n'";
  const ready = ({ dead, pid, currentCommand }) => (
    !dead && pid !== undefined && currentCommand === "bash"
  );
  assert.equal(await manager.sendRoleInputOnceIfReadyAsync(
    taskId, roleName, receiptId, input, ready
  ), "sent");
  assert.equal(await manager.sendRoleInputOnceIfReadyAsync(
    taskId, roleName, receiptId, input, () => {
      throw new Error("an existing receipt must bypass readiness");
    }
  ), "already-sent");

  let outputLines = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    outputLines = manager.captureRole(taskId, roleName, 20)
      .split("\n")
      .map((line) => line.trim());
    if (outputLines.includes("__YUI_REAL_RECEIPT__")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    outputLines.filter((line) => line === "__YUI_REAL_RECEIPT__").length,
    1
  );
});

test("real tmux Role process cannot inherit an undeclared Controller secret", async (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const nodeExecutor = new NodeCommandExecutor();
  const controllerSecret = "must-not-cross-agent-boundary";
  const executor = {
    run(command, args, options = {}) {
      return nodeExecutor.run(command, args, {
        ...options,
        environment: {
          ...options.environment,
          YUI_TEST_UNDECLARED_SECRET: controllerSecret
        }
      });
    },
    runAsync(command, args, options = {}) {
      return nodeExecutor.runAsync(command, args, {
        ...options,
        environment: {
          ...options.environment,
          YUI_TEST_UNDECLARED_SECRET: controllerSecret
        }
      });
    }
  };
  const manager = new TmuxManager("tmux", executor, {
    yuiHome: join(tmpdir(), `yui-real-clean-env-${process.pid}`)
  });
  const taskId = "clean-environment";
  const roleName = "worker";
  t.after(async () => {
    await manager.stopTaskAsync(taskId).catch(() => {});
  });
  await manager.ensureRoleWindowAsync(taskId, {
    name: roleName,
    workspace: process.cwd()
  }, {
    command: "bash",
    args: [
      "--noprofile",
      "--norc",
      "-c",
      "printf '__DECLARED=%s__UNDECLARED=%s__\\n' \"$DECLARED\" "
        + "\"$YUI_TEST_UNDECLARED_SECRET\"; sleep 30"
    ],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      DECLARED: "present"
    }
  });

  let content = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    content = manager.captureRole(taskId, roleName, 20);
    if (content.includes("__DECLARED=")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(content, /__DECLARED=present__UNDECLARED=__/u);
  assert.doesNotMatch(content, new RegExp(controllerSecret, "u"));
});

test("real tmux combined snapshots preserve styled Operator composer safety", async (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const manager = new TmuxManager(
    "tmux",
    new NodeCommandExecutor(),
    { yuiHome: join(tmpdir(), `yui-real-operator-${process.pid}`) }
  );
  const taskId = "operator";
  const footer = "gpt-5.6-sol medium · /tmp/workspace";
  const launch = async (roleName, composer) => {
    await manager.ensureRoleWindowAsync(taskId, {
      name: roleName,
      workspace: process.cwd()
    }, {
      command: "bash",
      args: [
        "--noprofile",
        "--norc",
        "-c",
        `printf '${composer}\\n\\n${footer}\\n'; sleep 30`
      ],
      env: {}
    });
  };
  await launch(
    "empty",
    "\\033[1m›\\033[0m \\033[2mSummarize recent commits\\033[0m"
  );
  await launch("draft", "\\033[1m›\\033[0m unsent draft");
  t.after(async () => {
    await manager.stopTaskAsync(taskId).catch(() => {});
  });

  const inspectWhenRendered = async (roleName) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pane = await manager.inspectPaneAsync(taskId, roleName);
      if (pane.content.includes(footer)) return pane;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`real tmux pane did not render: ${roleName}`);
  };
  const emptyPane = await inspectWhenRendered("empty");
  const draftPane = await inspectWhenRendered("draft");
  const operatorReady = agentComposerReadinessProbe("codex", "operator");

  assert.match(emptyPane.styledContent, /\u001b\[2mSummarize recent commits/u);
  assert.equal(emptyPane.content.includes("\u001b"), false);
  assert.equal(operatorReady(emptyPane), true);
  assert.equal(operatorReady(draftPane), false);
  assert.equal(await manager.sendRoleInputOnceIfReadyAsync(
    taskId,
    "empty",
    "operator-empty",
    "Question",
    operatorReady
  ), "sent");
  assert.equal(await manager.sendRoleInputOnceIfReadyAsync(
    taskId,
    "draft",
    "operator-draft",
    "must-not-be-pasted",
    operatorReady
  ), "not-ready");
  assert.equal(manager.hasDeliveryReceipt(taskId, "draft", "operator-draft"), false);
  assert.doesNotMatch(manager.captureRole(taskId, "draft"), /must-not-be-pasted/u);
});

test("real tmux pane changes between inspect and send are rejected without a receipt", async (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const yuiHome = join(tmpdir(), `yui-real-fence-${process.pid}`);
  const manager = new TmuxManager("tmux", new NodeCommandExecutor(), { yuiHome });
  const taskId = "fence-task";
  const roleName = "worker";
  await manager.ensureRoleWindowAsync(taskId, {
    name: roleName,
    workspace: process.cwd()
  }, {
    command: "bash",
    args: ["--noprofile", "--norc"],
    env: {}
  });
  t.after(async () => {
    await manager.stopTaskAsync(taskId).catch(() => {});
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pane = await manager.inspectPaneAsync(taskId, roleName);
    if (pane.currentCommand === "bash") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const target = `${yuiTmuxSessionName(yuiHome, taskId)}:${roleName}`;
  const receiptId = "real-pane-fence";
  const outcome = await manager.sendRoleInputOnceIfReadyAsync(
    taskId,
    roleName,
    receiptId,
    "must-not-be-pasted",
    () => {
      const changed = spawnSync("tmux", [
        "-L",
        yuiTmuxServerName(yuiHome),
        "send-keys",
        "-l",
        "-t",
        target,
        "x"
      ], { encoding: "utf8" });
      assert.equal(changed.status, 0, changed.stderr);
      return true;
    }
  );

  assert.equal(outcome, "not-ready");
  assert.equal(manager.hasDeliveryReceipt(taskId, roleName, receiptId), false);
  const content = manager.captureRole(taskId, roleName);
  assert.match(content, /x/u);
  assert.doesNotMatch(content, /must-not-be-pasted/u);
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
  assert.equal(calls.some((call) => tmuxCommand(call.args) === "set-buffer"), false);
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
  assert.equal(calls.some((call) => tmuxCommand(call.args) === "set-buffer"), false);
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
      if (tmuxCommand(args) === "set-buffer") {
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
  assert.equal(calls.filter((call) => tmuxCommand(call.args) === "set-buffer").length, 1);
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
      if (tmuxCommand(args) === "set-buffer") {
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
  assert.equal(calls.filter((call) => tmuxCommand(call.args) === "set-buffer").length, 2);
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
