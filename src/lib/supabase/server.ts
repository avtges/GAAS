import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireEnv } from "@/lib/env";

/** Supabase client bound to the current request's cookies (server components, actions, routes). */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL");
  const key = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "Supabase anon key");
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there. The proxy
          // (src/proxy.ts) refreshes sessions, so this is safe to ignore.
        }
      },
    },
  });
}
