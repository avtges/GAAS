import { AuthForm } from "@/components/auth-form";
import { signIn } from "@/app/(auth)/actions";
import { getEnv } from "@/lib/env";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const env = getEnv();
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
      <div className="space-y-3">
        {params.error === "config" && (
          <p className="max-w-sm rounded bg-red-50 p-2 text-xs text-red-800">
            Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY). See .env.example.
          </p>
        )}
        <AuthForm mode="login" localMode={env.AUTH_MODE === "local"} action={signIn} />
      </div>
    </main>
  );
}
