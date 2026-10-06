// Server actions on this page can run a background sync (and chat calls the AI model).
export const maxDuration = 300;

import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { requireWebsiteAccess } from "@/lib/websites/service";
import { listAvailableGa4Properties } from "@/lib/sources/select";
import { SelectOptionForm } from "@/components/select-option-form";
import { selectGa4PropertyAction } from "./actions";
import { AppError } from "@/lib/errors";
import { GoogleApiError } from "@/lib/providers/errors";

const TYPE: Record<string, string> = { PROPERTY_TYPE_ORDINARY: "Standard property", PROPERTY_TYPE_SUBPROPERTY: "Subproperty", PROPERTY_TYPE_ROLLUP: "Roll-up property" };

export default async function SelectGa4Page({ params }: PageProps<"/app/w/[websiteId]/connections/ga4">) {
  const user = await requireUser();
  const { websiteId } = await params;
  const { website } = await requireWebsiteAccess(user.id, websiteId);
  let options: { value: string; label: string; hint?: string }[] = [];
  let error: string | null = null;
  try {
    options = (await listAvailableGa4Properties(user.id, websiteId)).map((p) => ({
      value: p.propertyId,
      label: `${p.displayName} (properties/${p.propertyId})`,
      hint: `${p.account} · ${TYPE[p.propertyType] ?? "Property"}`,
    }));
  } catch (e) {
    error = e instanceof AppError || e instanceof GoogleApiError ? e.message : "Could not list GA4 properties.";
  }
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-8">
      <Link href={`/app/w/${websiteId}/connections`} className="text-xs text-zinc-500 hover:underline">← Connections</Link>
      <h2 className="text-lg font-semibold">Choose a GA4 property</h2>
      <p className="text-sm text-zinc-600">Pick the Google Analytics 4 property that measures <span className="font-medium">{website.domain}</span>. Changing it later deletes the imported GA4 data for this website and re-imports.</p>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <SelectOptionForm name="propertyId" options={options} current={website.ga4_property_id} action={selectGa4PropertyAction.bind(null, websiteId)} submitLabel="Use this property" />
    </div>
  );
}
