export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-03 14:02:11" in UTC, for sim time. */
export function formatSimTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** "14:02:11" in UTC, for log timestamps. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** "3h 12m", "4m 05s", for countdowns. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s)}s`;
}

export function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}`;
}

export function formatLon(lon: number): string {
  return `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;
}

export function formatAltitude(m: number): string {
  if (m >= 10_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m).toLocaleString("en-US")} m`;
}

/**
 * One shared empty array for store selectors. A selector that returns a fresh
 * [] each time looks like a change on every render and can loop forever.
 */
export const NONE: readonly never[] = Object.freeze([]);
