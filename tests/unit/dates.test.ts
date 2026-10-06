import { describe, it, expect } from "vitest";
import { addDays, chunkRange, daysInclusive, isIsoDate, previousPeriod, todayInTimeZone } from "@/lib/dates";

describe("date helpers", () => {
  it("validates ISO dates", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
  });
  it("adds days across month/year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("computes inclusive day counts and previous periods", () => {
    expect(daysInclusive("2026-09-01", "2026-09-30")).toBe(30);
    expect(previousPeriod("2026-09-01", "2026-09-30")).toEqual({ start: "2026-08-02", end: "2026-08-31" });
  });
  it("chunks ranges", () => {
    expect(chunkRange("2026-01-01", "2026-01-25", 10)).toEqual([
      { start: "2026-01-01", end: "2026-01-10" },
      { start: "2026-01-11", end: "2026-01-20" },
      { start: "2026-01-21", end: "2026-01-25" },
    ]);
  });
  it("resolves today in a time zone", () => {
    const now = new Date("2026-10-06T05:00:00Z"); // 22:00 PDT on Oct 5
    expect(todayInTimeZone("America/Los_Angeles", now)).toBe("2026-10-05");
    expect(todayInTimeZone("UTC", now)).toBe("2026-10-06");
  });
});
