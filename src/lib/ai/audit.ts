/**
 * Hallucination audit for assistant answers.
 *
 * Every numeric figure in the answer must be traceable to a tool result (allowing for
 * rounding, thousand separators, k/M suffixes and ratio→percent conversion) or to the
 * user's question. Anything else is reported as unsupported. The engine uses this to
 * trigger one repair round and to label answers that still contain unverified figures.
 */
export type AuditResult = { checked: boolean; supported: number; unsupported: string[] };

const NUMBER_RE = /(?<![\w.])[-−]?\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?[kKmM]?%?|(?<![\w.])[-−]?\$?\d+(?:\.\d+)?[kKmM]?%?/g;

function parseFigure(token: string): number | null {
  let t = token.replace(/[$,]/g, "").replace("−", "-");
  const pct = t.endsWith("%");
  if (pct) t = t.slice(0, -1);
  let mult = 1;
  if (/[kK]$/.test(t)) {
    mult = 1_000;
    t = t.slice(0, -1);
  } else if (/[mM]$/.test(t)) {
    mult = 1_000_000;
    t = t.slice(0, -1);
  }
  const v = Number(t);
  return Number.isFinite(v) ? v * mult : null;
}

/** Collects every number present in tool outputs, including numbers embedded in strings (dates, ids). */
export function collectNumbers(value: unknown, out: Set<number> = new Set()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.add(value);
  } else if (typeof value === "string") {
    for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
  return out;
}

function candidates(values: Set<number>): number[] {
  const out = new Set<number>();
  for (const v of values) {
    out.add(v);
    out.add(Math.abs(v));
    // ratios such as CTR 0.0428 are commonly written as 4.3%
    if (Math.abs(v) <= 1) out.add(Math.abs(v) * 100);
  }
  return [...out];
}

function supportedBy(a: number, cands: number[]): boolean {
  const abs = Math.abs(a);
  for (const c of cands) {
    const tol = Math.max(0.01 * Math.abs(c), 0.051);
    if (Math.abs(abs - Math.abs(c)) <= tol) return true;
  }
  return false;
}

export function auditAnswer(answer: string, toolOutputs: unknown[], extraText: string[] = []): AuditResult {
  const values = collectNumbers(toolOutputs);
  for (const t of extraText) collectNumbers(t, values);
  const cands = candidates(values);
  const unsupported: string[] = [];
  let supported = 0;
  // Ignore markdown list markers ("1. ") and ordinal structure words.
  const text = answer.replace(/^\s*\d+\.\s/gm, " ");
  for (const m of text.matchAll(NUMBER_RE)) {
    const token = m[0];
    const v = parseFigure(token);
    if (v === null) continue;
    // Small integers are structural ("top 5", "4 weeks", "2 campaigns") and not metrics.
    if (Number.isInteger(v) && Math.abs(v) <= 10 && !token.includes("%") && !token.includes("$")) continue;
    if (supportedBy(v, cands)) supported++;
    else unsupported.push(token);
  }
  return { checked: true, supported, unsupported: [...new Set(unsupported)] };
}
