import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const fishBinary = process.env.TASKMUX_TEST_FISH_BIN ?? "fish";
const fishAvailable = spawnSync(fishBinary, ["--version"], { stdio: "ignore", env: process.env }).status === 0;

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runBashCompletion(completion, words, env = process.env, preamble = "") {
  return spawnSync("bash", ["-c", `${completion}
${preamble}
COMP_WORDS=(${words.map(shellQuote).join(" ")})
COMP_CWORD=${words.length - 1}
_taskmux
if (( \${#COMPREPLY[@]} > 0 )); then printf '<%s>\\n' "\${COMPREPLY[@]}"; fi
`], { encoding: "utf8", env });
}

test("prints discoverable root help through the help command", () => {
  const output = execFileSync("node", ["dist/cli.js", "help"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.match(output, new RegExp(`TaskMux ${packageJson.version}`));
  assert.match(output, /Workflow:/);
  assert.match(output, /Configuration:/);
  assert.match(output, /Operations:/);
  assert.match(output, /Data:/);
  assert.match(output, /Support:/);
  assert.match(output, /\bhelp\b/);
  assert.match(output, /\bversion\b/);
  assert.match(output, /\bupdate\b/);
});

test("renders group, nested-group, and leaf help only through the canonical help command", () => {
  const env = { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" };
  const task = execFileSync("node", ["dist/cli.js", "help", "task"], { encoding: "utf8", env });
  const taskRole = execFileSync("node", ["dist/cli.js", "help", "task", "role"], { encoding: "utf8", env });
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

test("rejects a bare command group and points to its canonical help path", () => {
  const result = spawnSync("node", ["dist/cli.js", "task", "role"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^USAGE_ERROR: Command required after: task role\n\nTaskMux task role\n/);
  assert.match(result.stderr, /Run `taskmux help task role`/);
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

test("renders narrow help for functional value-style modes", () => {
  const env = { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" };
  const bash = execFileSync("node", ["dist/cli.js", "help", "completion", "bash"], { encoding: "utf8", env });
  const tmux = execFileSync("node", ["dist/cli.js", "help", "setup", "tmux"], { encoding: "utf8", env });

  assert.match(bash, /^TaskMux completion bash$/m);
  assert.match(bash, /Generate Bash completion\./);
  assert.match(bash, /  taskmux completion bash$/m);
  assert.doesNotMatch(bash, /completion zsh|\binstall\b/);

  assert.match(tmux, /^TaskMux setup tmux$/m);
  assert.match(tmux, /Install tmux before setup\./);
  assert.match(tmux, /  taskmux setup tmux$/m);
  assert.doesNotMatch(tmux, /^TaskMux setup$/m);
});

test("unknown functional modes report the error before nearest parent help", () => {
  const env = { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" };
  for (const [args, expectedPath, expectedParent, expectedEntry] of [
    [["completion", "powershell"], "completion powershell", "completion", "bash"],
    [["setup", "screen"], "setup screen", "setup", "tmux"]
  ]) {
    const result = spawnSync("node", ["dist/cli.js", ...args], { encoding: "utf8", env });

    assert.equal(result.status, 2, expectedPath);
    assert.equal(result.stdout, "", expectedPath);
    assert.match(
      result.stderr,
      new RegExp(`^USAGE_ERROR: Unknown command: ${expectedPath}\\n\\nTaskMux ${expectedParent}\\n`),
      expectedPath
    );
    assert.match(result.stderr, new RegExp(`\\b${expectedEntry}\\b`), expectedPath);
    assert.doesNotMatch(result.stderr, /TaskMux 0\.1\.5/, expectedPath);
  }
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

test("prints package version through the version command without storage", () => {
  const output = execFileSync("node", ["dist/cli.js", "version"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.equal(output.trim(), packageJson.version);
});

test("rejects operands after the canonical version command", () => {
  const result = spawnSync("node", ["dist/cli.js", "version", "extra"], {
    encoding: "utf8",
    env: { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" }
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^USAGE_ERROR: Version usage: taskmux version$/m);
});

test("rejects every removed help and version alias", () => {
  for (const alias of ["-h", "--help", "-help", "-v", "--version"]) {
    const result = spawnSync("node", ["dist/cli.js", alias], { encoding: "utf8" });
    assert.equal(result.status, 2, alias);
    assert.equal(result.stdout, "", alias);
    assert.match(result.stderr, new RegExp(`USAGE_ERROR: Unknown command: ${alias.replaceAll("-", "\\-")}`), alias);
  }
});

test("rejects scoped help aliases and treats help after a leaf as business data", () => {
  const env = { ...process.env, TASKMUX_HOME: "/path/that/does/not/exist" };
  const scoped = spawnSync("node", ["dist/cli.js", "task", "role", "help"], { encoding: "utf8", env });
  const flag = spawnSync("node", ["dist/cli.js", "task", "--help"], { encoding: "utf8", env });

  assert.equal(scoped.status, 2);
  assert.match(scoped.stderr, /^USAGE_ERROR: Unknown command: task role help\n\nTaskMux task role\n/);
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /^USAGE_ERROR: Unknown command: task --help\n\nTaskMux task\n/);
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

test("renders static shell completions without resolving the passwd account home", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-completion-passwd-home-"));
  const preload = join(fixtureRoot, "passwd-home-blocker.so");
  execFileSync("cc", [
    "-shared",
    "-fPIC",
    "-o",
    preload,
    join(process.cwd(), "test", "fixtures", "passwd-home-blocker.c")
  ]);
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const [shell, expected] of [
    ["bash", /complete -F _taskmux taskmux/],
    ["zsh", /#compdef taskmux/],
    ["fish", /complete -c taskmux/]
  ]) {
    const result = spawnSync("node", ["dist/cli.js", "completion", shell], {
      encoding: "utf8",
      env: {
        ...process.env,
        LD_PRELOAD: preload,
        TASKMUX_HOME: ""
      }
    });

    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.match(result.stdout, expected, shell);
    assert.equal(result.stderr, "", shell);
  }
});

test("generates path-aware completion from scoped catalog nodes", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], {
    encoding: "utf8"
  });
  const complete = (words, cword) => spawnSync("bash", ["-c", `${bash}
COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")})
COMP_CWORD=${cword}
_taskmux
printf '%s\\n' "\${COMPREPLY[@]}"
`], { encoding: "utf8" });
  const taskRole = complete(["taskmux", "task", "role", ""], 3);
  const taskCreate = complete(["taskmux", "task", "create", "--"], 3);
  const taskTemplate = complete(["taskmux", "task", "create", "--template", ""], 4);
  const completion = complete(["taskmux", "completion", ""], 2);

  assert.match(bash, /immediate=\('task' 'operator'/);
  assert.deepEqual(taskRole.stdout.trim().split("\n"), ["child", "update", "rename", "remove"]);
  assert.doesNotMatch(taskRole.stdout, /doctor|controller|agent/);
  assert.match(taskCreate.stdout, /^--template$/m);
  assert.deepEqual(taskTemplate.stdout.trim().split("\n"), ["feature", "bug", "review"]);
  assert.deepEqual(completion.stdout.trim().split("\n"), ["bash", "zsh", "fish", "install", "uninstall"]);
  assert.doesNotMatch(bash, /\bserve\b/);
  assert.equal(spawnSync("bash", ["-n"], { input: bash, encoding: "utf8" }).status, 0);
});

test("completion preserves catalog category order and never advertises removed aliases", () => {
  const expectedRoot = [
    "task", "operator",
    "setup", "config", "agent", "role", "completion",
    "controller", "doctor", "maintenance",
    "backup", "restore", "export", "import", "prune",
    "update", "version", "help"
  ];
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const result = spawnSync("bash", ["-c", `${bash}
COMP_WORDS=(taskmux "")
COMP_CWORD=1
_taskmux
printf '%s\\n' "\${COMPREPLY[@]}"
`], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), expectedRoot);
  for (const alias of ["-h", "--help", "-v", "--version"]) {
    assert.doesNotMatch(bash, new RegExp(`(?:^|[ '\\"])${alias.replaceAll("-", "\\-")}(?:$|[ '\\"])`));
  }
  assert.match(bash, /compopt -o nosort/);
  const zsh = execFileSync("node", ["dist/cli.js", "completion", "zsh"], { encoding: "utf8" });
  const fish = execFileSync("node", ["dist/cli.js", "completion", "fish"], { encoding: "utf8" });
  assert.match(zsh, /compadd -V taskmux-catalog/);
  assert.match(fish, /complete -c taskmux -f -k -a/);
});

test("completion offers options only for an option prefix and values only after their option", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const complete = (words, cword) => spawnSync("bash", ["-c", `${bash}
COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")})
COMP_CWORD=${cword}
_taskmux
printf '%s\\n' "\${COMPREPLY[@]}"
`], { encoding: "utf8" });

  const empty = complete(["taskmux", "task", "create", ""], 3);
  const option = complete(["taskmux", "task", "create", "--"], 3);
  const value = complete(["taskmux", "task", "create", "--template", ""], 4);

  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "");
  assert.match(option.stdout, /^--template$/m);
  assert.doesNotMatch(option.stdout, /^feature$/m);
  assert.deepEqual(value.stdout.trim().split("\n"), ["feature", "bug", "review"]);
});

test("completion owns positional shell values and finite cycle causes", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const setShell = runBashCompletion(bash, ["taskmux", "config", "set", "completion", ""]);
  const unsetShell = runBashCompletion(bash, ["taskmux", "config", "unset", "completion", ""]);
  const cycleCause = runBashCompletion(bash, ["taskmux", "task", "cycle", "create", "task-1", "--cause", ""]);
  const installOperand = runBashCompletion(bash, ["taskmux", "completion", "install", ""]);
  const uninstallOperand = runBashCompletion(bash, ["taskmux", "completion", "uninstall", ""]);

  assert.deepEqual(setShell.stdout.trim().split("\n"), ["<bash>", "<zsh>", "<fish>"]);
  assert.deepEqual(unsetShell.stdout.trim().split("\n"), ["<bash>", "<zsh>", "<fish>"]);
  assert.deepEqual(cycleCause.stdout.trim().split("\n"), [
    "<task-created>", "<user-comment>", "<schedule>", "<review-time>",
    "<operator-input>", "<role-result>", "<inactivity>", "<explicit-wake>"
  ]);
  assert.equal(installOperand.stdout, "");
  assert.equal(uninstallOperand.stdout, "");
});

test("agent command completion suggests unique PATH executables", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const root = mkdtempSync(join(tmpdir(), "taskmux-completion-executables-"));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  for (const directory of [first, second]) {
    const executable = join(directory, "taskmux-fixture-tool");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o755);
  }
  writeFileSync(join(first, "taskmux-fixture-text"), "not executable\n");

  try {
    const result = runBashCompletion(
      bash,
      ["taskmux", "agent", "add", "demo", "--command", "taskmux-fixture-"],
      { ...process.env, PATH: `${first}:${second}:${process.env.PATH ?? ""}` },
      "taskmux-fixture-function() { :; }"
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["<taskmux-fixture-tool>"]);
    assert.match(bash, /compgen -c/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion suppresses unrelated file fallback but keeps catalog-declared file arguments", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const fish = execFileSync("node", ["dist/cli.js", "completion", "fish"], { encoding: "utf8" });
  assert.doesNotMatch(bash, /complete .* -o default/);
  assert.match(bash, /compgen -f/);
  assert.match(fish, /if test \$argument_index -eq 0; and test \(count \$immediate\) -gt 0/);
  assert.match(fish, /if test \(count \$value_keys\) -gt 0/);
  assert.match(fish, /if test \(count \$options\) -gt 0/);
  assert.match(fish, /__fish_complete_path/);

  const root = mkdtempSync(join(tmpdir(), "taskmux-completion-files-"));
  writeFileSync(join(root, "state.json"), "{}");
  try {
    const result = spawnSync("bash", ["-c", `${bash}
cd "$1"
COMP_WORDS=(taskmux import sta)
COMP_CWORD=2
_taskmux
printf 'import:%s\\n' "\${COMPREPLY[@]}"
COMP_WORDS=(taskmux task show sta)
COMP_CWORD=3
_taskmux
printf 'show:%s\\n' "\${COMPREPLY[@]}"
`, "completion-file-test", root], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^import:state\.json$/m);
    assert.doesNotMatch(result.stdout, /^show:state\.json$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bash file completion preserves spaced candidates and filename semantics", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const root = mkdtempSync(join(tmpdir(), "taskmux-completion-spaces-"));
  writeFileSync(join(root, "state backup.json"), "{}");

  try {
    const result = spawnSync("bash", ["-c", `${bash}
cd "$1"
COMP_WORDS=(taskmux import state)
COMP_CWORD=2
_taskmux
printf '<%s>\\n' "\${COMPREPLY[@]}"
`, "completion-space-test", root], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "<state backup.json>");
    assert.match(bash, /compopt -o filenames/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bash completion keeps Bash 3.2-compatible array and stream primitives", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });

  assert.doesNotMatch(bash, /\b(?:local|declare)\s+-A\b/);
  assert.doesNotMatch(bash, /\b(?:mapfile|readarray)\b/);
  assert.match(bash, /while IFS= read -r/);
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
  assert.match(fish, /string join ' ' -- \$prior/);

  const bashResult = spawnSync("bash", ["-c", `${bash}
COMP_WORDS=(taskmux task ro)
COMP_CWORD=2
_taskmux
printf '%s\\n' "\${COMPREPLY[@]}"
`], { encoding: "utf8" });
  assert.equal(bashResult.status, 0, bashResult.stderr);
  assert.deepEqual(bashResult.stdout.trim().split("\n").sort(), ["role", "roles"]);
});

test("completion follows canonical help command paths from the same catalog", () => {
  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const result = spawnSync("bash", ["-c", `${bash}
COMP_WORDS=(taskmux help task ro)
COMP_CWORD=3
_taskmux
printf '%s\\n' "\${COMPREPLY[@]}"
`], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["roles", "role"]);
});

test("hybrid child completion cases precede executable parents in every shell", () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const script = execFileSync("node", ["dist/cli.js", "completion", shell], { encoding: "utf8" });
    const lines = script.split("\n");
    const child = lines.findIndex((line) => /^\s*(?:case )?'task transcript export'/.test(line));
    const parent = lines.findIndex((line) => /^\s*(?:case )?'task transcript'(?:\||\s|$)/.test(line));

    assert.notEqual(child, -1, `${shell} child case missing`);
    assert.notEqual(parent, -1, `${shell} parent case missing`);
    assert.ok(child < parent, `${shell} parent case shadows its hybrid child`);
  }

  const bash = execFileSync("node", ["dist/cli.js", "completion", "bash"], { encoding: "utf8" });
  const bashResult = spawnSync("bash", ["-c", `${bash}
COMP_WORDS=(taskmux task transcript export "--")
COMP_CWORD=4
_taskmux
printf '%s\\n' "\${COMPREPLY[@]}"
`], { encoding: "utf8" });
  assert.equal(bashResult.status, 0, bashResult.stderr);
  assert.match(bashResult.stdout, /^--format$/m);
  assert.match(bashResult.stdout, /^--output$/m);
  assert.doesNotMatch(bashResult.stdout, /^export$/m);
});

test("zsh completion preserves catalog behavior across candidate kinds", {
  skip: spawnSync("zsh", ["--version"], { stdio: "ignore" }).status !== 0
}, () => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-zsh-completion-"));
  const completion = execFileSync("node", ["dist/cli.js", "completion", "zsh"], { encoding: "utf8" });
  writeFileSync(join(root, "_taskmux"), completion);

  try {
    const invoke = (words) => spawnSync("zsh", [
      "-f",
      "-c",
      `fpath=("$1" $fpath)
autoload -Uz compinit
compinit -i -d "$1/.zcompdump"
autoload -Uz _taskmux
function compadd {
  local argument emit=0
  for argument in "$@"; do
    if (( emit )); then print -r -- "$argument"; elif [[ "$argument" == -- ]]; then emit=1; fi
  done
}
function _files { print -r -- 'state backup.json'; }
function _command_names { [[ "$1" == -e ]] || return 9; print -r -- 'taskmux-fixture-tool'; }
words=(${words.map(shellQuote).join(" ")})
CURRENT=${words.length}
_taskmux`,
      "taskmux-completion-test",
      root
    ], { encoding: "utf8" });

    const rootCandidates = invoke(["taskmux", ""]);
    const optionCandidates = invoke(["taskmux", "task", "create", "--"]);
    const enumCandidates = invoke(["taskmux", "task", "create", "--template", ""]);
    const hybridCandidates = invoke(["taskmux", "task", "transcript", "export", "--"]);
    const fileCandidates = invoke(["taskmux", "import", "state"]);
    const executableCandidates = invoke(["taskmux", "agent", "add", "demo", "--command", "taskmux"]);

    assert.deepEqual(rootCandidates.stdout.trim().split("\n"), [
      "task", "operator", "setup", "config", "agent", "role", "completion",
      "controller", "doctor", "maintenance", "backup", "restore", "export", "import", "prune", "update", "version", "help"
    ]);
    assert.deepEqual(optionCandidates.stdout.trim().split("\n"), [
      "--template", "--agent", "--workspace", "--description", "--priority", "--tag", "--due"
    ]);
    assert.deepEqual(enumCandidates.stdout.trim().split("\n"), ["feature", "bug", "review"]);
    assert.deepEqual(hybridCandidates.stdout.trim().split("\n"), ["--format", "--output"]);
    assert.equal(fileCandidates.stdout.trim(), "state backup.json");
    assert.equal(executableCandidates.stdout.trim(), "taskmux-fixture-tool");
    for (const result of [rootCandidates, optionCandidates, enumCandidates, hybridCandidates, fileCandidates, executableCandidates]) {
      assert.equal(result.status, 0, result.stderr);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fish completion executes catalog ordering and ownership rules", {
  skip: !fishAvailable
}, () => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-fish-completion-"));
  const completionPath = join(root, "taskmux.fish");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "taskmux-fixture-tool"), "#!/bin/sh\n");
  chmodSync(join(bin, "taskmux-fixture-tool"), 0o755);
  writeFileSync(completionPath, execFileSync("node", ["dist/cli.js", "completion", "fish"], { encoding: "utf8" }));

  try {
    const invoke = (prior, current, useRealCommandHelper = false) => spawnSync(fishBinary, ["-c", `
set -g test_prior ${prior.map(shellQuote).join(" ")}
set -g test_current ${shellQuote(current)}
function commandline
  if test "$argv[1]" = -opc
    printf '%s\\n' $test_prior
  else if test "$argv[1]" = -ct
    printf '%s' "$test_current"
  end
end
function __fish_complete_path
  printf '%s\\n' 'state backup.json'
end
function taskmux-fixture-function; end
${useRealCommandHelper ? "" : `function __fish_complete_command
  printf 'taskmux-fixture-function\\tFunction description\\ntaskmux-fixture-tool\\tFixture tool\\ntaskmux-fixture-tool\\tDuplicate description\\n'
end`}
source "$TASKMUX_COMPLETION_TEST_PATH"
_taskmux
`], { encoding: "utf8", env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TASKMUX_COMPLETION_TEST_PATH: completionPath
      } });

    const rootCandidates = invoke(["taskmux"], "");
    const optionCandidates = invoke(["taskmux", "task", "create"], "--");
    const enumCandidates = invoke(["taskmux", "task", "create", "--template"], "");
    const hybridCandidates = invoke(["taskmux", "task", "transcript", "export"], "--");
    const fileCandidates = invoke(["taskmux", "import"], "state");
    const executableCandidates = invoke(["taskmux", "agent", "add", "demo", "--command"], "taskmux");
    const realExecutableCandidates = invoke(["taskmux", "agent", "add", "demo", "--command"], "taskmux-fixture-", true);

    assert.deepEqual(rootCandidates.stdout.trim().split("\n"), [
      "task", "operator", "setup", "config", "agent", "role", "completion",
      "controller", "doctor", "maintenance", "backup", "export", "import", "prune", "update", "version", "help"
    ]);
    assert.deepEqual(optionCandidates.stdout.trim().split("\n"), [
      "--template", "--agent", "--workspace", "--description", "--priority", "--tag", "--due"
    ]);
    assert.deepEqual(enumCandidates.stdout.trim().split("\n"), ["feature", "bug", "review"]);
    assert.deepEqual(hybridCandidates.stdout.trim().split("\n"), ["--format", "--output"]);
    assert.equal(fileCandidates.stdout.trim(), "state backup.json");
    assert.equal(executableCandidates.stdout.trim(), "taskmux-fixture-tool\tFixture tool");
    assert.ok(realExecutableCandidates.stdout.trim().split("\n").some((record) => record.split("\t")[0] === "taskmux-fixture-tool"));
    for (const result of [rootCandidates, optionCandidates, enumCandidates, hybridCandidates, fileCandidates, executableCandidates, realExecutableCandidates]) {
      assert.equal(result.status, 0, result.stderr);
    }
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
  const help = execFileSync("node", ["dist/cli.js", "help"], {
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
