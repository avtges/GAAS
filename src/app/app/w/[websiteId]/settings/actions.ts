"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { updateSemanticConfig } from "@/lib/websites/service";
import { deleteWebsite, deleteWebsiteData } from "@/lib/websites/delete";
import { AppError } from "@/lib/errors";
import { isValidTimeZone } from "@/lib/dates";

export type SettingsState = { error?: string; ok?: boolean };

export async function saveSemanticConfigAction(websiteId: string, _prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const user = await requireUser();
  const tz = String(formData.get("timezone") ?? "");
  if (!isValidTimeZone(tz)) return { error: `"${tz}" is not a valid IANA time zone (e.g. America/New_York).` };
  const brand = String(formData.get("brandQueries") ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const opt = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  try {
    await updateSemanticConfig(user.id, websiteId, {
      timezone: tz,
      currency: String(formData.get("currency") ?? ""),
      businessConversionEvent: opt("businessConversionEvent"),
      revenueEvent: opt("revenueEvent"),
      primaryGoogleAdsConversion: opt("primaryGoogleAdsConversion"),
      brandQueries: brand,
    });
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/app/w/${websiteId}`, "layout");
  return { ok: true };
}

export async function deleteWebsiteDataAction(websiteId: string, formData: FormData): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  if (formData.get("confirm") !== "DELETE") return { error: "Type DELETE to confirm." };
  try {
    await deleteWebsiteData(user.id, websiteId);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/app/w/${websiteId}`, "layout");
  redirect(`/app/w/${websiteId}/connections`);
}

export async function deleteWebsiteAction(websiteId: string, formData: FormData): Promise<{ error?: string; ok?: boolean }> {
  const user = await requireUser();
  if (formData.get("confirm") !== "DELETE WEBSITE") return { error: "Type DELETE WEBSITE to confirm." };
  try {
    await deleteWebsite(user.id, websiteId);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/app", "layout");
  redirect("/app");
}
