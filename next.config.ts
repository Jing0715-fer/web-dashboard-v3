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
  // v1.29: hide the dev-tools indicator — this dashboard ships as a dev-mode
  // tool, and the floating "Open Next.js Dev Tools" button overlapped the
  // status footer on narrow screens (real UI-audit finding).
  devIndicators: false,
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
};

export default nextConfig;
