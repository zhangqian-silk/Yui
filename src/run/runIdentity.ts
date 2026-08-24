import { MAX_SESSION_TITLE_LENGTH } from "../runtime/sessionTitle.js";

/**
 * Prefixes managed launch input with the session title only. Unlike
 * continuation input, the run id lives in structured delivery metadata, the
 * launch environment (YUI_RUN_ID), and control hooks.
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
