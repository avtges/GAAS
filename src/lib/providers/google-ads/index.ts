import { getEnv } from "@/lib/env";
import type { GoogleAdsProvider } from "./types";
import { LiveGoogleAdsProvider } from "./live";
import { MockGoogleAdsProvider } from "./mock";

let instance: GoogleAdsProvider | undefined;

export function getGoogleAdsProvider(): GoogleAdsProvider {
  if (!instance) instance = getEnv().GOOGLE_PROVIDER_MODE === "mock" ? new MockGoogleAdsProvider() : new LiveGoogleAdsProvider();
  return instance;
}

export function setGoogleAdsProvider(p: GoogleAdsProvider | undefined): void {
  instance = p;
}

export type { GoogleAdsProvider, AdsAccount, AdsRow } from "./types";
