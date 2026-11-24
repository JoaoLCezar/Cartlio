import assert from "node:assert/strict";
import { test } from "node:test";
import { galleryClientIpConfigurationReady, galleryPinClientFingerprint } from "../src/lib/gallery-pin-client.ts";

function withEnvironment(values, callback) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { callback(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withSecret(secret, callback) {
  withEnvironment({
    SUPABASE_SERVER_SECRET_KEY: secret,
    CARTLIO_TRUSTED_CLIENT_IP_HEADER: undefined,
    NODE_ENV: "development",
  }, callback);
}

test("PIN client fingerprints are keyed and do not expose the client address", () => {
  withSecret("server-secret", () => {
    const request = new Request("http://localhost", { headers: { "x-real-ip": "203.0.113.8" } });
    const fingerprint = galleryPinClientFingerprint(request);
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(galleryPinClientFingerprint(request), fingerprint);
    assert.equal(fingerprint.includes("203.0.113.8"), false);
  });
});

test("PIN client fingerprints use the trusted address headers and the rightmost forwarded address", () => {
  withSecret("server-secret", () => {
    const direct = galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "cf-connecting-ip": "203.0.113.8", "x-real-ip": "203.0.113.9" },
    }));
    const trusted = galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-real-ip": "203.0.113.9", "x-forwarded-for": "192.0.2.1, 203.0.113.8" },
    }));
    const forwarded = galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-forwarded-for": "192.0.2.1, 203.0.113.8" },
    }));
    assert.notEqual(direct, trusted);
    assert.equal(forwarded, direct);
  });
});

test("PIN client fingerprints reject missing secrets and invalid addresses", () => {
  withSecret(undefined, () => {
    assert.equal(galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-real-ip": "203.0.113.8" },
    })), null);
  });
  withSecret("server-secret", () => {
    assert.equal(galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-forwarded-for": "forged, 999.999.999.999" },
    })), null);
  });
});

test("rotating the server secret rotates PIN client fingerprints", () => {
  const request = new Request("http://localhost", { headers: { "x-real-ip": "203.0.113.8" } });
  let first;
  let second;
  withSecret("first-secret", () => { first = galleryPinClientFingerprint(request); });
  withSecret("second-secret", () => { second = galleryPinClientFingerprint(request); });
  assert.notEqual(first, second);
});

test("production fingerprints use only the proxy header chosen by configuration", () => {
  withEnvironment({
    SUPABASE_SERVER_SECRET_KEY: "server-secret",
    CARTLIO_TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
    NODE_ENV: "production",
  }, () => {
    const configured = galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-real-ip": "203.0.113.8", "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.10" },
    }));
    const expected = galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-real-ip": "203.0.113.8" },
    }));
    assert.equal(configured, expected);
  });
});

test("production requires the configured proxy header and rejects forwarded chains", () => {
  withEnvironment({
    SUPABASE_SERVER_SECRET_KEY: "server-secret",
    CARTLIO_TRUSTED_CLIENT_IP_HEADER: undefined,
    NODE_ENV: "production",
  }, () => {
    assert.equal(galleryClientIpConfigurationReady(), false);
    assert.equal(galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-real-ip": "203.0.113.8" },
    })), null);
  });

  withEnvironment({
    SUPABASE_SERVER_SECRET_KEY: "server-secret",
    CARTLIO_TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for",
    NODE_ENV: "production",
  }, () => {
    assert.equal(galleryClientIpConfigurationReady(), true);
    assert.equal(galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-forwarded-for": "192.0.2.1, 203.0.113.8" },
    })), null);
    assert.match(galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.8" },
    })), /^[0-9a-f]{64}$/);
  });
});

test("production marks invalid trusted-proxy header names as not ready", () => {
  withEnvironment({
    SUPABASE_SERVER_SECRET_KEY: "server-secret",
    CARTLIO_TRUSTED_CLIENT_IP_HEADER: "forwarded",
    NODE_ENV: "production",
  }, () => {
    assert.equal(galleryClientIpConfigurationReady(), false);
    assert.equal(galleryPinClientFingerprint(new Request("http://localhost", {
      headers: { forwarded: "for=203.0.113.8" },
    })), null);
  });
});
