import { quadricsEnv } from "./scripts/lib/quadrics-env.mjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: quadricsEnv("NEXT_DIST_DIR") ?? ".next",
  output: "standalone",
  typescript: {
    // Temporary production builds (E2E and restore checks) must not rewrite
    // the developer's main tsconfig with their generated route types.
    tsconfigPath: quadricsEnv("NEXT_TSCONFIG") ?? "tsconfig.json",
  },
  experimental: {
    serverActions: { bodySizeLimit: "3mb" },
  },
  async headers() {
    const globalHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ...(process.env.NODE_ENV === "production"
        ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
        : []),
    ];
    return [
      { source: "/:path*", headers: globalHeaders },
      { source: "/g/:path*", headers: [
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      ] },
    ];
  },
};

export default nextConfig;
