export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export function resolveTimeZone(value?: unknown): string {
  const timeZone = value ?? DEFAULT_TIME_ZONE;
  if (typeof timeZone !== "string" || timeZone.trim() !== timeZone || timeZone.length === 0) {
    throw new TypeError("timeZone must be a valid IANA timezone.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new TypeError("timeZone must be a valid IANA timezone.");
  }
  return timeZone;
}

/** Formats persisted UTC/RFC 3339 timestamps for human-facing CLI output. */
export function formatTimestamp(value: string, configuredTimeZone?: unknown): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new TypeError("Timestamp is invalid.");
  const timeZone = resolveTimeZone(configuredTimeZone);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset"
  }).formatToParts(instant).map(({ type, value: part }) => [type, part]));
  const offset = parts.timeZoneName === "GMT"
    ? "+00:00"
    : parts.timeZoneName?.replace(/^GMT/, "");
  if (offset === undefined) throw new TypeError("Timezone offset is unavailable.");
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`;
}
