import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // Server-only packages must not be bundled for the browser.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
