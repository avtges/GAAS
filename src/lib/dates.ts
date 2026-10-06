/** Date helpers. All "dates" are ISO `YYYY-MM-DD` strings; no Date-object time zones leak out. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function fromIsoDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(s: string, days: number): string {
  const d = fromIsoDate(s);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** Inclusive day count between two ISO dates (end - start + 1). */
export function daysInclusive(start: string, end: string): number {
  return Math.round((fromIsoDate(end).getTime() - fromIsoDate(start).getTime()) / 86_400_000) + 1;
}

export function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minIso(a: string, b: string): string {
  return a < b ? a : b;
}
export function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

/** Today's calendar date in an IANA time zone. */
export function todayInTimeZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function* eachDay(start: string, end: string): Generator<string> {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}

export function chunkRange(start: string, end: string, size: number): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  for (let s = start; s <= end; s = addDays(s, size)) {
    const e = minIso(addDays(s, size - 1), end);
    out.push({ start: s, end: e });
  }
  return out;
}

/** The period of equal length immediately preceding [start, end]. */
export function previousPeriod(start: string, end: string): { start: string; end: string } {
  const n = daysInclusive(start, end);
  return { start: addDays(start, -n), end: addDays(start, -1) };
}
