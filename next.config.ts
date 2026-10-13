import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Playwright (live-preview thumbnails, v1.22) must stay external — bundling
  // it into the server build breaks its lazy browser discovery.
  serverExternalPackages: ["playwright", "playwright-core"],
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
