import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export — served via Nginx behind Twingate per architecture doc.
  // No Node server runtime; data fetching happens client-side against
  // Weaviate via the native v4 TS client.
  output: "export",
  images: {
    // Required by static export — no runtime image optimizer is available.
    unoptimized: true,
  },
  // Trailing slash so Nginx can serve /search/ -> /search/index.html.
  trailingSlash: true,
};

export default nextConfig;
