import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Next.js 16 proxy (formerly middleware): refreshes the Supabase session cookie on every
 * request and gates /app behind authentication. It never reads tenant data.
 */
/**
 * Absolute redirect target. Uses APP_URL when set, because behind a forwarding proxy
 * (e.g. GitHub Codespaces) request.url can point at localhost instead of the public URL.
 */
function to(path: string, request: NextRequest): URL {
  return new URL(path, process.env.APP_URL || request.url);
}

export async function proxy(request: NextRequest) {
  const authMode = process.env.AUTH_MODE ?? "supabase";
  const isProtected = request.nextUrl.pathname.startsWith("/app") || request.nextUrl.pathname.startsWith("/api/app");

  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");

  if (authMode === "local") {
    if (isProtected && !request.cookies.get("gaas_dev_session")) {
      return NextResponse.redirect(to("/login", request));
    }
    return response;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (isProtected) return NextResponse.redirect(to("/login?error=config", request));
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        response.headers.set("Cache-Control", "private, no-store");
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Refresh the session early so updated cookies are written before the response commits.
  const { data } = await supabase.auth.getUser();
  if (isProtected && !data.user) {
    return NextResponse.redirect(to("/login", request));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
