import assert from "node:assert/strict";
import { test } from "node:test";
import { maintenanceClient } from "../scripts/lib/maintenance-client.mjs";

const envKeys = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVER_SECRET_KEY"];

function withEnvironment(values, run) {
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, values);
  try { run(); }
  finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("maintenance mode must be explicit", () => {
  assert.throws(() => maintenanceClient("--hosted"), /explicit/);
});

test("remote maintenance requires a server URL and secret key", () => {
  withEnvironment({}, () => assert.throws(() => maintenanceClient("--remote"), /credentials are missing/));
});

test("remote maintenance rejects non-HTTPS public endpoints", () => {
  withEnvironment({ SUPABASE_URL: "http://project.example", SUPABASE_SERVER_SECRET_KEY: "test-secret" }, () => {
    assert.throws(() => maintenanceClient("--remote"), /must use HTTPS/);
  });
});

test("remote maintenance accepts HTTPS and never needs the CLI", () => {
  withEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://project.example", SUPABASE_SERVER_SECRET_KEY: "test-secret" }, () => {
    const client = maintenanceClient("--remote");
    assert.equal(typeof client.rpc, "function");
  });
});
