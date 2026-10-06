"use client";

import { useActionState } from "react";
import Link from "next/link";
import type { AuthState } from "@/app/(auth)/actions";

type Props = {
  mode: "login" | "register";
  localMode: boolean;
  action: (prev: AuthState, formData: FormData) => Promise<AuthState>;
};

export function AuthForm({ mode, localMode, action }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <h1 className="text-lg font-semibold">{mode === "login" ? "Sign in" : "Create an account"}</h1>
      {localMode && (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          Development auth mode: enter any email. Not for production.
        </p>
      )}
      <label className="block text-sm">
        <span className="text-zinc-700">Email</span>
        <input name="email" type="email" required autoComplete="email" className="mt-1 w-full rounded border border-zinc-300 px-3 py-2" />
      </label>
      {!localMode && (
        <label className="block text-sm">
          <span className="text-zinc-700">Password</span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className="mt-1 w-full rounded border border-zinc-300 px-3 py-2"
          />
        </label>
      )}
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      {state.message && <p className="text-sm text-emerald-700">{state.message}</p>}
      <button disabled={pending} className="w-full rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
      <p className="text-center text-xs text-zinc-600">
        {mode === "login" ? (
          <>
            No account? <Link href="/register" className="underline">Register</Link>
          </>
        ) : (
          <>
            Have an account? <Link href="/login" className="underline">Sign in</Link>
          </>
        )}
      </p>
    </form>
  );
}
