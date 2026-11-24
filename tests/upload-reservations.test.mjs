import assert from "node:assert/strict";
import test from "node:test";
import { reservePhotoUpload, resolveOriginalStorageProvider } from "../scripts/lib/upload-reservations.mjs";

const ids = {
  actorId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  galleryId: "33333333-3333-4333-8333-333333333333",
  uploadId: "44444444-4444-4444-8444-444444444444",
};

function reservationInput(overrides = {}) {
  return {
    ...ids,
    filename: "image.png",
    contentType: "image/png",
    byteSize: 1024,
    ...overrides,
  };
}

function serviceConfig(overrides = {}) {
  return {
    CARTLIO_ORIGINAL_STORAGE_PROVIDER: "r2",
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
    R2_BUCKET: "cartlio-homolog",
    SUPABASE_SERVER_SECRET_KEY: "server-secret",
    ...overrides,
  };
}

test("original storage provider defaults to Supabase and never reads a public selector", () => {
  assert.equal(resolveOriginalStorageProvider({ NEXT_PUBLIC_CARTLIO_ORIGINAL_STORAGE_PROVIDER: "r2" }), "supabase");
  assert.equal(resolveOriginalStorageProvider({}), "supabase");
  assert.equal(resolveOriginalStorageProvider({ CARTLIO_ORIGINAL_STORAGE_PROVIDER: "supabase" }), "supabase");
});

test("R2 selection requires complete private storage and Supabase service credentials", () => {
  assert.equal(resolveOriginalStorageProvider(serviceConfig()), "r2");
  assert.throws(() => resolveOriginalStorageProvider(serviceConfig({ R2_SECRET_ACCESS_KEY: "" })), {
    message: "R2_STORAGE_NOT_CONFIGURED",
  });
  assert.throws(() => resolveOriginalStorageProvider(serviceConfig({ SUPABASE_SERVER_SECRET_KEY: "" })), {
    message: "R2_UPLOAD_SERVER_NOT_CONFIGURED",
  });
  assert.throws(() => resolveOriginalStorageProvider({ CARTLIO_ORIGINAL_STORAGE_PROVIDER: "other" }), {
    message: "ORIGINAL_STORAGE_PROVIDER_INVALID",
  });
});

test("Supabase reservations stay on the authenticated client", async () => {
  const calls = [];
  const input = reservationInput();
  const userClient = { async rpc(name, args) { calls.push(["user", name, args]); return { data: { id: input.uploadId, storage_provider: "supabase" }, error: null }; } };
  const serviceClient = { async rpc() { throw new Error("service client must not be used"); } };

  const result = await reservePhotoUpload("supabase", input, { userClient, serviceClient });

  assert.deepEqual(result, { id: input.uploadId, storage_provider: "supabase" });
  assert.deepEqual(calls, [["user", "reserve_photo_upload", {
    p_tenant_id: input.tenantId,
    p_gallery_id: input.galleryId,
    p_upload_id: input.uploadId,
    p_filename: input.filename,
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
  }]]);
});

test("R2 reservations use the private service client and bind the authenticated actor", async () => {
  const calls = [];
  const input = reservationInput();
  const userClient = { async rpc() { throw new Error("user client must not be used"); } };
  const serviceClient = { async rpc(name, args) { calls.push([name, args]); return { data: { id: input.uploadId, storage_provider: "r2" }, error: null }; } };

  const result = await reservePhotoUpload("r2", input, { userClient, serviceClient });

  assert.deepEqual(result, { id: input.uploadId, storage_provider: "r2" });
  assert.deepEqual(calls, [["reserve_r2_photo_upload", {
    p_actor_id: input.actorId,
    p_tenant_id: input.tenantId,
    p_gallery_id: input.galleryId,
    p_upload_id: input.uploadId,
    p_filename: input.filename,
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
  }]]);
});

test("reservation errors expose only known upload codes", async () => {
  const input = reservationInput();
  const clients = {
    userClient: { async rpc() { return { data: null, error: { message: "STORAGE_QUOTA_EXCEEDED" } }; } },
    serviceClient: { async rpc() { return { data: null, error: { message: "secret database detail" } }; } },
  };

  await assert.rejects(reservePhotoUpload("supabase", input, clients), { message: "STORAGE_QUOTA_EXCEEDED" });
  await assert.rejects(reservePhotoUpload("r2", input, clients), { message: "UPLOAD_RESERVATION_UNAVAILABLE" });
  await assert.rejects(reservePhotoUpload("r2", reservationInput({ actorId: null }), clients), { message: "UPLOAD_INVALID" });
});
