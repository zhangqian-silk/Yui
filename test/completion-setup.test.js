import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileTaskStore } from "../dist/storage/taskStore.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { activationBlock, managedCompletionScript } from "../dist/completion/completionState.js";

function createHome() {
  const home = mkdtempSync(join(tmpdir(), "taskmux-completion-"));
  ensureStorageSchema(home);
  return home;
}

function run(args, env = {}) {
  return execFileSync("node", ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TASKMUX_CONTROLLER_MODE: "direct", ...env },
    encoding: "utf8"
  });
}

function runInteractive(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, TASKMUX_CONTROLLER_MODE: "direct", TASKMUX_SETUP_INTERACTIVE: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (status) => status === 0
      ? resolve(stdout)
      : reject(new Error(`status=${status}\n${stderr}\n${stdout}`)));
    child.stdin.end(input);
  });
}

test("config codec accepts supported completion installation records", () => {
  const home = createHome();
  const store = new FileTaskStore(home);
  const installations = {
    bash: { scriptPath: "/tmp/completions/taskmux", activationPath: "/tmp/bashrc" },
    zsh: { scriptPath: "/tmp/completions/_taskmux", activationPath: "/tmp/zshrc" },
    fish: { scriptPath: "/tmp/completions/taskmux.fish", activationPath: "/tmp/config.fish" }
  };

  store.saveConfig({ schemaVersion: 1, completionInstallations: installations });

  assert.deepEqual(store.getConfig().completionInstallations, installations);
});

test("config codec rejects unsupported completion shells", () => {
  const home = createHome();
  writeFileSync(join(home, "config.json"), JSON.stringify({
    schemaVersion: 1,
    completionInstallations: {
      powershell: { scriptPath: "/tmp/taskmux.ps1", activationPath: "/tmp/profile.ps1" }
    }
  }));

  assert.throws(() => new FileTaskStore(home).getConfig(), /Invalid config record/);
});

test("config codec rejects malformed completion installation records", () => {
  const invalidInstallations = [
    { bash: { scriptPath: "relative", activationPath: "/tmp/bashrc" } },
    { bash: { scriptPath: "/tmp/taskmux" } },
    { bash: { scriptPath: "/tmp/a/../taskmux", activationPath: "/tmp/bashrc" } },
    { bash: { scriptPath: "/tmp/taskmux", activationPath: "/tmp/bashrc", extra: true } },
    []
  ];
  for (const completionInstallations of invalidInstallations) {
    const home = createHome();
    writeFileSync(join(home, "config.json"), JSON.stringify({ schemaVersion: 1, completionInstallations }));
    assert.throws(() => new FileTaskStore(home).getConfig(), /Invalid config record/);
  }
});

test("config completion set and unset preserve sibling records", () => {
  const home = createHome();

  run(["config", "set", "completion", "bash", "/tmp/taskmux", "/tmp/bashrc"], { TASKMUX_HOME: home });
  run(["config", "set", "completion", "zsh", "/tmp/_taskmux", "/tmp/zshrc"], { TASKMUX_HOME: home });
  run(["config", "unset", "completion", "bash"], { TASKMUX_HOME: home });

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(config.completionInstallations, {
    zsh: { scriptPath: "/tmp/_taskmux", activationPath: "/tmp/zshrc" }
  });
});

test("interactive completion install is rejected before storage in non-TTY mode", () => {
  const home = join(mkdtempSync(join(tmpdir(), "taskmux-completion-missing-")), "home");
  const result = spawnSync("node", ["dist/cli.js", "completion", "install"], {
    cwd: process.cwd(),
    env: { ...process.env, TASKMUX_HOME: home },
    encoding: "utf8"
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires an interactive terminal/i);
  assert.equal(result.stdout, "");
});

test("interactive completion commands reject operands before storage or prompts", () => {
  for (const command of ["install", "uninstall"]) {
    const home = join(mkdtempSync(join(tmpdir(), "taskmux-completion-arity-")), "home");
    const result = spawnSync("node", ["dist/cli.js", "completion", command, "extra"], {
      cwd: process.cwd(),
      env: { ...process.env, TASKMUX_HOME: home, TASKMUX_SETUP_INTERACTIVE: "1" },
      encoding: "utf8"
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`Completion ${command} usage: taskmux completion ${command}`));
    assert.equal(result.stdout, "");
    assert.equal(existsSync(home), false);
  }
});

test("completion rendering honors the trusted development launcher identity", () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const output = run(["completion", shell], { TASKMUX_CLI_NAME: "taskmux-dev" });
    assert.match(output, /taskmux-dev/);
    assert.doesNotMatch(output, /complete(?:\s+-c|\s+-F)?[^\n]*\staskmux(?:\s|$)/);
  }
});

test("completion rendering ignores unsupported launcher identities", () => {
  const output = run(["completion", "bash"], { TASKMUX_CLI_NAME: "malicious name" });
  assert.match(output, /complete -F _taskmux taskmux/);
  assert.doesNotMatch(output, /malicious/);
});

test("managed zsh activation autoloads the generated function and registers candidates", {
  skip: spawnSync("zsh", ["--version"], { stdio: "ignore" }).status !== 0
}, () => {
  const root = mkdtempSync(join(tmpdir(), "taskmux-managed-zsh-"));
  const scriptPath = join(root, "custom functions", "_taskmux");
  const activationPath = join(root, "zsh rc");
  mkdirSync(join(root, "custom functions"), { recursive: true });
  const installation = { scriptPath, activationPath };
  writeFileSync(scriptPath, managedCompletionScript("zsh", "taskmux"));
  writeFileSync(activationPath, `${activationBlock("zsh", installation, "taskmux")}\n`);

  const result = spawnSync("zsh", [
    "-f",
    "-c",
    'source "$1"; function compadd { print -rl -- "$@"; }; words=(taskmux ve); CURRENT=2; _taskmux',
    "taskmux-managed-zsh-test",
    activationPath
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^version$/m);
});

test("completion selection prompt advertises skip", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  const output = await runInteractive(["completion", "install"], "skip\n", {
    TASKMUX_HOME: home,
    HOME: userHome,
    SHELL: "/bin/zsh"
  });
  assert.match(output, /Choose shell by number or name \[zsh\] \(or skip\):/);
  assert.match(output, /Completion install skipped/);
});

test("interactive install shows all shells and installs exactly one selected shell", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  const output = await runInteractive(["completion", "install"], "1\n\ny\n", {
    TASKMUX_HOME: home,
    HOME: userHome,
    SHELL: "/bin/bash",
    XDG_DATA_HOME: join(userHome, "share")
  });
  const scriptPath = join(userHome, "share", "bash-completion", "completions", "taskmux");

  assert.match(output, /\|\s*#\s*\|\s*Shell\s*\|\s*Status\s*\|\s*Action\s*\|\s*Current\s*\|\s*Script\s*\|/);
  assert.match(output, /\|\s*1\s*\|\s*Bash\s*\|\s*Not installed\s*\|\s*Install\s*\|\s*yes\s*\|\s*\|/);
  assert.match(output, /\|\s*2\s*\|\s*Zsh\s*\|\s*Not installed\s*\|\s*Install\s*\|\s*\|\s*\|/);
  assert.match(output, /Install using these paths\? \[Y\/n\/customize\]:/);
  assert.doesNotMatch(output, /Completion script path/);
  assert.match(output, /Update .*\.bashrc with the managed TaskMux block\? \[y\/N\]:/);
  assert.equal(existsSync(scriptPath), true);
  assert.match(readFileSync(scriptPath, "utf8"), /taskmux-completion: managed shell=bash identity=taskmux/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).completionInstallations), ["bash"]);
});

test("only customize prompts for and persists custom full paths", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  const scriptPath = join(userHome, "custom completion", "taskmux.bash");
  const activationPath = join(userHome, "custom bashrc");
  const output = await runInteractive(
    ["completion", "install"],
    `bash\ncustomize\n${scriptPath}\n${activationPath}\ny\n`,
    { TASKMUX_HOME: home, HOME: userHome, SHELL: "/bin/bash" }
  );

  assert.match(output, /Completion script path/);
  assert.match(output, /Activation file path/);
  assert.equal(existsSync(scriptPath), true);
  assert.deepEqual(new FileTaskStore(home).getConfig().completionInstallations?.bash, { scriptPath, activationPath });
});

test("interactive install reuses recorded paths and offers Refresh", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  const env = { TASKMUX_HOME: home, HOME: userHome, SHELL: "/bin/bash", XDG_DATA_HOME: join(userHome, "share") };
  await runInteractive(["completion", "install"], "\n\ny\n", env);

  const output = await runInteractive(["completion", "install"], "\nn\n", env);

  assert.match(output, /\|\s*Bash\s*\|\s*Installed\s*\|\s*Refresh\s*\|\s*yes\s*\|/);
  assert.match(output, new RegExp(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).completionInstallations.bash.scriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("interactive completion JSON mode fails before storage", () => {
  const home = join(mkdtempSync(join(tmpdir(), "taskmux-json-")), "home");
  const result = spawnSync("node", ["dist/cli.js", "completion", "install", "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, TASKMUX_HOME: home, TASKMUX_SETUP_INTERACTIVE: "1" },
    encoding: "utf8"
  });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    code: "USAGE_ERROR",
    message: "Completion install does not support --json.",
    details: {}
  });
  assert.equal(result.stdout, "");
  assert.equal(existsSync(home), false);
});

test("interactive uninstall removes only the selected managed installation", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  const env = { TASKMUX_HOME: home, HOME: userHome, SHELL: "/bin/bash", XDG_DATA_HOME: join(userHome, "share") };
  await runInteractive(["completion", "install"], "\n\ny\n", env);
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const scriptPath = config.completionInstallations.bash.scriptPath;

  const output = await runInteractive(["completion", "uninstall"], "\ny\n", env);

  assert.match(output, /Completion bash uninstalled/);
  assert.equal(existsSync(scriptPath), false);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).completionInstallations, undefined);
  assert.doesNotMatch(readFileSync(join(userHome, ".bashrc"), "utf8"), /taskmux completion/);
});

test("interactive install refuses to overwrite an unmanaged script", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  const scriptPath = join(userHome, "share", "bash-completion", "completions", "taskmux");
  mkdirSync(join(userHome, "share", "bash-completion", "completions"), { recursive: true });
  writeFileSync(scriptPath, "user owned\n");

  await assert.rejects(
    runInteractive(["completion", "install"], "\n\ny\n", {
      TASKMUX_HOME: home,
      HOME: userHome,
      SHELL: "/bin/bash",
      XDG_DATA_HOME: join(userHome, "share")
    }),
    /Refusing to overwrite unmanaged completion script/
  );
  assert.equal(readFileSync(scriptPath, "utf8"), "user owned\n");
  assert.equal(new FileTaskStore(home).getConfig().completionInstallations, undefined);
});

test("activation failure retains a repairable installation record", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  writeFileSync(join(userHome, ".bashrc"), "# >>> taskmux completion shell=bash identity=taskmux >>>\n");
  const env = { TASKMUX_HOME: home, HOME: userHome, SHELL: "/bin/bash", XDG_DATA_HOME: join(userHome, "share") };

  await assert.rejects(runInteractive(["completion", "install"], "\n\ny\n", env), /ambiguous TaskMux activation block/);

  const config = new FileTaskStore(home).getConfig();
  assert.ok(config.completionInstallations?.bash);
  assert.equal(existsSync(config.completionInstallations.bash.scriptPath), true);
  const output = await runInteractive(["completion", "install"], "\nn\n", env);
  assert.match(output, /\|\s*Bash\s*\|\s*Needs repair\s*\|\s*Repair\s*\|/);
});

test("uninstall preflights an ambiguous activation block before removing the script", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  const env = { TASKMUX_HOME: home, HOME: userHome, SHELL: "/bin/bash", XDG_DATA_HOME: join(userHome, "share") };
  await runInteractive(["completion", "install"], "\n\ny\n", env);
  const installation = new FileTaskStore(home).getConfig().completionInstallations.bash;
  writeFileSync(installation.activationPath, "# >>> taskmux completion shell=bash identity=taskmux >>>\n");

  await assert.rejects(runInteractive(["completion", "uninstall"], "\ny\n", env), /ambiguous TaskMux activation block/);

  assert.equal(existsSync(installation.scriptPath), true);
  assert.ok(new FileTaskStore(home).getConfig().completionInstallations?.bash);
});

test("config show owns each completion path on one table row", async () => {
  const home = createHome();
  const userHome = mkdtempSync(join(tmpdir(), "taskmux-user-"));
  await runInteractive(["completion", "install"], "\n\ny\n", {
    TASKMUX_HOME: home,
    HOME: userHome,
    SHELL: "/bin/bash",
    XDG_DATA_HOME: join(userHome, "share")
  });
  const output = run(["config", "show"], { TASKMUX_HOME: home, HOME: userHome, SHELL: "/bin/bash", XDG_DATA_HOME: join(userHome, "share") });

  assert.equal(output.match(/^TaskMux config$/gm)?.length, 1);
  assert.match(output, /\|\s*completion:bash\s*\|\s*configured\s*\|/);
  assert.match(output, /state=Installed/);
  assert.doesNotMatch(output, /^Completion path:/m);
});

test("logical export omits completion paths and import preserves target paths", () => {
  const source = createHome();
  const target = createHome();
  const output = join(mkdtempSync(join(tmpdir(), "taskmux-export-")), "snapshot.json");
  const sourceStore = new FileTaskStore(source);
  sourceStore.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: "/source",
    completionInstallations: { bash: { scriptPath: "/source/taskmux", activationPath: "/source/bashrc" } }
  });
  const targetStore = new FileTaskStore(target);
  targetStore.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: "/target",
    completionInstallations: { fish: { scriptPath: "/target/taskmux.fish", activationPath: "/target/config.fish" } }
  });

  run(["export", "--output", output], { TASKMUX_HOME: source });
  const snapshot = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(snapshot.config.completionInstallations, undefined);

  run(["import", output], { TASKMUX_HOME: target });
  assert.deepEqual(targetStore.getConfig().completionInstallations, {
    fish: { scriptPath: "/target/taskmux.fish", activationPath: "/target/config.fish" }
  });
  assert.equal(targetStore.getConfig().defaultWorkspace, "/source");
});

test("setup reuses the completion wizard for exactly one selected shell", async () => {
  const parent = mkdtempSync(join(tmpdir(), "taskmux-setup-completion-"));
  const home = join(parent, "state");
  const userHome = join(parent, "user");
  const output = await runInteractive(["setup"], "1\n3\n\n", {
    TASKMUX_HOME: home,
    HOME: userHome,
    SHELL: "/bin/fish",
    TASKMUX_TMUX_BIN: process.execPath
  });
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));

  assert.equal(output.match(/Completion installation/g)?.length, 1);
  assert.deepEqual(Object.keys(config.completionInstallations), ["fish"]);
  assert.equal(existsSync(config.completionInstallations.fish.scriptPath), true);
  assert.match(output, /TaskMux setup complete/);
});

test("setup JSON mode is rejected before initialization", () => {
  const home = join(mkdtempSync(join(tmpdir(), "taskmux-setup-json-")), "home");
  const result = spawnSync("node", ["dist/cli.js", "setup", "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, TASKMUX_HOME: home, TASKMUX_SETUP_INTERACTIVE: "1" },
    encoding: "utf8"
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).message, "Setup does not support --json.");
  assert.equal(existsSync(home), false);
});
