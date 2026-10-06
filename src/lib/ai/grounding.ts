import type { ToolEnvelope } from "@/lib/ai/tools/registry";
import type { Source } from "@/lib/websites/service";

export type ExecutedTool = { name: string; args: Record<string, unknown>; ok: boolean; envelope?: ToolEnvelope; error?: string; duration_ms: number };

export type GroundingMetadata = {
  sources: Source[];
  source_labels: string[];
  date_ranges: Array<{ start: string; end: string }>;
  comparison_ranges: Array<{ start: string; end: string }>;
  data_through: Partial<Record<Source, string | null>>;
  filters: Record<string, unknown>[];
  warnings: string[];
  tools: Array<{ name: string; args: Record<string, unknown>; ok: boolean; error?: string }>;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  /** Hallucination audit of the final answer (set by the engine). */
  audit?: { checked: boolean; supported: number; unsupported: string[]; repaired: boolean; initial_unsupported: string[] };
};

const LABELS: Record<Source, string> = { gsc: "Search Console", ga4: "GA4", ads: "Google Ads" };

/** Built from what actually executed; the model cannot influence it. */
export function buildGrounding(executed: ExecutedTool[], model: string | null, usage: GroundingMetadata["usage"]): GroundingMetadata {
  const sources = new Set<Source>();
  const ranges = new Map<string, { start: string; end: string }>();
  const comparisons = new Map<string, { start: string; end: string }>();
  const dataThrough: Partial<Record<Source, string | null>> = {};
  const filters: Record<string, unknown>[] = [];
  const warnings = new Set<string>();
  for (const t of executed) {
    const env = t.envelope;
    if (!env) continue;
    if (env.source === "gsc" || env.source === "ga4" || env.source === "ads") sources.add(env.source);
    if (env.sources_used && Array.isArray(env.sources_used)) for (const s of env.sources_used as Source[]) sources.add(s);
    if (env.date_range) ranges.set(`${env.date_range.start}|${env.date_range.end}`, env.date_range);
    if (env.comparison_range) comparisons.set(`${env.comparison_range.start}|${env.comparison_range.end}`, env.comparison_range);
    if (env.data_through) for (const [k, v] of Object.entries(env.data_through)) dataThrough[k as Source] = v;
    if (env.filters && Object.keys(env.filters).length) filters.push({ tool: t.name, ...env.filters });
    for (const w of env.warnings ?? []) warnings.add(w);
  }
  return {
    sources: [...sources],
    source_labels: [...sources].map((s) => LABELS[s]),
    date_ranges: [...ranges.values()],
    comparison_ranges: [...comparisons.values()],
    data_through: dataThrough,
    filters,
    warnings: [...warnings],
    tools: executed.map((t) => ({ name: t.name, args: t.args, ok: t.ok, error: t.error })),
    model,
    usage,
  };
}
