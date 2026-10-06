import type { Source } from "@/lib/websites/service";

export type SyncKind = "backfill" | "incremental";

export type SyncContext = {
  websiteId: string;
  organizationId: string;
  source: Source;
  kind: SyncKind;
  /** Wall-clock budget for this invocation; the sync must return before it elapses. */
  deadline: number;
  now: () => Date;
};

export type SyncOutcome = {
  rowsWritten: number;
  /** Last date for which data is considered complete. */
  dataThrough: string | null;
  rangeStart: string;
  rangeEnd: string;
  /** False when the backfill was interrupted by the time budget and must resume. */
  complete: boolean;
  limitations?: Record<string, unknown>;
};

export type SourceSyncer = (ctx: SyncContext) => Promise<SyncOutcome>;
