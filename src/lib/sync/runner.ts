import { withServiceDb, one, many } from "@/lib/db/pool";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { GoogleApiError } from "@/lib/providers/errors";
import { GoogleOAuthError } from "@/lib/google/oauth";
import { markConnectionRevoked } from "@/lib/google/connections";
import type { Source } from "@/lib/websites/service";
import type { SourceSyncer, SyncKind, SyncOutcome } from "@/lib/sync/types";
import { syncSearchConsole } from "@/lib/sync/gsc";
import { syncGa4 } from "@/lib/sync/ga4";
import { syncGoogleAds } from "@/lib/sync/ads";

const SYNCERS: Partial<Record<Source, SourceSyncer>> = { gsc: syncSearchConsole, ga4: syncGa4, ads: syncGoogleAds };

export function registerSyncer(source: Source, syncer: SourceSyncer): void {
  SYNCERS[source] = syncer;
}

const LEASE_MINUTES = 15;
const DEFAULT_BUDGET_MS = 45_000;

export type RunSyncResult = { status: "succeeded" | "failed" | "skipped"; outcome?: SyncOutcome; error?: string };

/**
 * Runs one sync for one website source with job bookkeeping. Sources are independent: a
 * failure here only affects this source's status. Safe to call from a cron tick, a manual
 * "Sync now" action, or tests.
 */
export async function runSync(websiteId: string, source: Source, opts: { budgetMs?: number; now?: () => Date; force?: boolean } = {}): Promise<RunSyncResult> {
  const env = getEnv();
  const now = opts.now ?? (() => new Date());
  const syncer = SYNCERS[source];
  if (!syncer) return { status: "skipped", error: `No syncer registered for ${source}` };

  // Claim the source (lease) so two invocations never sync the same source concurrently.
  const claimed = await withServiceDb((db) =>
    one<{ organization_id: string; backfill_done: boolean; kind: SyncKind }>(
      db,
      `update public.website_sources s
         set status = 'syncing', last_sync_started_at = now()
       where s.website_id = $1 and s.source = $2
         and s.status in ('ok','error','syncing')
         and (s.status <> 'syncing' or s.last_sync_started_at < now() - interval '${LEASE_MINUTES} minutes' or $3)
       returning s.organization_id, s.backfill_done, (case when s.backfill_done then 'incremental' else 'backfill' end) as kind`,
      [websiteId, source, opts.force === true],
    ),
  );
  if (!claimed) return { status: "skipped", error: "Source is not configured, is revoked/disconnected, or is already syncing." };

  const jobId = await withServiceDb(async (db) => {
    const r = await one<{ id: string }>(
      db,
      "insert into public.sync_jobs (organization_id, website_id, source, kind) values ($1, $2, $3, $4) returning id",
      [claimed.organization_id, websiteId, source, claimed.kind],
    );
    return r!.id;
  });
  const started = Date.now();
  log.info("sync started", { organizationId: claimed.organization_id, websiteId, source, kind: claimed.kind, jobId });

  try {
    const outcome = await syncer({
      websiteId,
      organizationId: claimed.organization_id,
      source,
      kind: claimed.kind,
      deadline: started + (opts.budgetMs ?? DEFAULT_BUDGET_MS),
      now,
    });
    const duration = Date.now() - started;
    await withServiceDb(async (db) => {
      await db.query(
        `update public.sync_jobs set finished_at = now(), status = 'succeeded', data_through = $2, range_start = $3, range_end = $4, rows_written = $5, duration_ms = $6 where id = $1`,
        [jobId, outcome.dataThrough, outcome.rangeStart, outcome.rangeEnd, outcome.rowsWritten, duration],
      );
      await db.query(
        `update public.website_sources set status = 'ok', last_error = null, last_sync_succeeded_at = now(),
           data_through = coalesce($3, data_through),
           backfill_done = backfill_done or $4,
           backfill_cursor = case when $4 then null else backfill_cursor end,
           limitations = coalesce($5::jsonb, limitations),
           next_sync_at = case when $4 then now() + ($6 || ' minutes')::interval else now() end
         where website_id = $1 and source = $2`,
        [websiteId, source, outcome.dataThrough, outcome.complete, outcome.limitations ? JSON.stringify(outcome.limitations) : null, String(env.SYNC_INTERVAL_MINUTES)],
      );
    });
    log.info("sync completed", { organizationId: claimed.organization_id, websiteId, source, kind: claimed.kind, rows: outcome.rowsWritten, dataThrough: outcome.dataThrough, durationMs: duration, complete: outcome.complete });
    return { status: "succeeded", outcome };
  } catch (e) {
    const duration = Date.now() - started;
    const { message, status } = classify(e);
    await withServiceDb(async (db) => {
      await db.query("update public.sync_jobs set finished_at = now(), status = 'failed', error_message = $2, duration_ms = $3 where id = $1", [jobId, message, duration]);
      await db.query(
        `update public.website_sources set status = $3, last_error = $4,
           next_sync_at = case when $3 = 'error' then now() + interval '30 minutes' else null end
         where website_id = $1 and source = $2`,
        [websiteId, source, status, message],
      );
    });
    if (status === "revoked") {
      const conn = await withServiceDb((db) => one<{ google_connection_id: string | null }>(db, "select google_connection_id from public.websites where id = $1", [websiteId]));
      if (conn?.google_connection_id) await markConnectionRevoked(conn.google_connection_id, message);
    }
    log.error("sync failed", { organizationId: claimed.organization_id, websiteId, source, kind: claimed.kind, durationMs: duration, error: message });
    return { status: "failed", error: message };
  }
}

function classify(e: unknown): { message: string; status: "error" | "revoked" } {
  if (e instanceof GoogleOAuthError && e.isRevoked) return { message: "Google access was revoked or expired. Reconnect Google.", status: "revoked" };
  if (e instanceof GoogleApiError) {
    switch (e.kind) {
      case "unauthenticated":
        return { message: "Google rejected the credentials. Reconnect Google.", status: "revoked" };
      case "permission_denied":
        return { message: `Google denied access: ${e.message}. Check that the account still has permission and the required scope was granted.`, status: "error" };
      case "not_found":
        return { message: `The selected property or account was not found (it may have been deleted): ${e.message}`, status: "error" };
      case "rate_limited":
        return { message: "Google API quota exceeded; the sync will retry later.", status: "error" };
      case "unavailable":
      case "network":
        return { message: "Google API was unavailable; the sync will retry later.", status: "error" };
      case "malformed":
        return { message: `Google returned an unexpected response: ${e.message}`, status: "error" };
      default:
        return { message: e.message, status: "error" };
    }
  }
  return { message: e instanceof Error ? e.message : String(e), status: "error" };
}

/** Cron entry point: process due sources, oldest first, within a batch size. */
export async function runDueSyncs(opts: { batchSize?: number; budgetMs?: number } = {}): Promise<Array<{ websiteId: string; source: Source } & RunSyncResult>> {
  const env = getEnv();
  const due = await withServiceDb((db) =>
    many<{ website_id: string; source: Source }>(
      db,
      `select website_id, source from public.website_sources
       where status in ('ok','error') and next_sync_at is not null and next_sync_at <= now()
       order by next_sync_at asc limit $1`,
      [opts.batchSize ?? env.SYNC_BATCH_SIZE],
    ),
  );
  const results = [];
  for (const d of due) {
    const r = await runSync(d.website_id, d.source, { budgetMs: opts.budgetMs });
    results.push({ websiteId: d.website_id, source: d.source, ...r });
  }
  return results;
}
