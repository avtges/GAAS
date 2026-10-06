"use client";

import { useActionState } from "react";
import { createWebsiteAction, type WebsiteFormState } from "@/app/app/websites/actions";

export function NewWebsiteForm({ organizations }: { organizations: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<WebsiteFormState, FormData>(createWebsiteAction, {});
  return (
    <form action={action} className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
      <label className="block text-sm">
        <span className="text-zinc-700">Organization</span>
        <select name="organizationId" className="mt-1 w-full rounded border border-zinc-300 px-3 py-2">
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-zinc-700">Display name</span>
        <input name="displayName" required maxLength={120} className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" placeholder="Acme Store" />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-700">Domain</span>
        <input name="domain" required className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" placeholder="example.com" />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-700">Reporting time zone (IANA)</span>
        <input name="timezone" defaultValue="UTC" className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" placeholder="America/New_York" />
      </label>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      <button disabled={pending} className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "Creating…" : "Create website"}
      </button>
    </form>
  );
}
