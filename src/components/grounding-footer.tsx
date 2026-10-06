import type { GroundingMetadata } from "@/lib/ai/grounding";

function fmt(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
const range = (r: { start: string; end: string }) => `${fmt(r.start)} – ${fmt(r.end)}`;

export function GroundingFooter({ metadata }: { metadata: GroundingMetadata }) {
  const dt = Object.entries(metadata.data_through).filter(([, v]) => v);
  const LABEL: Record<string, string> = { gsc: "Search Console", ga4: "GA4", ads: "Google Ads" };
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500">
      <dt>Sources</dt>
      <dd>{metadata.source_labels.length ? metadata.source_labels.join(", ") : "none (no data tools used)"}</dd>
      {metadata.date_ranges.length > 0 && (
        <>
          <dt>Period</dt>
          <dd>{metadata.date_ranges.map(range).join("; ")}</dd>
        </>
      )}
      {metadata.comparison_ranges.length > 0 && (
        <>
          <dt>Compared with</dt>
          <dd>{metadata.comparison_ranges.map(range).join("; ")}</dd>
        </>
      )}
      {dt.length > 0 && (
        <>
          <dt>Data through</dt>
          <dd>{dt.map(([k, v]) => `${LABEL[k] ?? k}: ${fmt(v!)}`).join(" · ")}</dd>
        </>
      )}
      {metadata.filters.length > 0 && (
        <>
          <dt>Filters</dt>
          <dd>
            {metadata.filters
              .map((f) =>
                Object.entries(f)
                  .filter(([k, v]) => k !== "tool" && v !== null && v !== "all" && v !== "none" && v !== 0)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(", "),
              )
              .filter(Boolean)
              .join("; ") || "none"}
          </dd>
        </>
      )}
      {metadata.warnings.length > 0 && (
        <>
          <dt>Caveats</dt>
          <dd>{metadata.warnings.join(" ")}</dd>
        </>
      )}
      {metadata.tools.some((t) => !t.ok) && (
        <>
          <dt>Tool errors</dt>
          <dd className="text-red-600">{metadata.tools.filter((t) => !t.ok).map((t) => `${t.name}: ${t.error}`).join("; ")}</dd>
        </>
      )}
    </dl>
  );
}
