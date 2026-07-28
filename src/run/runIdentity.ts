import { MAX_SESSION_TITLE_LENGTH } from "../runtime/sessionTitle.js";

const TITLED_RUN_SEPARATOR = " · Run ";

/** Adds the causal token consumed by the native Turn-complete Hook. */
export function markYuiRunInput(
  input: string,
  runId: string,
  title: string
): string {
  const text = input.replace(/\r/g, "").trim();
  return managedRunInput(text, runId, title);
}

/** Replaces the causal token on an input already owned by a persisted Yui Run. */
export function retagYuiRunInput(
  input: string,
  runId: string,
  title: string
): string {
  const lines = input.replace(/\r/g, "").split("\n");
  if (
    lines.length < 3
    || lines[1] !== ""
    || runIdFromHeader(lines[0]!) === undefined
  ) {
    throw new Error("Managed Run input header is required.");
  }
  return managedRunInput(lines.slice(2).join("\n").trim(), runId, title);
}

function managedRunInput(text: string, runId: string, title: string): string {
  const id = requireRunId(runId);
  if (text.length === 0) throw new Error("Run input is required.");
  return `${requireRunTitle(title)}${TITLED_RUN_SEPARATOR}${id}\n\n${text}`;
}

/** Reads the last managed Yui header from Codex's structured input-messages. */
export function yuiRunIdFromInputMessages(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  let found: string | undefined;
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const lines = entry.replace(/\r/g, "").split("\n");
    if (lines.length < 3 || lines[1] !== "") continue;
    const runId = runIdFromHeader(lines[0]!);
    if (runId !== undefined) found = runId;
  }
  return found;
}

/** Removes only a valid managed Run header, preserving user-authored lookalikes. */
export function yuiRunBodyFromInputMessage(value: string): string {
  const lines = value.replace(/\r/g, "").trim().split("\n");
  return lines.length >= 3
    && lines[1] === ""
    && runIdFromHeader(lines[0]!) !== undefined
    ? lines.slice(2).join("\n")
    : lines.join("\n");
}

function runIdFromHeader(line: string): string | undefined {
  const separator = line.lastIndexOf(TITLED_RUN_SEPARATOR);
  if (separator > 0) {
    try {
      requireRunTitle(line.slice(0, separator));
      return requireRunId(line.slice(separator + TITLED_RUN_SEPARATOR.length));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requireRunTitle(value: string): string {
  const title = value.trim();
  if (
    title.length === 0
    || title.length > MAX_SESSION_TITLE_LENGTH
    || !title.startsWith("Yui · ")
    || /[\r\n\0]/u.test(title)
  ) {
    throw new Error("Run title is invalid.");
  }
  return title;
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
