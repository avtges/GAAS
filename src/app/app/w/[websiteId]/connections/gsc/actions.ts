"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { selectGscProperty } from "@/lib/sources/select";
import { AppError } from "@/lib/errors";

export async function selectGscPropertyAction(websiteId: string, _prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await selectGscProperty(user.id, websiteId, { siteUrl: formData.get("siteUrl") });
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    return { error: (e as Error).message };
  }
  revalidatePath(`/app/w/${websiteId}`, "layout");
  redirect(`/app/w/${websiteId}/connections?selected=gsc`);
}
