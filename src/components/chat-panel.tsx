"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/chat/service";
import type { ChatFormState } from "@/app/app/w/[websiteId]/actions";
import { GroundingFooter } from "@/components/grounding-footer";

const SUGGESTED = [
  "What changed this week?",
  "Where are we wasting ad spend?",
  "What organic opportunities should I prioritize?",
  "Which landing pages are improving?",
  "Compare paid and organic acquisition.",
];

export function ChatPanel({
  messages,
  action,
  disabled,
}: {
  messages: ChatMessage[];
  action: (prev: ChatFormState, formData: FormData) => Promise<ChatFormState>;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="mx-auto max-w-2xl py-10 text-center">
            <h2 className="text-base font-semibold">Ask about your marketing data</h2>
            <p className="mt-1 text-sm text-zinc-600">Answers are grounded only in the connected sources; each one shows the sources, period and data freshness used.</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTED.map((q) => (
                <form key={q} action={formAction}>
                  <input type="hidden" name="message" value={q} />
                  <button disabled={pending || disabled} className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-50">
                    {q}
                  </button>
                </form>
              ))}
            </div>
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div className={`max-w-[85%] rounded-lg px-4 py-3 text-sm ${m.role === "user" ? "bg-zinc-900 text-white" : "border border-zinc-200 bg-white"}`}>
                <div className="whitespace-pre-wrap">{m.content}</div>
                {m.role === "assistant" && m.metadata && <GroundingFooter metadata={m.metadata} />}
              </div>
            </div>
          ))}
          {pending && (
            <div className="flex justify-start">
              <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500">Looking at your data…</div>
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <form action={formAction} className="border-t border-zinc-200 bg-white p-4">
        <div className="mx-auto flex max-w-3xl gap-2">
          <input
            name="message"
            required
            maxLength={2000}
            disabled={pending || disabled}
            placeholder={disabled ? "Connect at least one source to start chatting" : "Ask a question about your data…"}
            className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50"
            autoComplete="off"
          />
          <button disabled={pending || disabled} className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            Send
          </button>
        </div>
        {state.error && <p className="mx-auto mt-2 max-w-3xl text-xs text-red-700">{state.error}</p>}
      </form>
    </div>
  );
}
