import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = process.env.TASKMUX_INSTALLED_ROOT ?? process.cwd();
const sandbox = mkdtempSync(join(tmpdir(), "taskmux-runtime-package-smoke-"));
const isolatedHome = join(sandbox, "home");
const taskmuxHome = join(isolatedHome, ".taskmux");
const fakeBin = join(sandbox, "bin");
let cli;
let environment;
let controllerStarted = false;
const skills = [
  ["taskmux-leader", "# TaskMux Leader"],
  ["taskmux-worker", "# TaskMux Worker"],
  ["taskmux-operator", "# TaskMux Operator"]
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
  for (const [skill, heading] of skills) {
    const path = join(root, "skills", skill, "SKILL.md");
    if (!existsSync(path) || !readFileSync(path, "utf8").includes(heading)) {
      throw new Error(`Installed runtime package is missing ${skill}/SKILL.md.`);
    }
  }
  if (packageJson.bin?.taskmux !== "./dist/cli.js") {
    throw new Error("Installed runtime package does not expose the expected taskmux bin.");
  }

  cli = resolve(root, "..", "..", ".bin", "taskmux");
  if (!existsSync(cli)) {
    throw new Error("Installed runtime package did not create its taskmux bin.");
  }
  environment = {
    ...process.env,
    HOME: isolatedHome,
    TASKMUX_HOME: taskmuxHome,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    NO_COLOR: "1"
  };

  const version = runCli(cli, ["version"], environment).trim();
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI reported ${version}; expected ${packageJson.version}.`);
  }
  if (!runCli(cli, ["help"], environment).includes("TaskMux")) {
    throw new Error("Installed CLI help did not render.");
  }
  const scopedHelp = runCli(cli, ["help", "task", "role"], environment);
  if (!scopedHelp.includes("taskmux task role <command>") || !scopedHelp.includes("add")) {
    throw new Error("Installed CLI nested help did not render the restored command catalog.");
  }
  const completion = runCli(
    cli,
    ["completion", "candidates", "ta", "--"],
    environment
  ).trim().split("\n");
  if (!completion.includes("task")) {
    throw new Error("Installed CLI command completion did not use the restored catalog.");
  }

  const setup = runCli(
    cli,
    ["setup"],
    { ...environment, TASKMUX_SETUP_INTERACTIVE: "1" },
    `\n\n\n${join(taskmuxHome, "workspace")}\n\n`
  );
  if (!setup.includes("TaskMux setup complete.") || !setup.includes("Agents configured: codex")) {
    throw new Error("Installed CLI setup did not initialize the FileTaskStore runtime.");
  }

  const doctor = runCli(cli, ["doctor"], environment);
  if (!doctor.includes("TaskMux doctor") || !doctor.includes("storage schema")) {
    throw new Error("Installed CLI doctor did not inspect the initialized runtime.");
  }

  const created = runCli(cli, ["task", "create", "runtime smoke"], environment);
  controllerStarted = true;
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
  controllerStarted = false;

  process.stdout.write("Runtime package smoke passed.\n");
} finally {
  if (controllerStarted && cli !== undefined && environment !== undefined) {
    try {
      runCli(cli, ["controller", "stop"], environment);
    } catch {
      // Preserve the original smoke failure while making a best-effort cleanup.
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
}

function runCli(cli, args, env, input) {
  return execFileSync(cli, args, { encoding: "utf8", env, input });
}
