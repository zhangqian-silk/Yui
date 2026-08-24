const TITLE_SEPARATOR = " · ";
export const MAX_SESSION_TITLE_LENGTH = 80;
const TASK_TITLE_MAX_LENGTH = 20;

type TaskSessionIdentity = Readonly<{
  id: string;
  title: string;
}>;

export function taskRoleSessionTitle(
  task: TaskSessionIdentity,
  roleName: string
): string {
  const prefix = `Yui ${roleLabel(roleName)} ${normalizeSegment(task.id)}`;
  const title = displayTitle(normalizeSegment(task.title), TASK_TITLE_MAX_LENGTH);
  const full = `${prefix}${TITLE_SEPARATOR}${title}`;
  if (full.length <= MAX_SESSION_TITLE_LENGTH) return full;
  if (prefix.length + TITLE_SEPARATOR.length + 1 > MAX_SESSION_TITLE_LENGTH) {
    return truncate(prefix, MAX_SESSION_TITLE_LENGTH);
  }
  const titleLength =
    MAX_SESSION_TITLE_LENGTH - prefix.length - TITLE_SEPARATOR.length - 1;
  return `${prefix}${TITLE_SEPARATOR}${displayTitle(title, Math.max(titleLength, 1))}`;
}

export function resolveTaskRoleSessionTitle(
  existingTitle: string | undefined,
  task: TaskSessionIdentity,
  roleName: string
): string {
  if (
    existingTitle !== undefined
    && existingTitle.length > 0
    && existingTitle.length <= MAX_SESSION_TITLE_LENGTH
    && !/[\r\n\0]/u.test(existingTitle)
  ) {
    return existingTitle;
  }
  return taskRoleSessionTitle(task, roleName);
}

function displayTitle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${truncate(value, maxLength - 1)}…`;
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
