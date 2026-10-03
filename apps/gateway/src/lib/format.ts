export function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function formatMimeType(mime: string) {
  return mime.split("/")[1]?.toUpperCase() ?? mime.toUpperCase();
}

export function formatDimensions(item: {
  width: number | null;
  height: number | null;
}) {
  return item.width && item.height ? `${item.width} × ${item.height}` : "—";
}

export const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export const dateOnly = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
];

export function timeAgo(value: string | Date) {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  for (const [unit, size] of steps)
    if (Math.abs(seconds) >= size)
      return relative.format(Math.round(seconds / size), unit);
  return "just now";
}

export function initials(value: string) {
  return value.trim().slice(0, 2).toUpperCase();
}

/** Lowercase URL-safe segment, as the API expects for keys and folder names. */
export function toKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

export function slugify(name: string) {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
