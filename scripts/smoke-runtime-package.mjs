import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.TASKMUX_INSTALLED_ROOT ?? process.cwd();
const home = mkdtempSync(join(tmpdir(), "taskmux-runtime-package-smoke-"));
const skills = [
  ["taskmux-leader", "# TaskMux Leader"],
  ["taskmux-worker", "# TaskMux Worker"],
  ["taskmux-operator", "# TaskMux Operator"]
];

try {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const [skill, heading] of skills) {
    const path = join(root, "skills", skill, "SKILL.md");
    if (!existsSync(path) || !readFileSync(path, "utf8").includes(heading)) {
      throw new Error(`Installed runtime package is missing ${skill}/SKILL.md.`);
    }
  }

  const cli = join(root, "dist", "cli.js");
  const { ensureStorageSchema } = await import(pathToFileURL(
    join(root, "dist", "storage", "storageSchema.js")
  ).href);
  ensureStorageSchema(home);
  if (!existsSync(join(home, "schema.json"))) {
    throw new Error("Installed runtime package did not initialize its storage schema.");
  }
  const environment = {
    ...process.env,
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "direct"
  };
  const version = runCli(cli, ["version"], environment).trim();
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI reported ${version}; expected ${packageJson.version}.`);
  }
  if (!runCli(cli, ["help"], environment).includes("TaskMux")) {
    throw new Error("Installed CLI help did not render.");
  }
  runCli(
    cli,
    ["agent", "add", "runtime-smoke", "--adapter", "codex", "--command", process.execPath],
    environment
  );
  if (!existsSync(join(home, "schema.json"))) {
    throw new Error("Installed CLI did not retain its storage schema.");
  }

  const { compileDispatchInput } = await import(pathToFileURL(
    join(root, "dist", "context", "dispatchContext.js")
  ).href);
  const store = { listChildRoles: () => [] };
  if (!compileDispatchInput(store, "task-1", taskRole("leader"), "continue").includes("# TaskMux Leader")) {
    throw new Error("Installed dispatch context did not read the Leader Skill.");
  }
  if (!compileDispatchInput(store, "task-1", taskRole("worker"), "continue").includes("# TaskMux Worker")) {
    throw new Error("Installed dispatch context did not read the Worker Skill.");
  }

  const { prepareGlobalRoleLaunch } = await import(pathToFileURL(
    join(root, "dist", "operator", "operatorContext.js")
  ).href);
  const launch = prepareGlobalRoleLaunch(operatorRole(), {
    taskmuxHome: home,
    baseEnv: { ...process.env, CODEX_HOME: join(home, "codex-home") }
  });
  if (!readFileSync(launch.env.TASKMUX_OPERATOR_CONTEXT, "utf8").includes("# TaskMux Operator")) {
    throw new Error("Installed operator context did not read the Operator Skill.");
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

function runCli(cli, args, env) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
}

function taskRole(name) {
  return {
    schemaVersion: 2,
    taskId: "task-1",
    name,
    activeAgentId: "codex",
    agentBindings: {
      codex: {
        agentId: "codex",
        adapterId: "codex",
        config: { adapterId: "codex" }
      }
    },
    workspace: "/tmp/runtime-package-smoke",
    status: "idle",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    responsibilities: [],
    constraints: []
  };
}

function operatorRole() {
  return {
    schemaVersion: 1,
    name: "operator",
    agent: "codex",
    command: "codex",
    args: [],
    env: {},
    workspace: "/tmp/runtime-package-smoke",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    responsibilities: [],
    constraints: []
  };
}
