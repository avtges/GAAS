import { z } from "zod";

/**
 * Environment configuration. Parsed lazily so `next build` does not require secrets.
 * Anything optional here is validated again at the point of use (e.g. OAuth start
 * throws a clear error if GOOGLE_CLIENT_ID is missing in live mode).
 */
const intFromEnv = (def: number, min = 0, max = 100000) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  GOOGLE_PROVIDER_MODE: z.enum(["live", "mock"]).default("mock"),
  OPENAI_MODE: z.enum(["live", "mock"]).default("mock"),
  AUTH_MODE: z.enum(["supabase", "local"]).default("supabase"),

  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  DATABASE_URL: z.string().min(1),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_API_VERSION: z.string().regex(/^v\d+$/).default("v25"),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1"),

  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  CRON_SECRET: z.string().optional(),

  SYNC_BACKFILL_DAYS: intFromEnv(90, 1, 400),
  RECONCILIATION_DAYS_GSC: intFromEnv(3, 0, 60),
  RECONCILIATION_DAYS_GA4: intFromEnv(3, 0, 60),
  RECONCILIATION_DAYS_ADS: intFromEnv(7, 0, 90),
  GSC_ROW_CAP_PER_DAY: intFromEnv(2500, 100, 25000),
  SYNC_INTERVAL_MINUTES: intFromEnv(360, 5, 10080),
  SYNC_BATCH_SIZE: intFromEnv(5, 1, 50),
  AI_MAX_TOOL_ROUNDS: intFromEnv(6, 1, 12),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;
  if (env.AUTH_MODE === "local" && env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=local is a development-only setting and cannot be used in production.");
  }
  if (env.AUTH_MODE === "local" && !env.TOKEN_ENCRYPTION_KEY) {
    throw new Error("AUTH_MODE=local requires TOKEN_ENCRYPTION_KEY to sign the dev session cookie.");
  }
  cached = env;
  return env;
}

/** Test helper: clear the memoised environment. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** Required-at-use accessor with a helpful message. */
export function requireEnv<K extends keyof Env>(key: K, why: string): NonNullable<Env[K]> {
  const v = getEnv()[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing environment variable ${String(key)} (${why}). See .env.example.`);
  }
  return v as NonNullable<Env[K]>;
}
