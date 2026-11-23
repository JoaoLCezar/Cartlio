import assert from "node:assert/strict";
import test from "node:test";
import { checkReadiness, parseReadinessUrl } from "../scripts/check-readiness.mjs";

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("readiness accepts a healthy response without exposing credentials", async () => {
  let request;
  const result = await checkReadiness("http://127.0.0.1:3000/api/ready", {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { status: "ready", checks: { database: "ok", storage: "ok", clientIp: "ok" } });
    },
  });
  assert.deepEqual(result, { status: "ready", database: "ok", storage: "ok", clientIp: "ok" });
  assert.equal(request.options.redirect, "manual");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.equal(new URL(request.url).search, "");
});

test("readiness fails when a dependency is unavailable even if the response is HTTP 200", async () => {
  await assert.rejects(checkReadiness("http://localhost/api/ready", {
    fetchImpl: async () => response(200, { status: "not_ready", checks: { database: "ok", storage: "unavailable", clientIp: "ok" } }),
  }), /Readiness failed .*storage=unavailable/);
});

test("readiness fails when the production client IP header is misconfigured", async () => {
  await assert.rejects(checkReadiness("https://status.example.com/api/ready", {
    fetchImpl: async () => response(503, {
      status: "not_ready",
      checks: { database: "ok", storage: "ok", clientIp: "misconfigured" },
    }),
  }), /Readiness failed .*client_ip=misconfigured/);
});

test("readiness fails on service errors and does not follow redirects", async () => {
  let requestedRedirectMode;
  await assert.rejects(checkReadiness("https://status.example.com/api/ready", {
    fetchImpl: async (_url, options) => {
      requestedRedirectMode = options.redirect;
      return response(503, { status: "not_ready", checks: { database: "unavailable", storage: "unavailable", clientIp: "misconfigured" } });
    },
  }), /HTTP 503/);
  assert.equal(requestedRedirectMode, "manual");
});

test("readiness accepts HTTPS externally and restricts insecure and credential-bearing URLs", () => {
  assert.equal(parseReadinessUrl("https://status.example.com/api/ready").protocol, "https:");
  for (const url of [
    "http://status.example.com/api/ready",
    "https://user:secret@status.example.com/api/ready",
    "https://status.example.com/api/ready?key=secret",
    "https://status.example.com/health",
  ]) {
    assert.throws(() => parseReadinessUrl(url));
  }
});

test("readiness timeout must be within the supported bound", async () => {
  await assert.rejects(checkReadiness("http://127.0.0.1/api/ready", { timeoutMs: 0 }), /between 1 and 30000/);
  await assert.rejects(checkReadiness("http://127.0.0.1/api/ready", { timeoutMs: 30_001 }), /between 1 and 30000/);
});
