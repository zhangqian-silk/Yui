import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = process.env.YUI_INSTALLED_ROOT ?? process.cwd();
const sandbox = mkdtempSync(join(tmpdir(), "yui-runtime-package-smoke-"));
const isolatedHome = join(sandbox, "home");
const yuiHome = join(isolatedHome, ".yui");
const fakeBin = join(sandbox, "bin");
let cli;
let environment;
const skills = [
  "yui-leader",
  "yui-worker",
  "yui-operator",
  "yui-reviewer",
  "yui-runtime"
];

try {
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  mkdirSync(fakeBin, { recursive: true, mode: 0o755 });
  for (const command of ["codex", "git", "tmux"]) {
    writeFileSync(
      join(fakeBin, command),
      `#!/bin/sh\nprintf '%s\\n' 'fake ${command} 1.0'\n`,
      { mode: 0o755 }
    );
  }

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // Follow the actual instructions' local Markdown links, including cross-Role
  // references, in the installed tree. Source-only references cannot satisfy
  // this check; prose/heading changes do not invalidate the contract.
  const skillRoot = resolve(root, "skills");
  const pendingSkills = skills.map((skill) => join(skillRoot, skill, "SKILL.md"));
  const checkedSkills = new Set();
  while (pendingSkills.length > 0) {
    const path = pendingSkills.pop();
    if (checkedSkills.has(path)) continue;
    checkedSkills.add(path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Installed Skill resource is missing: ${relative(skillRoot, path)}.`);
    }
    const content = readFileSync(path, "utf8");
    if (content.trim().length === 0) {
      throw new Error(`Installed Skill resource is empty: ${relative(skillRoot, path)}.`);
    }
    for (const [, href] of content.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/gu)) {
      if (/^[a-z][a-z\d+.-]*:/iu.test(href)) continue;
      const target = href.split("#")[0];
      if (!target.endsWith(".md")) continue;
      const resolved = resolve(dirname(path), target);
      const local = relative(skillRoot, resolved);
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) {
        throw new Error(`Installed Skill reference leaves its package: ${href}.`);
      }
      pendingSkills.push(resolved);
    }
  }
  if (packageJson.bin?.yui !== "./dist/cli.js") {
    throw new Error("Installed runtime package does not expose the expected yui bin.");
  }
  // PR #110 regression: the installed CLI must stay executable. npm applies
  // the process umask on extraction, so the exact tarball mode (asserted as
  // 0755 in the package structure check) may land as 0700 locally; the
  // regression contract is a surviving execute bit, and the .bin/yui
  // invocations below prove it is runnable.
  const installedCli = join(root, "dist", "cli.js");
  const installedMode = statSync(installedCli).mode & 0o777;
  if ((installedMode & 0o111) === 0) {
    throw new Error(
      `Installed dist/cli.js must be executable, received ${installedMode.toString(8).padStart(4, "0")}.`
    );
  }

  cli = resolve(root, "..", "..", ".bin", "yui");
  if (!existsSync(cli)) {
    throw new Error("Installed runtime package did not create its yui bin.");
  }
  environment = {
    ...process.env,
    HOME: isolatedHome,
    YUI_HOME: yuiHome,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    NO_COLOR: "1"
  };

  const version = runCli(cli, ["version"], environment).trim();
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI reported ${version}; expected ${packageJson.version}.`);
  }
  if (!runCli(cli, ["help"], environment).includes("Yui")) {
    throw new Error("Installed CLI help did not render.");
  }
  const scopedHelp = runCli(cli, ["help", "task", "role"], environment);
  if (!scopedHelp.includes("yui task role <command>") || !scopedHelp.includes("add")) {
    throw new Error("Installed CLI nested help did not render the restored command catalog.");
  }
  const completion = runCli(
    cli,
    ["config", "completion", "candidates", "ta", "--"],
    environment
  ).trim().split("\n");
  if (!completion.includes("task")) {
    throw new Error("Installed CLI command completion did not use the restored catalog.");
  }

  const setup = runCli(
    cli,
    ["setup"],
    { ...environment, YUI_SETUP_INTERACTIVE: "1" },
    "\n"
  );
  if (
    !setup.includes("Yui setup complete.")
    || !/^Operator: .+ \(created\)\.$/mu.test(setup)
    || !/^Leader: .+ \(created\)\.$/mu.test(setup)
  ) {
    throw new Error("Installed CLI setup did not create the minimum task-ready runtime.");
  }

  const doctor = runCli(cli, ["doctor"], environment);
  if (!doctor.includes("Yui doctor") || !doctor.includes("storage schema")) {
    throw new Error("Installed CLI doctor did not inspect the initialized runtime.");
  }

  const created = runCli(cli, ["task", "create", "runtime smoke"], environment);
  const taskId = /Created Draft task (task-[A-Za-z0-9_-]+)/u.exec(created)?.[1];
  if (taskId === undefined) {
    throw new Error("Installed CLI did not create a Draft Task.");
  }
  const tasks = runCli(cli, ["task", "list"], environment);
  if (!tasks.includes(taskId) || !tasks.includes("draft")) {
    throw new Error("Installed CLI controller did not return the created Draft Task.");
  }
  const beforeRestart = runCli(cli, ["controller", "status"], environment);
  const previousPid = /PID (\d+)/u.exec(beforeRestart)?.[1];
  if (previousPid === undefined) {
    throw new Error("Installed CLI did not report the Controller PID before restart.");
  }
  const restarted = runCli(cli, ["controller", "restart"], environment);
  const restartedPids = /PID (\d+) -> (\d+)/u.exec(restarted);
  if (
    restartedPids?.[1] !== previousPid
    || restartedPids[2] === previousPid
    || !restarted.includes("tmux sessions were not stopped")
  ) {
    throw new Error("Installed CLI did not replace the Controller process safely.");
  }
  const stopped = runCli(cli, ["controller", "stop"], environment);
  if (!stopped.includes("Controller stopped.")) {
    throw new Error("Installed CLI controller did not stop cleanly.");
  }
} finally {
  // setup can start a Controller before any Task command succeeds. Inspect the
  // fixture we own instead of setting a late "started" flag. Do not erase the
  // Home when shutdown fails: another Agent needs its exact identity to clean it.
  if (existsSync(join(yuiHome, "yui.db")) && cli !== undefined && environment !== undefined) {
    try {
      runCli(cli, ["controller", "stop"], environment);
    } catch (error) {
      throw new Error(`Runtime smoke cleanup failed; fixture retained at ${sandbox}.`, { cause: error });
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
}
process.stdout.write("Runtime package smoke passed.\n");

function runCli(cli, args, env, input) {
  return execFileSync(cli, args, { encoding: "utf8", env, input });
}
