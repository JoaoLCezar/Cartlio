import assert from "node:assert/strict";
import { test } from "node:test";
import { originalAttachmentHeader, parseAuthorizedOriginal } from "../src/lib/authorized-original.ts";

const tenant = "10000000-0000-4000-8000-000000000001";
const gallery = "10000000-0000-4000-8000-000000000002";
const photo = "10000000-0000-4000-8000-000000000003";
const authorized = {
  tenant_id: tenant, gallery_id: gallery, photo_id: photo,
  path: `${tenant}/${gallery}/${photo}.png`,
  filename: "Ensaio São João.png", content_type: "image/png", byte_size: 128,
};

test("download identity supports current Supabase files and legacy individual downloads", () => {
  assert.deepEqual(parseAuthorizedOriginal({ ...authorized, storage_provider: "supabase", storage_etag: null }), {
    provider: "supabase", path: authorized.path, filename: authorized.filename, byteSize: 128,
  });
  assert.deepEqual(parseAuthorizedOriginal({ path: authorized.path, filename: authorized.filename }), {
    provider: "supabase", path: authorized.path, filename: authorized.filename, byteSize: null,
  });
});

test("download identity requires a scoped R2 object with its verified ETag", () => {
  const file = parseAuthorizedOriginal({ ...authorized, storage_provider: "r2", storage_etag: '"verified"' });
  assert.equal(file.provider, "r2");
  assert.equal(file.original.object_path, authorized.path);
  assert.equal(file.original.storage_etag, '"verified"');
  for (const override of [
    { storage_etag: null }, { storage_etag: "*" }, { tenant_id: gallery },
    { content_type: "image/jpeg" }, { byte_size: undefined }, { storage_provider: "unknown" },
  ]) {
    assert.equal(parseAuthorizedOriginal({ ...authorized, storage_provider: "r2", storage_etag: '"verified"', ...override }), null);
  }
  assert.equal(parseAuthorizedOriginal({ ...authorized, storage_etag: '"verified"' }), null);
});

test("R2 attachment header encodes accents and removes path and control characters", () => {
  assert.equal(originalAttachmentHeader("C:\\ensaio\\São João'\r\n.png", "image/png"),
    "attachment; filename=\"foto.png\"; filename*=UTF-8''S%C3%A3o%20Jo%C3%A3o%27__.png");
});
