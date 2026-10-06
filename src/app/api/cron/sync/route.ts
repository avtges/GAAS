import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { runDueSyncs } from "@/lib/sync/runner";

export const maxDuration = 300;

/**
 * Scheduled sync endpoint. Vercel Cron (or any scheduler) calls it with
 * `Authorization: Bearer $CRON_SECRET`. Each invocation processes a bounded batch.
 */
export async function GET(request: NextRequest) {
  const env = getEnv();
  if (!env.CRON_SECRET) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.CRON_SECRET}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const results = await runDueSyncs({ budgetMs: 200_000 });
  return NextResponse.json({ processed: results.length, results });
}
