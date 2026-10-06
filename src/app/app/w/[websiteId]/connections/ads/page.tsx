// Server actions on this page can run a background sync (and chat calls the AI model).
export const maxDuration = 300;

import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { requireWebsiteAccess } from "@/lib/websites/service";
import { listAvailableAdsAccounts } from "@/lib/sources/select";
import { SelectOptionForm } from "@/components/select-option-form";
import { selectAdsAccountAction } from "./actions";
import { AppError } from "@/lib/errors";
import { GoogleApiError } from "@/lib/providers/errors";

const fmtId = (id: string) => `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;

export default async function SelectAdsPage({ params }: PageProps<"/app/w/[websiteId]/connections/ads">) {
  const user = await requireUser();
  const { websiteId } = await params;
  const { website } = await requireWebsiteAccess(user.id, websiteId);
  let options: { value: string; label: string; hint?: string; disabled?: boolean }[] = [];
  let errors: string[] = [];
  let error: string | null = null;
  try {
    const r = await listAvailableAdsAccounts(user.id, websiteId);
    errors = r.errors;
    options = r.accounts.map((a) => ({
      value: a.customerId,
      label: `${a.descriptiveName} (${fmtId(a.customerId)})`,
      hint: [a.loginCustomerId ? `via manager ${fmtId(a.loginCustomerId)}` : "direct access", a.currencyCode, a.timeZone, a.testAccount ? "test account" : null, a.status && a.status !== "ENABLED" ? a.status.toLowerCase() : null].filter(Boolean).join(" · "),
      disabled: !!a.status && a.status !== "ENABLED",
    }));
  } catch (e) {
    error = e instanceof AppError || e instanceof GoogleApiError ? e.message : "Could not list Google Ads accounts.";
  }
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-8">
      <Link href={`/app/w/${websiteId}/connections`} className="text-xs text-zinc-500 hover:underline">← Connections</Link>
      <h2 className="text-lg font-semibold">Choose a Google Ads account</h2>
      <p className="text-sm text-zinc-600">Read-only reporting for <span className="font-medium">{website.domain}</span>. This app never changes campaigns, budgets, bids or keywords. Changing the account later deletes the imported Ads data for this website.</p>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {errors.length > 0 && (
        <details className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <summary>Some accounts could not be read ({errors.length})</summary>
          <ul className="mt-2 list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </details>
      )}
      <SelectOptionForm name="customerId" options={options} current={website.google_ads_customer_id} action={selectAdsAccountAction.bind(null, websiteId)} submitLabel="Use this account" />
    </div>
  );
}
