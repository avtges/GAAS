import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GAAS — talk to your marketing data",
  description: "Connect Google Search Console, GA4 and Google Ads, then ask questions grounded in your own data.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">{children}</body>
    </html>
  );
}
