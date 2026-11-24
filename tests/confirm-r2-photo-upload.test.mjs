import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmR2PhotoUpload } from "../scripts/lib/confirm-r2-photo-upload.mjs";

const ids = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  galleryId: "10000000-0000-4000-8000-000000000002",
  uploadId: "10000000-0000-4000-8000-000000000003",
};
const actor = "10000000-0000-4000-8000-000000000004";
const path = `${ids.tenantId}/${ids.galleryId}/${ids.uploadId}.png`;
const reservation = {
  id: ids.uploadId, tenant_id: ids.tenantId, gallery_id: ids.galleryId, object_path: path,
  storage_provider: "r2", content_type: "image/png", byte_size: 128, state: "reserved",
};
const object = { provider: "r2", path, byteSize: 128, contentType: "image/png", etag: '"object-1"' };

function setup({ user = { id: actor }, session = reservation, metadata = object, rpcError = null } = {}) {
  const filters = [];
  const calls = [];
  const query = {
    select() { return this; },
    eq(column, value) { filters.push([column, value]); return this; },
    async maybeSingle() { calls.push("query"); return { data: session }; },
  };
  return {
    filters,
    calls,
    userClient: {
      auth: { async getUser() { calls.push("auth"); return { data: { user } }; } },
      from(table) { assert.equal(table, "upload_sessions"); return query; },
    },
    async readObject(received) {
      calls.push("head");
      assert.equal(received, session);
      return metadata;
    },
    serviceClient: {
      async rpc(name, args) {
        calls.push([name, args]);
        return { data: ids.uploadId, error: rpcError };
      },
    },
  };
}

test("R2 confirmation verifies identity and scope before sending object metadata to the privileged RPC", async () => {
  const api = setup();
  assert.equal(await confirmR2PhotoUpload(ids, api), ids.uploadId);
  assert.deepEqual(api.filters, [["id", ids.uploadId], ["tenant_id", ids.tenantId], ["gallery_id", ids.galleryId]]);
  assert.deepEqual(api.calls, ["auth", "query", "head", ["complete_r2_photo_upload", {
    p_actor_id: actor, p_tenant_id: ids.tenantId, p_gallery_id: ids.galleryId, p_upload_id: ids.uploadId,
    p_object_path: path, p_object_bytes: 128, p_object_content_type: "image/png", p_object_etag: '"object-1"',
  }]]);
});

test("R2 confirmation stops before storage or privileged writes for unauthenticated and foreign sessions", async () => {
  const anonymous = setup({ user: null });
  await assert.rejects(confirmR2PhotoUpload(ids, anonymous), { message: "UPLOAD_CONFIRMATION_DENIED" });
  assert.deepEqual(anonymous.calls, ["auth"]);
  const outsider = setup({ session: null });
  await assert.rejects(confirmR2PhotoUpload(ids, outsider), { message: "UPLOAD_NOT_FOUND" });
  assert.deepEqual(outsider.calls, ["auth", "query"]);
  const canceled = setup({ session: { ...reservation, state: "canceled" } });
  await assert.rejects(confirmR2PhotoUpload(ids, canceled), { message: "UPLOAD_CLOSED" });
  assert.deepEqual(canceled.calls, ["auth", "query"]);
});

test("R2 confirmation rejects absent metadata and unusable ETags before a privileged write", async () => {
  for (const [metadata, message] of [
    [null, "UPLOAD_MISSING"],
    [{ ...object, etag: null }, "UPLOAD_MISMATCH"],
    [{ ...object, etag: "*" }, "UPLOAD_MISMATCH"],
    [{ ...object, etag: 'W/"weak"' }, "UPLOAD_MISMATCH"],
  ]) {
    const api = setup({ metadata });
    await assert.rejects(confirmR2PhotoUpload(ids, api), { message });
    assert.deepEqual(api.calls, ["auth", "query", "head"]);
  }
});

test("R2 confirmation reports typed database errors and hides unexpected details", async () => {
  await assert.rejects(confirmR2PhotoUpload(ids, setup({ rpcError: { message: "UPLOAD_MISMATCH" } })),
    { message: "UPLOAD_MISMATCH" });
  await assert.rejects(confirmR2PhotoUpload(ids, setup({ rpcError: { message: "database details" } })),
    { message: "UPLOAD_CONFIRMATION_UNAVAILABLE" });
});
