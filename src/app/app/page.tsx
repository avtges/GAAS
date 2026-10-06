import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { listWebsites } from "@/lib/websites/service";

export default async function AppHome() {
  const user = await requireUser();
  const websites = await listWebsites(user.id);
  redirect(websites.length > 0 ? `/app/w/${websites[0].id}` : "/app/websites/new");
}
