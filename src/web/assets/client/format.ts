export const FORMAT_SCRIPT = `
// Date / time formatting helpers shared by cards and views.
export function relativeTime(iso, locale, t) {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || Math.abs(seconds) < 45) return t("time.justNow");
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60]
  ];
  const selected = units.find(function (entry) { return Math.abs(seconds) >= entry[1]; }) || ["second", 1];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(seconds / selected[1]),
    selected[0]
  );
}

export function formatDateTime(iso, locale) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function byNewest(left, right) {
  return Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt);
}
`;
