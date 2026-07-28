const TITLE_SEPARATOR = " · ";
export const MAX_SESSION_TITLE_LENGTH = 160;

type TaskSessionIdentity = Readonly<{
  id: string;
  title: string;
}>;

export function taskRoleSessionTitle(
  task: TaskSessionIdentity,
  roleName: string
): string {
  return sessionTitle(["Yui", task.id, task.title, roleLabel(roleName)]);
}

export function executionAttemptSessionTitle(
  task: TaskSessionIdentity,
  workItemTitle: string,
  profileId: string
): string {
  return sessionTitle(["Yui", task.id, task.title, workItemTitle, profileId]);
}

function sessionTitle(segments: readonly string[]): string {
  const normalized = segments.map(normalizeSegment);
  const full = normalized.join(TITLE_SEPARATOR);
  if (full.length <= MAX_SESSION_TITLE_LENGTH) return full;

  const tail = truncate(normalized.at(-1)!, 48);
  const head = normalized.slice(0, -1).join(TITLE_SEPARATOR);
  const headLength =
    MAX_SESSION_TITLE_LENGTH - TITLE_SEPARATOR.length - tail.length - 1;
  if (headLength < 1) return truncate(full, MAX_SESSION_TITLE_LENGTH);
  return `${truncate(head, headLength)}…${TITLE_SEPARATOR}${tail}`;
}

function normalizeSegment(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Session title segment is invalid.");
  }
  const normalized = value
    .replaceAll(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
  if (normalized.length === 0) throw new Error("Session title segment is required.");
  return normalized;
}

function roleLabel(roleName: string): string {
  const normalized = normalizeSegment(roleName);
  if (normalized === "leader") return "Leader";
  if (normalized === "operator") return "Operator";
  return normalized;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = maxLength;
  if (
    end > 0
    && end < value.length
    && isHighSurrogate(value.charCodeAt(end - 1))
    && isLowSurrogate(value.charCodeAt(end))
  ) end -= 1;
  return value.slice(0, end);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}
