"use client";

import { useActionState } from "react";

type Result = { error?: string; ok?: boolean };

/** A destructive action gated behind typing a confirmation word. */
export function ConfirmForm({
  action,
  word,
  label,
  description,
}: {
  action: (formData: FormData) => Promise<Result>;
  word: string;
  label: string;
  description: string;
}) {
  const [state, formAction, pending] = useActionState<Result, FormData>(async (_prev, fd) => action(fd), {});
  return (
    <form action={formAction} className="space-y-2 rounded border border-red-200 bg-red-50 p-3 text-sm">
      <p className="text-red-900">{description}</p>
      <div className="flex gap-2">
        <input name="confirm" placeholder={`Type ${word}`} className="flex-1 rounded border border-red-300 bg-white px-2 py-1" autoComplete="off" />
        <button disabled={pending} className="rounded bg-red-700 px-3 py-1 font-medium text-white disabled:opacity-50">
          {pending ? "Working…" : label}
        </button>
      </div>
      {state.error && <p className="text-xs text-red-800">{state.error}</p>}
      {state.ok && <p className="text-xs text-emerald-800">Done.</p>}
    </form>
  );
}
