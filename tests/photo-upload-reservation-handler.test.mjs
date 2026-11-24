import assert from "node:assert/strict";
import test from "node:test";
import { handlePhotoUploadReservation } from "../scripts/lib/photo-upload-reservation-handler.mjs";

const input = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  galleryId: "33333333-3333-4333-8333-333333333333",
  uploadId: "44444444-4444-4444-8444-444444444444",
  filename: "foto.png",
  contentType: "image/png",
  byteSize: 1024,
};

function request(body = input, headers = {}) {
  return new Request("https://cartlio.test/api/photo-uploads/reservations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function dependencies({ user = { id: "11111111-1111-4111-8111-111111111111" }, rpcError = null, env = {} } = {}) {
  const calls = [];
  return {
    calls,
    env,
    isTrustedOrigin: true,
    userClient: {
      auth: { async getUser() { calls.push("auth"); return { data: { user }, error: null }; } },
      async rpc(name, args) {
        calls.push([name, args]);
        return { data: { id: input.uploadId, storage_provider: "supabase" }, error: rpcError };
      },
    },
  };
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

test("reservation handler binds the authenticated Supabase user and accepts only bounded upload metadata", async () => {
  const deps = dependencies();
  const result = await readResponse(await handlePhotoUploadReservation(request(), deps));

  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { id: input.uploadId, storage_provider: "supabase" });
  assert.deepEqual(deps.calls, ["auth", ["reserve_photo_upload", {
    p_tenant_id: input.tenantId,
    p_gallery_id: input.galleryId,
    p_upload_id: input.uploadId,
    p_filename: input.filename,
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
  }]]);
});

test("reservation handler rejects cross-origin, unauthenticated, malformed, oversized, and invalid requests before writing", async () => {
  const cases = [
    [request(), { isTrustedOrigin: false }, 403, "UPLOAD_REQUEST_DENIED"],
    [request(), dependencies({ user: null }), 401, "UPLOAD_AUTHENTICATION_REQUIRED"],
    [request({ ...input, contentType: "text/plain" }), dependencies(), 400, "UPLOAD_INVALID"],
    [request(input, { "Content-Length": "9000" }), dependencies(), 413, "UPLOAD_INVALID"],
  ];

  for (const [req, deps, status, error] of cases) {
    const configured = { ...dependencies(), ...deps };
    const result = await readResponse(await handlePhotoUploadReservation(req, configured));
    assert.deepEqual(result, { status, body: { error } });
    assert.equal(configured.calls?.some(call => Array.isArray(call) && call[0] === "reserve_photo_upload"), false);
  }
});

test("reservation handler refuses the R2 selector before writing while its transfer lifecycle is incomplete", async () => {
  const deps = dependencies({ env: { CARTLIO_ORIGINAL_STORAGE_PROVIDER: "r2" } });
  const result = await readResponse(await handlePhotoUploadReservation(request(), deps));

  assert.deepEqual(result, { status: 503, body: { error: "UPLOAD_PROVIDER_UNSUPPORTED" } });
  assert.deepEqual(deps.calls, ["auth"]);
});

test("reservation handler hides unexpected database errors and preserves safe quota codes", async () => {
  for (const [message, expected] of [["secret database detail", "UPLOAD_RESERVATION_UNAVAILABLE"], ["STORAGE_QUOTA_EXCEEDED", "STORAGE_QUOTA_EXCEEDED"]]) {
    const deps = dependencies({ rpcError: { message } });
    const result = await readResponse(await handlePhotoUploadReservation(request(), deps));
    assert.equal(result.status, message === "STORAGE_QUOTA_EXCEEDED" ? 409 : 503);
    assert.deepEqual(result.body, { error: expected });
  }
});
