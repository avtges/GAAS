import { getEnv } from "@/lib/env";
import type { Ga4Provider } from "./types";
import { LiveGa4Provider } from "./live";
import { MockGa4Provider } from "./mock";

let instance: Ga4Provider | undefined;

export function getGa4Provider(): Ga4Provider {
  if (!instance) instance = getEnv().GOOGLE_PROVIDER_MODE === "mock" ? new MockGa4Provider() : new LiveGa4Provider();
  return instance;
}

export function setGa4Provider(p: Ga4Provider | undefined): void {
  instance = p;
}

export type { Ga4Provider, AccountSummary, KeyEvent, Ga4Property } from "./types";
