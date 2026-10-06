import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { listWebsiteSources } from "@/lib/websites/service";
import { getThread, listThreads, type ChatMessage } from "@/lib/chat/service";
import { ChatPanel } from "@/components/chat-panel";
import { sendMessageAction, deleteThreadAction } from "./actions";
import { AppError } from "@/lib/errors";

export default async function WebsiteChatPage({ params, searchParams }: PageProps<"/app/w/[websiteId]">) {
  const user = await requireUser();
  const { websiteId } = await params;
  const sp = await searchParams;
  const threadId = typeof sp.thread === "string" ? sp.thread : null;
  const [threads, sources] = await Promise.all([listThreads(user.id, websiteId), listWebsiteSources(user.id, websiteId)]);
  let messages: ChatMessage[] = [];
  let activeThread: string | null = null;
  if (threadId) {
    try {
      messages = (await getThread(user.id, websiteId, threadId)).messages;
      activeThread = threadId;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }
  const anyConfigured = sources.some((s) => s.status !== "not_configured" && s.status !== "disconnected");

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200 bg-white md:flex">
        <div className="flex items-center justify-between border-b border-zinc-200 p-3">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Chats</span>
          <Link href={`/app/w/${websiteId}`} className="rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50">New</Link>
        </div>
        <ul className="flex-1 overflow-y-auto p-2 text-xs">
          {threads.map((t) => (
            <li key={t.id} className={`group flex items-center justify-between rounded px-2 py-1.5 ${t.id === activeThread ? "bg-zinc-100" : "hover:bg-zinc-50"}`}>
              <Link href={`/app/w/${websiteId}?thread=${t.id}`} className="min-w-0 flex-1 truncate">
                {t.title ?? "Untitled chat"}
              </Link>
              <form action={deleteThreadAction.bind(null, websiteId, t.id)}>
                <button className="ml-1 hidden text-zinc-400 hover:text-red-600 group-hover:inline" title="Delete chat">×</button>
              </form>
            </li>
          ))}
          {threads.length === 0 && <li className="px-2 py-1.5 text-zinc-400">No chats yet</li>}
        </ul>
      </aside>
      <ChatPanel messages={messages} action={sendMessageAction.bind(null, websiteId, activeThread)} disabled={!anyConfigured} />
    </div>
  );
}
