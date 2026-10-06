"use server";

import { z } from "zod";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { LOCAL_SESSION_COOKIE, localUserIdForEmail, signLocalSession } from "@/lib/auth/local";
import { rateLimit } from "@/lib/ratelimit";

const Credentials = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});

export type AuthState = { error?: string; message?: string };

async function limited(action: string): Promise<string | null> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const r = rateLimit(`${action}:${ip}`, { capacity: 10, refillPerSecond: 10 / 60 });
  return r.ok ? null : `Too many attempts. Try again in ${r.retryAfterSeconds}s.`;
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const block = await limited("signin");
  if (block) return { error: block };
  const env = getEnv();
  if (env.AUTH_MODE === "local") {
    const email = z.string().trim().email().safeParse(formData.get("email"));
    if (!email.success) return { error: "Enter a valid email." };
    const store = await cookies();
    store.set(LOCAL_SESSION_COOKIE, signLocalSession({ id: localUserIdForEmail(email.data), email: email.data }), {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    redirect("/app");
  }
  const parsed = Credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Enter a valid email and a password of at least 8 characters." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "Invalid email or password." };
  redirect("/app");
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const block = await limited("signup");
  if (block) return { error: block };
  const env = getEnv();
  if (env.AUTH_MODE === "local") return signIn(_prev, formData);
  const parsed = Credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Enter a valid email and a password of at least 8 characters." };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${env.APP_URL}/auth/callback` },
  });
  if (error) return { error: error.message };
  if (data.session) redirect("/app");
  return { message: "Check your email to confirm your account, then sign in." };
}

export async function signOut(): Promise<void> {
  const env = getEnv();
  const store = await cookies();
  if (env.AUTH_MODE === "local") {
    store.delete(LOCAL_SESSION_COOKIE);
  } else {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
