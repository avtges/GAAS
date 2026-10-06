import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { LOCAL_SESSION_COOKIE, verifyLocalSession } from "@/lib/auth/local";
import { withUserDb } from "@/lib/db/pool";

export type CurrentUser = { id: string; email: string | null };

/** The authenticated user for this request, or null. Verified server-side only. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const env = getEnv();
  if (env.AUTH_MODE === "local") {
    const store = await cookies();
    const s = verifyLocalSession(store.get(LOCAL_SESSION_COOKIE)?.value);
    return s ? { id: s.id, email: s.email } : null;
  }
  const supabase = await createSupabaseServerClient();
  // getUser() validates the JWT with the Auth server rather than trusting the cookie.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  await ensureUserProfile(user);
  return user;
}

const ensured = new Set<string>();

/** Keeps public.users in step with auth.users (idempotent, cached per process). */
export async function ensureUserProfile(user: CurrentUser): Promise<void> {
  if (ensured.has(user.id)) return;
  await withUserDb(user.id, (db) =>
    db.query(
      `insert into public.users (id, email) values ($1, $2)
       on conflict (id) do update set email = excluded.email`,
      [user.id, user.email],
    ),
  );
  ensured.add(user.id);
}
