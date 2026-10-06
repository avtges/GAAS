import OpenAI from "openai";
import { getEnv, requireEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import type { OpenAIFunctionTool } from "@/lib/ai/tools/registry";

/**
 * Thin abstraction over the OpenAI Responses API (verified against openai@7.28.0 types):
 *   request: { model, instructions, input: items[], tools, store:false }
 *   output items: { type:'message', content:[{type:'output_text', text}] } | { type:'function_call', call_id, name, arguments }
 * The mock implementation drives the same loop without network access.
 */
export type ChatInputItem =
  | { type: "message"; role: "user" | "assistant" | "system" | "developer"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type ChatOutputItem = { type: "message"; text: string } | { type: "function_call"; call_id: string; name: string; arguments: string };

export type ChatRequest = { instructions: string; input: ChatInputItem[]; tools: OpenAIFunctionTool[] };
export type ChatResponse = { output: ChatOutputItem[]; usage: { input_tokens: number; output_tokens: number } | null; model: string; responseId: string | null };

export interface ChatModelClient {
  createResponse(req: ChatRequest): Promise<ChatResponse>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export class LiveOpenAIClient implements ChatModelClient {
  private client: OpenAI;
  private model: string;
  constructor() {
    this.client = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY", "OpenAI API key"), maxRetries: 2, timeout: 60_000 });
    this.model = getEnv().OPENAI_MODEL;
  }

  async createResponse(req: ChatRequest): Promise<ChatResponse> {
    let res: OpenAI.Responses.Response;
    try {
      res = await this.client.responses.create({
        model: this.model,
        instructions: req.instructions,
        input: req.input.map((item) =>
          item.type === "message"
            ? { type: "message" as const, role: item.role, content: item.content }
            : item.type === "function_call"
              ? { type: "function_call" as const, call_id: item.call_id, name: item.name, arguments: item.arguments }
              : { type: "function_call_output" as const, call_id: item.call_id, output: item.output },
        ),
        tools: req.tools,
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        max_output_tokens: 1500,
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const retryable = status === 429 || (status !== undefined && status >= 500);
      log.error("openai request failed", { status, error: (e as Error).message });
      throw new AiProviderError(`The AI service is unavailable (${status ?? "network"}). Please try again.`, retryable);
    }
    if (res.status === "failed" || res.error) {
      throw new AiProviderError(`The AI service returned an error: ${res.error?.message ?? res.status}`, true);
    }
    const output: ChatOutputItem[] = [];
    for (const item of res.output) {
      if (item.type === "message") {
        const text = item.content
          .filter((c): c is OpenAI.Responses.ResponseOutputText => c.type === "output_text")
          .map((c) => c.text)
          .join("");
        if (text) output.push({ type: "message", text });
      } else if (item.type === "function_call") {
        output.push({ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments });
      }
    }
    if (res.status === "incomplete") {
      output.push({ type: "message", text: "\n\n(The answer was cut short by the output length limit.)" });
    }
    return { output, usage: res.usage ? { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } : null, model: res.model, responseId: res.id };
  }
}
