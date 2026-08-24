import { MAX_SESSION_TITLE_LENGTH } from "../runtime/sessionTitle.js";

/**
 * Prefixes managed launch input with its session title. The bootstrap body
 * exposes the exact current Run identity to the Agent, while structured
 * delivery metadata and control hooks retain the delivery fence.
 */
export function prefixYuiTitleInput(
  input: string,
  title: string
): string {
  const text = input.replace(/\r/g, "").trim();
  if (text.length === 0) throw new Error("Managed input body is required.");
  return `${requireRunTitle(title)}\n\n${text}`;
}

function requireRunTitle(value: string): string {
  const title = value.trim();
  if (
    title.length === 0
    || title.length > MAX_SESSION_TITLE_LENGTH
    || /[\r\n\0]/u.test(title)
    || !title.startsWith("Yui ")
  ) {
    throw new Error("Run title is invalid.");
  }
  return title;
}
