import { usageError } from "../errors/cliError.js";
import {
  createRoleSessionSet,
  type GlobalRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  listOperatorSessions,
  prepareOperatorNewSession,
  prepareOperatorResumeSession
} from "../operator/operatorSessionHistory.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatRelativeTimestamp } from "../output/timePresentation.js";
import { updateGlobalRole, type GlobalRole } from "../role/role.js";
import {
  submitOperatorMessage,
  type TaskCommandExecution,
  type TaskCommandOptions,
  type TaskWorkflowStore
} from "./taskCommands.js";

export type OperatorSessionControl =
  | Readonly<{
      kind: "session";
      action: "new";
      targetAgentId: string;
    }>
  | Readonly<{
      kind: "session";
      action: "resume";
      targetAgentId: string;
      ref: string;
    }>;

export type OperatorCommandExecution = TaskCommandExecution | OperatorSessionControl;

export type OperatorCommandOptions = TaskCommandOptions & Readonly<{
  width?: number;
}>;

/** Operator command parsing never launches or attaches a native process. */
export function runOperatorCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: OperatorCommandOptions = {}
): OperatorCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "list": return listSessions(rest, store, options);
    case "new": return newSession(rest, store);
    case "resume": return resumeSession(rest, store);
    case "submit": return submit(rest, store, options);
    default:
      throw usageError(command === undefined
        ? "Operator command is required."
        : `Unknown command: operator ${command}`);
  }
}

function submit(
  rest: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Operator submit usage: yui operator submit <body> [--task <id>].";
  const positionals: string[] = [];
  let taskId: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value !== "--task") {
      if (value.startsWith("--")) throw usageError(`Unsupported option: ${value}.`, usage);
      positionals.push(value);
      continue;
    }
    if (taskId !== undefined) throw usageError("Option may only be specified once: --task.", usage);
    const candidate = rest[index + 1];
    if (candidate === undefined || candidate.startsWith("--")) {
      throw usageError("--task is required.", usage);
    }
    taskId = candidate.trim();
    index += 1;
  }
  if (positionals.length !== 1 || positionals[0].trim().length === 0) {
    throw usageError(usage);
  }
  return {
    kind: "output",
    output: submitOperatorMessage(positionals[0], taskId, store, options)
  };
}

function listSessions(
  args: string[],
  store: TaskWorkflowStore,
  options: OperatorCommandOptions
): TaskCommandExecution {
  if (args.length !== 0) throw usageError("Operator list usage: yui operator list.");
  const sessions = listOperatorSessions(store.getGlobalRoleSessionSet("operator"));
  const now = options.now?.() ?? new Date();
  const output = sessions.length === 0
    ? "○ No Operator sessions are available.\n"
    : `${renderTable(
        "Operator sessions",
        [
          { header: "Updated", minWidth: 7, maxWidth: 12 },
          { header: "Agent", minWidth: 6, maxWidth: 16 },
          { header: "Conversation", minWidth: 20, maxWidth: 72 },
          { header: "State", minWidth: 7, maxWidth: 10 }
        ],
        sessions.map((session) => [
          formatRelativeTimestamp(session.updatedAt, now),
          adapterLabel(session.adapterId),
          session.displayTitle,
          session.state
        ]),
        options.width ?? defaultTableWidth()
      )}\n\n${sessions.length} session${sessions.length === 1 ? "" : "s"}\n`;
  return {
    kind: "output",
    output,
    data: { sessions }
  };
}

function newSession(
  args: string[],
  store: TaskWorkflowStore
): OperatorSessionControl {
  let agentId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value !== "--agent") {
      throw usageError(
        value.startsWith("--")
          ? `Unsupported option: ${value}.`
          : `Unexpected argument: ${value}.`,
        "Operator new usage: yui operator new [--agent <id>]."
      );
    }
    if (agentId !== undefined) throw usageError("Option may only be specified once: --agent.");
    agentId = requiredValue(args[index + 1], "--agent");
    index += 1;
  }
  const role = requireOperator(store);
  const targetAgentId = agentId ?? role.activeAgentId;
  if (!Object.hasOwn(role.agentBindings, targetAgentId)) {
    throw usageError(`Operator Agent is not bound: ${targetAgentId}.`);
  }
  return { kind: "session", action: "new", targetAgentId };
}

function resumeSession(
  args: string[],
  store: TaskWorkflowStore
): OperatorSessionControl {
  let ref: string | undefined;
  let last = false;
  for (const value of args) {
    if (value === "--last") {
      if (last) throw usageError("Option may only be specified once: --last.");
      last = true;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unsupported option: ${value}.`);
    if (ref !== undefined) {
      throw usageError("Operator resume accepts only one session reference.");
    }
    ref = value;
  }
  if (last && ref !== undefined) {
    throw usageError("Operator resume accepts either a session reference or --last.");
  }
  const sessions = listOperatorSessions(store.getGlobalRoleSessionSet("operator"));
  const selectedRef = last ? sessions[0]?.ref : ref;
  if (selectedRef === undefined) {
    throw usageError(last
      ? "No Operator session is available to resume."
      : "Operator resume requires a session selection.");
  }
  const selected = sessions.find((session) => session.ref === selectedRef);
  if (selected === undefined) throw usageError(`Operator session not found: ${selectedRef}.`);
  const role = requireOperator(store);
  if (!Object.hasOwn(role.agentBindings, selected.agentId)) {
    throw usageError(`Operator session Agent is no longer bound: ${selected.agentId}.`);
  }
  return {
    kind: "session",
    action: "resume",
    targetAgentId: selected.agentId,
    ref: selected.ref
  };
}

export function applyOperatorSessionControl(
  control: OperatorSessionControl,
  store: TaskWorkflowStore,
  now = new Date()
): Readonly<{ role: GlobalRole; sessions: GlobalRoleSessionSet }> {
  return store.transaction((tx) => {
    const role = requireOperator(tx);
    const binding = role.agentBindings[control.targetAgentId];
    if (binding === undefined) {
      throw usageError(`Operator Agent is not bound: ${control.targetAgentId}.`);
    }
    const current = tx.getGlobalRoleSessionSet(role.name)
      ?? createRoleSessionSet(
        { scope: "global", roleName: role.name },
        role.activeAgentId,
        now
      );
    const sessions = control.action === "new"
      ? prepareOperatorNewSession(current, control.targetAgentId, now)
      : prepareOperatorResumeSession(current, control.ref, now);
    const selected = sessions.sessions[control.targetAgentId];
    if (selected !== undefined && selected.adapterId !== binding.adapterId) {
      throw usageError(
        `Operator session adapter does not match Agent: ${control.targetAgentId}.`
      );
    }
    const updatedRole = updateGlobalRole(
      role,
      { activeAgentId: control.targetAgentId },
      now
    );
    tx.saveGlobalRoleWithSessionSet(updatedRole, sessions);
    return { role: updatedRole, sessions };
  });
}

function requireOperator(store: TaskWorkflowStore): GlobalRole {
  const role = store.getGlobalRole("operator");
  if (role === null) throw usageError("Operator is not configured. Run yui setup first.");
  return role;
}

function adapterLabel(adapterId: string): string {
  return adapterId === "codex"
    ? "Codex"
    : adapterId === "claude"
      ? "Claude"
      : adapterId;
}

function requiredValue(value: string | undefined, option: string): string {
  if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
    throw usageError(`${option} is required.`);
  }
  return value.trim();
}
