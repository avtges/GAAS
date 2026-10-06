import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { ensureDefaultOrganization } from "@/lib/orgs/service";
import { listWebsites } from "@/lib/websites/service";
import { signOut } from "@/app/(auth)/actions";

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const user = await requireUser();
  await ensureDefaultOrganization(user.id, user.email);
  const websites = await listWebsites(user.id);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white">
        <div className="border-b border-zinc-200 p-4">
          <Link href="/app" className="text-sm font-semibold">GAAS</Link>
          <p className="truncate text-xs text-zinc-500">{user.email}</p>
        </div>
        <nav className="flex-1 overflow-y-auto p-3 text-sm">
          <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Websites</p>
          <ul className="space-y-1">
            {websites.map((w) => (
              <li key={w.id}>
                <Link href={`/app/w/${w.id}`} className="block rounded px-2 py-1.5 hover:bg-zinc-100">
                  <span className="block truncate font-medium">{w.display_name}</span>
                  <span className="block truncate text-xs text-zinc-500">{w.domain}</span>
                </Link>
                <ul className="ml-2 border-l border-zinc-200 pl-2 text-xs text-zinc-600">
                  <li><Link href={`/app/w/${w.id}`} className="block rounded px-2 py-1 hover:bg-zinc-100">Chat</Link></li>
                  <li><Link href={`/app/w/${w.id}/connections`} className="block rounded px-2 py-1 hover:bg-zinc-100">Connections</Link></li>
                  <li><Link href={`/app/w/${w.id}/settings`} className="block rounded px-2 py-1 hover:bg-zinc-100">Settings</Link></li>
                </ul>
              </li>
            ))}
          </ul>
          <Link href="/app/websites/new" className="mt-3 block rounded border border-dashed border-zinc-300 px-2 py-1.5 text-center text-xs text-zinc-600 hover:bg-zinc-50">
            + Add website
          </Link>
        </nav>
        <form action={signOut} className="border-t border-zinc-200 p-3">
          <button className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-600 hover:bg-zinc-100">Sign out</button>
        </form>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
