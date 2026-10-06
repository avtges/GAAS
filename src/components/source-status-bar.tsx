import Link from "next/link";
import type { WebsiteSource } from "@/lib/websites/service";

const LABELS: Record<WebsiteSource["source"], string> = { gsc: "Search Console", ga4: "GA4", ads: "Google Ads" };

function fmtTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const DOT: Record<WebsiteSource["status"], string> = {
  ok: "bg-emerald-500",
  syncing: "bg-sky-500 animate-pulse",
  error: "bg-red-500",
  revoked: "bg-red-500",
  disconnected: "bg-zinc-400",
  not_configured: "bg-zinc-300",
};

export function SourceStatusBar({ websiteId, sources }: { websiteId: string; sources: WebsiteSource[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {sources.map((s) => (
        <Link key={s.source} href={`/app/w/${websiteId}/connections`} className="flex items-center gap-2 rounded border border-zinc-200 px-2 py-1 hover:bg-zinc-50" title={s.last_error ?? undefined}>
          <span className={`inline-block h-2 w-2 rounded-full ${DOT[s.status]}`} />
          <span className="font-medium">{LABELS[s.source]}</span>
          {s.status === "not_configured" ? (
            <span className="text-zinc-500">not connected</span>
          ) : s.status === "revoked" || s.status === "disconnected" ? (
            <span className="text-red-700">{s.status}</span>
          ) : (
            <span className="text-zinc-500">
              synced {fmtTime(s.last_sync_succeeded_at)} · data through {fmtDate(s.data_through)}
              {s.status === "error" && <span className="text-red-700"> · error</span>}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
