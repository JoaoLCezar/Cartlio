import assert from "node:assert/strict";
import test from "node:test";
import { authReturnPath, safeInvitationReturnPath } from "../src/lib/auth-redirect.ts";
import { trustedAppOrigin } from "../src/lib/app-origin.ts";

test("accepts only the internal invitation path with a full hex token", () => {
  const path = `/convite/${"a1".repeat(32)}`;
  assert.equal(safeInvitationReturnPath(path), path);
  assert.equal(authReturnPath(path), path);
});

test("uses the configured canonical app origin for auth links", () => {
  const headers = new Headers({ origin: "https://attacker.example", host: "attacker.example" });
  assert.equal(trustedAppOrigin(headers, {
    canonicalUrl: "https://cartlio.example/",
    production: true,
  }), "https://cartlio.example");
});

test("requires a canonical HTTPS origin in production", () => {
  const headers = new Headers({ origin: "https://cartlio.example", host: "cartlio.example" });
  assert.equal(trustedAppOrigin(headers, { production: true }), null);
  assert.equal(trustedAppOrigin(headers, {
    canonicalUrl: "http://cartlio.example",
    production: true,
  }), null);
  assert.equal(trustedAppOrigin(headers, {
    canonicalUrl: "http://127.0.0.1:3310",
    production: true,
  }), "http://127.0.0.1:3310");
});

test("uses request origin only for local development and rejects host poisoning", () => {
  const valid = new Headers({ origin: "http://localhost:3000", host: "localhost:3000" });
  const poisoned = new Headers({ origin: "https://attacker.example", host: "cartlio.example" });
  assert.equal(trustedAppOrigin(valid, { production: false }), "http://localhost:3000");
  assert.equal(trustedAppOrigin(poisoned, { production: false }), null);
});

test("rejects external, malformed, and query-bearing return paths", () => {
  for (const path of ["https://attacker.example", "//attacker.example", "/painel", "/convite/short", `/convite/${"a".repeat(64)}?next=https://attacker.example`]) {
    assert.equal(safeInvitationReturnPath(path), null);
    assert.equal(authReturnPath(path), "/painel");
  }
});
