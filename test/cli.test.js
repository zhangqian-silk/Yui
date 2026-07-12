import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

test("prints help text", () => {
  const output = execFileSync("node", ["dist/cli.js", "--help"], {
    encoding: "utf8"
  });

  assert.match(output, new RegExp(`TaskMux ${packageJson.version}`));
  assert.match(output, /tmux/);
});

test("prints discoverable root help through the help command", () => {
  const output = execFileSync("node", ["dist/cli.js", "help"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.match(output, new RegExp(`TaskMux ${packageJson.version}`));
  assert.match(output, /Commands:/);
  assert.match(output, /\bhelp\b/);
  assert.match(output, /\bversion\b/);
  assert.match(output, /\bupdate\b/);
});

test("renders scoped group, nested-group, and leaf help without storage", () => {
  const env = { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" };
  const task = execFileSync("node", ["dist/cli.js", "task", "--help"], { encoding: "utf8", env });
  const taskRole = execFileSync("node", ["dist/cli.js", "task", "role", "help"], { encoding: "utf8", env });
  const rename = execFileSync("node", ["dist/cli.js", "help", "task", "role", "rename"], { encoding: "utf8", env });
  const create = execFileSync("node", ["dist/cli.js", "help", "task", "create"], { encoding: "utf8", env });

  assert.match(task, /TaskMux task/);
  assert.match(task, /  taskmux task <command>/);
  assert.doesNotMatch(task, /taskmux taskmux/);
  assert.match(task, /\brole\b/);
  assert.doesNotMatch(task, /controller start/);
  assert.match(taskRole, /TaskMux task role/);
  assert.match(taskRole, /\brename\b/);
  assert.doesNotMatch(taskRole, /task create/);
  assert.match(rename, /taskmux task role rename <task-id> <role> <new-role>/);
  assert.doesNotMatch(rename, /Commands:/);
  assert.match(create, /--template\s+Select a task template\./);
});

test("renders group help when a command group has no child", () => {
  const output = execFileSync("node", ["dist/cli.js", "task", "role"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.match(output, /TaskMux task role/);
  assert.match(output, /\bchild\b/);
});

test("prints an unknown path error before nearest scoped help", () => {
  const result = spawnSync("node", ["dist/cli.js", "task", "role", "wat"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^USAGE_ERROR: Unknown command: task role wat\n\nTaskMux task role\n/);
  assert.match(result.stderr, /\brename\b/);
  assert.doesNotMatch(result.stderr, /TaskMux task\n/);
});

test("keeps unknown path JSON errors to one envelope", () => {
  const result = spawnSync("node", ["dist/cli.js", "task", "role", "wat", "--json"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    code: "USAGE_ERROR",
    message: "Unknown command: task role wat",
    details: {}
  });
  assert.equal(result.stderr.trim().split("\n").length, 1);
});

test("prints package version", () => {
  const output = execFileSync("node", ["dist/cli.js", "--version"], {
    encoding: "utf8"
  });

  assert.equal(output.trim(), packageJson.version);
});

test("prints package version through the version command without storage", () => {
  const output = execFileSync("node", ["dist/cli.js", "version"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.equal(output.trim(), packageJson.version);
});

test("prints help text for the standard short flag", () => {
  const output = execFileSync("node", ["dist/cli.js", "-h"], {
    encoding: "utf8"
  });

  assert.match(output, new RegExp(`TaskMux ${packageJson.version}`));
  assert.match(output, /\bversion\b/);
});

test("rejects the removed nonstandard help alias", () => {
  const result = spawnSync("node", ["dist/cli.js", "-help"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Unknown command: -help/);
});

test("prints shell completion scripts", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], {
    encoding: "utf8"
  });
  const zsh = execFileSync("node", ["dist/cli.js", "completion", "zsh"], {
    encoding: "utf8"
  });
  const fish = execFileSync("node", ["dist/cli.js", "completion", "fish"], {
    encoding: "utf8"
  });

  assert.match(bash, /complete -F _taskmux taskmux/);
  assert.match(zsh, /#compdef taskmux/);
  assert.match(fish, /complete -c taskmux/);
});

test("generates path-aware completion from scoped catalog nodes", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], {
    encoding: "utf8"
  });
  const taskRoleCase = bash.split("\n").find((line) => line.includes('"task role"')) ?? "";
  const taskCreateCase = bash.split("\n").find((line) => line.includes('"task create"')) ?? "";
  const completionCase = bash.split("\n").find((line) => line.includes('"completion"')) ?? "";

  assert.match(bash, /help version update/);
  assert.match(taskRoleCase, /child update rename remove/);
  assert.doesNotMatch(taskRoleCase, /doctor|controller|agent/);
  assert.match(taskCreateCase, /--template/);
  assert.match(taskCreateCase, /feature bug review/);
  assert.match(completionCase, /bash zsh fish/);
  assert.doesNotMatch(bash, /\bserve\b/);
  assert.equal(spawnSync("bash", ["-n"], { input: bash, encoding: "utf8" }).status, 0);
});

test("completion scope is derived only from words before the current token", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const zsh = execFileSync("node", ["dist/cli.js", "completion", "zsh"], { encoding: "utf8" });
  const fish = execFileSync("node", ["dist/cli.js", "completion", "fish"], { encoding: "utf8" });

  assert.match(bash, /COMP_WORDS\[\*\]:1:COMP_CWORD-1/);
  assert.match(zsh, /words\[2,CURRENT-1\]/);
  assert.match(zsh, /CURRENT > 2/);
  assert.doesNotMatch(zsh, /words\[2,-1\]/);
  assert.match(fish, /commandline -opc/);

  const bashResult = spawnSync("bash", ["-c", `${bash}
COMP_WORDS=(taskmux task ro)
COMP_CWORD=2
_taskmux
printf '%s\\n' "\${COMPREPLY[@]}"
`], { encoding: "utf8" });
  assert.equal(bashResult.status, 0, bashResult.stderr);
  assert.deepEqual(bashResult.stdout.trim().split("\n").sort(), ["role", "roles"]);
});

test("hybrid child completion cases precede executable parents in every shell", () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const script = execFileSync("node", ["dist/cli.js", "completion", shell], { encoding: "utf8" });
    const lines = script.split("\n");
    const child = lines.findIndex((line) => line.split("candidates=")[0]?.includes("task transcript export"));
    const parent = lines.findIndex((line) => {
      const selector = line.split("candidates=")[0] ?? "";
      return selector.includes("task transcript") && !selector.includes("export");
    });

    assert.notEqual(child, -1, `${shell} child case missing`);
    assert.notEqual(parent, -1, `${shell} parent case missing`);
    assert.ok(child < parent, `${shell} parent case shadows its hybrid child`);
  }

  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const bashResult = spawnSync("bash", ["-c", `${bash}
COMP_WORDS=(taskmux task transcript export "")
COMP_CWORD=4
_taskmux
printf '%s\\n' "\${COMPREPLY[@]}"
`], { encoding: "utf8" });
  assert.equal(bashResult.status, 0, bashResult.stderr);
  assert.match(bashResult.stdout, /^--format$/m);
  assert.match(bashResult.stdout, /^--output$/m);
  assert.doesNotMatch(bashResult.stdout, /^export$/m);
});

test("zsh completion works as an autoloaded fpath function after compinit", {
  skip: spawnSync("zsh", ["--version"], { stdio: "ignore" }).status !== 0
}, () => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-zsh-completion-"));
  const completion = execFileSync("node", ["dist/cli.js", "completion", "zsh"], { encoding: "utf8" });
  writeFileSync(join(root, "_taskmux"), completion);

  try {
    const result = spawnSync("zsh", [
      "-f",
      "-c",
      'fpath=("$1" $fpath); autoload -Uz compinit; compinit -i -d "$1/.zcompdump"; autoload -Uz _taskmux; function compadd { print -rl -- "$@"; }; words=(taskmux ve); CURRENT=2; _taskmux; words=(taskmux task ro); CURRENT=3; _taskmux',
      "taskmux-completion-test",
      root
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^version$/m);
    assert.match(result.stdout, /^role$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updates through the latest global npm package with inherited output", () => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-update-"));
  const npm = join(root, "npm");
  const log = join(root, "npm-argv.json");
  writeFileSync(npm, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.TASKMUX_UPDATE_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write("npm update stdout\\n");
process.stderr.write("npm update stderr\\n");
`);
  chmodSync(npm, 0o755);

  try {
    const result = spawnSync("node", ["dist/cli.js", "update"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        TASKMUX_UPDATE_LOG: log,
        TASKMUX_HOME: "/path/that/does/not/exist"
      }
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
      "install",
      "--global",
      "@zq-silk/taskmux@latest"
    ]);
    assert.equal(result.stdout, "npm update stdout\n");
    assert.equal(result.stderr, "npm update stderr\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects JSON update mode before spawning npm", () => {
  const result = spawnSync("node", ["dist/cli.js", "update", "--json"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    code: "USAGE_ERROR",
    message: "Update does not support --json.",
    details: {}
  });
});

test("propagates npm update failures and rejects update operands", () => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-update-failure-"));
  const npm = join(root, "npm");
  writeFileSync(npm, "#!/bin/sh\necho npm failed >&2\nexit 7\n");
  chmodSync(npm, 0o755);
  const env = { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` };

  try {
    const failed = spawnSync("node", ["dist/cli.js", "update"], { encoding: "utf8", env });
    const invalid = spawnSync("node", ["dist/cli.js", "update", "later"], { encoding: "utf8", env });

    assert.equal(failed.status, 7);
    assert.equal(failed.stderr, "npm failed\n");
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /USAGE_ERROR: Update usage: taskmux update/);
    assert.doesNotMatch(invalid.stderr, /npm failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not advertise removed compatibility commands", () => {
  const help = execFileSync("node", ["dist/cli.js", "--help"], {
    encoding: "utf8"
  });
  const completion = execFileSync("node", ["dist/cli.js", "completion", "bash"], {
    encoding: "utf8"
  });

  for (const command of ["assistant", "runner", "migrate"]) {
    assert.doesNotMatch(help, new RegExp(`taskmux ${command}(?:\\s|$)`));
    assert.doesNotMatch(completion, new RegExp(`(?:^|\\s)${command}(?:\\s|$)`));
  }
  assert.doesNotMatch(help, /taskmux board(?:\s|$)/);
});
