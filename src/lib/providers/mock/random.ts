/** Deterministic PRNG (mulberry32) so fixtures are stable across runs. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Day-of-week seasonality (weekends lower) and a gentle trend. */
export function seasonality(date: string, trendPerDay = 0.001, dayIndex = 0): number {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 6 ? 0.75 : 1;
  return weekend * (1 + trendPerDay * dayIndex);
}
