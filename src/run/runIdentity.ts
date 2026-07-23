const RUN_MARKER = "Yui-Run-Id:";

/** Adds the causal token consumed by the native Turn-complete Hook. */
export function markYuiRunInput(input: string, runId: string): string {
  const text = input
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !line.startsWith(`${RUN_MARKER} `))
    .join("\n")
    .trim();
  const id = requireRunId(runId);
  if (text.length === 0) throw new Error("Run input is required.");
  return `${RUN_MARKER} ${id}\n\n${text}`;
}

/** Reads the last Yui Run marker from Codex's structured input-messages. */
export function yuiRunIdFromInputMessages(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  let found: string | undefined;
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    for (const line of entry.replace(/\r/g, "").split("\n")) {
      if (!line.startsWith(`${RUN_MARKER} `)) continue;
      try {
        found = requireRunId(line.slice(RUN_MARKER.length + 1));
      } catch {
        // A malformed user-authored lookalike is not a Yui causal token.
      }
    }
  }
  return found;
}

function requireRunId(value: string): string {
  const id = value.trim();
  if (
    id.length === 0
    || id.length > 1_024
    || ["__proto__", "prototype", "constructor", ".", ".."].includes(id)
    || /[\/\\\0\s]/.test(id)
  ) {
    throw new Error("Run id is invalid.");
  }
  return id;
}
