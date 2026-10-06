"use client";

import { useActionState } from "react";
import type { SettingsState } from "@/app/app/w/[websiteId]/settings/actions";

type Props = {
  action: (prev: SettingsState, fd: FormData) => Promise<SettingsState>;
  values: { timezone: string; currency: string; businessConversionEvent: string | null; revenueEvent: string | null; primaryGoogleAdsConversion: string | null; brandQueries: string[] };
  keyEvents: string[];
  observedEvents: string[];
  adsConversionActions: string[];
  disabled: boolean;
};

export function SemanticConfigForm({ action, values, keyEvents, observedEvents, adsConversionActions, disabled }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const events = [...new Set([...keyEvents, ...observedEvents])];
  return (
    <form action={formAction} className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5 text-sm">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-zinc-700">Reporting time zone</span>
          <input name="timezone" defaultValue={values.timezone} disabled={disabled} className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-zinc-700">Currency (ISO 4217)</span>
          <input name="currency" defaultValue={values.currency} maxLength={3} disabled={disabled} className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 uppercase" />
        </label>
      </div>
      <label className="block">
        <span className="text-zinc-700">Business conversion event (GA4 event name)</span>
        <input name="businessConversionEvent" list="ga4-events" defaultValue={values.businessConversionEvent ?? ""} disabled={disabled} placeholder="e.g. paid_purchase" className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" />
        <span className="mt-1 block text-xs text-zinc-500">The event that represents a real business outcome (a customer, subscription or qualified lead). Without it, the assistant will not treat GA4 key events as business conversions.</span>
      </label>
      <label className="block">
        <span className="text-zinc-700">Revenue event (GA4 event name)</span>
        <input name="revenueEvent" list="ga4-events" defaultValue={values.revenueEvent ?? ""} disabled={disabled} placeholder="e.g. purchase" className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" />
      </label>
      <datalist id="ga4-events">
        {events.map((e) => (
          <option key={e} value={e}>{keyEvents.includes(e) ? "key event" : "event"}</option>
        ))}
      </datalist>
      <label className="block">
        <span className="text-zinc-700">Primary Google Ads conversion action</span>
        <input name="primaryGoogleAdsConversion" list="ads-actions" defaultValue={values.primaryGoogleAdsConversion ?? ""} disabled={disabled} className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" />
        <datalist id="ads-actions">{adsConversionActions.map((a) => <option key={a} value={a} />)}</datalist>
      </label>
      <label className="block">
        <span className="text-zinc-700">Brand queries (one per line or comma-separated)</span>
        <textarea name="brandQueries" rows={3} defaultValue={values.brandQueries.join("\n")} disabled={disabled} placeholder={"acme\nacme store"} className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" />
        <span className="mt-1 block text-xs text-zinc-500">Search Console queries containing any of these are treated as brand searches.</span>
      </label>
      {state.error && <p className="text-red-700">{state.error}</p>}
      {state.ok && <p className="text-emerald-700">Saved.</p>}
      <button disabled={pending || disabled} className="rounded bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50">{pending ? "Saving…" : "Save configuration"}</button>
    </form>
  );
}
