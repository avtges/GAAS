"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createWebsite } from "@/lib/websites/service";
import { AppError } from "@/lib/errors";

export type WebsiteFormState = { error?: string };

export async function createWebsiteAction(_prev: WebsiteFormState, formData: FormData): Promise<WebsiteFormState> {
  const user = await requireUser();
  let id: string;
  try {
    const site = await createWebsite(user.id, {
      organizationId: formData.get("organizationId"),
      domain: formData.get("domain"),
      displayName: formData.get("displayName"),
      timezone: formData.get("timezone") || "UTC",
    });
    id = site.id;
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  redirect(`/app/w/${id}/connections`);
}
