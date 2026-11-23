import assert from "node:assert/strict";
import test from "node:test";
import { validateProductionConfig } from "../scripts/lib/production-config.mjs";

const validConfig = {
  CARTLIO_APP_URL: "https://studio.example.test",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  SUPABASE_SERVER_SECRET_KEY: "sb_secret_fixture",
  CARTLIO_TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
  CARTLIO_SMTP_HOST: "smtp.example.test",
  CARTLIO_SMTP_PORT: "587",
  CARTLIO_SMTP_FROM: "Cartlio <gallery@example.test>",
};

test("production configuration accepts HTTPS origins, server secret, and TLS SMTP", () => {
  assert.deepEqual(validateProductionConfig(validConfig), []);
  assert.deepEqual(validateProductionConfig({
    ...validConfig,
    CARTLIO_SMTP_SECURE: "true",
    CARTLIO_SMTP_PORT: "465",
    CARTLIO_SMTP_USER: "cartlio",
    CARTLIO_SMTP_PASSWORD: "mail-secret",
  }), []);
});

test("Quadrics values take precedence while legacy environment variables remain supported", () => {
  const config = { ...validConfig, QUADRICS_APP_URL: "https://quadrics.example.test", CARTLIO_APP_URL: "http://legacy.example.test" };
  assert.deepEqual(validateProductionConfig(config), []);
  assert.ok(validateProductionConfig({ ...config, QUADRICS_APP_URL: "", CARTLIO_APP_URL: "https://legacy.example.test" })
    .some(error => error.startsWith("QUADRICS_APP_URL")));
});

test("production configuration requires canonical URLs and server-only Supabase credentials", () => {
  const errors = validateProductionConfig({
    ...validConfig,
    CARTLIO_APP_URL: "http://studio.example.test",
    NEXT_PUBLIC_SUPABASE_URL: "http://project.supabase.co",
    SUPABASE_SERVER_SECRET_KEY: "",
  });
  assert.ok(errors.some(error => error.startsWith("QUADRICS_APP_URL")));
  assert.ok(errors.some(error => error.startsWith("NEXT_PUBLIC_SUPABASE_URL")));
  assert.ok(errors.some(error => error.startsWith("SUPABASE_SERVER_SECRET_KEY")));
});

test("production configuration rejects paths and credentials in canonical origins", () => {
  assert.ok(validateProductionConfig({
    ...validConfig,
    CARTLIO_APP_URL: "https://user:pass@studio.example.test/path",
  }).some(error => error.startsWith("QUADRICS_APP_URL")));
});

test("production configuration rejects partial SMTP credentials and disabled TLS", () => {
  const errors = validateProductionConfig({
    ...validConfig,
    CARTLIO_SMTP_USER: "cartlio",
    CARTLIO_SMTP_REQUIRE_TLS: "false",
  });
  assert.ok(errors.some(error => error.includes("configured together")));
  assert.ok(errors.some(error => error.includes("must use TLS")));
});

test("production configuration rejects control characters in SMTP host and sender", () => {
  const errors = validateProductionConfig({
    ...validConfig,
    CARTLIO_SMTP_HOST: "smtp.example.test\r\nattacker.test",
    CARTLIO_SMTP_FROM: "Cartlio <gallery@example.test>\r\nBcc: attacker@example.test",
  });
  assert.ok(errors.some(error => error.startsWith("QUADRICS_SMTP_HOST")));
  assert.ok(errors.some(error => error.startsWith("QUADRICS_SMTP_FROM")));
});

test("production configuration rejects a public key reused as the server secret", () => {
  assert.ok(validateProductionConfig({
    ...validConfig,
    SUPABASE_SERVER_SECRET_KEY: validConfig.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  }).some(error => error.includes("must not contain the public key")));
});

test("production configuration requires one explicitly trusted client IP header", () => {
  assert.ok(validateProductionConfig({
    ...validConfig,
    CARTLIO_TRUSTED_CLIENT_IP_HEADER: undefined,
  }).some(error => error.startsWith("QUADRICS_TRUSTED_CLIENT_IP_HEADER")));
  for (const header of ["x-forwarded-for, x-real-ip", "forwarded", "x-client-ip"]) {
    assert.ok(validateProductionConfig({
      ...validConfig,
      CARTLIO_TRUSTED_CLIENT_IP_HEADER: header,
    }).some(error => error.startsWith("QUADRICS_TRUSTED_CLIENT_IP_HEADER")));
  }
  assert.deepEqual(validateProductionConfig({
    ...validConfig,
    CARTLIO_TRUSTED_CLIENT_IP_HEADER: "CF-Connecting-IP",
  }), []);
});
