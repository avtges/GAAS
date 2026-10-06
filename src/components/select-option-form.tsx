"use client";

import { useActionState } from "react";

type Option = { value: string; label: string; hint?: string; disabled?: boolean };

export function SelectOptionForm({
  name,
  options,
  current,
  action,
  submitLabel,
}: {
  name: string;
  options: Option[];
  current: string | null;
  action: (prev: { error?: string }, formData: FormData) => Promise<{ error?: string }>;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white">
        {options.map((o) => (
          <li key={o.value}>
            <label className={`flex cursor-pointer items-start gap-3 p-3 text-sm ${o.disabled ? "opacity-50" : "hover:bg-zinc-50"}`}>
              <input type="radio" name={name} value={o.value} defaultChecked={current === o.value} disabled={o.disabled} required className="mt-1" />
              <span>
                <span className="block font-mono text-xs sm:text-sm">{o.label}</span>
                {o.hint && <span className="block text-xs text-zinc-500">{o.hint}</span>}
              </span>
            </label>
          </li>
        ))}
        {options.length === 0 && <li className="p-3 text-sm text-zinc-500">Nothing available for the connected Google account.</li>}
      </ul>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      <button disabled={pending || options.length === 0} className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
