/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        // Wildcard subdomain — matches any Supabase project's Storage host,
        // since the project ref (NEXT_PUBLIC_SUPABASE_URL) differs per deployment.
        hostname: "**.supabase.co",
        pathname: "/storage/v1/object/**",
      },
      {
        // avatarUrl can also come from GitHub profile import (backend/src/app.ts
        // ghData.avatarUrl), which next/image also needs allowlisted.
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
    ],
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        // Deny framing on all non-embed routes to mitigate clickjacking.
        // The pattern uses a path-segment boundary "embed(/|$)" so only
        // /embed and its children are excluded — not any future route that
        // merely starts with the same letters.
        // Content-Security-Policy is set in middleware.ts instead of here:
        // process.env is only resolved at build time in next.config.mjs,
        // which bakes in an empty connect-src on hosts where these vars
        // are injected at runtime rather than build time.
        source: "/((?!embed(/|$)).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
      {
        // Allow cross-origin embedding of the embed widget pages
        source: "/embed/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
        ],
      },
    ];
  },
};

export default nextConfig;
