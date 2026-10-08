import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  devIndicators: false,
  allowedDevOrigins: [
    "*.space-z.ai",
    "*.preview-chat-*.space-z.ai",
  ],
};

export default nextConfig;
