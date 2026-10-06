import { z } from "zod";
import { daysInclusive, isIsoDate, previousPeriod } from "@/lib/dates";
import { badRequest } from "@/lib/errors";

export const MAX_RANGE_DAYS = 400;

export const DateRangeInput = z.object({
  start_date: z.string().describe("Inclusive start date, YYYY-MM-DD"),
  end_date: z.string().describe("Inclusive end date, YYYY-MM-DD"),
});
export type DateRange = { start: string; end: string };

export function parseRange(input: { start_date: string; end_date: string }): DateRange {
  if (!isIsoDate(input.start_date) || !isIsoDate(input.end_date)) throw badRequest("Dates must be valid YYYY-MM-DD values.");
  if (input.start_date > input.end_date) throw badRequest("start_date must be on or before end_date.");
  if (daysInclusive(input.start_date, input.end_date) > MAX_RANGE_DAYS) throw badRequest(`Date range may not exceed ${MAX_RANGE_DAYS} days.`);
  return { start: input.start_date, end: input.end_date };
}

export function comparisonRange(range: DateRange): DateRange {
  return previousPeriod(range.start, range.end);
}

/** Percentage change; null when the previous value is zero (undefined, not infinite). */
export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round(((current - previous) / Math.abs(previous)) * 100, 1);
}

export function safeDiv(numerator: number, denominator: number): number | null {
  if (!denominator || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  return numerator / denominator;
}

export function round(n: number | null, digits = 2): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export type Change = { current: number; previous: number; change: number; pct_change: number | null };

export function change(current: number, previous: number, digits = 2): Change {
  return { current: round(current, digits)!, previous: round(previous, digits)!, change: round(current - previous, digits)!, pct_change: pctChange(current, previous) };
}

/** Flags comparisons that rest on tiny counts so the model discloses them. */
export const SMALL_SAMPLE_THRESHOLD = 20;

export function smallSampleWarning(label: string, ...counts: number[]): string | null {
  const min = Math.min(...counts);
  if (!Number.isFinite(min) || min >= SMALL_SAMPLE_THRESHOLD) return null;
  return `${label} is based on a small count (${counts.map((c) => Math.round(c)).join(" vs ")}); percentage changes are not reliable.`;
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
