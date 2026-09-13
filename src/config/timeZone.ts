

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
