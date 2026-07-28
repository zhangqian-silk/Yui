import type { OperatorSessionListItem } from "../operator/operatorSessionHistory.js";
import { renderTable } from "../output/table.js";
import { formatRelativeTimestamp } from "../output/timePresentation.js";
import type { SelectionIo } from "./interactiveSelection.js";

type OperatorRoleView = Readonly<{
  activeAgentId: string;
  agentBindings: Readonly<Record<string, Readonly<{
    agentId: string;
    adapterId: string;
  }>>>;
}>;

export type OperatorWizardResolution =
  | Readonly<{ kind: "unchanged"; args: string[] }>
  | Readonly<{ kind: "resolved"; args: string[] }>
  | Readonly<{ kind: "cancelled"; args: string[] }>;

export async function resolveOperatorWizardArguments(
  commandArgs: readonly string[],
  role: OperatorRoleView | null,
  sessions: readonly OperatorSessionListItem[],
  io: SelectionIo,
  now = new Date()
): Promise<OperatorWizardResolution> {
  const args = [...commandArgs];
  if (!io.interactive || io.json || role === null || args[0] !== "operator") {
    return { kind: "unchanged", args };
  }
  if (args[1] === "new" && args.length === 2) {
    const bindings = Object.values(role.agentBindings);
    if (bindings.length === 0) return { kind: "unchanged", args };
    const selected = bindings.length === 1
      ? bindings[0]?.agentId
      : await choose(
          "Select Operator Agent",
          bindings.map((binding) => ({
            value: binding.agentId,
            cells: [
              adapterLabel(binding.adapterId),
              binding.agentId,
              binding.agentId === role.activeAgentId ? "active" : "bound"
            ]
          })),
          [
            { header: "Adapter", minWidth: 7, maxWidth: 12 },
            { header: "Agent", minWidth: 6, maxWidth: 24 },
            { header: "State", minWidth: 6, maxWidth: 8 }
          ],
          io,
          role.activeAgentId,
          "Agent"
        );
    return selected === undefined
      ? { kind: "cancelled", args }
      : { kind: "resolved", args: [...args, "--agent", selected] };
  }
  if (args[1] === "resume" && args.length === 2) {
    const newSession = "__operator_new_session__";
    const selected = await choose(
      "Resume an Operator session",
      [
        ...sessions.map((session) => ({
          value: session.ref,
          cells: [
            formatRelativeTimestamp(session.updatedAt, now),
            adapterLabel(session.adapterId),
            session.displayTitle,
            session.state
          ]
        })),
        {
          value: newSession,
          cells: ["", "", "Start a new session", "new"]
        }
      ],
      [
        { header: "Updated", minWidth: 7, maxWidth: 12 },
        { header: "Agent", minWidth: 6, maxWidth: 12 },
        { header: "Conversation", minWidth: 20, maxWidth: 64 },
        { header: "State", minWidth: 7, maxWidth: 10 }
      ],
      io,
      sessions[0]?.ref ?? newSession,
      "session"
    );
    if (selected === newSession) {
      return resolveOperatorWizardArguments(
        ["operator", "new"],
        role,
        sessions,
        io,
        now
      );
    }
    return selected === undefined
      ? { kind: "cancelled", args }
      : { kind: "resolved", args: [...args, selected] };
  }
  return { kind: "unchanged", args };
}

async function choose(
  title: string,
  choices: readonly Readonly<{ value: string; cells: readonly string[] }>[],
  columns: readonly Readonly<{ header: string; minWidth: number; maxWidth: number }>[],
  io: SelectionIo,
  defaultValue: string | undefined,
  label: string
): Promise<string | undefined> {
  if (choices.length === 0) {
    io.write("○ No Operator sessions are available.\n");
    return undefined;
  }
  io.write(`${renderTable(
    title,
    [{ header: "#", minWidth: 1, maxWidth: 4 }, ...columns],
    choices.map((choice, index) => [String(index + 1), ...choice.cells]),
    io.width
  )}\n\n`);
  const answer = (await io.question(
    `Choose ${label} [1-${choices.length}/value, q]: `
  ))?.trim();
  if (answer === undefined || answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
    return undefined;
  }
  if (answer.length === 0) {
    return choices.find((choice) => choice.value === defaultValue)?.value
      ?? choices[0]?.value;
  }
  const index = Number(answer);
  if (Number.isSafeInteger(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1]?.value;
  }
  return choices.find((choice) => choice.value === answer)?.value;
}

function adapterLabel(adapterId: string): string {
  return adapterId === "codex"
    ? "Codex"
    : adapterId === "claude"
      ? "Claude"
      : adapterId;
}
