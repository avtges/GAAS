import { getEnv } from "@/lib/env";
import type { SearchConsoleProvider } from "./types";
import { LiveSearchConsoleProvider } from "./live";
import { MockSearchConsoleProvider } from "./mock";

let instance: SearchConsoleProvider | undefined;

export function getSearchConsoleProvider(): SearchConsoleProvider {
  if (!instance) instance = getEnv().GOOGLE_PROVIDER_MODE === "mock" ? new MockSearchConsoleProvider() : new LiveSearchConsoleProvider();
  return instance;
}

/** Test helper. */
export function setSearchConsoleProvider(p: SearchConsoleProvider | undefined): void {
  instance = p;
}

export type { SearchConsoleProvider, SiteEntry, SearchAnalyticsQueryRequest, SearchAnalyticsQueryResponse } from "./types";
