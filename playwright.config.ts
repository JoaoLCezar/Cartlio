import { quadricsEnv } from "./scripts/lib/quadrics-env.mjs";
import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

const isWindows = process.platform === "win32";
const configuredUrl = quadricsEnv("TEST_SUPABASE_URL");
const configuredPublishableKey = quadricsEnv("TEST_SUPABASE_PUBLISHABLE_KEY");
const configuredSecretKey = quadricsEnv("TEST_SUPABASE_SECRET_KEY");
const rawStatus = configuredUrl && configuredPublishableKey && configuredSecretKey
  ? null
  : execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    shell: isWindows,
  });
const local = configuredUrl && configuredPublishableKey && configuredSecretKey
  ? {
    API_URL: configuredUrl,
    PUBLISHABLE_KEY: configuredPublishableKey,
    SERVICE_ROLE_KEY: configuredSecretKey,
  }
  : JSON.parse(rawStatus!.replace(/^\uFEFF/, "")) as {
    API_URL: string;
    PUBLISHABLE_KEY: string;
    SERVICE_ROLE_KEY: string;
  };

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL ?? "http://127.0.0.1:3310";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  testIgnore: configuredUrl && configuredPublishableKey && configuredSecretKey
    ? []
    : ["**/restored-instance.spec.ts"],
  reporter: "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions: isWindows && !process.env.CI ? { channel: "msedge" } : {},
    trace: "retain-on-failure",
  },
  webServer: externalBaseURL ? undefined : {
    command: "npm run build:e2e && npm run start",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
      SUPABASE_SERVER_SECRET_KEY: local.SERVICE_ROLE_KEY,
      QUADRICS_TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for",
      QUADRICS_APP_URL: baseURL,
      // Keep the standalone tree under the already ignored node_modules directory.
      // Otherwise Turbopack watches .next-e2e/standalone/node_modules during E2E builds.
      QUADRICS_NEXT_DIST_DIR: "node_modules/.cache/quadrics-next-e2e",
      QUADRICS_NEXT_TSCONFIG: "tsconfig.e2e.json",
      HOSTNAME: "127.0.0.1",
      PORT: "3310",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
