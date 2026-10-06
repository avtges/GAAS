import { describe, it, expect } from "vitest";
import { change, comparisonRange, parseRange, pctChange, safeDiv, smallSampleWarning } from "@/lib/analytics/common";
import { expectedCtrForPosition, opportunityScore } from "@/lib/analytics/gsc";

describe("analytics calculations", () => {
  it("percentage change guards against zero and rounds", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(3, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
    expect(pctChange(1, 3)).toBe(-66.7);
  });
  it("safe division returns null for zero denominators", () => {
    expect(safeDiv(10, 0)).toBeNull();
    expect(safeDiv(10, 4)).toBe(2.5);
  });
  it("change objects carry current/previous/abs/pct", () => {
    expect(change(3, 1, 0)).toEqual({ current: 3, previous: 1, change: 2, pct_change: 200 });
  });
  it("small sample warnings fire below the threshold", () => {
    expect(smallSampleWarning("Conversions", 3, 1)).toMatch(/small count \(3 vs 1\)/);
    expect(smallSampleWarning("Conversions", 300, 120)).toBeNull();
  });
  it("validates and bounds date ranges", () => {
    expect(parseRange({ start_date: "2026-09-01", end_date: "2026-09-30" })).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(() => parseRange({ start_date: "2026-09-30", end_date: "2026-09-01" })).toThrow(/before/);
    expect(() => parseRange({ start_date: "2024-01-01", end_date: "2026-09-01" })).toThrow(/exceed/);
    expect(() => parseRange({ start_date: "2026-02-30", end_date: "2026-03-01" })).toThrow(/valid/);
    expect(comparisonRange({ start: "2026-09-01", end: "2026-09-30" })).toEqual({ start: "2026-08-02", end: "2026-08-31" });
  });
  it("opportunity score is zero for tiny samples and grows with the CTR gap", () => {
    expect(expectedCtrForPosition(1)).toBeGreaterThan(expectedCtrForPosition(5));
    expect(expectedCtrForPosition(20)).toBeLessThan(expectedCtrForPosition(10));
    expect(opportunityScore({ impressions: 10, ctr: 0, position: 3 })).toBe(0);
    const low = opportunityScore({ impressions: 1000, ctr: 0.01, position: 3 });
    const ok = opportunityScore({ impressions: 1000, ctr: 0.1, position: 3 });
    expect(low).toBeGreaterThan(ok);
    expect(ok).toBe(0);
  });
});
