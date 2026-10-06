"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { selectAdsAccount } from "@/lib/sources/select";
import { AppError } from "@/lib/errors";
import { GoogleApiError } from "@/lib/providers/errors";

export async function selectAdsAccountAction(websiteId: string, _prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await selectAdsAccount(user.id, websiteId, { customerId: formData.get("customerId") });
  } catch (e) {
    if (e instanceof AppError || e instanceof GoogleApiError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/app/w/${websiteId}`, "layout");
  redirect(`/app/w/${websiteId}/connections?selected=ads`);
}
