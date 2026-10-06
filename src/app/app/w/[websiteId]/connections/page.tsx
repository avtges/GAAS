// Server actions on this page can run a background sync (and chat calls the AI model).
export const maxDuration = 300;

import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { listWebsiteSources, requireWebsiteAccess, type WebsiteSource } from "@/lib/websites/service";
import { connectionProducts, getWebsiteConnection } from "@/lib/google/connections";
import { ConfirmForm } from "@/components/confirm-form";
import { disconnectGoogleAction, syncNowAction } from "./actions";
import { listRecentSyncJobs } from "@/lib/sources/select";
import { getEnv } from "@/lib/env";

const ERRORS: Record<string, string> = {
  oauth_state: "The sign-in attempt expired or was tampered with. Please try again.",
  oauth_user_mismatch: "The Google sign-in was started by a different user session.",
  oauth_denied: "You declined access in Google. No changes were made.",
  oauth_error: "Google returned an error during sign-in. Please try again.",
  oauth_no_refresh_token: "Google did not issue a refresh token. Remove this app from your Google account permissions (myaccount.google.com/permissions) and connect again.",
};

const PRODUCT_LABEL = { gsc: "Google Search Console", ga4: "Google Analytics 4", ads: "Google Ads" } as const;

function selectionFor(source: WebsiteSource["source"], w: { gsc_property: string | null; ga4_property_id: string | null; google_ads_customer_id: string | null }) {
  if (source === "gsc") return w.gsc_property;
  if (source === "ga4") return w.ga4_property_id ? `properties/${w.ga4_property_id}` : null;
  return w.google_ads_customer_id;
}

export default async function ConnectionsPage({ params, searchParams }: PageProps<"/app/w/[websiteId]/connections">) {
  const user = await requireUser();
  const { websiteId } = await params;
  const sp = await searchParams;
  const { website, role } = await requireWebsiteAccess(user.id, websiteId);
  const sources = await listWebsiteSources(user.id, websiteId);
  const connection = await getWebsiteConnection(user.id, websiteId);
  const jobs = await listRecentSyncJobs(user.id, websiteId, 8);
  const granted = connectionProducts(connection);
  const isAdmin = role === "owner" || role === "admin";
  const env = getEnv();
  const error = typeof sp.error === "string" ? ERRORS[sp.error] ?? ERRORS.oauth_error : null;
  const partial = typeof sp.partial === "string" ? sp.partial.split(",") : [];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-8">
      <div>
        <h2 className="text-lg font-semibold">Connections</h2>
        <p className="text-sm text-zinc-600">One Google account can grant access to all three products. Each product also needs you to choose which property or account belongs to this website.</p>
      </div>

      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {sp.connected === "1" && !partial.length && <p className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">Google connected.</p>}
      {partial.length > 0 && (
        <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Google connected, but access was not granted for: {partial.map((p) => PRODUCT_LABEL[p as keyof typeof PRODUCT_LABEL] ?? p).join(", ")}. Use &ldquo;Grant access&rdquo; below.
        </p>
      )}
      {env.GOOGLE_PROVIDER_MODE === "mock" && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">Mock mode: Google is simulated with fixture data.</p>}

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-semibold">Google account</h3>
        {connection ? (
          <div className="mt-2 text-sm">
            <p>
              <span className="font-medium">{connection.google_email ?? connection.google_user_id}</span>{" "}
              <span className={connection.status === "active" ? "text-emerald-700" : "text-red-700"}>({connection.status})</span>
            </p>
            {connection.last_error && <p className="text-xs text-red-700">{connection.last_error}</p>}
            {connection.status === "revoked" && isAdmin && (
              <Link href={`/api/google/oauth/start?websiteId=${website.id}`} className="mt-2 inline-block rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white">
                Reconnect Google
              </Link>
            )}
          </div>
        ) : (
          <div className="mt-2 text-sm">
            <p className="text-zinc-600">Not connected.</p>
            {isAdmin ? (
              <Link href={`/api/google/oauth/start?websiteId=${website.id}`} className="mt-2 inline-block rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white">
                Connect Google
              </Link>
            ) : (
              <p className="text-xs text-zinc-500">Ask an organization owner or admin to connect Google.</p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        {sources.map((s) => {
          const label = PRODUCT_LABEL[s.source];
          const hasScope = granted[s.source];
          const selected = selectionFor(s.source, website);
          return (
            <div key={s.source} className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold">{label}</h3>
                  <p className="text-xs text-zinc-500">
                    Access: {hasScope ? <span className="text-emerald-700">granted</span> : <span className="text-zinc-500">not granted</span>} · Selection:{" "}
                    {selected ? <span className="font-mono">{selected}</span> : <span className="text-zinc-500">none</span>} · Status: {s.status.replace("_", " ")}
                  </p>
                  {s.last_error && <p className="mt-1 text-xs text-red-700">{s.last_error}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  {connection && connection.status === "active" && !hasScope && isAdmin && (
                    <Link href={`/api/google/oauth/start?websiteId=${website.id}&products=${s.source}`} className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50">
                      Grant access
                    </Link>
                  )}
                  {isAdmin && selected && (s.status === "ok" || s.status === "error") && (
                    <form action={syncNowAction.bind(null, website.id)}>
                      <input type="hidden" name="source" value={s.source} />
                      <button className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50">Sync now</button>
                    </form>
                  )}
                  {hasScope && isAdmin && (
                    <Link href={`/app/w/${website.id}/connections/${s.source}`} className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50">
                      {selected ? "Change selection" : "Choose"}
                    </Link>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {jobs.length > 0 && (
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">Recent syncs</h3>
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr><th className="py-1">Source</th><th>Kind</th><th>Started</th><th>Status</th><th>Rows</th><th>Data through</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-zinc-100 align-top" title={j.error_message ?? undefined}>
                  <td className="py-1">{PRODUCT_LABEL[j.source]}</td>
                  <td>{j.kind}</td>
                  <td>{new Date(j.started_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td className={j.status === "failed" ? "text-red-700" : j.status === "running" ? "text-sky-700" : "text-emerald-700"}>{j.status}</td>
                  <td>{j.rows_written.toLocaleString()}</td>
                  <td>{j.data_through ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {connection && isAdmin && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-red-800">Danger zone</h3>
          <ConfirmForm
            action={disconnectGoogleAction.bind(null, website.id)}
            word="DISCONNECT"
            label="Disconnect Google"
            description="Revokes this app's access to the Google account, removes the stored credentials and stops all syncs for this website. Imported data is kept until you delete it in Settings."
          />
        </section>
      )}
    </div>
  );
}
