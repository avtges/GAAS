export const dynamic = "force-dynamic";

import { AuthForm } from "@/components/auth-form";
import { signUp } from "@/app/(auth)/actions";
import { getEnv } from "@/lib/env";

export default function RegisterPage() {
  const env = getEnv();
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
      <AuthForm mode="register" localMode={env.AUTH_MODE === "local"} action={signUp} />
    </main>
  );
}
