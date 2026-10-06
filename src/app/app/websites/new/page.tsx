import { requireUser } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/orgs/service";
import { NewWebsiteForm } from "@/components/new-website-form";

export default async function NewWebsitePage() {
  const user = await requireUser();
  const orgs = await listOrganizations(user.id);
  return (
    <div className="mx-auto w-full max-w-lg p-8">
      <h1 className="mb-1 text-lg font-semibold">Add a website</h1>
      <p className="mb-6 text-sm text-zinc-600">A website is the workspace that ties together one Search Console property, one GA4 property and one Google Ads account.</p>
      <NewWebsiteForm organizations={orgs.filter((o) => o.role !== "member").map((o) => ({ id: o.id, name: o.name }))} />
    </div>
  );
}
