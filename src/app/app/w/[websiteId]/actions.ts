"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { deleteThread, sendMessage } from "@/lib/chat/service";
import { AppError } from "@/lib/errors";

export type ChatFormState = { error?: string };

export async function sendMessageAction(websiteId: string, threadId: string | null, _prev: ChatFormState, formData: FormData): Promise<ChatFormState> {
  const user = await requireUser();
  let id: string;
  try {
    const r = await sendMessage(user.id, websiteId, threadId, { message: formData.get("message") });
    id = r.threadId;
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/app/w/${websiteId}`);
  redirect(`/app/w/${websiteId}?thread=${id}`);
}

export async function deleteThreadAction(websiteId: string, threadId: string): Promise<void> {
  const user = await requireUser();
  await deleteThread(user.id, websiteId, threadId);
  revalidatePath(`/app/w/${websiteId}`);
  redirect(`/app/w/${websiteId}`);
}
