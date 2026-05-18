import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // Static export — served via Nginx behind Twingate per architecture doc.
  // No Node server runtime; data fetching happens client-side against
  // Weaviate via the native v4 TS client.
  //
  // Disabled in dev because Next.js forbids `rewrites()` when output is
  // "export". In production Nginx handles same-origin routing so no
  // rewrite is needed.
  ...(isDev ? {} : { output: "export" as const }),
  images: {
    // Required by static export — no runtime image optimizer is available.
    unoptimized: true,
  },
  // Trailing slash so Nginx can serve /search/ -> /search/index.html.
  trailingSlash: true,
  // Dev-only same-origin proxy to Weaviate. The browser POSTs to
  // `/api/weaviate/v1/graphql` and Next forwards server-side to WCD —
  // sidestepping CORS (WCD locks `Access-Control-Allow-Origin` to
  // `https://console.weaviate.cloud` only). In production the static
  // bundle is served behind Nginx/Twingate which routes same-origin
  // already, so this rewrite is not needed (and `output: "export"`
  // would refuse to compile with rewrites present anyway).
  ...(isDev && {
    async rewrites() {
      const target = (process.env.NEXT_PUBLIC_WEAVIATE_URL || "").replace(/\/$/, "");
      if (!target) return [];
      return [
        {
          source: "/api/weaviate/:path*",
          destination: `${target}/:path*`,
        },
      ];
    },
  }),
};

export default nextConfig;
