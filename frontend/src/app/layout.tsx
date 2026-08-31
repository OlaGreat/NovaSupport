import type { Metadata } from "next";
import Script from "next/script";
import { SITE_URL } from "@/lib/config";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "NovaSupport",
  description:
    "Stellar-native support profiles for maintainers, creators, and developers.",
  // #774: PWA manifest and theme color
  manifest: "/manifest.json",
  themeColor: "#00e5be",
  openGraph: {
    title: "NovaSupport",
    description:
      "Stellar-native support profiles for maintainers, creators, and developers.",
    url: SITE_URL,
    siteName: "NovaSupport",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NovaSupport",
    description:
      "Stellar-native support profiles for maintainers, creators, and developers.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Loaded from a static file rather than inlined: the CSP set in
          middleware.ts is `script-src 'self' 'unsafe-inline'` with no nonce,
          because statically prerendered pages can't carry a per-request
          nonce and adding one would make browsers ignore 'unsafe-inline'
          (see middleware.ts). A same-origin external script needs neither —
          it's allowed by 'self' alone. `beforeInteractive` is next/script's
          mechanism for a script that must run before hydration/paint (same
          timing an inline anti-flash script needs), so it avoids the theme
          flash without tripping @next/next/no-sync-scripts.
        */}
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
