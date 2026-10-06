import type { NextConfig } from "next";

/**
 * GitHub Codespaces serves the dev server at https://<codespace>-3000.app.github.dev while
 * forwarding requests to localhost:3000. Next.js would otherwise reject those requests
 * (dev-origin check, and the Server Actions CSRF origin check). These relaxations apply
 * ONLY inside a Codespace (GitHub sets CODESPACES=true); never in production.
 */
const inCodespaces = process.env.CODESPACES === "true";
const codespacesOrigins = ["*.app.github.dev"];

const nextConfig: NextConfig = {
  agentRules: false,
  // Server-only packages must not be bundled for the browser.
  serverExternalPackages: ["pg"],
  ...(inCodespaces ? { allowedDevOrigins: codespacesOrigins } : {}),
  experimental: {
    ...(inCodespaces ? { serverActions: { allowedOrigins: codespacesOrigins } } : {}),
  },
};

export default nextConfig;
