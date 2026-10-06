import { z } from "zod";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { todayInTimeZone } from "@/lib/dates";
import { AiProviderError, LiveOpenAIClient, type ChatInputItem, type ChatModelClient } from "@/lib/ai/client";
import { MockChatClient } from "@/lib/ai/mock-client";
import { getToolRegistry } from "@/lib/ai/tools";
import type { ToolContext } from "@/lib/ai/tools/registry";
import { buildGrounding, type ExecutedTool, type GroundingMetadata } from "@/lib/ai/grounding";
import { buildSystemPrompt } from "@/lib/ai/prompt";
import { getSourceFreshness } from "@/lib/analytics/status";
import { AppError } from "@/lib/errors";
import type { Website } from "@/lib/websites/service";

let client: ChatModelClient | undefined;

export function getChatClient(): ChatModelClient {
  if (!client) {
    const env = getEnv();
    client = env.OPENAI_MODE === "mock" ? new MockChatClient(() => todayInTimeZone("UTC")) : new LiveOpenAIClient();
  }
  return client;
}

/** Test helper. */
export function setChatClient(c: ChatModelClient | undefined): void {
  client = c;
}

export type ChatTurnInput = {
  userId: string;
  website: Website;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
};

export type ChatTurnResult = { content: string; grounding: GroundingMetadata; executed: ExecutedTool[] };

const MAX_TOOL_OUTPUT_CHARS = 60_000;

/**
 * One chat turn: system prompt → model → (tool calls → execute → model)* → answer.
 * Tools run with the authenticated user's context; the model never supplies it.
 */
export async function runChatTurn(input: ChatTurnInput, opts: { maxToolRounds?: number } = {}): Promise<ChatTurnResult> {
  const env = getEnv();
  const registry = getToolRegistry();
  const freshness = await getSourceFreshness(input.userId, input.website.id);
  const today = todayInTimeZone(input.website.timezone);
  const ctx: ToolContext = { userId: input.userId, website: input.website, freshness, now: () => new Date(), today };
  const instructions = buildSystemPrompt(input.website, freshness, today);

  const items: ChatInputItem[] = [
    ...input.history.slice(-12).map((m) => ({ type: "message" as const, role: m.role, content: m.content })),
    { type: "message", role: "user", content: input.message },
  ];
  const tools = registry.openAITools();
  const executed: ExecutedTool[] = [];
  let model: string | null = null;
  let usage: GroundingMetadata["usage"] = null;
  const maxRounds = opts.maxToolRounds ?? env.AI_MAX_TOOL_ROUNDS;

  for (let round = 0; round <= maxRounds; round++) {
    const res = await getChatClient().createResponse({ instructions, input: items, tools });
    model = res.model;
    if (res.usage) {
      const prev: { input_tokens: number; output_tokens: number } = usage ?? { input_tokens: 0, output_tokens: 0 };
      usage = { input_tokens: prev.input_tokens + res.usage.input_tokens, output_tokens: prev.output_tokens + res.usage.output_tokens };
    }
    const calls = res.output.filter((o): o is Extract<typeof o, { type: "function_call" }> => o.type === "function_call");
    const text = res.output.filter((o): o is Extract<typeof o, { type: "message" }> => o.type === "message").map((o) => o.text).join("\n");

    if (calls.length === 0) {
      return { content: text || "I could not produce an answer from the available data.", grounding: buildGrounding(executed, model, usage), executed };
    }
    if (round === maxRounds) {
      log.warn("tool round limit reached", { websiteId: input.website.id, rounds: round });
      return {
        content: text || "I gathered data but hit the tool-call limit before finishing. Please ask a narrower question.",
        grounding: buildGrounding(executed, model, usage),
        executed,
      };
    }
    for (const call of calls) {
      items.push({ type: "function_call", call_id: call.call_id, name: call.name, arguments: call.arguments });
      const result = await executeTool(registry, ctx, call.name, call.arguments);
      executed.push(result.executed);
      items.push({ type: "function_call_output", call_id: call.call_id, output: result.output });
    }
  }
  throw new AiProviderError("Unexpected end of tool loop", false);
}

async function executeTool(registry: ReturnType<typeof getToolRegistry>, ctx: ToolContext, name: string, rawArgs: string): Promise<{ executed: ExecutedTool; output: string }> {
  const started = Date.now();
  const tool = registry.get(name);
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return fail(name, args, "Tool arguments were not valid JSON.", started);
  }
  if (!tool) return fail(name, args, `Unknown tool "${name}".`, started);
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return fail(name, args, `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, started);
  }
  try {
    const envelope = await tool.execute(ctx, parsed.data);
    let output = JSON.stringify(envelope);
    if (output.length > MAX_TOOL_OUTPUT_CHARS) {
      output = JSON.stringify({ ...envelope, rows: undefined, breakdown: undefined, truncated: true, warnings: [...envelope.warnings, "Result was too large and was truncated; ask for fewer rows."] });
    }
    log.info("tool executed", { websiteId: ctx.website.id, tool: name, durationMs: Date.now() - started });
    return { executed: { name, args: parsed.data as Record<string, unknown>, ok: true, envelope, duration_ms: Date.now() - started }, output };
  } catch (e) {
    const message = e instanceof AppError ? e.message : e instanceof Error ? e.message : String(e);
    log.warn("tool failed", { websiteId: ctx.website.id, tool: name, error: message });
    return fail(name, parsed.data as Record<string, unknown>, message, started, tool.sources[0]);
  }
}

function fail(name: string, args: Record<string, unknown>, error: string, started: number, source?: string): { executed: ExecutedTool; output: string } {
  return {
    executed: { name, args, ok: false, error, duration_ms: Date.now() - started },
    output: JSON.stringify({ error, source: source ?? "system", warnings: [error] }),
  };
}

export const ChatMessageInput = z.object({ message: z.string().trim().min(1).max(2000) });
