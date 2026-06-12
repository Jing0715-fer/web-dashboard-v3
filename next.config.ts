import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone 模式: 产出 .next/standalone/server.js（项目用 project-manager.sh 启动）
  output: "standalone",
  allowedDevOrigins: [
    'preview-chat-ae8a34bd-c8a9-4464-ae34-38a84c9fe2d6.space-z.ai',
    'preview-chat-b5f0da22-2a0a-4a27-9c7d-8bc0a2dabb3d.space-z.ai',
  ],
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {},
};

export default nextConfig;
