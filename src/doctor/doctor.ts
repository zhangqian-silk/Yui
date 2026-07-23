import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

import { configuredAgentToDefinition, type ConfiguredAgent } from "../agent/agent.js";
import {
  inspectAgentCapabilities,
  type AgentProbeResult,
  type CapabilitySnapshot
} from "../executor/agentAdapter.js";
import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  FileTaskStore,
  resolveYuiHome,
  STORAGE_STATE_FILE
} from "../storage/taskStore.js";
import {
  inspectStorageSchema,
  type StorageSchemaState
} from "../storage/storageSchema.js";
import {
  CommandExecutionError,
  type CommandExecutor
} from "../tmux/commandExecutor.js";

export type DoctorStatus = "ok" | "missing" | "unsupported" | "invalid";

export type DoctorCheck = Readonly<{
  name: string;
  status: DoctorStatus;
  detail: string;
}>;

type StorageInspection = Readonly<{
  check: DoctorCheck;
  agents: readonly ConfiguredAgent[];
}>;

type SchemaInspection = StorageSchemaState | Readonly<{
  status: "read-error";
  detail: string;
}>;

/** Runs the read-only FileTaskStore diagnostics used by `yui doctor`. */
export function runDoctorCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): string {
  if (args.length !== 0) throw usageError("Doctor usage: yui doctor");
  return renderDoctor(getDoctorChecks(env, executor));
}

export function getDoctorChecks(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): DoctorCheck[] {
  const home = resolveYuiHome(env);
  const homeCheck = checkHome(home);
  const schema = readSchema(home);
  const schemaCheck = checkSchema(schema);
  const storage = inspectState(home, homeCheck, schema);
  return [
    homeCheck,
    schemaCheck,
    storage.check,
    checkExecutable("git", env.YUI_GIT_BIN ?? "git", ["--version"], executor),
    checkExecutable("tmux", env.YUI_TMUX_BIN ?? "tmux", ["-V"], executor),
    ...storage.agents.flatMap((agent) => checkAgent(agent, executor))
  ];
}

export function renderDoctor(checks: readonly DoctorCheck[]): string {
  return `Yui doctor\n${renderTable(
    "Checks",
    [
      { header: "Check", minWidth: 8, maxWidth: 28 },
      { header: "Status", minWidth: 7, maxWidth: 11 },
      { header: "Detail", minWidth: 12, maxWidth: 88 }
    ],
    checks.map((check) => [check.name, check.status, check.detail]),
    defaultTableWidth()
  )}\n`;
}

function checkHome(home: string): DoctorCheck {
  try {
    const metadata = lstatSync(home);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return {
        name: "yui home",
        status: "invalid",
        detail: "YUI_HOME must be a real directory."
      };
    }
    accessSync(home, constants.R_OK);
    return { name: "yui home", status: "ok", detail: home };
  } catch (error) {
    if (systemCode(error) === "ENOENT") {
      return { name: "yui home", status: "missing", detail: "run yui setup" };
    }
    return { name: "yui home", status: "invalid", detail: errorMessage(error) };
  }
}

function readSchema(home: string): SchemaInspection {
  try {
    return inspectStorageSchema(home);
  } catch (error) {
    return { status: "read-error", detail: errorMessage(error) };
  }
}

function checkSchema(state: SchemaInspection): DoctorCheck {
  switch (state.status) {
    case "uninitialized":
      return { name: "storage schema", status: "missing", detail: "run yui setup" };
    case "current":
      return {
        name: "storage schema",
        status: "ok",
        detail: `current=${state.currentVersion} latest=${state.latestVersion}`
      };
    case "unsupported":
      return {
        name: "storage schema",
        status: "unsupported",
        detail: `current=${state.currentVersion} latest=${state.latestVersion} direction=${state.direction}`
      };
    case "invalid":
      return { name: "storage schema", status: "invalid", detail: state.detail };
    case "read-error":
      return { name: "storage schema", status: "invalid", detail: state.detail };
  }
}

function inspectState(
  home: string,
  homeCheck: DoctorCheck,
  schema: SchemaInspection
): StorageInspection {
  if (homeCheck.status !== "ok") {
    return blockedStorage(homeCheck.status, homeCheck.detail);
  }
  if (schema.status === "uninitialized") {
    return blockedStorage("missing", "run yui setup");
  }
  if (schema.status === "unsupported") {
    return blockedStorage(
      "unsupported",
      `current=${schema.currentVersion} latest=${schema.latestVersion}`
    );
  }
  if (schema.status === "invalid") return blockedStorage("invalid", schema.detail);
  if (schema.status === "read-error") return blockedStorage("invalid", schema.detail);

  const statePath = join(home, STORAGE_STATE_FILE);
  if (!existsSync(statePath)) return blockedStorage("missing", "run yui setup");
  try {
    const metadata = lstatSync(statePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return blockedStorage("invalid", `${STORAGE_STATE_FILE} must be a regular file.`);
    }
    accessSync(statePath, constants.R_OK);
    const store = new FileTaskStore(home);
    const config = store.getConfig();
    const agents = store.listConfiguredAgents();
    const tasks = store.listTasks();
    const globalRoles = store.listGlobalRoles();
    const roleCount = tasks.reduce(
      (count, task) => count + store.listRoles(task.id).length,
      0
    );
    return {
      check: {
        name: "storage state",
        status: "ok",
        detail: `readable agents=${agents.length} tasks=${tasks.length} roles=${roleCount} globalRoles=${globalRoles.length} defaultAgent=${config.defaultAgent ?? "none"}`
      },
      agents
    };
  } catch (error) {
    return blockedStorage("invalid", errorMessage(error));
  }
}

function blockedStorage(status: Exclude<DoctorStatus, "ok">, detail: string): StorageInspection {
  return {
    check: { name: "storage state", status, detail },
    agents: []
  };
}

function checkExecutable(
  name: "git" | "tmux",
  command: string,
  args: string[],
  executor: CommandExecutor
): DoctorCheck {
  try {
    const output = firstLine(executor.run(command, args));
    return {
      name,
      status: "ok",
      detail: output.length === 0 ? command : `${command}: ${output}`
    };
  } catch (error) {
    return {
      name,
      status: isMissingCommand(error) ? "missing" : "invalid",
      detail: `${command}: ${commandFailure(error)}`
    };
  }
}

function checkAgent(agent: ConfiguredAgent, executor: CommandExecutor): DoctorCheck[] {
  let snapshot: CapabilitySnapshot;
  try {
    snapshot = inspectAgentCapabilities(configuredAgentToDefinition(agent), {
      run: (command, args) => runAgentProbe(executor, command, args)
    });
  } catch (error) {
    return [{
      name: `agent:${agent.id}`,
      status: "invalid",
      detail: `${agent.command}: ${errorMessage(error)}`
    }];
  }

  const installation = snapshot.installation;
  const status: DoctorStatus = installation.status === "installed"
    ? "ok"
    : installation.status === "missing"
      ? "missing"
      : installation.status === "unsupported-version" ? "unsupported" : "invalid";
  const commandDetail = [
    `command=${installation.command}`,
    `adapter=${snapshot.adapterId}`,
    ...(installation.version === undefined ? [] : [`version=${installation.version}`]),
    ...(installation.reason === undefined ? [] : [`reason=${installation.reason}`])
  ].join(" ");
  const available = snapshot.fields.filter((field) => field.status === "available").length;
  const degraded = snapshot.fields.filter((field) => field.status === "degraded").length;
  const unavailable = snapshot.fields.filter((field) => field.status === "unavailable").length;
  return [
    { name: `agent:${agent.id}:command`, status, detail: commandDetail },
    {
      name: `agent:${agent.id}:capability`,
      status,
      detail: [
        `start resume interrupt nativeSession=${snapshot.lifecycle.nativeSessionDiscovery}`,
        `fields=${available}/${degraded}/${unavailable}`,
        ...snapshot.warnings.map((warning) => `warning=${warning}`)
      ].join(" ")
    }
  ];
}

function runAgentProbe(
  executor: CommandExecutor,
  command: string,
  args: readonly string[]
): AgentProbeResult {
  try {
    return { status: 0, stdout: executor.run(command, [...args]), stderr: "" };
  } catch (error) {
    const missing = isMissingCommand(error);
    const probeError = Object.assign(new Error(errorMessage(error)), {
      ...(missing ? { code: "ENOENT" } : {})
    });
    return {
      status: error instanceof CommandExecutionError ? error.exitStatus ?? null : null,
      stdout: "",
      stderr: error instanceof CommandExecutionError ? error.stderr : "",
      error: probeError
    };
  }
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof CommandExecutionError
    ? error.code === "COMMAND_NOT_FOUND"
    : systemCode(error) === "ENOENT";
}

function commandFailure(error: unknown): string {
  if (error instanceof CommandExecutionError) {
    return error.stderr.trim() || error.message;
  }
  return errorMessage(error);
}

function firstLine(output: string): string {
  return output.trim().split(/\r?\n/, 1)[0] ?? "";
}

function systemCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
