import type { ZodType } from "zod";
import { GoogleApiError, kindFromStatus } from "@/lib/providers/errors";
import { log } from "@/lib/logger";

export type GoogleAuth = { accessToken: string };

type FetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  service: string;
  /** Retries for transient errors (429/5xx/network). */
  retries?: number;
  signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal, dependency-free Google REST client: bearer auth, JSON, bounded retries with
 * exponential backoff, uniform error classification and schema validation of the body.
 * The Authorization header is never logged.
 */
export async function googleFetch<T>(url: string, auth: GoogleAuth, schema: ZodType<T>, opts: FetchOptions): Promise<T> {
  const retries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    attempt++;
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (e) {
      if (attempt <= retries) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new GoogleApiError("network", `${opts.service}: ${(e as Error).message}`, undefined, opts.service);
    }

    if (res.ok) {
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new GoogleApiError("malformed", `${opts.service}: response was not JSON`, res.status, opts.service);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        log.warn("google api response failed schema validation", { service: opts.service, issues: parsed.error.issues.slice(0, 5) });
        throw new GoogleApiError("malformed", `${opts.service}: unexpected response shape (${parsed.error.issues[0]?.path.join(".")})`, res.status, opts.service);
      }
      return parsed.data;
    }

    const kind = kindFromStatus(res.status);
    const detail = await res.text().catch(() => "");
    let message = `${opts.service}: HTTP ${res.status}`;
    try {
      const j = JSON.parse(detail) as { error?: { message?: string; status?: string } | string };
      if (typeof j.error === "object" && j.error?.message) message += ` ${j.error.message}`;
      else if (typeof j.error === "string") message += ` ${j.error}`;
    } catch {
      /* non-JSON error body */
    }
    const err = new GoogleApiError(kind, message, res.status, opts.service);
    if (err.isTransient && attempt <= retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1));
      continue;
    }
    throw err;
  }
}
