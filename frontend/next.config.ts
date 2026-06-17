import type { NextConfig } from "next";

// Standalone Node server (output: "standalone") — produces a self-contained
// `.next/standalone` build for a slim Docker/Cloud Run image. Data fetching is
// server-side via App Router route handlers (`/api/*`) that query Weaviate with
// the TS client; the browser only calls same-origin `/api/*`. No static export.
const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
