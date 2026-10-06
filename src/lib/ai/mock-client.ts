import type { ChatInputItem, ChatModelClient, ChatRequest, ChatResponse } from "@/lib/ai/client";
import { addDays } from "@/lib/dates";

/**
 * Deterministic stand-in for the model. It performs the same two-step protocol as the
 * real model (choose tool calls → read tool outputs → write an answer) using keyword
 * routing, so the engine, grounding metadata and UI can be exercised without OpenAI.
 * It never invents numbers: the answer is rendered from the tool outputs only.
 */
export class MockChatClient implements ChatModelClient {
  constructor(private readonly today: () => string) {}

  async createResponse(req: ChatRequest): Promise<ChatResponse> {
    const outputs = req.input.filter((i): i is Extract<ChatInputItem, { type: "function_call_output" }> => i.type === "function_call_output");
    const lastUser = [...req.input].reverse().find((i): i is Extract<ChatInputItem, { type: "message" }> => i.type === "message" && i.role === "user");
    const question = (lastUser?.content ?? "").toLowerCase();
    const available = new Set(req.tools.map((t) => t.name));

    if (outputs.length === 0) {
      const calls = this.plan(question, available);
      return { output: calls.map((c, i) => ({ type: "function_call", call_id: `mock-call-${i}`, name: c.name, arguments: JSON.stringify(c.args) })), usage: null, model: "mock", responseId: null };
    }
    return { output: [{ type: "message", text: this.answer(outputs) }], usage: null, model: "mock", responseId: null };
  }

  private range(question: string): { start_date: string; end_date: string } {
    const today = this.today();
    const m = question.match(/last (\d+) days/);
    if (m) return { start_date: addDays(today, -Number(m[1])), end_date: addDays(today, -1) };
    if (/this week|last 7 days|past week/.test(question)) return { start_date: addDays(today, -7), end_date: addDays(today, -1) };
    if (/last week/.test(question)) return { start_date: addDays(today, -14), end_date: addDays(today, -8) };
    if (/this month|last 30 days|past month/.test(question)) return { start_date: addDays(today, -30), end_date: addDays(today, -1) };
    return { start_date: addDays(today, -28), end_date: addDays(today, -1) };
  }

  private plan(q: string, available: Set<string>): Array<{ name: string; args: Record<string, unknown> }> {
    const range = this.range(q);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const want = (name: string, args: Record<string, unknown>) => {
      if (available.has(name)) calls.push({ name, args });
    };
    if (/status|connected|fresh|synced|what data/.test(q)) want("get_sync_status", {});
    if (/landing page|pages? (are|is)|which pages/.test(q) && /organic|search console|seo|google search/.test(q)) {
      want("get_search_pages", { ...range, limit: 10, sort_by: /improv|gain/.test(q) ? "impressions_change" : "clicks", min_impressions: 50, contains: null });
    } else if (/landing page|which pages/.test(q) && available.has("get_ga4_landing_pages")) {
      want("get_ga4_landing_pages", { ...range, limit: 10, sort_by: /improv|gain/.test(q) ? "sessions_change" : "sessions", channel_group: null });
    }
    if (/quer|keyword|impressions but|weak ctr|low ctr|opportunit|brand/.test(q) && !/ads|paid|search term/.test(q)) {
      want("get_search_queries", { ...range, limit: 15, sort_by: /impressions but|weak ctr|low ctr|opportunit/.test(q) ? "opportunity" : /gain/.test(q) ? "impressions_change" : "clicks", min_impressions: 100, brand_filter: /non[- ]brand/.test(q) ? "non_brand" : /brand/.test(q) ? "brand" : "all", contains: null });
    }
    if (/search term|wasting|wasted spend/.test(q)) want("get_ads_search_terms", { ...range, limit: 15, sort_by: "wasted_spend", min_cost: 0 });
    if (/campaign|cpa|roas|ad spend|cost per/.test(q) && !/search term/.test(q)) want("get_ads_campaign_performance", { ...range, compare_with_previous_period: true, sort_by: /cpa/.test(q) ? "cpa" : "cost", limit: 15 });
    if (/ad group/.test(q)) want("get_ads_ad_group_performance", { ...range, sort_by: "cost", limit: 15 });
    if (/keyword/.test(q) && /ads|paid/.test(q)) want("get_ads_keyword_performance", { ...range, sort_by: "cost", limit: 15 });
    if (/paid (and|vs|versus) organic|organic (and|vs|versus) paid|compare paid|compare channels|channel/.test(q)) want("compare_channels", { ...range, compare_with_previous_period: true });
    if (/conversion|purchase|subscri|sign ?up|lead/.test(q) && !/ads|campaign/.test(q)) want("get_ga4_business_conversions", { ...range, compare_with_previous_period: true });
    if (/device|mobile|desktop/.test(q)) want(available.has("get_ga4_devices") && !/search console|organic/.test(q) ? "get_ga4_devices" : "get_search_performance", available.has("get_ga4_devices") && !/search console|organic/.test(q) ? { ...range, compare_with_previous_period: true } : { ...range, compare_with_previous_period: true, breakdown: "device" });
    if (/traffic|sessions|users|acquisition|source|medium/.test(q) && available.has("get_ga4_acquisition") && !/organic only|search console/.test(q)) want("get_ga4_acquisition", { ...range, compare_with_previous_period: true, group_by: "channel_group", limit: 15 });
    if (/what changed|compare|vs|previous|trend|happened|traffic|organic|search performance|clicks|impressions/.test(q) || calls.length === 0) {
      if (/what changed|happened/.test(q) && available.has("compare_date_ranges")) {
        want("compare_date_ranges", { ...range, compare_with: "previous_period" });
      } else {
        want("get_search_performance", { ...range, compare_with_previous_period: true, breakdown: "none" });
      }
    }
    // de-duplicate by name
    const seen = new Set<string>();
    return calls.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  }

  private answer(outputs: Array<{ call_id: string; output: string }>): string {
    const parts: string[] = [];
    for (const o of outputs) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(o.output) as Record<string, unknown>;
      } catch {
        parts.push("A tool returned an unreadable result.");
        continue;
      }
      if (data.error) {
        parts.push(`I could not retrieve ${String(data.source ?? "that data")}: ${String(data.error)}`);
        continue;
      }
      const label = String(data.source_label ?? data.source ?? "data");
      const range = data.date_range as { start: string; end: string } | undefined;
      const totals = data.totals as Record<string, unknown> | undefined;
      const rawChanges = data.changes as Record<string, { current: number; previous: number; pct_change: number | null } | null> | undefined;
      const changes = rawChanges ? Object.fromEntries(Object.entries(rawChanges).filter(([, c]) => c && typeof c === "object" && "current" in c)) as Record<string, { current: number; previous: number; pct_change: number | null }> : undefined;
      const rows = data.rows as Array<Record<string, unknown>> | undefined;
      const warnings = (data.warnings as string[]) ?? [];
      const head = range ? `${label} (${range.start} to ${range.end})` : label;
      const lines: string[] = [`**${head}**`];
      if (totals) lines.push("Totals: " + Object.entries(totals).map(([k, v]) => `${k} ${v === null ? "n/a" : String(v)}`).join(", ") + ".");
      if (changes) {
        lines.push(
          "Observation vs previous period: " +
            Object.entries(changes)
              .map(([k, c]) => `${k} ${c.previous} → ${c.current}${c.pct_change === null ? " (no baseline)" : ` (${c.pct_change > 0 ? "+" : ""}${c.pct_change}%)`}`)
              .join("; ") +
            ".",
        );
      }
      if (rows && rows.length) {
        const keys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== "object").slice(0, 6);
        lines.push("Top rows:");
        for (const r of rows.slice(0, 8)) lines.push("- " + keys.map((k) => `${k}: ${String(r[k])}`).join(", "));
      } else if (rows) {
        lines.push("No rows were returned for this request.");
      }
      if (data.sources) {
        const srcs = data.sources as Array<Record<string, unknown>>;
        lines.push(...srcs.map((s) => `- ${String(s.label)}: ${String(s.status)}${s.data_through ? `, data through ${String(s.data_through)}` : ""}`));
      }
      if (warnings.length) lines.push("Caveats: " + warnings.join(" "));
      parts.push(lines.join("\n"));
    }
    parts.push("_Hypothesis: none offered — the mock assistant reports observations only. Configure OPENAI_MODE=live for interpreted answers._");
    return parts.join("\n\n");
  }
}
