import { z } from "zod";
import { withUserDb, many, one } from "@/lib/db/pool";
import { badRequest, notFound } from "@/lib/errors";
import { requireWebsiteAccess } from "@/lib/websites/service";
import { runChatTurn, ChatMessageInput } from "@/lib/ai/engine";
import type { GroundingMetadata } from "@/lib/ai/grounding";
import { rateLimit } from "@/lib/ratelimit";
import { AiProviderError } from "@/lib/ai/client";

export type ChatThread = { id: string; website_id: string; title: string | null; created_at: string };
export type ChatMessage = { id: string; role: "user" | "assistant"; content: string; metadata: GroundingMetadata | null; created_at: string };

const uuid = z.string().uuid();

export async function listThreads(userId: string, websiteId: string): Promise<ChatThread[]> {
  await requireWebsiteAccess(userId, websiteId);
  return withUserDb(userId, (db) => many<ChatThread>(db, "select id, website_id, title, created_at from public.chat_threads where website_id = $1 order by created_at desc limit 50", [websiteId]));
}

export async function getThread(userId: string, websiteId: string, threadId: string): Promise<{ thread: ChatThread; messages: ChatMessage[] }> {
  await requireWebsiteAccess(userId, websiteId);
  if (!uuid.safeParse(threadId).success) throw notFound("Chat");
  const thread = await withUserDb(userId, (db) => one<ChatThread>(db, "select id, website_id, title, created_at from public.chat_threads where id = $1 and website_id = $2", [threadId, websiteId]));
  if (!thread) throw notFound("Chat");
  const messages = await withUserDb(userId, (db) =>
    many<ChatMessage>(db, "select id, role, content, metadata, created_at from public.chat_messages where thread_id = $1 and role in ('user','assistant') order by created_at", [threadId]),
  );
  return { thread, messages };
}

export async function createThread(userId: string, websiteId: string, title: string | null): Promise<ChatThread> {
  const { website } = await requireWebsiteAccess(userId, websiteId);
  const t = await withUserDb(userId, (db) =>
    one<ChatThread>(db, "insert into public.chat_threads (organization_id, website_id, created_by, title) values ($1, $2, $3, $4) returning id, website_id, title, created_at", [website.organization_id, websiteId, userId, title]),
  );
  return t!;
}

export async function deleteThread(userId: string, websiteId: string, threadId: string): Promise<void> {
  await requireWebsiteAccess(userId, websiteId);
  await withUserDb(userId, (db) => db.query("delete from public.chat_threads where id = $1 and website_id = $2", [threadId, websiteId]));
}

/**
 * Sends a user message in a thread and stores the grounded assistant reply. Authorization:
 * the website must be accessible to the user (RLS + membership); the thread must belong
 * to that website.
 */
export async function sendMessage(userId: string, websiteId: string, threadId: string | null, input: unknown): Promise<{ threadId: string; assistant: ChatMessage }> {
  const parsed = ChatMessageInput.safeParse(input);
  if (!parsed.success) throw badRequest("Message must be between 1 and 2000 characters.");
  const limit = rateLimit(`chat:${userId}`, { capacity: 20, refillPerSecond: 20 / 60 });
  if (!limit.ok) throw badRequest(`Too many messages; try again in ${limit.retryAfterSeconds}s.`);

  const { website } = await requireWebsiteAccess(userId, websiteId);
  const thread = threadId ? (await getThread(userId, websiteId, threadId)).thread : await createThread(userId, websiteId, parsed.data.message.slice(0, 80));
  const history = threadId ? (await getThread(userId, websiteId, threadId)).messages.map((m) => ({ role: m.role, content: m.content })) : [];

  await withUserDb(userId, (db) =>
    db.query("insert into public.chat_messages (thread_id, organization_id, role, content) values ($1, $2, 'user', $3)", [thread.id, website.organization_id, parsed.data.message]),
  );

  let content: string;
  let metadata: GroundingMetadata | null;
  try {
    const result = await runChatTurn({ userId, website, history, message: parsed.data.message });
    content = result.content;
    metadata = result.grounding;
  } catch (e) {
    if (e instanceof AiProviderError) {
      content = `Sorry — ${e.message} No data was fabricated; please retry.`;
      metadata = null;
    } else {
      throw e;
    }
  }

  const assistant = await withUserDb(userId, (db) =>
    one<ChatMessage>(
      db,
      "insert into public.chat_messages (thread_id, organization_id, role, content, metadata) values ($1, $2, 'assistant', $3, $4) returning id, role, content, metadata, created_at",
      [thread.id, website.organization_id, content, metadata ? JSON.stringify(metadata) : null],
    ),
  );
  return { threadId: thread.id, assistant: assistant! };
}
