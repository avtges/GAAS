"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { selectGa4Property } from "@/lib/sources/select";
import { AppError } from "@/lib/errors";
import { GoogleApiError } from "@/lib/providers/errors";

export async function selectGa4PropertyAction(websiteId: string, _prev: { error?: string }, formData: FormData): Promise<{ error?: string }> {
  const user = await requireUser();
  try {
    await selectGa4Property(user.id, websiteId, { propertyId: formData.get("propertyId") });
  } catch (e) {
    if (e instanceof AppError || e instanceof GoogleApiError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/app/w/${websiteId}`, "layout");
  redirect(`/app/w/${websiteId}/connections?selected=ga4`);
}
