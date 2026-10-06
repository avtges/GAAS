import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { listWebsiteSources, requireWebsiteAccess } from "@/lib/websites/service";
import { AppError } from "@/lib/errors";
import { SourceStatusBar } from "@/components/source-status-bar";

export default async function WebsiteLayout({ children, params }: LayoutProps<"/app/w/[websiteId]">) {
  const user = await requireUser();
  const { websiteId } = await params;
  let website;
  try {
    website = (await requireWebsiteAccess(user.id, websiteId)).website;
  } catch (e) {
    if (e instanceof AppError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
  const sources = await listWebsiteSources(user.id, websiteId);
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold">{website.display_name}</h1>
            <p className="text-xs text-zinc-500">{website.domain} · {website.timezone}</p>
          </div>
          <SourceStatusBar websiteId={website.id} sources={sources} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
