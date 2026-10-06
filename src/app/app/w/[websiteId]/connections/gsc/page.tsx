// Server actions on this page can run a background sync (and chat calls the AI model).
export const maxDuration = 300;

import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { requireWebsiteAccess } from "@/lib/websites/service";
import { listAvailableGscProperties } from "@/lib/sources/select";
import { SelectOptionForm } from "@/components/select-option-form";
import { selectGscPropertyAction } from "./actions";
import { AppError } from "@/lib/errors";
import { GoogleApiError } from "@/lib/providers/errors";

export default async function SelectGscPage({ params }: PageProps<"/app/w/[websiteId]/connections/gsc">) {
  const user = await requireUser();
  const { websiteId } = await params;
  const { website } = await requireWebsiteAccess(user.id, websiteId);
  let options: { value: string; label: string; hint?: string }[] = [];
  let error: string | null = null;
  try {
    options = (await listAvailableGscProperties(user.id, websiteId)).map((s) => ({
      value: s.siteUrl,
      label: s.siteUrl,
      hint: `${s.siteUrl.startsWith("sc-domain:") ? "Domain property" : "URL-prefix property"} · ${s.permissionLevel.replace("SITE_", "").replace("_", " ").toLowerCase()}`,
    }));
  } catch (e) {
    error = e instanceof AppError || e instanceof GoogleApiError ? e.message : "Could not list Search Console properties.";
  }
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-8">
      <Link href={`/app/w/${websiteId}/connections`} className="text-xs text-zinc-500 hover:underline">← Connections</Link>
      <h2 className="text-lg font-semibold">Choose a Search Console property</h2>
      <p className="text-sm text-zinc-600">Pick the property that represents <span className="font-medium">{website.domain}</span>. Changing it later deletes the imported Search Console data for this website and re-imports from the new property.</p>
      {error && <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <SelectOptionForm name="siteUrl" options={options} current={website.gsc_property} action={selectGscPropertyAction.bind(null, websiteId)} submitLabel="Use this property" />
    </div>
  );
}
