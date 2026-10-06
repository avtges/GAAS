import { signOut } from "@/app/(auth)/actions";

export async function POST() {
  await signOut();
}
