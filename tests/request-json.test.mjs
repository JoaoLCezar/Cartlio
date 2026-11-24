import assert from "node:assert/strict";
import test from "node:test";
import { readLimitedJson } from "../src/lib/request-json.ts";

test("parses JSON that fits within the byte limit", async () => {
  const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ action: "clear" }) });
  assert.deepEqual(await readLimitedJson(request, 1024), { ok: true, value: { action: "clear" } });
});

test("rejects a declared body larger than the limit", async () => {
  const request = new Request("http://localhost", {
    method: "POST",
    headers: { "content-length": "1025" },
    body: "{}",
  });
  assert.deepEqual(await readLimitedJson(request, 1024), { ok: false, reason: "too-large" });
});

test("rejects and cancels a streamed body that exceeds the limit without a length header", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ note: "abcdef" }))); },
    cancel() { cancelled = true; },
  });
  const request = new Request("http://localhost", { method: "POST", body, duplex: "half" });

  assert.deepEqual(await readLimitedJson(request, 5), { ok: false, reason: "too-large" });
  assert.equal(cancelled, true);
});

test("rejects malformed JSON separately from an oversized request", async () => {
  const request = new Request("http://localhost", { method: "POST", body: "{" });
  assert.deepEqual(await readLimitedJson(request, 1024), { ok: false, reason: "invalid-json" });
});
