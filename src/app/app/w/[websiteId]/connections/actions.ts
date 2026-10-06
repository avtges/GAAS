"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { disconnectGoogle } from "@/lib/google/connections";
import { requestSyncNow } from "@/lib/sources/select";
import { AppError } from "@/lib/errors";
import { Source } from "@/lib/websites/service";

export type ActionResult = { error?: string; ok?: boolean };

export async function disconnectGoogleAction(websiteId: string, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (formData.get("confirm") !== "DISCONNECT") return { error: "Type DISCONNECT to confirm." };
  try {
    await disconnectGoogle(user.id, websiteId);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/app/w/${websiteId}`, "layout");
  redirect(`/app/w/${websiteId}/connections`);
}

export async function syncNowAction(websiteId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const source = Source.safeParse(formData.get("source"));
  if (!source.success) return;
  try {
    await requestSyncNow(user.id, websiteId, source.data);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
  }
  revalidatePath(`/app/w/${websiteId}`, "layout");
  redirect(`/app/w/${websiteId}/connections`);
}
