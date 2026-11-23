import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalSupabaseStatus } from "../scripts/restore-fixture.mjs";

test("restore fixture accepts a local Supabase status without exposing its keys", () => {
  const parsed = parseLocalSupabaseStatus(JSON.stringify({
    API_URL: "http://127.0.0.1:54321",
    PUBLISHABLE_KEY: "public-test-key",
    SECRET_KEY: "secret-test-key",
  }));
  assert.deepEqual(parsed, {
    apiUrl: "http://127.0.0.1:54321",
    publishableKey: "public-test-key",
    serviceRoleKey: "secret-test-key",
  });
});

test("restore fixture rejects remote or non-HTTP Supabase endpoints", () => {
  for (const url of ["https://project.supabase.co", "http://192.168.1.5:54321", "http://localhost.attacker.test:54321"]) {
    assert.throws(() => parseLocalSupabaseStatus(JSON.stringify({
      API_URL: url,
      PUBLISHABLE_KEY: "public-test-key",
      SECRET_KEY: "secret-test-key",
    })), /local Supabase endpoint/);
  }
});

test("restore fixture rejects invalid status or incomplete local credentials", () => {
  assert.throws(() => parseLocalSupabaseStatus("not-json"), /valid local status/);
  assert.throws(() => parseLocalSupabaseStatus(JSON.stringify({ API_URL: "http://localhost:54321" })), /local keys required/);
});
