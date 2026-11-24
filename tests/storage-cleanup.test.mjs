import assert from "node:assert/strict";
import test from "node:test";
import { cleanupTenantStorage } from "../tests/e2e/support/storage-cleanup.mjs";

test("E2E Storage cleanup removes referenced and unreferenced objects only for its tenant", async () => {
  const objects = new Map([
    ["gallery-originals", new Set([
      "11111111-1111-4111-8111-111111111111/gallery/photo.png",
      "11111111-1111-4111-8111-111111111111/gallery/orphan.png",
      "22222222-2222-4222-8222-222222222222/gallery/other.png",
    ])],
    ["gallery-previews", new Set(["11111111-1111-4111-8111-111111111111/gallery/photo.webp"])],
    ["gallery-thumbnails", new Set(["22222222-2222-4222-8222-222222222222/gallery/other.webp"])],
    ["gallery-brand-assets", new Set([
      "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.webp",
      "22222222-2222-4222-8222-222222222222/44444444-4444-4444-8444-444444444444.webp",
    ])],
  ]);
  const removed = [];
  const client = {
    storage: {
      from(bucket) {
        return {
          async list(prefix, { limit, offset }) {
            const immediate = new Map();
            for (const path of objects.get(bucket)) {
              if (!path.startsWith(`${prefix}/`)) continue;
              const remainder = path.slice(prefix.length + 1);
              const slash = remainder.indexOf("/");
              const name = slash < 0 ? remainder : remainder.slice(0, slash);
              immediate.set(name, slash < 0 ? { name, metadata: { size: 1 } } : { name, metadata: null });
            }
            return { data: [...immediate.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit), error: null };
          },
          async remove(paths) {
            removed.push([bucket, ...paths]);
            for (const path of paths) objects.get(bucket).delete(path);
            return { error: null };
          },
        };
      },
    },
  };

  const result = await cleanupTenantStorage(client, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(result, { "gallery-originals": 2, "gallery-previews": 1, "gallery-thumbnails": 0, "gallery-brand-assets": 1 });
  assert.equal(objects.get("gallery-originals").has("22222222-2222-4222-8222-222222222222/gallery/other.png"), true);
  assert.equal(removed.flat().some(value => typeof value === "string" && value.startsWith("22222222-2222-4222-8222-222222222222/")), false);
});

test("E2E Storage cleanup rejects an invalid tenant before listing any bucket", async () => {
  const client = { storage: { from() { assert.fail("must not access Storage"); } } };
  await assert.rejects(cleanupTenantStorage(client, "../"), /Tenant UUID is required/);
});
