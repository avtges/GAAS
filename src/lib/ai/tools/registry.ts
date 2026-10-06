import { z, type ZodObject, type ZodRawShape } from "zod";
import type { Website, Source } from "@/lib/websites/service";
import type { SourceFreshness } from "@/lib/analytics/status";

/**
 * Typed, bounded AI tools. The model only ever sees the JSON schema and the JSON result.
 * Organization/website/user context is injected server-side from the authenticated
 * request and can never be supplied by the model.
 */
export type ToolContext = {
  userId: string;
  website: Website;
  /** Freshness per source, loaded once per chat turn. */
  freshness: SourceFreshness[];
  now: () => Date;
  today: string; // in the website's time zone
};

export type ToolEnvelope = {
  source: Source | "multiple" | "system";
  source_label: string;
  measurement?: string;
  date_range?: { start: string; end: string } | null;
  comparison_range?: { start: string; end: string } | null;
  data_through?: Record<string, string | null>;
  filters?: Record<string, unknown>;
  warnings: string[];
  [key: string]: unknown;
};

export type ToolDefinition<S extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>> = {
  name: string;
  description: string;
  schema: S;
  sources: Source[];
  execute: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolEnvelope>;
};

export function defineTool<S extends ZodObject<ZodRawShape>>(def: ToolDefinition<S>): ToolDefinition<S> {
  if (!/^[a-z_]{3,64}$/.test(def.name)) throw new Error(`invalid tool name ${def.name}`);
  return def;
}

/** Keywords OpenAI strict mode does not accept; the Zod schema still enforces them at execution. */
const STRIP_KEYWORDS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "default", "$schema"]);

export function toStrictJsonSchema(schema: ZodObject<ZodRawShape>): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (STRIP_KEYWORDS.has(k)) continue;
        out[k] = walk(v);
      }
      if (out.type === "object") {
        out.additionalProperties = false;
        out.required = Object.keys((out.properties as Record<string, unknown>) ?? {});
      }
      return out;
    }
    return node;
  };
  return walk(raw) as Record<string, unknown>;
}

export type OpenAIFunctionTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict: true };

export function toOpenAITool(def: ToolDefinition): OpenAIFunctionTool {
  return { type: "function", name: def.name, description: def.description, parameters: toStrictJsonSchema(def.schema), strict: true };
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  register(def: ToolDefinition): this {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
    this.tools.set(def.name, def);
    return this;
  }
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
  openAITools(): OpenAIFunctionTool[] {
    return this.list().map(toOpenAITool);
  }
}

/** Shared helpers for tool implementations. */
export function freshnessFor(ctx: ToolContext, source: Source): { data_through: string | null; status: string; note: string | null } {
  const f = ctx.freshness.find((x) => x.source === source);
  if (!f || !f.configured) return { data_through: null, status: "not_configured", note: `${source} is not connected for this website.` };
  const notes: string[] = [];
  if (f.status === "error" || f.status === "revoked") notes.push(`Last sync failed: ${f.last_error ?? f.status}. Data may be stale.`);
  if (f.limitations && typeof f.limitations === "object") {
    const l = f.limitations as Record<string, unknown>;
    if (l.sampled) notes.push("GA4 reported sampling for some of the imported data.");
    if (l.thresholded) notes.push("GA4 applied data thresholds; small segments may be withheld.");
    if (l.data_loss_from_other_row) notes.push("GA4 grouped some low-volume rows into '(other)'.");
  }
  return { data_through: f.data_through, status: f.status, note: notes.length ? notes.join(" ") : null };
}

export function clampRangeToDataThrough(range: { start: string; end: string }, dataThrough: string | null, warnings: string[]): { start: string; end: string } {
  if (dataThrough && range.end > dataThrough) {
    warnings.push(`Data is only complete through ${dataThrough}; days after that are missing or partial.`);
  }
  return range;
}
