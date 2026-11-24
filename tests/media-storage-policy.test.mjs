import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaStorageProviders, panelOriginalUrl, photoOriginalProvider } from "../src/lib/media-storage-policy.ts";

test("display derivatives and studio logos have an explicit Supabase source", () => {
  assert.deepEqual(mediaStorageProviders, {
    original: "recorded-per-photo",
    preview: "supabase",
    thumbnail: "supabase",
    studioLogo: "supabase",
  });
});

test("originals use their recorded provider and legacy rows default to Supabase", () => {
  assert.equal(photoOriginalProvider({ storage_provider: "supabase" }), "supabase");
  assert.equal(photoOriginalProvider({ storage_provider: "r2" }), "r2");
  assert.equal(photoOriginalProvider({}), "supabase");
});

test("unknown or malformed original providers fail closed", () => {
  for (const record of [null, undefined, "r2", { storage_provider: null }, { storage_provider: "unknown" }]) {
    assert.equal(photoOriginalProvider(record), null);
  }
});

test("panel original URLs are scoped to the workspace, gallery, and photo", () => {
  assert.equal(panelOriginalUrl("tenant id", "gallery", "photo"),
    "/painel/tenant%20id/galerias/gallery/fotos/photo/original");
});
