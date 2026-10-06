import { requireUser } from "@/lib/auth/session";
import { requireWebsiteAccess } from "@/lib/websites/service";
import { listGa4KeyEvents } from "@/lib/sources/select";
import { listObservedEvents } from "@/lib/analytics/ga4";
import { withUserDb, many } from "@/lib/db/pool";
import { addDays, todayInTimeZone } from "@/lib/dates";
import { SemanticConfigForm } from "@/components/semantic-config-form";
import { ConfirmForm } from "@/components/confirm-form";
import { saveSemanticConfigAction, deleteWebsiteDataAction, deleteWebsiteAction } from "./actions";

export default async function SettingsPage({ params }: PageProps<"/app/w/[websiteId]/settings">) {
  const user = await requireUser();
  const { websiteId } = await params;
  const { website, role } = await requireWebsiteAccess(user.id, websiteId);
  const isAdmin = role === "owner" || role === "admin";
  const today = todayInTimeZone(website.timezone);
  const keyEvents = await listGa4KeyEvents(user.id, websiteId).then((k) => k.map((e) => e.eventName)).catch(() => [] as string[]);
  const observed = (await listObservedEvents(user.id, websiteId, { start: addDays(today, -90), end: today })).map((e) => e.event_name);
  const adsActions = (await withUserDb(user.id, (db) => many<{ n: string }>(db, "select distinct conversion_action_name as n from public.ads_conversion_action_daily where website_id = $1 order by 1 limit 50", [websiteId]))).map((r) => r.n);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 p-8">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Semantic configuration</h2>
        <p className="text-sm text-zinc-600">Tell the assistant what your platform metrics mean for your business. Missing settings are reported in answers rather than guessed.</p>
        {!isAdmin && <p className="text-xs text-zinc-500">Only owners and admins can change these settings.</p>}
        <SemanticConfigForm
          action={saveSemanticConfigAction.bind(null, websiteId)}
          disabled={!isAdmin}
          keyEvents={keyEvents}
          observedEvents={observed}
          adsConversionActions={adsActions}
          values={{ timezone: website.timezone, currency: website.currency, businessConversionEvent: website.business_conversion_event, revenueEvent: website.revenue_event, primaryGoogleAdsConversion: website.primary_google_ads_conversion, brandQueries: website.brand_queries }}
        />
      </section>
      {isAdmin && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-red-800">Danger zone</h2>
          <ConfirmForm
            action={deleteWebsiteDataAction.bind(null, websiteId)}
            word="DELETE"
            label="Delete imported data"
            description="Permanently deletes all imported Search Console, GA4 and Google Ads data, sync history and chats for this website, clears the selected properties, and removes the stored Google credentials if no other website uses them. This cannot be undone."
          />
          <ConfirmForm
            action={deleteWebsiteAction.bind(null, websiteId)}
            word="DELETE WEBSITE"
            label="Delete website"
            description="Deletes this website workspace and everything in it, including credentials not used by another website."
          />
        </section>
      )}
    </div>
  );
}
