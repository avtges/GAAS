import { describe, it, expect } from "vitest";
import { auditAnswer } from "@/lib/ai/audit";

const tool = { totals: { clicks: 49332, impressions: 275183, ctr: 0.1793, position: 6 }, changes: { clicks: { current: 49332, previous: 50072, pct_change: -1.5 } }, date_range: { start: "2026-09-06", end: "2026-10-05" }, cost: 1234.56, cpa: 41.15 };

describe("hallucination audit", () => {
  it("accepts figures from tool output, with separators, rounding, k-suffix and ratio→percent", () => {
    const r = auditAnswer("Clicks were 49,332 (about 49.3k), down 1.5% from 50,072. CTR was 17.9% at position 6. Cost $1,234.56, CPA $41.15. Period Sep 6 to Oct 5, 2026.", [tool]);
    expect(r.unsupported).toEqual([]);
    expect(r.supported).toBeGreaterThan(5);
  });
  it("flags invented figures", () => {
    const r = auditAnswer("Conversions rose 37% to 812 and revenue hit $98,000.", [tool]);
    expect(r.unsupported).toEqual(expect.arrayContaining(["37%", "812", "$98,000"]));
  });
  it("ignores small structural integers and list markers, and allows numbers from the question", () => {
    const r = auditAnswer("1. Top 3 queries over the last 30 days:\n2. Compared with 4 weeks", [tool], ["what happened in the last 30 days?"]);
    expect(r.unsupported).toEqual([]);
  });
});
