import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeCommandExecutor } from "../../dist/tmux/commandExecutor.js";
import { TmuxManager } from "../../dist/tmux/tmuxManager.js";
import {
  TmuxWebTerminalService
} from "../../dist/web/tmuxWebTerminal.js";
import {
  yuiTmuxServerName,
  yuiTmuxSessionName
} from "../../dist/tmux/tmuxManager.js";

function fakePty() {
  const data = new Set();
  const exit = new Set();
  return {
    writes: [],
    resizes: [],
    killed: 0,
    onData(listener) {
      data.add(listener);
      return { dispose: () => data.delete(listener) };
    },
    onExit(listener) {
      exit.add(listener);
      return { dispose: () => exit.delete(listener) };
    },
    write(value) { this.writes.push(value); },
    resize(columns, rows) { this.resizes.push([columns, rows]); },
    kill() { this.killed += 1; },
    emitData(value) { for (const listener of data) listener(value); },
    emitExit(value) { for (const listener of exit) listener(value); }
  };
}

function fakeTmux(writable = false) {
  return {
    hasWritableClient: () => writable,
    createInteractiveClientSession: () => "yui-client-test",
    destroyInteractiveClientSession() {}
  };
}

function runTmux(yuiHome, args) {
  const result = spawnSync(
    "tmux",
    ["-L", yuiTmuxServerName(yuiHome), ...args],
    { encoding: "utf8" }
  );
  return result.status === 0 ? result.stdout.trim() : "";
}

async function waitFor(value, predicate) {
  const deadline = Date.now() + 2_000;
  let current = value();
  while (!predicate(current) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = value();
  }
  return current;
}

test("web terminal prepares and attaches the exact Task Role through a PTY", async () => {
  const calls = [];
  const processes = [];
  const home = "/tmp/yui-home";
  const service = new TmuxWebTerminalService({
    yuiHome: home,
    tmuxBin: "tmux-test",
    tmux: fakeTmux(),
    async prepareTaskRole(input) { calls.push(["prepare-task", input]); },
    async prepareGlobalRole(roleName) { calls.push(["prepare-global", roleName]); },
    spawnPty(command, args, options) {
      const process = fakePty();
      processes.push(process);
      calls.push(["spawn", command, args, options]);
      return process;
    },
    environment: { PATH: "/usr/bin", LANG: "C.UTF-8" }
  });

  const connection = await service.open({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    columns: 100,
    rows: 30
  });

  assert.equal(connection.readOnly, false);
  assert.deepEqual(calls[0], [
    "prepare-task",
    { taskId: "task-1", roleName: "leader" }
  ]);
  assert.deepEqual(calls[1], [
    "spawn",
    "tmux-test",
    [
      "-L", yuiTmuxServerName(home),
      "attach-session", "-t",
      "yui-client-test:leader"
    ],
    {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: home,
      env: {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        TERM: "xterm-256color"
      }
    }
  ]);

  const data = [];
  const exits = [];
  const stopData = connection.onData((value) => data.push(value));
  const stopExit = connection.onExit((value) => exits.push(value));
  processes[0].emitData("native output");
  processes[0].emitExit({ exitCode: 0 });
  connection.write("/status\r");
  connection.resize(120, 40);
  assert.deepEqual(data, ["native output"]);
  assert.deepEqual(exits, [{ exitCode: 0 }]);
  assert.deepEqual(processes[0].writes, ["/status\r"]);
  assert.deepEqual(processes[0].resizes, [[120, 40]]);

  stopData();
  stopExit();
  connection.close();
  connection.close();
  assert.equal(processes[0].killed, 1);
});

test("web terminal attaches through an isolated interactive client session", async () => {
  const calls = [];
  const process = fakePty();
  const service = new TmuxWebTerminalService({
    yuiHome: "/tmp/yui-home",
    tmuxBin: "tmux-test",
    tmux: {
      hasWritableClient() { return false; },
      createInteractiveClientSession(hostId) {
        calls.push(["create-client", hostId]);
        return "yui-client-000000000000000000000001";
      },
      destroyInteractiveClientSession(sessionName) {
        calls.push(["destroy-client", sessionName]);
      }
    },
    async prepareTaskRole() {},
    async prepareGlobalRole() {},
    spawnPty(_command, args) {
      calls.push(["spawn", args]);
      return process;
    }
  });

  const connection = await service.open({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    columns: 80,
    rows: 24
  });
  assert.deepEqual(calls.slice(0, 2), [
    ["create-client", "task-1"],
    [
      "spawn",
      [
        "-L", yuiTmuxServerName("/tmp/yui-home"),
        "attach-session", "-t",
        "yui-client-000000000000000000000001:leader"
      ]
    ]
  ]);

  connection.close();
  assert.deepEqual(calls.at(-1), [
    "destroy-client",
    "yui-client-000000000000000000000001"
  ]);
});

test("web terminal cleanup failures are reported without escaping or leaking the PTY", async () => {
  const process = fakePty();
  const errors = [];
  const service = new TmuxWebTerminalService({
    yuiHome: "/tmp/yui-home",
    tmuxBin: "tmux-test",
    tmux: {
      hasWritableClient() { return false; },
      createInteractiveClientSession() { return "yui-client-test"; },
      destroyInteractiveClientSession() {
        throw new Error("tmux cleanup failed");
      }
    },
    async prepareTaskRole() {},
    async prepareGlobalRole() {},
    spawnPty() { return process; },
    onError(error) { errors.push(error); }
  });
  const connection = await service.open({
    scope: "global",
    roleName: "operator",
    columns: 80,
    rows: 24
  });

  assert.doesNotThrow(() => connection.close());
  assert.equal(process.killed, 1);
  assert.deepEqual(errors.map((error) => error.message), ["tmux cleanup failed"]);
});

test("web terminal exposes an existing pane history limit to the browser", async () => {
  const service = new TmuxWebTerminalService({
    yuiHome: "/tmp/yui-home",
    tmuxBin: "tmux-test",
    tmux: {
      ...fakeTmux(),
      inspectRoleHistory() {
        return { actual: 2_000, configured: 100_000, limited: true };
      }
    },
    async prepareTaskRole() {},
    async prepareGlobalRole() {},
    spawnPty() { return fakePty(); }
  });

  const connection = await service.open({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    columns: 80,
    rows: 24
  });

  assert.deepEqual(connection.history, { limit: 2_000, target: 100_000 });
  connection.close();
});

test("only the first web terminal for one tmux host is writable", async () => {
  const spawnedArgs = [];
  const processes = [];
  const service = new TmuxWebTerminalService({
    yuiHome: "/tmp/yui-home",
    tmuxBin: "tmux-test",
    tmux: fakeTmux(),
    async prepareTaskRole() {},
    async prepareGlobalRole() {},
    spawnPty(_command, args) {
      const process = fakePty();
      processes.push(process);
      spawnedArgs.push(args);
      return process;
    }
  });
  const request = {
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    columns: 80,
    rows: 24
  };

  const first = await service.open(request);
  const second = await service.open(request);
  assert.equal(first.readOnly, false);
  assert.equal(second.readOnly, true);
  assert.equal(spawnedArgs[0].includes("-r"), false);
  assert.equal(spawnedArgs[1].includes("-r"), true);

  first.close();
  const third = await service.open(request);
  assert.equal(third.readOnly, false);
  assert.equal(spawnedArgs[2].includes("-r"), false);
  second.close();
  third.close();
  assert.deepEqual(processes.map((process) => process.killed), [1, 1, 1]);
});

test("an existing terminal client makes a web terminal read-only", async () => {
  let prepared = "";
  let args;
  const service = new TmuxWebTerminalService({
    yuiHome: "/tmp/yui-home",
    tmuxBin: "tmux-test",
    tmux: fakeTmux(true),
    async prepareTaskRole() {},
    async prepareGlobalRole(roleName) { prepared = roleName; },
    spawnPty(_command, inputArgs) {
      args = inputArgs;
      return fakePty();
    }
  });

  const connection = await service.open({
    scope: "global",
    roleName: "operator",
    columns: 80,
    rows: 24
  });

  assert.equal(prepared, "operator");
  assert.equal(connection.readOnly, true);
  assert.equal(args.includes("-r"), true);
  connection.close();
});

test("web terminal replays PTY output and exit produced before browser listeners attach", async () => {
  const process = fakePty();
  const subscribeExit = process.onExit.bind(process);
  let firstExitSubscription = true;
  process.onExit = (listener) => {
    if (firstExitSubscription) {
      firstExitSubscription = false;
      process.emitData("early native screen");
      listener({ exitCode: 7 });
      return { dispose() {} };
    }
    return subscribeExit(listener);
  };
  const service = new TmuxWebTerminalService({
    yuiHome: "/tmp/yui-home",
    tmuxBin: "tmux-test",
    tmux: fakeTmux(),
    async prepareTaskRole() {},
    async prepareGlobalRole() {},
    spawnPty() { return process; }
  });

  const connection = await service.open({
    scope: "global",
    roleName: "operator",
    columns: 80,
    rows: 24
  });
  const data = [];
  const exits = [];
  connection.onData((value) => data.push(value));
  connection.onExit((value) => exits.push(value));

  assert.deepEqual(data, ["early native screen"]);
  assert.deepEqual(exits, [{ exitCode: 7 }]);
  connection.close();
});

test("real web PTY detaches without stopping its tmux Agent", async () => {
  const yuiHome = mkdtempSync(join(tmpdir(), "yui-web-terminal-"));
  const manager = new TmuxManager("tmux", new NodeCommandExecutor(), { yuiHome });
  try {
    manager.ensureRoleWindow("operator", {
      name: "operator",
      workspace: yuiHome
    }, {
      command: "/bin/sh",
      args: [],
      env: {
        HOME: yuiHome,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "xterm-256color"
      }
    });
    const service = new TmuxWebTerminalService({
      yuiHome,
      tmuxBin: "tmux",
      tmux: manager,
      async prepareTaskRole() {},
      async prepareGlobalRole() {}
    });
    const connection = await service.open({
      scope: "global",
      roleName: "operator",
      columns: 80,
      rows: 24
    });
    let output = "";
    const marker = "__YUI_WEB_PTY_OK__";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for real PTY output: ${output}`)),
        3_000
      );
      const stop = connection.onData((data) => {
        output += data;
        if (!output.includes(marker)) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
      connection.write(`printf '${marker}\\n'\\r`);
    });

    connection.close();
    assert.equal(manager.probeRoleStatus("operator", "operator"), "running");
  } finally {
    manager.stopTask("operator");
    rmSync(yuiHome, { recursive: true, force: true });
  }
});

test("real web terminals keep independent Role windows and native tmux scrolling", async () => {
  const yuiHome = mkdtempSync(join(tmpdir(), "yui-web-terminal-clients-"));
  const manager = new TmuxManager("tmux", new NodeCommandExecutor(), { yuiHome });
  const connections = [];
  try {
    for (const roleName of ["leader", "worker"]) {
      manager.ensureRoleWindow("task-1", {
        name: roleName,
        workspace: yuiHome
      }, {
        command: "/bin/sh",
        args: [],
        env: {
          HOME: yuiHome,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TERM: "xterm-256color"
        }
      });
    }
    const service = new TmuxWebTerminalService({
      yuiHome,
      tmuxBin: "tmux",
      tmux: manager,
      async prepareTaskRole() {},
      async prepareGlobalRole() {}
    });
    for (const roleName of ["leader", "worker"]) {
      connections.push(await service.open({
        scope: "task",
        taskId: "task-1",
        roleName,
        columns: 80,
        rows: 24
      }));
    }

    const clients = await waitFor(
      () => runTmux(yuiHome, [
        "list-clients", "-F", "#{session_name}|#{window_name}"
      ]).split("\n").filter(Boolean),
      (rows) => rows.length === 2
    );
    assert.deepEqual(
      clients.map((row) => row.split("|")[1]).sort(),
      ["leader", "worker"]
    );
    for (const row of clients) {
      const clientSession = row.split("|")[0];
      assert.match(clientSession, /^yui-client-[a-f0-9]{24}$/);
      assert.equal(runTmux(yuiHome, [
        "show-options", "-v", "-t", clientSession, "mouse"
      ]), "on");
      assert.equal(runTmux(yuiHome, [
        "show-options", "-v", "-t", clientSession, "status"
      ]), "off");
    }
    // `window-size largest` is pinned on the Role window itself so a compact
    // viewer cannot shrink the shared window for the primary terminal.
    for (const roleName of ["leader", "worker"]) {
      assert.equal(runTmux(yuiHome, [
        "show-options", "-w", "-v",
        "-t", `${yuiTmuxSessionName(yuiHome, "task-1")}:${roleName}`,
        "window-size"
      ]), "largest");
    }

    for (const connection of connections) connection.close();
    const remainingClientSessions = await waitFor(
      () => runTmux(yuiHome, ["list-sessions", "-F", "#{session_name}"])
        .split("\n")
        .filter((name) => name.startsWith("yui-client-")),
      (names) => names.length === 0
    );
    assert.deepEqual(remainingClientSessions, []);
    assert.equal(manager.probeRoleStatus("task-1", "leader"), "running");
    assert.equal(manager.probeRoleStatus("task-1", "worker"), "running");
  } finally {
    for (const connection of connections) connection.close();
    manager.stopTask("task-1");
    rmSync(yuiHome, { recursive: true, force: true });
  }
});
